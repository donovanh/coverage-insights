import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Mock child_process before importing build so the module sees the mock
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { build } from '../../src/build/index.js';
import { vitestRunner } from '../../src/build/runners/vitest.js';
import { execFileSync, execFile } from 'child_process';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);

// Minimal vitest JSON reporter output (two test cases)
const FAKE_DISCOVERY = JSON.stringify({
  testResults: [
    {
      name: '/project/tests/math.test.ts',
      assertionResults: [
        { status: 'passed', ancestorTitles: ['math'], fullName: 'math adds two numbers', title: 'adds two numbers' },
        { status: 'passed', ancestorTitles: ['math'], fullName: 'math subtracts two numbers', title: 'subtracts two numbers' },
      ],
    },
  ],
});

// Minimal Istanbul coverage-final.json (add covers line 2, subtract covers line 6)
const FAKE_COVERAGE = {
  '/project/src/math.ts': {
    s: { '0': 1, '1': 0 },
    statementMap: {
      '0': { start: { line: 2 }, end: { line: 2 } },
      '1': { start: { line: 6 }, end: { line: 6 } },
    },
    f: { '0': 1, '1': 0 },
    fnMap: {
      '0': { name: 'add', decl: { start: { line: 1 } } },
      '1': { name: 'subtract', decl: { start: { line: 5 } } },
    },
    branchMap: {},
    b: {},
  },
};

function writeCoverage(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify(FAKE_COVERAGE));
}

describe('build + vitestRunner (unit — no real subprocesses)', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-unit-'));
    vi.clearAllMocks();

    // Discovery pass: execFileSync with --reporter=json returns fake JSON
    mockExecFileSync.mockImplementation((_prog, args) => {
      if ((args as string[]).includes('--reporter=json')) return FAKE_DISCOVERY;
      // Aggregate pass: write fake coverage to reportsDirectory
      const rdArg = (args as string[]).find(a => a.startsWith('--coverage.reportsDirectory='));
      if (rdArg) writeCoverage(rdArg.split('=').slice(1).join('='));
      return '';
    });

    // Per-test pass: execFile writes coverage then resolves immediately
    mockExecFile.mockImplementation((_prog, args, _opts, callback) => {
      const rdArg = (args as string[]).find(a => a.startsWith('--coverage.reportsDirectory='));
      if (rdArg) writeCoverage(rdArg.split('=').slice(1).join('='));
      setImmediate(() => (callback as (err: null) => void)(null));
      return undefined as unknown as ReturnType<typeof execFile>;
    });
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('returns a TestLineMap with one entry per test case', async () => {
    const { map } = await build({ projectRoot: '/project', outDir, concurrency: 2 }, vitestRunner);
    expect(Object.keys(map)).toHaveLength(2);
  });

  it('maps each test to the lines it covers', async () => {
    const { map } = await build({ projectRoot: '/project', outDir, concurrency: 1 }, vitestRunner);
    const entry = Object.values(map).find(e => e.title === 'adds two numbers');
    expect(entry).toBeDefined();
    const srcFile = Object.keys(entry!.sourceLines).find(f => f.includes('math.ts'));
    expect(srcFile).toBeDefined();
    expect(entry!.sourceLines[srcFile!]).toContain(2);
  });

  it('writes test-line-map.json and coverage-summary.json to outDir', async () => {
    await build({ projectRoot: '/project', outDir, concurrency: 1 }, vitestRunner);
    expect(fs.existsSync(path.join(outDir, 'test-line-map.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'coverage-summary.json'))).toBe(true);
  });

  it('respects concurrency — never exceeds the limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    mockExecFile.mockImplementation((_prog, args, _opts, callback) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const rdArg = (args as string[]).find(a => a.startsWith('--coverage.reportsDirectory='));
      if (rdArg) writeCoverage(rdArg.split('=').slice(1).join('='));
      setImmediate(() => {
        concurrent--;
        (callback as (err: null) => void)(null);
      });
      return undefined as unknown as ReturnType<typeof execFile>;
    });

    await build({ projectRoot: '/project', outDir, concurrency: 1 }, vitestRunner);
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  it('does not exceed concurrency=2 with two tests', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    mockExecFile.mockImplementation((_prog, args, _opts, callback) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const rdArg = (args as string[]).find(a => a.startsWith('--coverage.reportsDirectory='));
      if (rdArg) writeCoverage(rdArg.split('=').slice(1).join('='));
      setImmediate(() => {
        concurrent--;
        (callback as (err: null) => void)(null);
      });
      return undefined as unknown as ReturnType<typeof execFile>;
    });

    await build({ projectRoot: '/project', outDir, concurrency: 2 }, vitestRunner);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('returns empty map when no tests found', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ testResults: [] }));
    const { map } = await build({ projectRoot: '/project', outDir }, vitestRunner);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('returns empty map when discovery output is blank', async () => {
    mockExecFileSync.mockImplementation(() => { throw Object.assign(new Error('fail'), { stdout: '' }); });
    const { map } = await build({ projectRoot: '/project', outDir }, vitestRunner);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('skips skipped/todo tests during discovery', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({
      testResults: [{
        name: '/project/tests/math.test.ts',
        assertionResults: [
          { status: 'passed', ancestorTitles: [], fullName: 'passes', title: 'passes' },
          { status: 'skipped', ancestorTitles: [], fullName: 'skipped one', title: 'skipped one' },
        ],
      }],
    }));
    const { map } = await build({ projectRoot: '/project', outDir, concurrency: 1 }, vitestRunner);
    expect(Object.keys(map)).toHaveLength(1);
  });

  it('passes fileFilter to filter out non-matching test files', async () => {
    const { map } = await build({
      projectRoot: '/project',
      outDir,
      concurrency: 1,
      fileFilter: 'nonexistent-pattern-that-matches-nothing',
    }, vitestRunner);
    expect(Object.keys(map)).toHaveLength(0);
  });
});
