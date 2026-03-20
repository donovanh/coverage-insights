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

/** Return all test source directories for the project and its submodules. */
function findTestSourceDirs(
  projectRoot: string,
  modules: string[],
): Array<{ dir: string; modulePath: string }> {
  const dirs: Array<{ dir: string; modulePath: string }> = [];
  const candidates = [
    path.join('src', 'test', 'java'),
    path.join('src', 'test', 'kotlin'),
    'test',
  ];
  for (const candidate of candidates) {
    const d = path.join(projectRoot, candidate);
    if (fs.existsSync(d)) dirs.push({ dir: d, modulePath: projectRoot });
  }
  for (const m of modules) {
    const modPath = moduleToPath(m, projectRoot);
    for (const candidate of candidates) {
      const d = path.join(modPath, candidate);
      if (fs.existsSync(d)) dirs.push({ dir: d, modulePath: modPath });
    }
  }
  return dirs;
}

/** Recursively collect all .java and .kt files under dir. */
function findSourceFiles(dir: string, results: string[] = []): string[] {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findSourceFiles(full, results);
      else if (entry.isFile() && (entry.name.endsWith('.java') || entry.name.endsWith('.kt')))
        results.push(full);
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

/** Parse @Test-annotated method names from a Java source file. */
function parseJavaTestFile(content: string, modulePath: string): TestCase[] {
  const packageMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
  const packageName  = packageMatch ? packageMatch[1] : '';
  const classMatch   = content.match(/(?:public\s+|abstract\s+|final\s+)*class\s+(\w+)/);
  if (!classMatch) return [];
  const fqcn = packageName ? `${packageName}.${classMatch[1]}` : classMatch[1];

  const testCases: TestCase[] = [];
  // Split on @Test / @ParameterizedTest / @RepeatedTest (with optional params).
  // Use \b so @TestMethodOrder etc. are not matched.
  const parts = content.split(/@(?:Test|ParameterizedTest|RepeatedTest)\b(?:\s*\([^)]*\))?/);
  for (let i = 1; i < parts.length; i++) {
    let text = parts[i];
    // Strip other annotations that may appear between @Test and the method signature
    text = text.replace(/@\w+(?:\s*\([^)]*\))?\s*/g, ' ');
    // Strip access/type modifiers so the first remaining word(+paren) is the method name
    text = text.replace(/\b(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|void)\b/g, ' ');
    const m = text.match(/\b(\w+)\s*\(/);
    if (m && m[1] !== 'class' && m[1] !== 'new') {
      testCases.push({
        filePath:    modulePath,
        fullName:    `${fqcn} > ${m[1]}`,
        title:       m[1],
        describePath: fqcn,
      });
    }
  }
  return testCases;
}

/** Parse test names from a Kotlin test file (JUnit5 @Test and KoTest DSL). */
function parseKotlinTestFile(content: string, modulePath: string): TestCase[] {
  const packageMatch = content.match(/^\s*package\s+([\w.]+)/m);
  const packageName  = packageMatch ? packageMatch[1] : '';
  const classMatch   = content.match(/class\s+(\w+)/);
  if (!classMatch) return [];
  const fqcn = packageName ? `${packageName}.${classMatch[1]}` : classMatch[1];

  const testCases: TestCase[] = [];

  // JUnit5-style: @Test before a fun declaration (including backtick names)
  const annotatedParts = content.split(/@(?:Test|ParameterizedTest|RepeatedTest)\b(?:\s*\([^)]*\))?/);
  for (let i = 1; i < annotatedParts.length; i++) {
    let text = annotatedParts[i];
    text = text.replace(/@\w+(?:\s*\([^)]*\))?\s*/g, ' ');
    // Backtick name: fun `some description`()
    const btMatch = text.match(/fun\s+`([^`]+)`/);
    if (btMatch) {
      testCases.push({ filePath: modulePath, fullName: `${fqcn} > ${btMatch[1]}`, title: btMatch[1], describePath: fqcn });
      continue;
    }
    // Plain name: fun testSomething()
    const plainMatch = text.match(/fun\s+(\w+)\s*\(/);
    if (plainMatch) {
      testCases.push({ filePath: modulePath, fullName: `${fqcn} > ${plainMatch[1]}`, title: plainMatch[1], describePath: fqcn });
    }
  }

  // KoTest DSL: "test name" { ... } or it("test name") / should("test name") / then("test name") etc.
  // Matches string-literal test names passed to common KoTest DSL methods.
  const kotestDsl = /\b(?:it|test|should|then|context|describe|given|when|expect|and)\s*\(\s*"([^"]+)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = kotestDsl.exec(content)) !== null) {
    const title = match[1];
    testCases.push({ filePath: modulePath, fullName: `${fqcn} > ${title}`, title, describePath: fqcn });
  }

  // KoTest StringSpec / FreeSpec bare string blocks: "test name" { }
  const bareString = /"([^"]+)"\s*\{/g;
  while ((match = bareString.exec(content)) !== null) {
    const title = match[1];
    // Avoid duplicating tests already caught by the DSL pattern above
    if (!testCases.some(tc => tc.title === title && tc.describePath === fqcn)) {
      testCases.push({ filePath: modulePath, fullName: `${fqcn} > ${title}`, title, describePath: fqcn });
    }
  }

  return testCases;
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
  // Gradle incurs JVM startup overhead per test; keep concurrency low by default.
  defaultConcurrency: 2,

  async discover(projectRoot, fileFilter, _configPath) {
    ensureSession(projectRoot);
    const modules    = parseModules(projectRoot);
    const sourceDirs = findTestSourceDirs(projectRoot, modules);
    const testCases: TestCase[] = [];
    for (const { dir, modulePath } of sourceDirs) {
      if (fileFilter && !modulePath.includes(fileFilter)) continue;
      for (const file of findSourceFiles(dir)) {
        const content = fs.readFileSync(file, 'utf8');
        const parsed  = file.endsWith('.kt')
          ? parseKotlinTestFile(content, modulePath)
          : parseJavaTestFile(content, modulePath);
        testCases.push(...parsed);
      }
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
      '--no-daemon',
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
        '--no-daemon',
        '--rerun-tasks',
        '--init-script', initScript,
        `-Pcoverage.insights.xmlDir=${aggregateDir}`,
      ], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* test failures OK */ }

    mergeJacocoDir(aggregateDir, projectRoot);

    // Kill any stray daemons from previous runs as a safety net. Best-effort.
    try {
      execFileSync(gradleCmd, ['--stop'], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* ignore */ }
  },
};
