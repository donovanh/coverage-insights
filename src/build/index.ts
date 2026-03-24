import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TestCase, TestLineMap, CoverageSummary, CoverageSummaryEntry } from '../types.js';

export type { TestCase };

export interface BuildOptions {
  projectRoot: string;
  outDir: string;
  concurrency?: number;
  noAggregate?: boolean;
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
  runAll?(projectRoot: string, workDir: string, testCases?: TestCase[]): Promise<void>;
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
    // Compact format written by Gradle's mergeLinesFromJacocoDir: { [absPath]: number[] }
    if (Array.isArray(fileCov)) {
      if ((fileCov as number[]).length > 0)
        result[shortPath(file, projectRoot)] = fileCov as number[];
      continue;
    }
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
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startBatchSpinner(isTTY: boolean, testCount: number, batchDir: string): () => void {
  let lastPollTime = 0;
  let peakExec = 0;
  let currentExec = 0;
  function pollExec() {
    const now = Date.now();
    if (now - lastPollTime < 5000) return;
    lastPollTime = now;
    try {
      const files = fs.readdirSync(batchDir);
      const execCount = files.filter(f => f.endsWith('.exec')).length;
      if (execCount > peakExec) peakExec = execCount;
      currentExec = execCount;
    } catch { /* ignore */ }
  }
  function formatEta(elapsedSecs: number): string {
    if (peakExec === 0 || elapsedSecs === 0) return '';
    const processed = peakExec - currentExec;
    if (processed <= 0) return '';
    const rate = processed / elapsedSecs;
    const remainingSecs = Math.round(currentExec / rate);
    const rm = Math.floor(remainingSecs / 60);
    const rs = remainingSecs % 60;
    return rm > 0 ? `~${rm}m ${rs}s remaining` : `~${rs}s remaining`;
  }
  if (!isTTY) {
    process.stderr.write(`  Running ${testCount} tests in batch mode...\n`);
    return () => {};
  }
  const start = Date.now();
  let frame = 0;
  const write = () => {
    pollExec();
    const secs = (Date.now() - start) / 1000;
    const eta = formatEta(secs);
    const etaStr = eta ? `, ${eta}` : '';
    process.stderr.write(`\r  ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Batch test run (${testCount} tests)... ${formatElapsed(start)}${etaStr}`.padEnd(80));
    frame++;
  };
  write();
  const timer = setInterval(write, 100);
  return () => {
    clearInterval(timer);
    process.stderr.write(`\r${' '.repeat(80)}\r`);
  };
}

function formatElapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  const whole = Math.round(secs);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function startAggregateSpinner(isTTY: boolean): () => void {
  if (!isTTY) {
    process.stderr.write('  Running aggregate coverage pass...\n');
    return () => {};
  }
  const start = Date.now();
  let frame = 0;
  const write = () => {
    process.stderr.write(`\r  ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Aggregate coverage pass... ${formatElapsed(start)}`.padEnd(80));
    frame++;
  };
  write();
  const timer = setInterval(write, 100);
  return () => {
    clearInterval(timer);
    process.stderr.write(`\r${' '.repeat(80)}\r`);
  };
}

/** Sanitise a string to a safe file name, matching the Kotlin batchConvert naming. */
function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Write a large JSON object entry-by-entry to avoid V8 string length limits. */
function streamWriteJson(filePath: string, obj: Record<string, unknown>): void {
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, '{\n');
    const entries = Object.entries(obj);
    for (let i = 0; i < entries.length; i++) {
      const line = '  ' + JSON.stringify(entries[i][0]) + ': ' + JSON.stringify(entries[i][1])
        + (i < entries.length - 1 ? ',' : '') + '\n';
      fs.writeSync(fd, line);
    }
    fs.writeSync(fd, '}\n');
  } finally {
    fs.closeSync(fd);
  }
}

export async function build(opts: BuildOptions, runner: Runner): Promise<BuildResult> {
  const defaultConcurrency = runner.defaultConcurrency ?? CPU_CONCURRENCY;
  const { projectRoot, outDir, concurrency = defaultConcurrency, noAggregate, fileFilter, configPath } = opts;

  fs.mkdirSync(outDir, { recursive: true });

  // ── Step 1: Discover ─────────────────────────────────────────────────────────
  const testCases = await runner.discover(projectRoot, fileFilter, configPath);
  if (testCases.length === 0) return { map: {}, summary: {} };

  const isTTY = process.stderr.isTTY;

  // ── Step 2: Per-test coverage ────────────────────────────────────────────────
  let map: TestLineMap = {};

  if (runner.runAll) {
    // ── Step 2 (batch): single Gradle invocation ──────────────────────────────
    const batchDir = path.join(outDir, 'batch');
    fs.mkdirSync(batchDir, { recursive: true });
    const stopBatch = startBatchSpinner(isTTY, testCases.length, batchDir);
    try {
      await runner.runAll(projectRoot, batchDir, testCases);
      stopBatch();
      // Read one JSON file per test — no single large string ever created
      const tcByKey = new Map<string, TestCase>();
      for (const tc of testCases) {
        const key = safeFileName(`${tc.describePath}.${tc.title}`);
        tcByKey.set(key, tc);
      }
      let unmatchedBatch = 0;
      for (const f of fs.readdirSync(batchDir)) {
        if (!f.endsWith('.json') || f.startsWith('.')) continue;
        const testKey = f.slice(0, -5);
        const tc = tcByKey.get(testKey);
        if (!tc) { unmatchedBatch++; continue; }
        const fileLines = JSON.parse(fs.readFileSync(path.join(batchDir, f), 'utf8')) as Record<string, number[]>;
        const sourceLines: Record<string, number[]> = {};
        for (const [absPath, lines] of Object.entries(fileLines)) {
          if (lines.length > 0) sourceLines[shortPath(absPath, projectRoot)] = lines;
        }
        if (Object.keys(sourceLines).length === 0) continue;
        const key = `${shortPath(tc.filePath, projectRoot)} > ${tc.fullName}`;
        map[key] = { file: shortPath(tc.filePath, projectRoot), fullName: tc.fullName, title: tc.title, describePath: tc.describePath, sourceLines };
      }
      if (unmatchedBatch > 0) {
        process.stderr.write(`  coverage-insights: ${unmatchedBatch} batch output files had no matching test — parameterized tests or JUnit 5 tests are not supported in batch mode\n`);
      } else {
        process.stderr.write('  coverage-insights: batch conversion produced no output.\n' +
          '  Check that JaCoCo jars are resolvable (jacocoAnt or buildscript classpath).\n');
      }
    } finally {
      stopBatch(); // idempotent — clearInterval is safe to call twice
      fs.rmSync(batchDir, { recursive: true, force: true });
    }
  } else {
    // ── Step 2 (per-test): worker pool ────────────────────────────────────────
    if (isTTY) process.stderr.write(`  Running ${testCases.length} tests with concurrency=${concurrency}\n`);
    const tmpRoot = path.join(outDir, 'tmp-per-test');
    fs.mkdirSync(tmpRoot, { recursive: true });
    let idx = 0, done = 0;
    const total = testCases.length;
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

    async function workerFn(workerIdx: number): Promise<void> {
      while (idx < testCases.length) await runOne(testCases[idx++], workerIdx);
    }

    await Promise.all(Array.from({ length: concurrency }, (_, i) => workerFn(i)));
    clearProgress();
    // Remove per-test worker directories now that coverage data has been extracted into map.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── Step 3: Aggregate ────────────────────────────────────────────────────────
  const aggregateDir = path.join(outDir, 'aggregate');
  let summary: CoverageSummary = {};
  if (noAggregate) {
    if (isTTY) process.stderr.write('  Skipping aggregate pass (--no-aggregate).\n');
  } else {
    const stopSpinner = startAggregateSpinner(isTTY);
    await runner.aggregate(projectRoot, aggregateDir, configPath);
    stopSpinner();
    const aggregatePath = path.join(aggregateDir, 'coverage-final.json');
    if (fs.existsSync(aggregatePath)) {
      summary = buildCoverageSummary(JSON.parse(fs.readFileSync(aggregatePath, 'utf8')) as Record<string, unknown>);
    }
  }

  // ── Step 4: Write outputs ─────────────────────────────────────────────────
  streamWriteJson(path.join(outDir, 'test-line-map.json'), map as unknown as Record<string, unknown>);
  streamWriteJson(path.join(outDir, 'coverage-summary.json'), summary as unknown as Record<string, unknown>);

  return { map, summary };
}
