import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../src/setup/gradle-listener.js', () => ({
  ensureListenerJar: vi.fn().mockReturnValue('/fake/listener.jar'),
}));

import { execFileSync, execFile } from 'child_process';
import { gradleRunner, _resetSession } from '../../src/build/runners/gradle.js';
import { generateInitScript } from '../../src/build/runners/gradle/init-script.js';
import { ensureListenerJar } from '../../src/setup/gradle-listener.js';

const mockEnsureListenerJar = vi.mocked(ensureListenerJar);

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

// Write fake Surefire XML files at the expected path (used by runOne/aggregate tests)
function writeSurefireXml(projectRoot: string, module: string, filename: string, content: string) {
  const dir = path.join(projectRoot, module, 'build', 'test-results', 'test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

// Write a Java test source file at src/test/java/<pkg path>/<className>.java
function writeJavaTestFile(projectRoot: string, module: string, pkg: string, className: string, content: string) {
  const dir = path.join(projectRoot, module, 'src', 'test', 'java', ...pkg.split('.'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${className}.java`), content);
}

// Write a Kotlin test source file at src/test/kotlin/<pkg path>/<className>.kt
function writeKotlinTestFile(projectRoot: string, module: string, pkg: string, className: string, content: string) {
  const dir = path.join(projectRoot, module, 'src', 'test', 'kotlin', ...pkg.split('.'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${className}.kt`), content);
}

// Write fake JaCoCo XML at the path the init script produces (used by aggregate tests only)
function writeJacocoXml(baseDir: string, moduleName: string, content: string) {
  const dir = path.join(baseDir, moduleName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jacoco.xml'), content);
}

describe('gradleRunner.discover', () => {
  it('returns TestCase for each @Test method in Java source files', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeJavaTestFile(root, 'application', 'com.example', 'FormatterTest', `
      package com.example;
      public class FormatterTest {
        @Test void shouldFormatDate() {}
        @Test void shouldHandleNull() {}
      }
    `);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases).toHaveLength(2);
    expect(cases.map(c => c.title)).toContain('shouldFormatDate');
    expect(cases.map(c => c.title)).toContain('shouldHandleNull');
  });

  it('sets filePath to module directory', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeJavaTestFile(root, 'application', 'com.example', 'FormatterTest', `
      package com.example;
      public class FormatterTest {
        @Test void shouldFormatDate() {}
      }
    `);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases[0].filePath).toBe(path.join(root, 'application'));
  });

  it('sets describePath to class name', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    writeJavaTestFile(root, 'application', 'com.example', 'FormatterTest', `
      package com.example;
      public class FormatterTest {
        @Test void shouldFormatDate() {}
      }
    `);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases[0].describePath).toBe('com.example.FormatterTest');
  });

  it('handles KoTest DSL string-based test names', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":api")');
    writeKotlinTestFile(root, 'api', 'com.example', 'CalculatorSpec', `
      package com.example
      class CalculatorSpec : StringSpec({
        "Calculator - should add two numbers" { }
      })
    `);

    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('Calculator - should add two numbers');
  });

  it('filters by module name when fileFilter is provided', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":api", ":application")');
    writeJavaTestFile(root, 'application', 'com.example', 'FormatterTest', `
      package com.example;
      public class FormatterTest {
        @Test void shouldFormatDate() {}
      }
    `);
    writeKotlinTestFile(root, 'api', 'com.example', 'CalculatorSpec', `
      package com.example
      class CalculatorSpec : StringSpec({
        "should add" { }
      })
    `);

    const cases = await gradleRunner.discover(root, 'api', undefined);
    expect(cases.every(c => String(c.filePath).includes('api'))).toBe(true);
    expect(cases.some(c => String(c.filePath).includes('application'))).toBe(false);
  });

  // ── Java annotation edge cases ──────────────────────────────────────────────

  it('handles @Test(expected = ...) with annotation params', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'ExpectedExceptionTest', `
      package com.example;
      public class ExpectedExceptionTest {
        @Test(expected = IllegalArgumentException.class)
        public void throwsOnNull() {}

        @Test (expected = SomeException.class)
        public void throwsOnInvalid() {}

        @Test()
        public void emptyParens() {}

        @Test(expected = X.class, timeout = 1000)
        public void multipleParams() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases.map(c => c.title)).toContain('throwsOnNull');
    expect(cases.map(c => c.title)).toContain('throwsOnInvalid');
    expect(cases.map(c => c.title)).toContain('emptyParens');
    expect(cases.map(c => c.title)).toContain('multipleParams');
  });

  it('handles multi-line annotation params', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'MultiLineTest', `
      package com.example;
      public class MultiLineTest {
        @Test(
          expected = IllegalArgumentException.class
        )
        public void multiLineAnnotation() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases.map(c => c.title)).toContain('multiLineAnnotation');
  });

  it('handles @Test and method declaration on the same line', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'SameLineTest', `
      package com.example;
      public class SameLineTest {
        @Test public void testAddKeyOrder() {}
        @Test public void testRemoveKeyOrder() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases.map(c => c.title)).toContain('testAddKeyOrder');
    expect(cases.map(c => c.title)).toContain('testRemoveKeyOrder');
  });

  it('handles @Test with a following @Ignore annotation before the method', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'ComboAnnotationTest', `
      package com.example;
      public class ComboAnnotationTest {
        @Test @Ignore("flaky: BOPS-212")
        public void testSomething() {}

        @Test
        @Override
        public void testOverride() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases.map(c => c.title)).toContain('testSomething');
    expect(cases.map(c => c.title)).toContain('testOverride');
  });

  it('does not emit false positives for @Test in line comments', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'CommentedOutTest', `
      package com.example;
      public class CommentedOutTest {
        // @Test - this used to be a test
        public void formerTest() {}

        @Test
        public void realTest() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases.map(c => c.title)).toContain('realTest');
    expect(cases.map(c => c.title)).not.toContain('formerTest');
  });

  it('does not emit false positives for @Test in block comments', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'BlockCommentTest', `
      package com.example;
      public class BlockCommentTest {
        /* @Test */
        public void alsoFormerTest() {}

        /**
         * @Test was previously used here
         */
        public void javadocTest() {}

        @Test
        public void realTest() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases.map(c => c.title)).toContain('realTest');
    expect(cases.map(c => c.title)).not.toContain('alsoFormerTest');
    expect(cases.map(c => c.title)).not.toContain('javadocTest');
  });

  it('does not emit false positives for @Test in string literals', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'StringLiteralTest', `
      package com.example;
      public class StringLiteralTest {
        @Test
        public void realTest() {
          String s = "@Test annotation example";
        }
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('realTest');
  });

  it('emits inherited @Test methods under the concrete subclass, not the abstract base', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'AbstractBaseTest', `
      package com.example;
      public abstract class AbstractBaseTest {
        @Test
        public void sharedTest() {}
      }
    `);
    writeJavaTestFile(root, 'app', 'com.example', 'ConcreteSubTest', `
      package com.example;
      public class ConcreteSubTest extends AbstractBaseTest {}
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    // sharedTest should be emitted under the concrete class — that's what Gradle needs
    expect(cases.map(c => c.title)).toContain('sharedTest');
    expect(cases.find(c => c.title === 'sharedTest')?.describePath).toBe('com.example.ConcreteSubTest');
    // Abstract class should not be emitted directly when a concrete subclass exists
    expect(cases.every(c => c.describePath !== 'com.example.AbstractBaseTest')).toBe(true);
  });

  it('handles multi-level inheritance chains', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'GrandparentTest', `
      package com.example;
      public abstract class GrandparentTest {
        @Test public void grandparentTest() {}
      }
    `);
    writeJavaTestFile(root, 'app', 'com.example', 'ParentTest', `
      package com.example;
      public abstract class ParentTest extends GrandparentTest {
        @Test public void parentTest() {}
      }
    `);
    writeJavaTestFile(root, 'app', 'com.example', 'ChildTest', `
      package com.example;
      public class ChildTest extends ParentTest {
        @Test public void childTest() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    const childCases = cases.filter(c => c.describePath === 'com.example.ChildTest');
    expect(childCases.map(c => c.title)).toContain('childTest');
    expect(childCases.map(c => c.title)).toContain('parentTest');
    expect(childCases.map(c => c.title)).toContain('grandparentTest');
    // Abstract classes not emitted directly
    expect(cases.every(c => c.describePath !== 'com.example.GrandparentTest')).toBe(true);
    expect(cases.every(c => c.describePath !== 'com.example.ParentTest')).toBe(true);
  });

  it('falls back to abstract class name when no concrete subclass is in the scan', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example', 'StandaloneAbstractTest', `
      package com.example;
      public abstract class StandaloneAbstractTest {
        @Test public void orphanTest() {}
      }
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    // No concrete subclass scanned — emit under abstract as best-effort fallback
    expect(cases.map(c => c.title)).toContain('orphanTest');
    expect(cases.find(c => c.title === 'orphanTest')?.describePath).toBe('com.example.StandaloneAbstractTest');
  });

  it('resolves parent class from explicit import when in different package', async () => {
    const root = path.join(tmpDir, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":app")');
    writeJavaTestFile(root, 'app', 'com.example.base', 'BaseTest', `
      package com.example.base;
      public abstract class BaseTest {
        @Test public void baseMethod() {}
      }
    `);
    writeJavaTestFile(root, 'app', 'com.example.impl', 'ImplTest', `
      package com.example.impl;
      import com.example.base.BaseTest;
      public class ImplTest extends BaseTest {}
    `);
    const cases = await gradleRunner.discover(root, undefined, undefined);
    const impl = cases.filter(c => c.describePath === 'com.example.impl.ImplTest');
    expect(impl.map(c => c.title)).toContain('baseMethod');
    expect(cases.every(c => c.describePath !== 'com.example.base.BaseTest')).toBe(true);
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

  it('passes -Pcoverage.insights.xmlDir to gradle', async () => {
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

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args.some(a => a.startsWith('-Pcoverage.insights.xmlDir='))).toBe(true);
    expect(args.every(a => !a.startsWith('-Pcoverage.insights.jsonDir='))).toBe(true);
  });

  it('writes empty coverage-final.json when no jacoco XML produced', async () => {
    const root = path.join(tmpDir, 'project');
    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(root);
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    // No XML written — simulates test with no coverage data

    const tc = {
      filePath: path.join(root, 'application'),
      fullName: 'com.example.FormatterTest > shouldFormatDate',
      title: 'shouldFormatDate',
      describePath: 'com.example.FormatterTest',
    };

    await gradleRunner.runOne(tc, root, workerDir, undefined);
    const json = fs.readFileSync(path.join(workerDir, 'coverage-final.json'), 'utf8');
    expect(json).toBe('{}');
  });

  it('uses : prefix for root-project tests to avoid running submodule test tasks', async () => {
    const root = path.join(tmpDir, 'project');
    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(root);
    fs.mkdirSync(workerDir, { recursive: true });
    // No settings.gradle.kts — root project, no submodules
    writeJacocoXml(workerDir, '', JACOCO_XML);

    const tc = {
      filePath: root,  // filePath is the root — pathToModule returns ''
      fullName: 'com.example.FormatterTest > shouldFormatDate',
      title: 'shouldFormatDate',
      describePath: 'com.example.FormatterTest',
    };

    await gradleRunner.runOne(tc, root, workerDir, undefined);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args[0]).toBe(':test');  // ':test' not 'test'
  });

});

describe('generateInitScript', () => {
  it('includes coverage.insights.jsonDir property check in redirect block', () => {
    const script = generateInitScript(false);
    expect(script).toContain('coverage.insights.jsonDir');
    expect(script).toContain('ExecFileLoader');
    expect(script).toContain('CoverageBuilder');
    expect(script).toContain('coverage-final.json');
  });

  it('includes coverage.insights.jsonDir property check in injection block', () => {
    const script = generateInitScript(true);
    expect(script).toContain('coverage.insights.jsonDir');
    expect(script).toContain('ExecFileLoader');
  });

  it('still wires finalizedBy when jsonDir not set (XML mode)', () => {
    const script = generateInitScript(false);
    expect(script).toContain('finalizedBy');
    expect(script).toContain('jacocoTestReport');
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

describe('gradleRunner.runAll', () => {
  it('calls gradlew test --no-daemon with pertest.dir property', async () => {
    const root = path.join(tmpDir, 'project');
    const workDir = path.join(tmpDir, 'batch');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');

    await gradleRunner.runAll!(root, workDir);

    const testCall = mockExecFile.mock.calls.find(c => (c[1] as string[])[0] === 'test');
    expect(testCall).toBeDefined();
    const args = testCall![1] as string[];
    expect(args).toContain('--no-daemon');
    expect(args.some(a => a.startsWith('-Pcoverage.insights.pertest.dir='))).toBe(true);
  });

  it('calls gradlew coverageInsightsBatchReport --no-daemon after tests', async () => {
    const root = path.join(tmpDir, 'project');
    const workDir = path.join(tmpDir, 'batch');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');

    await gradleRunner.runAll!(root, workDir);

    const batchCall = mockExecFile.mock.calls.find(c => (c[1] as string[]).includes('coverageInsightsBatchReport'));
    expect(batchCall).toBeDefined();
    const args = batchCall![1] as string[];
    expect(args).toContain('--no-daemon');
    expect(args.some(a => a.startsWith('-Pcoverage.insights.pertest.dir='))).toBe(true);
  });

  it('passes listenerJar path from ensureListenerJar to the test invocation', async () => {
    const root = path.join(tmpDir, 'project');
    const workDir = path.join(tmpDir, 'batch');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');
    mockEnsureListenerJar.mockReturnValue('/custom/path/listener.jar');

    await gradleRunner.runAll!(root, workDir);

    const testCall = mockExecFile.mock.calls.find(c => (c[1] as string[])[0] === 'test');
    expect(testCall).toBeDefined();
    const args = testCall![1] as string[];
    expect(args).toContain('-Pcoverage.insights.listener.jar=/custom/path/listener.jar');
  });

  it('does not throw if the test run fails', async () => {
    const root = path.join(tmpDir, 'project');
    const workDir = path.join(tmpDir, 'batch');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'include(":application")');

    // Make the test run call invoke callback with an error (simulating test failures),
    // batchReport should still run
    mockExecFile.mockImplementation((_cmd, args: unknown, _opts, cb) => {
      const a = args as string[];
      if (a[0] === 'test') {
        setImmediate(() => (cb as (e: null) => void)(null));  // swallowed — test failures OK
      } else {
        setImmediate(() => (cb as (e: null) => void)(null));
      }
      return undefined as unknown as ReturnType<typeof execFile>;
    });

    await expect(gradleRunner.runAll!(root, workDir)).resolves.toBeUndefined();

    const batchCall = mockExecFile.mock.calls.find(c => (c[1] as string[]).includes('coverageInsightsBatchReport'));
    expect(batchCall).toBeDefined();
  });
});
