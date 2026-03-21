/**
 * Gradle per-test performance benchmark.
 *
 * Baseline is the current implementation: --daemon with isolated project-cache-dir,
 * single invocation (jacocoTestReport via finalizedBy), upToDateWhen{false} on test task.
 *
 * This round investigates two high-impact approaches:
 *   A. Baseline:      current implementation
 *   B. No-coverage:   test only, JaCoCo agent + report both disabled — absolute floor
 *   C. Agent-only:    JaCoCo agent writes .exec, jacocoTestReport disabled — quantifies report overhead
 *   D. Tooling API:   persistent JVM sidecar, eliminates gradlew client JVM spawn per test
 *
 * Run with:
 *   npx tsx tests/bench/gradle-bench.ts
 *
 * Requires Java and the fixture project's gradlew to be functional.
 * The sidecar JAR must be pre-built: run `gradlew -p tests/bench/tooling-sidecar shadowJar`
 */

import { execFileSync, spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PROJECT     = path.resolve('tests/fixtures/gradle-project');
const GRADLEW     = path.join(PROJECT, 'gradlew');
const SIDECAR_JAR = path.resolve('tests/bench/tooling-sidecar/build/libs/sidecar.jar');

// ── Init scripts ─────────────────────────────────────────────────────────────

// A/B/C: CLI approaches — upToDateWhen{false}, jacoco report via finalizedBy (already in build.gradle.kts)
const BASE_SCRIPT = `
allprojects {
    tasks.withType<Test> {
        outputs.upToDateWhen { false }
    }
}
`;

// D: Tooling API init script — uses project properties for test filtering (--tests is CLI-only)
const TOOLING_API_SCRIPT = `
allprojects {
    tasks.withType<Test> {
        outputs.upToDateWhen { false }
        val testClass  = providers.gradleProperty("coverage.insights.testClass").orNull
        val testMethod = providers.gradleProperty("coverage.insights.testMethod").orNull
        if (testClass != null) {
            filter {
                includeTest(testClass, testMethod)
                isFailOnNoMatchingTests = false
            }
        }
    }
}
`;

// B: disable both JaCoCo agent and report — absolute floor (pure test execution)
const NO_COVERAGE_SCRIPT = `
allprojects {
    tasks.withType<Test> {
        outputs.upToDateWhen { false }
        extensions.findByType<JacocoTaskExtension>()?.isEnabled = false
    }
    tasks.withType<JacocoReport> { enabled = false }
}
`;

// C: keep JaCoCo agent (exec written), disable jacocoTestReport — quantifies report task overhead
const AGENT_ONLY_SCRIPT = `
allprojects {
    tasks.withType<Test> {
        outputs.upToDateWhen { false }
        // JaCoCo agent stays enabled — writes .exec at JVM shutdown
    }
    tasks.withType<JacocoReport> { enabled = false }
}
`;

// ── Tests to benchmark ───────────────────────────────────────────────────────

const TESTS: Array<{ module: string; filter: string; testClass: string; testMethod: string; label: string }> = [
  { module: ':application', filter: 'com.example.app.FormatterTest.should format date',                         testClass: 'com.example.app.FormatterTest',   testMethod: 'should format date',                          label: 'Formatter/formatDate'  },
  { module: ':application', filter: 'com.example.app.FormatterTest.should format name',                         testClass: 'com.example.app.FormatterTest',   testMethod: 'should format name',                          label: 'Formatter/formatName'  },
  { module: ':application', filter: 'com.example.app.StringUtilsTest.truncate short string unchanged',          testClass: 'com.example.app.StringUtilsTest', testMethod: 'truncate short string unchanged',              label: 'StringUtils/truncate'  },
  { module: ':application', filter: 'com.example.app.StringUtilsTest.isPalindrome returns true for palindrome', testClass: 'com.example.app.StringUtilsTest', testMethod: 'isPalindrome returns true for palindrome',     label: 'StringUtils/isPalin'   },
  { module: ':application', filter: 'com.example.app.MathUtilsTest.clamp returns value when in range',          testClass: 'com.example.app.MathUtilsTest',   testMethod: 'clamp returns value when in range',            label: 'MathUtils/clamp'       },
  { module: ':application', filter: 'com.example.app.MathUtilsTest.isPrime returns true for prime',             testClass: 'com.example.app.MathUtilsTest',   testMethod: 'isPrime returns true for prime',               label: 'MathUtils/isPrime'     },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function gradle(args: string[]): void {
  execFileSync(GRADLEW, args, {
    cwd: PROJECT, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function makeTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ci-bench-${label}-`));
}

function writeInitScript(content: string, label: string): string {
  const p = path.join(os.tmpdir(), `ci-bench-init-${label}.gradle.kts`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ── Approach runner (gradlew subprocess per test) ────────────────────────────

function runApproach(label: string, scriptContent: string, tests: typeof TESTS): number[] {
  const cacheDir   = makeTmpDir(`${label}-cache`);
  const initScript = writeInitScript(scriptContent, label);
  const times: number[] = [];
  try {
    for (const t of tests) {
      const workerDir = makeTmpDir(label);
      const start = process.hrtime.bigint();
      try {
        gradle([
          `${t.module}:test`, '--tests', t.filter,
          '--daemon', '--no-build-cache', '--init-script', initScript,
          `--project-cache-dir=${cacheDir}`,
          `-Pcoverage.insights.xmlDir=${workerDir}`,
        ]);
      } catch { /* test failures ok */ }
      times.push(ms(start));
      fs.rmSync(workerDir, { recursive: true, force: true });
      process.stdout.write(`  ${label}  ${t.label.padEnd(32)} ${(times.at(-1)! / 1000).toFixed(1)}s\n`);
    }
  } finally {
    try { gradle(['--stop', `--project-cache-dir=${cacheDir}`]); } catch { /* ok */ }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  return times;
}

// ── Approach D: Tooling API sidecar (persistent JVM, no per-test process spawn) ─

async function runToolingApi(tests: typeof TESTS): Promise<number[]> {
  const cacheDir   = makeTmpDir('D-cache');
  const initScript = writeInitScript(TOOLING_API_SCRIPT, 'D');

  const sidecar = spawn('java', ['-jar', SIDECAR_JAR, PROJECT], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Wait for the sidecar to signal it's ready
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: sidecar.stdout! });
    rl.once('line', line => { rl.close(); if (line === 'ready') resolve(); else reject(new Error(`Bad ready: ${line}`)); });
    sidecar.once('error', reject);
  });

  // Set up a simple request→response queue over the persistent stdout stream
  const rl = readline.createInterface({ input: sidecar.stdout! });
  const pending: Array<(line: string) => void> = [];
  rl.on('line', line => pending.shift()!(line));

  const sendRequest = (req: object): Promise<{ ok: boolean; ms: number }> =>
    new Promise(resolve => {
      pending.push(line => resolve(JSON.parse(line)));
      sidecar.stdin!.write(JSON.stringify(req) + '\n');
    });

  const times: number[] = [];
  try {
    for (const t of tests) {
      const workerDir = makeTmpDir('D');
      const start = process.hrtime.bigint();
      await sendRequest({ module: t.module, testClass: t.testClass, testMethod: t.testMethod, workerDir, cacheDir, initScript });
      times.push(ms(start));
      fs.rmSync(workerDir, { recursive: true, force: true });
      process.stdout.write(`  D  ${t.label.padEnd(32)} ${(times.at(-1)! / 1000).toFixed(1)}s\n`);
    }
  } finally {
    sidecar.stdin!.write('quit\n');
    rl.close();
    await new Promise(r => sidecar.once('close', r));
    try { gradle(['--stop', `--project-cache-dir=${cacheDir}`]); } catch { /* ok */ }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  return times;
}

// ── Output helpers ────────────────────────────────────────────────────────────

function avg(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function projectedMinutes(avgMs: number, n: number): string {
  const mins = (avgMs * n) / 60_000;
  if (mins < 60) return `${mins.toFixed(0)} min`;
  return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(SIDECAR_JAR)) {
    console.error(`\nSidecar JAR not found at ${SIDECAR_JAR}`);
    console.error('Build it first: ./tests/fixtures/gradle-project/gradlew -p tests/bench/tooling-sidecar shadowJar\n');
    process.exit(1);
  }

  console.log('\n=== Gradle per-test benchmark ===');
  console.log(`Project: ${PROJECT}`);
  console.log(`Tests:   ${TESTS.length} (running each once)\n`);

  console.log('[ A ] Baseline: current implementation (daemon + upToDateWhen init script)');
  const timesA = runApproach('A', BASE_SCRIPT, TESTS);

  console.log('\n[ B ] No-coverage floor: JaCoCo agent + report both disabled');
  const timesB = runApproach('B', NO_COVERAGE_SCRIPT, TESTS);

  console.log('\n[ C ] Agent-only: JaCoCo agent enabled, jacocoTestReport disabled');
  const timesC = runApproach('C', AGENT_ONLY_SCRIPT, TESTS);

  console.log('\n[ D ] Tooling API: persistent sidecar JVM, no gradlew spawn per test');
  const timesD = await runToolingApi(TESTS);

  const PROJECTED_TESTS = 5000;

  console.log('\n=== Results ===');
  console.log('');
  console.log(`${'Approach'.padEnd(48)} ${'Avg/test'.padEnd(12)} ${'vs A'.padEnd(10)} Projected (${PROJECTED_TESTS} tests, concurrency=2)`);
  console.log('─'.repeat(103));

  const rows = [
    { label: 'A  Baseline (current)',                              times: timesA },
    { label: 'B  No coverage (absolute floor)',                    times: timesB },
    { label: 'C  Agent only, no jacocoTestReport',                 times: timesC },
    { label: 'D  Tooling API (persistent sidecar)',                times: timesD },
  ];

  const baseAvg = avg(timesA);
  for (const { label, times } of rows) {
    const a   = avg(times);
    const ratio = a / baseAvg;
    const proj  = projectedMinutes(a / 2, PROJECTED_TESTS);
    console.log(`${label.padEnd(48)} ${(a / 1000).toFixed(2).padStart(6)}s      ${(ratio * 100).toFixed(0).padStart(4)}%   ${proj}`);
  }

  console.log('');
  console.log('Note: First test in daemon approaches includes JVM startup; subsequent are warm.');
  console.log('      Warm averages (after first invocation):');
  for (const { label, times } of rows) {
    if (times.length > 1) {
      const warmAvg = avg(times.slice(1));
      console.log(`        ${label.slice(0, 43).padEnd(43)} warm avg: ${(warmAvg / 1000).toFixed(2)}s`);
    }
  }
})();
