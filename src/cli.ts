#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import { build } from './build/index.js';
import { vitestRunner } from './build/runners/vitest.js';
import { jestRunner } from './build/runners/jest.js';
import { detectRunner } from './build/detect.js';
import { analyse } from './analyse.js';
import { consoleReport } from './report/console.js';
import { htmlReport } from './report/html.js';
import type { AnalysisOptions } from './types.js';

function parseArgs(argv: string[]): {
  root: string;
  outDir: string;
  html: boolean;
  opts: AnalysisOptions;
  concurrency: number | undefined;
  fileFilter?: string;
  configPath?: string;
  runnerFlag?: string;
} {
  const args = argv.slice(2);
  const get = (prefix: string) => args.find(a => a.startsWith(prefix))?.split('=').slice(1).join('=');

  const root        = path.resolve(get('--root=')        ?? process.cwd());
  const outDir      = path.resolve(root, get('--out=')   ?? 'coverage-insights');
  const html        = args.includes('--html');
  const fileFilter  = get('--file=');
  const configPath  = get('--config=') ? path.resolve(get('--config=')!) : undefined;
  const rawConc     = get('--concurrency=');
  const concurrency = rawConc !== undefined ? parseInt(rawConc, 10) : undefined;
  const runnerFlag  = get('--runner=');

  const opts: AnalysisOptions = {
    threshold:            parseFloat(get('--threshold=')    ?? '0.9'),
    lowCoverageThreshold: parseFloat(get('--low-coverage=') ?? '80'),
    sourceFilter:         get('--source='),
    topN:                 get('--top=') ? parseInt(get('--top=')!, 10) : undefined,
  };

  return { root, outDir, html, opts, concurrency, fileFilter, configPath, runnerFlag };
}

export async function main(): Promise<void> {
  const { root, outDir, html, opts, concurrency, fileFilter, configPath, runnerFlag } = parseArgs(process.argv);

  if (!fs.existsSync(root)) {
    process.stderr.write(`Error: project root does not exist: ${root}\n`);
    process.exit(1);
  }

  process.stdout.write(`coverage-insights: scanning ${root}\n`);

  const runnerName = detectRunner(root, runnerFlag);
  const runner = runnerName === 'jest' ? jestRunner : vitestRunner;

  const { map, summary } = await build({ projectRoot: root, outDir, concurrency, fileFilter, configPath }, runner);

  const report = analyse(map, summary, opts);
  consoleReport(report, opts);

  const jsonPath = path.join(outDir, 'test-line-map.json');
  process.stdout.write(`\n  JSON  ${jsonPath}\n`);

  if (html) {
    const htmlContent = htmlReport(report, opts);
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, 'report.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf8');
    process.stdout.write(`  HTML  ${htmlPath}\n`);
  }

  for (const dir of ['tmp-per-test', 'aggregate']) {
    fs.rmSync(path.join(outDir, dir), { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
