import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { build } from '../../src/build/index.js';
import { jestRunner } from '../../src/build/runners/jest.js';
import { analyse } from '../../src/analyse.js';

const FIXTURE_ROOT   = path.resolve(__dirname, '../fixtures/shared-project');
const FIXTURE_CONFIG = path.join(FIXTURE_ROOT, 'tests/jest/jest.config.js');

describe('coverage-insights — Jest runner (integration)', () => {
  let outDir: string;
  let result: Awaited<ReturnType<typeof build>>;

  beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-jest-int-'));
    result = await build(
      { projectRoot: FIXTURE_ROOT, outDir, concurrency: 1, configPath: FIXTURE_CONFIG },
      jestRunner,
    );
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('discovers exactly 6 test cases', () => {
    expect(Object.keys(result.map)).toHaveLength(6);
  });

  it('flags exactly 2 zero-contribution tests', () => {
    const report = analyse(result.map, result.summary);
    expect(report.redundancy.zeroContribution).toHaveLength(2);
  });

  it('zero-contribution tests are "adds numbers" and "divides numbers"', () => {
    const report = analyse(result.map, result.summary);
    const titles = report.redundancy.zeroContribution.map(t => t.title);
    expect(titles).toContain('adds numbers');
    expect(titles).toContain('divides numbers');
  });

  it('flags formatError as the only uncovered function', () => {
    const report = analyse(result.map, result.summary);
    expect(report.coverageDepth.uncoveredFunctions).toHaveLength(1);
    expect(report.coverageDepth.uncoveredFunctions[0].name).toBe('formatError');
  });

  it('has no low-coverage files', () => {
    const report = analyse(result.map, result.summary);
    expect(report.coverageDepth.lowCoverageFiles).toHaveLength(0);
  });
});
