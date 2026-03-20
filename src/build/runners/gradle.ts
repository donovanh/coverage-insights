import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { Runner, TestCase } from '../index.js';
import { parseModules, moduleToPath, pathToModule, findGradleCommand } from './gradle/settings.js';
import { parseJacocoXml, mergeIstanbulMaps } from './gradle/jacoco.js';
import { generateInitScript, detectJacoco } from './gradle/init-script.js';

// Session state — initialised lazily by whichever method is called first
let _gradleCmd: string | undefined;
let _initScriptPath: string | undefined;

/** For testing only — reset session state between tests. */
export function _resetSession(): void {
  _gradleCmd = undefined;
  _initScriptPath = undefined;
}

function ensureSession(projectRoot: string): void {
  if (_gradleCmd && _initScriptPath) return;
  _gradleCmd = findGradleCommand(projectRoot);
  const modules = parseModules(projectRoot).map(m => moduleToPath(m, projectRoot));
  const needsInjection = !detectJacoco(projectRoot, modules);
  const script = generateInitScript(needsInjection);
  _initScriptPath = path.join(os.tmpdir(), `coverage-insights-${process.pid}.init.gradle.kts`);
  fs.writeFileSync(_initScriptPath, script, 'utf8');
}

function escapeTestName(name: string): string {
  return name.replace(/\*/g, '\\*').replace(/\?/g, '\\?');
}
// Note: parentheses in parameterised test names (e.g. myTest(param)) are not escaped
// — Gradle may match the whole test class in those cases, which is an acceptable over-approximation.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', entityExpansionLimit: Number.MAX_SAFE_INTEGER } as any);

interface SuiteXml {
  testsuite?: {
    '@_name': string;
    testcase?: TestcaseXml | TestcaseXml[];
  };
}
interface TestcaseXml {
  '@_name': string;
  '@_classname'?: string;
  skipped?: unknown;
}

function parseSurefireXml(content: string, modulePath: string): TestCase[] {
  const doc = xmlParser.parse(content) as SuiteXml;
  const suite = doc.testsuite;
  if (!suite) return [];
  const className = suite['@_name'];
  const raw = suite.testcase;
  const cases = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return cases
    .filter(tc => tc.skipped === undefined)
    .map(tc => {
      // JUnit 5 appends "()" to method names in Surefire XML (e.g. "should format date()").
      // Gradle's --tests filter does not accept the trailing parens, so strip them here.
      const rawName = tc['@_name'];
      const title = rawName.endsWith('()') ? rawName.slice(0, -2) : rawName;
      return {
        filePath:    modulePath,
        fullName:    `${tc['@_classname'] ?? className} > ${title}`,
        title,
        describePath: tc['@_classname'] ?? className,
      };
    });
}

function findSurefireXml(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '.gradle' && entry.name !== '.git') {
        results.push(...findSurefireXml(full));
      } else if (entry.isFile() && entry.name.startsWith('TEST-') && entry.name.endsWith('.xml')
        && dir.includes(path.join('build', 'test-results'))) {
        results.push(full);
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

function modulePathFromXml(xmlPath: string): string {
  const marker = path.join('build', 'test-results');
  const idx = xmlPath.indexOf(marker);
  return idx >= 0 ? xmlPath.slice(0, idx - 1) : path.dirname(xmlPath);
}

function mergeJacocoDir(dir: string, projectRoot: string): void {
  const xmlFiles: string[] = [];
  function scan(d: string) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) scan(full);
        else if (e.isFile() && e.name === 'jacoco.xml') xmlFiles.push(full);
      }
    } catch { /* ignore */ }
  }
  scan(dir);

  if (xmlFiles.length === 0) {
    process.stderr.write(`  coverage-insights: no jacoco.xml found in ${dir} — aggregate coverage will be empty\n`);
  }

  const maps = xmlFiles.map(f => {
    // <dir>/<moduleRelPath>/jacoco.xml — derive real source path from relative module path
    const moduleRelPath = path.relative(dir, path.dirname(f));
    const realModulePath = path.join(projectRoot, moduleRelPath);
    return parseJacocoXml(fs.readFileSync(f, 'utf8'), realModulePath, projectRoot);
  });

  const merged = mergeIstanbulMaps(maps);
  fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify(merged), 'utf8');
}

export const gradleRunner: Runner = {
  async discover(projectRoot, fileFilter, _configPath) {
    ensureSession(projectRoot);
    const gradleCmd = _gradleCmd!;

    const modules = parseModules(projectRoot);
    // Detect whether the root project itself has test sources (e.g. projects that keep
    // tests at the root alongside submodules, rather than exclusively in submodules).
    const rootHasTests = fs.existsSync(path.join(projectRoot, 'test'))
                      || fs.existsSync(path.join(projectRoot, 'src', 'test'));
    let taskArgs: string[];
    if (modules.length === 0) {
      taskArgs = ['test'];
    } else {
      const filtered = fileFilter ? modules.filter(m => m.includes(fileFilter)) : modules;
      taskArgs = filtered.map(m => `${m}:test`);
      if (rootHasTests) {
        taskArgs = ['test', ...taskArgs];
      }
    }

    // Run cleanTest first to reset Gradle's incremental test tracking state.
    // Without this, after runOne() has run each test individually with --rerun-tasks,
    // Gradle considers all tests "passed recently" and skips them on the next plain `test` run.
    const cleanTasks = taskArgs.map(t => {
      const idx = t.lastIndexOf(':');
      const taskName = idx >= 0 ? t.slice(idx + 1) : t;
      const prefix   = idx >= 0 ? t.slice(0, idx + 1) : '';
      return `${prefix}clean${taskName.charAt(0).toUpperCase()}${taskName.slice(1)}`;
    });
    try {
      execFileSync(gradleCmd, [...cleanTasks, '--continue'], {
        cwd: projectRoot, encoding: 'utf8', stdio: 'pipe',
      });
    } catch { /* ignore clean failures */ }
    try {
      execFileSync(gradleCmd, [...taskArgs, '--continue'], {
        cwd: projectRoot, encoding: 'utf8', stdio: 'pipe',
      });
    } catch { /* test failures are OK — Surefire XML is still written */ }

    const xmlFiles = findSurefireXml(projectRoot);
    const testCases: TestCase[] = [];
    for (const f of xmlFiles) {
      const modulePath = modulePathFromXml(f);
      if (fileFilter && !modulePath.includes(fileFilter)) continue;
      const content = fs.readFileSync(f, 'utf8');
      testCases.push(...parseSurefireXml(content, modulePath));
    }
    return testCases;
  },

  async runOne(tc, projectRoot, workerDir, _configPath) {
    ensureSession(projectRoot);
    const gradleCmd = _gradleCmd!;
    const initScript = _initScriptPath!;

    // Clean up any stale jacoco.xml files from a previous test in this worker slot.
    // workerDir is reused across tests in the same worker; without this, mergeJacocoDir
    // would pick up XML from prior tests and contaminate coverage results.
    fs.rmSync(workerDir, { recursive: true, force: true });
    fs.mkdirSync(workerDir, { recursive: true });

    const gradleModule = pathToModule(tc.filePath as string, projectRoot);
    const testFilter = escapeTestName(`${tc.describePath}.${tc.title}`);

    const taskPrefix = gradleModule ? `${gradleModule}:` : '';
    // Run test and jacocoTestReport in separate invocations because --tests is
    // a Test-task-specific option and Gradle rejects it when applied to jacocoTestReport.
    const commonArgs = [
      '--rerun-tasks',
      '--init-script', initScript,
      `-Pcoverage.insights.xmlDir=${workerDir}`,
    ];
    const testArgs = [
      `${taskPrefix}test`,
      '--tests', testFilter,
      ...commonArgs,
    ];
    const reportArgs = [
      `${taskPrefix}jacocoTestReport`,
      ...commonArgs,
    ];

    await new Promise<void>((resolve, reject) => {
      execFile(gradleCmd, testArgs, { cwd: projectRoot, maxBuffer: 50 * 1024 * 1024 }, err => {
        if (err) reject(err); else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      execFile(gradleCmd, reportArgs, { cwd: projectRoot, maxBuffer: 50 * 1024 * 1024 }, err => {
        if (err) reject(err); else resolve();
      });
    });

    // Convert JaCoCo XML(s) in workerDir to coverage-final.json
    mergeJacocoDir(workerDir, projectRoot);
  },

  async aggregate(projectRoot, aggregateDir, _configPath) {
    ensureSession(projectRoot);
    const gradleCmd = _gradleCmd!;
    const initScript = _initScriptPath!;

    // Unqualified task names intentionally run across all subprojects.
    // aggregate does not scope by module — it always covers the whole project.
    try {
      execFileSync(gradleCmd, [
        'test', 'jacocoTestReport',
        '--continue',
        '--rerun-tasks',
        '--init-script', initScript,
        `-Pcoverage.insights.xmlDir=${aggregateDir}`,
      ], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* test failures OK */ }

    mergeJacocoDir(aggregateDir, projectRoot);
  },
};
