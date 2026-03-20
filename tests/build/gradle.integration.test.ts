import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { gradleRunner, _resetSession } from '../../src/build/runners/gradle.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/gradle-project');

// Skip all tests if java is not available
const javaAvailable = (() => {
  try { execFileSync('java', ['-version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
})();

describe.skipIf(!javaAvailable)('gradleRunner integration', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-int-'));
    _resetSession();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discover returns at least 4 test cases (2 JUnit + 2 KoTest)', async () => {
    const cases = await gradleRunner.discover(FIXTURE, undefined, undefined);
    expect(cases.length).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('discover finds both JUnit 5 and KoTest tests', async () => {
    const cases = await gradleRunner.discover(FIXTURE, undefined, undefined);
    expect(cases.some(c => c.describePath === 'com.example.app.FormatterTest')).toBe(true);
    expect(cases.some(c => c.describePath === 'com.example.api.CalculatorSpec')).toBe(true);
  }, 120_000);

  it('runOne produces coverage-final.json with covered lines', async () => {
    const cases = await gradleRunner.discover(FIXTURE, undefined, undefined);
    const tc = cases.find(c => c.title.includes('format date') || c.title === 'should format date')!;
    expect(tc).toBeDefined();

    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(workerDir, { recursive: true });
    await gradleRunner.runOne(tc, FIXTURE, workerDir, undefined);

    const coveragePath = path.join(workerDir, 'coverage-final.json');
    expect(fs.existsSync(coveragePath)).toBe(true);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    expect(Object.keys(coverage).length).toBeGreaterThan(0);
  }, 180_000);

  it('aggregate produces coverage-final.json with multiple source files', async () => {
    const aggregateDir = path.join(tmpDir, 'aggregate');
    fs.mkdirSync(aggregateDir, { recursive: true });
    await gradleRunner.aggregate(FIXTURE, aggregateDir, undefined);

    const coveragePath = path.join(aggregateDir, 'coverage-final.json');
    expect(fs.existsSync(coveragePath)).toBe(true);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    expect(Object.keys(coverage).length).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
