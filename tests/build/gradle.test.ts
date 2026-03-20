import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execFileSync, execFile } from 'child_process';
import { gradleRunner, _resetSession } from '../../src/build/runners/gradle.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);

// Minimal Surefire XML for a JUnit 5 test
const SUREFIRE_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FormatterTest" tests="2" skipped="1">
  <testcase name="shouldFormatDate" classname="com.example.FormatterTest" time="0.1"/>
  <testcase name="shouldHandleNull" classname="com.example.FormatterTest" time="0.05">
    <failure message="expected null"/>
  </testcase>
  <testcase name="skippedTest" classname="com.example.FormatterTest" time="0.0">
    <skipped/>
  </testcase>
</testsuite>`;

// Minimal Surefire XML for a KoTest spec
const SUREFIRE_KOTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.CalculatorSpec" tests="1">
  <testcase name="Calculator - should add two numbers" classname="com.example.CalculatorSpec" time="0.2"/>
</testsuite>`;

// Minimal JaCoCo XML
const JACOCO_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<report name="test">
  <package name="com/example">
    <class name="com/example/Formatter" sourcefilename="Formatter.kt">
      <method name="formatDate" desc="()V" line="5">
        <counter type="METHOD" missed="0" covered="1"/>
      </method>
    </class>
    <sourcefile name="Formatter.kt">
      <line nr="5" mi="0" ci="3" mb="0" cb="0"/>
      <line nr="6" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-unit-'));
  vi.clearAllMocks();
  _resetSession();
  // Default: execFileSync does nothing (gradle test run)
  mockExecFileSync.mockReturnValue('');
  // Default: execFile resolves immediately
  mockExecFile.mockImplementation((_p, _a, _o, cb) => {
    setImmediate(() => (cb as (e: null) => void)(null));
    return undefined as unknown as ReturnType<typeof execFile>;
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Write fake Surefire XML files at the expected path
function writeSurefireXml(projectRoot: string, module: string, filename: string, content: string) {
  const dir = path.join(projectRoot, module, 'build', 'test-results', 'test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

// Write fake JaCoCo XML at the path the init script would produce
function writeJacocoXml(baseDir: string, moduleName: string, content: string) {
  const dir = path.join(baseDir, moduleName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jacoco.xml'), content);
}

describe('gradleRunner.discover', () => {
  it('returns TestCase for each non-skipped testcase in Surefire XML', async () => {
    // Set up a minimal multi-module project
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeSurefireXml(root, 'application', 'TEST-com.example.FormatterTest.xml', SUREFIRE_JUNIT);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    // shouldFormatDate + shouldHandleNull (failing tests are included), skipped is excluded
    expect(cases).toHaveLength(2);
    expect(cases.map(c => c.title)).toContain('shouldFormatDate');
    expect(cases.map(c => c.title)).toContain('shouldHandleNull');
    expect(cases.map(c => c.title)).not.toContain('skippedTest');
  });

  it('sets filePath to module directory', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeSurefireXml(root, 'application', 'TEST-com.example.FormatterTest.xml', SUREFIRE_JUNIT);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases[0].filePath).toBe(path.join(root, 'application'));
  });

  it('sets describePath to class name', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeSurefireXml(root, 'application', 'TEST-com.example.FormatterTest.xml', SUREFIRE_JUNIT);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases[0].describePath).toBe('com.example.FormatterTest');
  });

  it('handles KoTest display names with spaces', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":api")');
    writeSurefireXml(root, 'api', 'TEST-com.example.CalculatorSpec.xml', SUREFIRE_KOTEST);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('Calculator - should add two numbers');
  });

  it('filters by module name when fileFilter is provided', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":api", ":application")');
    writeSurefireXml(root, 'application', 'TEST-com.example.FormatterTest.xml', SUREFIRE_JUNIT);
    writeSurefireXml(root, 'api', 'TEST-com.example.CalculatorSpec.xml', SUREFIRE_KOTEST);

    const cases = await gradleRunner.discover(root, 'api', undefined);
    expect(cases.every(c => String(c.filePath).includes('api'))).toBe(true);
    expect(cases.some(c => String(c.filePath).includes('application'))).toBe(false);
  });

  it('caches session state — init script written only once across multiple calls', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeSurefireXml(root, 'application', 'TEST-com.example.FormatterTest.xml', SUREFIRE_JUNIT);

    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    await gradleRunner.discover(root, undefined, undefined);
    const writesAfterFirst = writeSpy.mock.calls.filter(c => String(c[0]).includes('.init.gradle.kts')).length;

    await gradleRunner.discover(root, undefined, undefined);
    const writesAfterSecond = writeSpy.mock.calls.filter(c => String(c[0]).includes('.init.gradle.kts')).length;

    expect(writesAfterFirst).toBe(1);
    expect(writesAfterSecond).toBe(1); // no additional writes — session cached
    writeSpy.mockRestore();
  });
});

describe('gradleRunner.runOne', () => {
  it('writes coverage-final.json to workerDir', async () => {
    const root = path.join(tmpDir, 'project');
    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(root);
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    // Write fake JaCoCo XML that runOne would find
    writeJacocoXml(workerDir, 'application', JACOCO_XML);

    const tc = {
      filePath: path.join(root, 'application'),
      fullName: 'com.example.FormatterTest > shouldFormatDate',
      title: 'shouldFormatDate',
      describePath: 'com.example.FormatterTest',
    };

    await gradleRunner.runOne(tc, root, workerDir, undefined);
    expect(fs.existsSync(path.join(workerDir, 'coverage-final.json'))).toBe(true);
  });

  it('passes --tests with class.method format to gradle', async () => {
    const root = path.join(tmpDir, 'project');
    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(root);
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeJacocoXml(workerDir, 'application', JACOCO_XML);

    const tc = {
      filePath: path.join(root, 'application'),
      fullName: 'com.example.FormatterTest > shouldFormatDate',
      title: 'shouldFormatDate',
      describePath: 'com.example.FormatterTest',
    };

    await gradleRunner.runOne(tc, root, workerDir, undefined);

    const call = mockExecFile.mock.calls[0];
    const args = call[1] as string[];
    expect(args).toContain('--tests');
    const testsArgIdx = args.indexOf('--tests');
    expect(args[testsArgIdx + 1]).toBe('com.example.FormatterTest.shouldFormatDate');
  });

  it('escapes * and ? in test names', async () => {
    const root = path.join(tmpDir, 'project');
    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(root);
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeJacocoXml(workerDir, 'application', JACOCO_XML);

    const tc = {
      filePath: path.join(root, 'application'),
      fullName: 'com.example.FooTest > test with * wildcard',
      title: 'test with * wildcard',
      describePath: 'com.example.FooTest',
    };

    await gradleRunner.runOne(tc, root, workerDir, undefined);
    const args = mockExecFile.mock.calls[0][1] as string[];
    const testsIdx = args.indexOf('--tests');
    expect(args[testsIdx + 1]).toContain('\\*');
  });
});

describe('gradleRunner.aggregate', () => {
  it('writes coverage-final.json to aggregateDir', async () => {
    const root = path.join(tmpDir, 'project');
    const aggregateDir = path.join(tmpDir, 'aggregate');
    fs.mkdirSync(root);
    fs.mkdirSync(aggregateDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeJacocoXml(aggregateDir, 'application', JACOCO_XML);

    await gradleRunner.aggregate(root, aggregateDir, undefined);
    expect(fs.existsSync(path.join(aggregateDir, 'coverage-final.json'))).toBe(true);
  });

  it('emits a warning to stderr when no jacoco.xml found', async () => {
    const root = path.join(tmpDir, 'project');
    const aggregateDir = path.join(tmpDir, 'aggregate-empty');
    fs.mkdirSync(root);
    fs.mkdirSync(aggregateDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    // No jacoco.xml written — aggregateDir is empty

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await gradleRunner.aggregate(root, aggregateDir, undefined);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('no jacoco.xml'));
    stderrSpy.mockRestore();
  });
});
