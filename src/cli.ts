#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import { build } from './build/index.js';
import { vitestRunner } from './build/runners/vitest.js';
import { jestRunner } from './build/runners/jest.js';
import { gradleRunner } from './build/runners/gradle.js';
import { playRunner } from './build/runners/play.js';
import { analyseControllers } from './build/runners/play/dead-controllers.js';
import { detectRunner } from './build/detect.js';
import { analyse } from './analyse.js';
import { consoleReport } from './report/console.js';
import { htmlReport } from './report/html.js';
import type { AnalysisOptions } from './types.js';
import type { PlayReportData } from './report/html.js';

function openFile(filePath: string): void {
  spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
}

function parseArgs(argv: string[]): {
  root: string;
  outDir: string;
  html: boolean;
  noBuild: boolean;
  noAggregate: boolean;
  openHtml: boolean;
  companion?: string;
  opts: AnalysisOptions;
  concurrency: number | undefined;
  fileFilter?: string;
  configPath?: string;
  runnerFlag?: string;
} {
  const args = argv.slice(2);
  const get = (prefix: string): string | undefined => {
    const withEq = args.find(a => a.startsWith(prefix));
    if (withEq !== undefined) return withEq.split('=').slice(1).join('=');
    const bare = prefix.replace(/=$/, '');
    const idx  = args.indexOf(bare);
    if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) return args[idx + 1];
    return undefined;
  };

  const root        = path.resolve(get('--root=')        ?? process.cwd());
  const outDir      = path.resolve(root, get('--out=')   ?? 'coverage-insights');
  const html        = !args.includes('--no-html');
  const noBuild     = args.includes('--no-build');
  const fileFilter  = get('--file=');
  const runnerFlag  = get('--runner=');
  // Play runner skips aggregate by default — ITests can't run in isolation so
  // the aggregate JaCoCo pass adds noise without meaningful signal.
  const noAggregate = args.includes('--no-aggregate') || fileFilter !== undefined || runnerFlag === 'play';
  const openHtml    = !args.includes('--no-open');
  const companion   = get('--companion=') ? path.resolve(get('--companion=')!) : undefined;
  const configPath  = get('--config=') ? path.resolve(get('--config=')!) : undefined;
  const rawConc     = get('--concurrency=');
  const concurrency = rawConc !== undefined ? parseInt(rawConc, 10) : undefined;

  const opts: AnalysisOptions = {
    threshold:            parseFloat(get('--threshold=')    ?? '0.9'),
    lowCoverageThreshold: parseFloat(get('--low-coverage=') ?? '80'),
    sourceFilter:         get('--source='),
    topN:                 get('--top=') ? parseInt(get('--top=')!, 10) : undefined,
  };

  return { root, outDir, html, noBuild, noAggregate, openHtml, companion, opts, concurrency, fileFilter, configPath, runnerFlag };
}

export async function main(): Promise<void> {
  const { root, outDir, html, noBuild, noAggregate, openHtml, companion, opts, concurrency, fileFilter, configPath, runnerFlag } = parseArgs(process.argv);

  if (!fs.existsSync(root)) {
    process.stderr.write(`Error: project root does not exist: ${root}\n`);
    process.exit(1);
  }

  let map: Awaited<ReturnType<typeof build>>['map'];
  let summary: Awaited<ReturnType<typeof build>>['summary'];

  if (noBuild) {
    // Load existing test-line-map.json without re-running tests
    const mapPath = path.join(outDir, 'test-line-map.json');
    if (!fs.existsSync(mapPath)) {
      process.stderr.write(`Error: no test-line-map.json found at ${mapPath}\n`);
      process.stderr.write(`Run without --no-build first to collect coverage data.\n`);
      process.exit(1);
    }
    process.stdout.write(`coverage-insights: loading existing data from ${outDir}\n`);
    map     = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    summary = {};
    const summaryPath = path.join(outDir, 'coverage-summary.json');
    if (fs.existsSync(summaryPath)) {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    }
  } else {
    process.stdout.write(`coverage-insights: scanning ${root}\n`);
    const runnerName = detectRunner(root, runnerFlag);
    const runner = runnerName === 'jest'   ? jestRunner
                 : runnerName === 'gradle' ? gradleRunner
                 : runnerName === 'play'   ? playRunner
                 : vitestRunner;
    ({ map, summary } = await build({ projectRoot: root, outDir, concurrency, noAggregate, fileFilter, configPath }, runner));
  }

  const report = analyse(map, summary, opts);
  consoleReport(report, opts);

  const jsonPath = path.join(outDir, 'test-line-map.json');
  process.stdout.write(`\n  JSON  ${jsonPath}\n`);

  let playData: PlayReportData | undefined;
  if (detectRunner(root, runnerFlag) === 'play') {
    playData = { controllers: analyseControllers(root) };
  }

  let htmlPath: string | undefined;
  if (html) {
    const htmlContent = htmlReport(report, opts, playData);
    fs.mkdirSync(outDir, { recursive: true });
    htmlPath = path.join(outDir, 'report.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf8');
    process.stdout.write(`  HTML  ${htmlPath}\n`);
  }

  for (const dir of ['tmp-per-test', 'aggregate']) {
    fs.rmSync(path.join(outDir, dir), { recursive: true, force: true });
  }

  // Run companion script if provided — passes outDir and map path as arguments.
  // The companion can generate supplementary reports, run project-specific analysis,
  // or produce a combined HTML output.
  if (companion) {
    if (!fs.existsSync(companion)) {
      process.stderr.write(`Warning: companion script not found: ${companion}\n`);
    } else {
      process.stderr.write(`\n▶ Running companion: ${companion}\n`);
      try {
        execFileSync(process.execPath, [
          companion,
          `--out=${outDir}`,
          `--map=${jsonPath}`,
        ], { stdio: 'inherit' });
      } catch {
        process.stderr.write(`Warning: companion script exited with an error.\n`);
      }
    }
  }

  // Auto-open HTML — companion may have replaced report.html with a combined version
  if (openHtml) {
    const toOpen = htmlPath ?? path.join(outDir, 'report.html');
    if (fs.existsSync(toOpen)) openFile(toOpen);
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
