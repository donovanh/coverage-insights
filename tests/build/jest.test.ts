import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { jestRunner } from '../../src/build/runners/jest.js';
import { execFileSync, execFile } from 'child_process';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);

// Jest --json output shape (uses name + assertionResults at the file level)
const FAKE_JEST_DISCOVERY = JSON.stringify({
  testResults: [
    {
      name: '/project/tests/calc.test.ts',
      assertionResults: [
        { status: 'passed', ancestorTitles: ['calc'], fullName: 'calc adds numbers', title: 'adds numbers' },
        { status: 'passed', ancestorTitles: ['calc'], fullName: 'calc subtracts numbers', title: 'subtracts numbers' },
      ],
    },
  ],
});

const FAKE_COVERAGE = {
  '/project/src/calc.ts': {
    s: { '0': 1, '1': 0 },
    statementMap: {
      '0': { start: { line: 1 }, end: { line: 1 } },
      '1': { start: { line: 2 }, end: { line: 2 } },
    },
    f: { '0': 1, '1': 0 },
    fnMap: {
      '0': { name: 'add',      decl: { start: { line: 1 } } },
      '1': { name: 'subtract', decl: { start: { line: 2 } } },
    },
    branchMap: {},
  },
};

function writeCoverage(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify(FAKE_COVERAGE));
}

describe('jestRunner (unit — no real subprocesses)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-jest-unit-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discover: parses Jest JSON output (name + assertionResults shape)', async () => {
    mockExecFileSync.mockReturnValue(FAKE_JEST_DISCOVERY);
    const testCases = await jestRunner.discover('/project', undefined, undefined);
    expect(testCases).toHaveLength(2);
    expect(testCases[0].filePath).toBe('/project/tests/calc.test.ts');
    expect(testCases[0].title).toBe('adds numbers');
  });

  it('discover: returns empty array when output is blank', async () => {
    mockExecFileSync.mockImplementation(() => { throw Object.assign(new Error('fail'), { stdout: '' }); });
    const testCases = await jestRunner.discover('/project', undefined, undefined);
    expect(testCases).toHaveLength(0);
  });

  it('discover: skips skipped/todo tests', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({
      testResults: [{
        name: '/project/tests/calc.test.ts',
        assertionResults: [
          { status: 'passed',  ancestorTitles: [], fullName: 'passes', title: 'passes' },
          { status: 'skipped', ancestorTitles: [], fullName: 'skipped', title: 'skipped' },
        ],
      }],
    }));
    const testCases = await jestRunner.discover('/project', undefined, undefined);
    expect(testCases).toHaveLength(1);
  });

  it('runOne: calls npx jest with --testPathPattern, --testNamePattern, --forceExit', async () => {
    mockExecFile.mockImplementation((_prog, args, _opts, cb) => {
      const a = args as string[];
      writeCoverage(a.find(x => x.startsWith('--coverageDirectory='))!.split('=')[1]);
      setImmediate(() => (cb as (e: null) => void)(null));
      return undefined as never;
    });
    const tc = { filePath: '/project/tests/calc.test.ts', fullName: 'calc adds numbers', title: 'adds numbers', describePath: 'calc' };
    await jestRunner.runOne(tc, '/project', tmpDir, undefined);
    expect(mockExecFile).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['jest', '--forceExit', '--coverage', '--coverageReporters=json']),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('aggregate: calls npx jest with --coverage and --forceExit', async () => {
    mockExecFileSync.mockImplementation((_prog, args) => {
      const a = args as string[];
      writeCoverage(a.find(x => x.startsWith('--coverageDirectory='))!.split('=')[1]);
      return '';
    });
    await jestRunner.aggregate('/project', tmpDir, undefined);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['jest', '--coverage', '--forceExit']),
      expect.any(Object),
    );
  });
});
