import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TestCase, TestLineMap, CoverageSummary, CoverageSummaryEntry } from '../types.js';

export type { TestCase };

export interface BuildOptions {
  projectRoot: string;
  outDir: string;
  concurrency?: number;
  fileFilter?: string;
  configPath?: string;
}

export interface BuildResult {
  map: TestLineMap;
  summary: CoverageSummary;
}

export interface Runner {
  discover(projectRoot: string, fileFilter: string | undefined, configPath: string | undefined): Promise<TestCase[]>;
  runOne(tc: TestCase, projectRoot: string, workerDir: string, configPath: string | undefined): Promise<void>;
  aggregate(projectRoot: string, aggregateDir: string, configPath: string | undefined): Promise<void>;
  /** Override the default concurrency for this runner. If omitted, the CPU-based default is used. */
  defaultConcurrency?: number;
}

/** Return the path from /packages/ onward, or relative to projectRoot, else return as-is. */
function shortPath(p: string, projectRoot?: string): string {
  const idx = p.indexOf('/packages/');
  if (idx >= 0) return p.slice(idx + 1);
  if (projectRoot && p.startsWith(projectRoot)) return p.slice(projectRoot.length).replace(/^\//, '');
  return p;
}

/** Extract covered source lines from a coverage-final.json Istanbul map. */
function extractLines(coverageMap: Record<string, unknown>, projectRoot?: string): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [file, fileCov] of Object.entries(coverageMap)) {
    const cov = fileCov as { s: Record<string, number>; statementMap: Record<string, { start: { line: number } }> };
    const lines = new Set<number>();
    for (const [id, count] of Object.entries(cov.s)) {
      if (count > 0 && cov.statementMap?.[id]) lines.add(cov.statementMap[id].start.line);
    }
    if (lines.size > 0) result[shortPath(file, projectRoot)] = [...lines].sort((a, b) => a - b);
  }
  return result;
}

/** Build CoverageSummary from a coverage-final.json map. */
function buildCoverageSummary(coverageFinal: Record<string, unknown>): CoverageSummary {
  const summary: CoverageSummary = {};
  for (const [file, data] of Object.entries(coverageFinal)) {
    const d = data as {
      s: Record<string, number>;
      f: Record<string, number>;
      fnMap: Record<string, { name: string; decl: { start: { line: number } } }>;
      branchMap: Record<string, { name: string; loc: { start: { line: number } } }>;
    };
    const stmts = Object.values(d.s);
    const fns   = Object.values(d.f);
    const totalStmts   = stmts.length;
    const coveredStmts = stmts.filter(c => c > 0).length;
    const totalFns     = fns.length;
    const coveredFns   = fns.filter(c => c > 0).length;
    const entry: CoverageSummaryEntry = {
      lines:      { total: totalStmts, covered: coveredStmts, pct: totalStmts > 0 ? (coveredStmts / totalStmts) * 100 : 100 },
      functions:  { total: totalFns,   covered: coveredFns,   pct: totalFns   > 0 ? (coveredFns   / totalFns)   * 100 : 100 },
      statements: { total: totalStmts, covered: coveredStmts, pct: totalStmts > 0 ? (coveredStmts / totalStmts) * 100 : 100 },
      branchMap: d.branchMap ?? {},
      fnMap: d.fnMap ?? {},
      f:     d.f   ?? {},
    };
    summary[file] = entry;
  }
  return summary;
}

const CPU_CONCURRENCY = Math.max(1, Math.min(Math.floor(os.cpus().length / 2), 10));

export async function build(opts: BuildOptions, runner: Runner): Promise<BuildResult> {
  const defaultConcurrency = runner.defaultConcurrency ?? CPU_CONCURRENCY;
  const { projectRoot, outDir, concurrency = defaultConcurrency, fileFilter, configPath } = opts;

  fs.mkdirSync(outDir, { recursive: true });

  // ── Step 1: Discover ─────────────────────────────────────────────────────────
  const testCases = await runner.discover(projectRoot, fileFilter, configPath);
  if (testCases.length === 0) return { map: {}, summary: {} };

  if (process.stderr.isTTY) process.stderr.write(`  Running ${testCases.length} tests with concurrency=${concurrency}\n`);

  // ── Step 2: Per-test isolation ───────────────────────────────────────────────
  const tmpRoot = path.join(outDir, 'tmp-per-test');
  fs.mkdirSync(tmpRoot, { recursive: true });

  const map: TestLineMap = {};
  let idx = 0, done = 0;
  const total = testCases.length;
  const isTTY = process.stderr.isTTY;
  const startTime = Date.now();

  function formatEta(elapsedMs: number, completedSoFar: number): string {
    if (completedSoFar === 0) return '';
    const mins = (elapsedMs / completedSoFar) * (total - completedSoFar) / 60000;
    if (mins < 1) return '< 1 min';
    if (mins < 60) return `~${Math.ceil(mins)} min${Math.ceil(mins) !== 1 ? 's' : ''}`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
  }

  function progress(): void {
    if (!isTTY) return;
    const pct = Math.round((done / total) * 100);
    const filled = Math.floor(pct / 5);
    const bar = `[${'█'.repeat(filled)}${' '.repeat(20 - filled)}]`;
    const eta = done > 0 ? ` ${formatEta(Date.now() - startTime, done)}` : '';
    process.stderr.write(`\r  ${bar} ${done}/${total} (${pct}%)${eta}`.padEnd(80));
  }

  function clearProgress(): void {
    if (isTTY) process.stderr.write(`\r${' '.repeat(80)}\r`);
  }

  async function runOne(tc: TestCase, workerIdx: number): Promise<void> {
    const workerDir = path.join(tmpRoot, `worker-${workerIdx}`);
    progress();
    try {
      await runner.runOne(tc, projectRoot, workerDir, configPath);
      const coveragePath = path.join(workerDir, 'coverage-final.json');
      if (fs.existsSync(coveragePath)) {
        const raw = JSON.parse(fs.readFileSync(coveragePath, 'utf8')) as Record<string, unknown>;
        const sourceLines = extractLines(raw, projectRoot);
        const key = `${shortPath(tc.filePath, projectRoot)} > ${tc.fullName}`;
        map[key] = { file: shortPath(tc.filePath, projectRoot), fullName: tc.fullName, title: tc.title, describePath: tc.describePath, sourceLines };
        fs.rmSync(coveragePath);
      }
    } catch { /* individual test failure — skip */ }
    done++;
    progress();
  }

  async function worker(workerIdx: number): Promise<void> {
    while (idx < testCases.length) await runOne(testCases[idx++], workerIdx);
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  clearProgress();
  // Remove per-test worker directories now that coverage data has been extracted into map.
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (process.stderr.isTTY) process.stderr.write(`  Per-test runs complete. Running aggregate coverage pass...\n`);

  // ── Step 3: Aggregate ────────────────────────────────────────────────────────
  const aggregateDir = path.join(outDir, 'aggregate');
  let summary: CoverageSummary = {};
  await runner.aggregate(projectRoot, aggregateDir, configPath);
  const aggregatePath = path.join(aggregateDir, 'coverage-final.json');
  if (fs.existsSync(aggregatePath)) {
    summary = buildCoverageSummary(JSON.parse(fs.readFileSync(aggregatePath, 'utf8')) as Record<string, unknown>);
  }

  // ── Step 4: Write outputs ─────────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'test-line-map.json'), JSON.stringify(map, null, 2));
  fs.writeFileSync(path.join(outDir, 'coverage-summary.json'), JSON.stringify(summary, null, 2));

  return { map, summary };
}
