/**
 * Gradle per-test performance benchmark.
 *
 * Measures wall-clock time per test for four approaches:
 *   A. Current:   --no-daemon, 2 invocations (test + jacocoTestReport)
 *   B. Opt-1inv:  --no-daemon, 1 invocation (relies on finalizedBy in build file)
 *   C. Opt-daemon: --daemon with per-worker isolated cache, 2 invocations
 *   D. Opt-both:  --daemon with per-worker isolated cache, 1 invocation
 *
 * Run with:
 *   npx tsx tests/bench/gradle-bench.ts
 *
 * Requires Java and the fixture project's gradlew to be functional.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const PROJECT = path.resolve('tests/fixtures/gradle-project');
const GRADLEW  = path.join(PROJECT, 'gradlew');

// Tests to benchmark — one from each class to get a spread
const TESTS: Array<{ module: string; filter: string; label: string }> = [
  { module: ':application', filter: 'com.example.app.FormatterTest.should format date',      label: 'Formatter/formatDate'   },
  { module: ':application', filter: 'com.example.app.FormatterTest.should format name',      label: 'Formatter/formatName'   },
  { module: ':application', filter: 'com.example.app.StringUtilsTest.truncate short string unchanged', label: 'StringUtils/truncate'  },
  { module: ':application', filter: 'com.example.app.StringUtilsTest.isPalindrome returns true for palindrome', label: 'StringUtils/isPalin' },
  { module: ':application', filter: 'com.example.app.MathUtilsTest.clamp returns value when in range', label: 'MathUtils/clamp'       },
  { module: ':application', filter: 'com.example.app.MathUtilsTest.isPrime returns true for prime', label: 'MathUtils/isPrime'     },
];

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function gradle(args: string[], env?: Record<string, string>): void {
  execFileSync(GRADLEW, args, {
    cwd: PROJECT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function makeTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ci-bench-${label}-`));
}

// ── Approach A: current (--no-daemon, 2 invocations) ────────────────────────
function runCurrentApproach(tests: typeof TESTS): number[] {
  const times: number[] = [];
  for (const t of tests) {
    const workerDir = makeTmpDir('A');
    const common = [
      '--no-daemon', '--rerun-tasks',
      `-Pcoverage.insights.xmlDir=${workerDir}`,
    ];
    const start = process.hrtime.bigint();
    try {
      gradle([`${t.module}:test`, '--tests', t.filter, ...common]);
      gradle([`${t.module}:jacocoTestReport`, ...common]);
    } catch { /* test failures are ok */ }
    times.push(ms(start));
    fs.rmSync(workerDir, { recursive: true, force: true });
    process.stdout.write(`  A  ${t.label.padEnd(30)} ${(times.at(-1)! / 1000).toFixed(1)}s\n`);
  }
  return times;
}

// ── Approach B: single invocation (--no-daemon, relies on finalizedBy) ───────
function runSingleInvocationApproach(tests: typeof TESTS): number[] {
  const times: number[] = [];
  for (const t of tests) {
    const workerDir = makeTmpDir('B');
    const start = process.hrtime.bigint();
    try {
      gradle([
        `${t.module}:test`,
        '--tests', t.filter,
        '--no-daemon', '--rerun-tasks',
        `-Pcoverage.insights.xmlDir=${workerDir}`,
      ]);
      // No second invocation — jacocoTestReport runs via finalizedBy
    } catch { /* ok */ }
    times.push(ms(start));
    fs.rmSync(workerDir, { recursive: true, force: true });
    process.stdout.write(`  B  ${t.label.padEnd(30)} ${(times.at(-1)! / 1000).toFixed(1)}s\n`);
  }
  return times;
}

// ── Approach C: daemon per worker, 2 invocations ─────────────────────────────
function runDaemonApproach(tests: typeof TESTS): number[] {
  const cacheDir = makeTmpDir('C-cache');
  const times: number[] = [];
  try {
    for (const t of tests) {
      const workerDir = makeTmpDir('C');
      const common = [
        '--daemon', '--rerun-tasks',
        `--project-cache-dir=${cacheDir}`,
        `-Pcoverage.insights.xmlDir=${workerDir}`,
      ];
      const start = process.hrtime.bigint();
      try {
        gradle([`${t.module}:test`, '--tests', t.filter, ...common]);
        gradle([`${t.module}:jacocoTestReport`, ...common]);
      } catch { /* ok */ }
      times.push(ms(start));
      fs.rmSync(workerDir, { recursive: true, force: true });
      process.stdout.write(`  C  ${t.label.padEnd(30)} ${(times.at(-1)! / 1000).toFixed(1)}s\n`);
    }
  } finally {
    try { gradle(['--stop', `--project-cache-dir=${cacheDir}`]); } catch { /* ok */ }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  return times;
}

// ── Approach D: daemon per worker + single invocation ────────────────────────
function runDaemonSingleInvocationApproach(tests: typeof TESTS): number[] {
  const cacheDir = makeTmpDir('D-cache');
  const times: number[] = [];
  try {
    for (const t of tests) {
      const workerDir = makeTmpDir('D');
      const start = process.hrtime.bigint();
      try {
        gradle([
          `${t.module}:test`,
          '--tests', t.filter,
          '--daemon', '--rerun-tasks',
          `--project-cache-dir=${cacheDir}`,
          `-Pcoverage.insights.xmlDir=${workerDir}`,
        ]);
      } catch { /* ok */ }
      times.push(ms(start));
      fs.rmSync(workerDir, { recursive: true, force: true });
      process.stdout.write(`  D  ${t.label.padEnd(30)} ${(times.at(-1)! / 1000).toFixed(1)}s\n`);
    }
  } finally {
    try { gradle(['--stop', `--project-cache-dir=${cacheDir}`]); } catch { /* ok */ }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  return times;
}

function avg(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function projectedMinutes(avgMs: number, n: number): string {
  const mins = (avgMs * n) / 60_000;
  if (mins < 60) return `${mins.toFixed(0)} min`;
  return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('\n=== Gradle per-test benchmark ===');
console.log(`Project: ${PROJECT}`);
console.log(`Tests:   ${TESTS.length} (running each once)\n`);

console.log('[ A ] Current: --no-daemon, 2 invocations');
const timesA = runCurrentApproach(TESTS);

console.log('\n[ B ] Opt-1inv: --no-daemon, 1 invocation (finalizedBy)');
const timesB = runSingleInvocationApproach(TESTS);

console.log('\n[ C ] Opt-daemon: --daemon isolated cache, 2 invocations');
const timesC = runDaemonApproach(TESTS);

console.log('\n[ D ] Opt-both: --daemon isolated cache, 1 invocation');
const timesD = runDaemonSingleInvocationApproach(TESTS);

const PROJECTED_TESTS = 5000;

console.log('\n=== Results ===');
console.log('');
console.log(`${'Approach'.padEnd(40)} ${'Avg/test'.padEnd(12)} ${'vs A'.padEnd(10)} Projected (${PROJECTED_TESTS} tests, concurrency=2)`);
console.log('─'.repeat(95));

const rows = [
  { label: 'A  Current (--no-daemon, 2 invocations)', times: timesA },
  { label: 'B  Single invocation (--no-daemon)', times: timesB },
  { label: 'C  Daemon reuse (2 invocations)', times: timesC },
  { label: 'D  Daemon + single invocation (best case)', times: timesD },
];

const baseAvg = avg(timesA);
for (const { label, times } of rows) {
  const a = avg(times);
  const ratio = a / baseAvg;
  const proj = projectedMinutes(a / 2, PROJECTED_TESTS); // /2 for concurrency=2
  console.log(`${label.padEnd(40)} ${(a / 1000).toFixed(2).padStart(6)}s      ${(ratio * 100).toFixed(0).padStart(4)}%   ${proj}`);
}

console.log('');
console.log('Note: First test in daemon approaches includes JVM startup; subsequent are warm.');
console.log(`      Per-test times after the first invocation:`);
for (const { label, times } of rows) {
  if (times.length > 1) {
    const warmAvg = avg(times.slice(1));
    console.log(`        ${label.slice(0, 35).padEnd(35)} warm avg: ${(warmAvg / 1000).toFixed(2)}s`);
  }
}
