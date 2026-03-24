import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Runner, TestCase } from '../index.js';
import { parseModules, moduleToPath, pathToModule, findGradleCommand } from './gradle/settings.js';
import { parseJacocoXml, mergeIstanbulMaps } from './gradle/jacoco.js';
import { generateInitScript, detectJacoco } from './gradle/init-script.js';

// Session state — initialised lazily by whichever method is called first
let _gradleCmd: string | undefined;
let _initScriptPath: string | undefined;
let _daemonCacheDir: string | undefined;

/** For testing only — reset session state between tests. */
export function _resetSession(): void {
  _gradleCmd = undefined;
  _initScriptPath = undefined;
  _daemonCacheDir = undefined;
}

function ensureSession(projectRoot: string): void {
  if (_gradleCmd && _initScriptPath) return;
  _gradleCmd = findGradleCommand(projectRoot);
  // Clear any stale daemons from previous interrupted runs before starting.
  try {
    execFileSync(_gradleCmd, ['--stop'], { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* no daemons running is fine */ }
  const modules = parseModules(projectRoot).map(m => moduleToPath(m, projectRoot));
  const needsInjection = !detectJacoco(projectRoot, modules);
  const script = generateInitScript(needsInjection);
  _initScriptPath = path.join(os.tmpdir(), `coverage-insights-${process.pid}.init.gradle.kts`);
  fs.writeFileSync(_initScriptPath, script, 'utf8');
  _daemonCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-insights-gradle-'));
}

function escapeTestName(name: string): string {
  return name.replace(/\*/g, '\\*').replace(/\?/g, '\\?');
}
// Note: parentheses in parameterised test names (e.g. myTest(param)) are not escaped
// — Gradle may match the whole test class in those cases, which is an acceptable over-approximation.

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

interface ParsedJavaClass {
  fqcn:        string;
  packageName: string;
  isAbstract:  boolean;
  extendsName: string | null;  // simple class name only
  imports:     string[];       // fully-qualified import names
  ownTests:    string[];       // @Test method names found directly in this file
  modulePath:  string;
}

/** Parse structural information + @Test methods from a Java source file. */
function parseJavaClass(content: string, modulePath: string): ParsedJavaClass | null {
  // Strip comments and string literals to avoid false positives.
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

  const packageMatch = stripped.match(/^\s*package\s+([\w.]+)\s*;/m);
  const packageName  = packageMatch ? packageMatch[1] : '';

  // Capture class name
  const classMatch = stripped.match(/(?:\w+\s+)*class\s+(\w+)/);
  if (!classMatch) return null;
  const simpleClass = classMatch[1];
  // Check for 'abstract' anywhere in the class declaration (before the opening brace)
  const classPos   = stripped.indexOf(classMatch[0]);
  const bodyStart  = stripped.indexOf('{', classPos);
  const header     = stripped.slice(Math.max(0, classPos - 50), bodyStart >= 0 ? bodyStart : classPos + 80);
  const isAbstract = /\babstract\b/.test(header);
  const fqcn          = packageName ? `${packageName}.${simpleClass}` : simpleClass;

  // extends clause — allow it to be on a different line from `class`
  const extendsMatch  = stripped.match(/\bclass\s+\w+[^{]*?\bextends\s+(\w+)/s);
  const extendsName   = extendsMatch ? extendsMatch[1] : null;

  // import statements
  const imports: string[] = [];
  for (const m of stripped.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm))
    imports.push(m[1]);

  // @Test method names
  const ownTests: string[] = [];
  const parts = stripped.split(/@(?:Test|ParameterizedTest|RepeatedTest)\b(?:\s*\([^)]*\))?/);
  for (let i = 1; i < parts.length; i++) {
    let text = parts[i];
    text = text.replace(/@\w+(?:\s*\([^)]*\))?\s*/g, ' ');
    text = text.replace(/\b(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|void)\b/g, ' ');
    const m = text.match(/\b(\w+)\s*\(/);
    if (m && m[1] !== 'class' && m[1] !== 'new') ownTests.push(m[1]);
  }

  return { fqcn, packageName, isAbstract, extendsName, imports, ownTests, modulePath };
}

/** Resolve simple parent class name to FQCN using imports + same-package fallback. */
function resolveParentFqcn(child: ParsedJavaClass, simpleName: string): string | null {
  const imported = child.imports.find(i => i === simpleName || i.endsWith(`.${simpleName}`));
  if (imported) return imported;
  return child.packageName ? `${child.packageName}.${simpleName}` : simpleName;
}

/** Collect all @Test titles reachable from fqcn, walking up the inheritance chain. */
function collectAllTests(
  fqcn: string,
  byFqcn: Map<string, ParsedJavaClass>,
  visited = new Set<string>(),
): string[] {
  if (visited.has(fqcn)) return [];
  visited.add(fqcn);
  const cls = byFqcn.get(fqcn);
  if (!cls) return [];
  const parentTests = cls.extendsName
    ? collectAllTests(resolveParentFqcn(cls, cls.extendsName) ?? '', byFqcn, visited)
    : [];
  // Child overrides parent: deduplicate title-first (child wins)
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of [...cls.ownTests, ...parentTests]) {
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  }
  return result;
}

/** Resolve inheritance and emit TestCase[] for all parsed Java classes. */
function resolveJavaTestCases(classes: ParsedJavaClass[]): TestCase[] {
  const byFqcn = new Map(classes.map(c => [c.fqcn, c]));

  // Track which abstract classes have at least one concrete subclass anywhere in the scan.
  // Walk the full ancestor chain from each concrete class so grandparents are included.
  const abstractsWithConcrete = new Set<string>();
  for (const cls of classes) {
    if (!cls.isAbstract) {
      let current: ParsedJavaClass | undefined = cls;
      const visited = new Set<string>();
      while (current?.extendsName) {
        const parentFqcn = resolveParentFqcn(current, current.extendsName);
        if (!parentFqcn || visited.has(parentFqcn)) break;
        visited.add(parentFqcn);
        const parent = byFqcn.get(parentFqcn);
        if (!parent) break;
        abstractsWithConcrete.add(parentFqcn);
        current = parent;
      }
    }
  }

  const testCases: TestCase[] = [];
  for (const cls of classes) {
    // Abstract classes whose tests will be emitted via concrete subclasses — skip directly
    if (cls.isAbstract && abstractsWithConcrete.has(cls.fqcn)) continue;

    const titles = cls.isAbstract
      ? cls.ownTests  // fallback: abstract with no known concrete subclass
      : collectAllTests(cls.fqcn, byFqcn);

    for (const title of titles) {
      testCases.push({
        filePath:    cls.modulePath,
        fullName:    `${cls.fqcn} > ${title}`,
        title,
        describePath: cls.fqcn,
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

function scanJacocoXml(dir: string): string[] {
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
  return xmlFiles;
}

/** Full Istanbul conversion — used by both runOne() and aggregate(). */
function mergeJacocoDir(dir: string, projectRoot: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const xmlFiles = scanJacocoXml(dir);

  if (xmlFiles.length === 0) {
    process.stderr.write(`  coverage-insights: no jacoco.xml found in ${dir} — coverage will be empty\n`);
    fs.writeFileSync(path.join(dir, 'coverage-final.json'), '{}', 'utf8');
    return;
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
    const testCases: TestCase[]        = [];
    const javaClasses: ParsedJavaClass[] = [];

    for (const { dir, modulePath } of sourceDirs) {
      for (const file of findSourceFiles(dir)) {
        if (fileFilter && !modulePath.includes(fileFilter) && !file.includes(fileFilter)) continue;
        const content = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.kt')) {
          testCases.push(...parseKotlinTestFile(content, modulePath));
        } else {
          const parsed = parseJavaClass(content, modulePath);
          if (parsed) javaClasses.push(parsed);
        }
      }
    }

    testCases.push(...resolveJavaTestCases(javaClasses));
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

    // Use ':' prefix for root project to scope to root only — without it, Gradle
    // applies --tests to all submodule test tasks too, which fail with "No tests found".
    const taskPrefix = gradleModule ? `${gradleModule}:` : ':';
    const testArgs = [
      `${taskPrefix}test`,
      '--tests', testFilter,
      '--no-daemon',
      '--init-script', initScript,
      `-Pcoverage.insights.xmlDir=${workerDir}`,
    ];

    await new Promise<void>((resolve, reject) => {
      execFile(gradleCmd, testArgs, { cwd: projectRoot, maxBuffer: 50 * 1024 * 1024 }, err => {
        if (err) reject(err); else resolve();
      });
    });

    // Convert JaCoCo XML(s) produced by jacocoTestReport into coverage-final.json.
    mergeJacocoDir(workerDir, projectRoot);
  },

  async runAll(projectRoot: string, workDir: string, testCases?: TestCase[]): Promise<void> {
    ensureSession(projectRoot);
    const gradleCmd  = _gradleCmd!;
    const initScript = _initScriptPath!;
    fs.mkdirSync(workDir, { recursive: true });
    // Write filter file so batchConvert only processes the discovered test subset.
    if (testCases && testCases.length > 0) {
      const filterNames = testCases.map(tc =>
        (tc.describePath + '.' + tc.title).replace(/[^a-zA-Z0-9._-]/g, '_'),
      );
      fs.writeFileSync(path.join(workDir, '.ci-filter.txt'), filterNames.join('\n'), 'utf8');
    }
    // PID-based port avoids conflicts if two coverage-insights processes run simultaneously.
    const port = 6300 + (process.pid % 1000);
    await new Promise<void>(resolve => {
      execFile(gradleCmd, [
        ':test',
        '--no-daemon',
        '--init-script', initScript,
        `-Pcoverage.insights.pertest.dir=${workDir}`,
        `-Pcoverage.insights.pertest.port=${port}`,
      ], { cwd: projectRoot, maxBuffer: 50 * 1024 * 1024 }, () => resolve()); // swallow errors — test failures OK
    });
    // batchConvert runs inline in the Gradle process via the TestListener's afterSuite hook,
    // writing per-test JSON files to workDir. No second Gradle invocation needed.
  },

  async aggregate(projectRoot, aggregateDir, _configPath) {
    ensureSession(projectRoot);
    const gradleCmd = _gradleCmd!;
    const initScript = _initScriptPath!;

    // Unqualified task names intentionally run across all subprojects.
    // aggregate does not scope by module — it always covers the whole project.
    fs.mkdirSync(aggregateDir, { recursive: true });
    try {
      execFileSync(gradleCmd, [
        'test', 'jacocoTestReport',
        '--continue',
        '--daemon',
        '--rerun-tasks',
        `--project-cache-dir=${_daemonCacheDir}`,
        '--init-script', initScript,
        `-Pcoverage.insights.xmlDir=${aggregateDir}`,
      ], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* test failures OK */ }

    mergeJacocoDir(aggregateDir, projectRoot);

    // Stop daemons and clean up the session cache dir.
    try {
      execFileSync(gradleCmd, ['--stop', `--project-cache-dir=${_daemonCacheDir}`], {
        cwd: projectRoot, encoding: 'utf8', stdio: 'pipe',
      });
    } catch { /* ignore */ }
    if (_daemonCacheDir) {
      fs.rmSync(_daemonCacheDir, { recursive: true, force: true });
      _daemonCacheDir = undefined;
    }
  },
};
