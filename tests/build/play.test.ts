import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn().mockImplementation((_p: unknown, _a: unknown, _o: unknown, cb: (err: null) => void) => { cb(null); return {}; }),
}));

import { playRunner } from '../../src/build/runners/play.js';
import { _resetSession } from '../../src/build/runners/gradle.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/play-project');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-runner-'));
  vi.clearAllMocks();
  _resetSession();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('playRunner.discover', () => {
  it('returns UTest cases from the test/ directory', async () => {
    const cases = await playRunner.discover(FIXTURE, undefined, undefined);
    const uTests = cases.filter(tc => !tc.filePath.endsWith('ITest.java'));
    expect(uTests.length).toBeGreaterThan(0);
  });

  it('returns ITest cases alongside UTest cases', async () => {
    const cases = await playRunner.discover(FIXTURE, undefined, undefined);
    const iTests = cases.filter(tc => tc.filePath.endsWith('ITest.java'));
    expect(iTests.length).toBeGreaterThan(0);
  });

  it('ITest cases carry staticTargets linking to controller source files', async () => {
    const cases = await playRunner.discover(FIXTURE, undefined, undefined);
    const iTests = cases.filter(tc => tc.filePath.endsWith('ITest.java'));
    const withTargets = iTests.filter(tc => (tc as import('../../src/build/runners/play/itest-analysis.js').PlayITestCase).staticTargets?.length > 0);
    expect(withTargets.length).toBeGreaterThan(0);
  });

  it('applies fileFilter to both UTest and ITest discovery', async () => {
    const cases = await playRunner.discover(FIXTURE, 'HomeController', undefined);
    expect(cases.every(tc => tc.filePath.includes('HomeController') || tc.file?.includes('HomeController'))).toBe(true);
  });
});

describe('playRunner.runOne — ITest', () => {
  it('writes a coverage-final.json for an ITest without running Gradle', async () => {
    const cases = await playRunner.discover(FIXTURE, undefined, undefined);
    const iTest = cases.find(tc => tc.filePath.endsWith('ITest.java'));
    if (!iTest) throw new Error('No ITest case found');

    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(workerDir, { recursive: true });
    await playRunner.runOne(iTest, FIXTURE, workerDir, undefined);

    const coveragePath = path.join(workerDir, 'coverage-final.json');
    expect(fs.existsSync(coveragePath)).toBe(true);
  });

  it('ITest coverage-final.json maps controller source files to line arrays', async () => {
    const cases = await playRunner.discover(FIXTURE, undefined, undefined);
    const iTest = cases.find(tc =>
      tc.filePath.endsWith('ITest.java') &&
      (tc as import('../../src/build/runners/play/itest-analysis.js').PlayITestCase).staticTargets?.length > 0,
    );
    if (!iTest) throw new Error('No ITest case with static targets found');

    const workerDir = path.join(tmpDir, 'worker-0');
    fs.mkdirSync(workerDir, { recursive: true });
    await playRunner.runOne(iTest, FIXTURE, workerDir, undefined);

    const raw = JSON.parse(fs.readFileSync(path.join(workerDir, 'coverage-final.json'), 'utf8'));
    // At least one key pointing to a controller file
    const keys = Object.keys(raw);
    expect(keys.some(k => k.includes('Controller'))).toBe(true);
  });
});

describe('playRunner — gradle runner unchanged', () => {
  it('gradleRunner.discover still works independently (no play contamination)', async () => {
    const { gradleRunner } = await import('../../src/build/runners/gradle.js');
    const cases = await gradleRunner.discover(FIXTURE, undefined, undefined);
    // gradleRunner only sees UTest files — no ITests
    expect(cases.every(tc => !tc.filePath.endsWith('ITest.java'))).toBe(true);
  });
});
