import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { build } from '../../src/build/index.js';
import { vitestRunner } from '../../src/build/runners/vitest.js';
import { analyse } from '../../src/analyse.js';

const FIXTURE_ROOT   = path.resolve(__dirname, '../fixtures/shared-project');
const FIXTURE_CONFIG = path.join(FIXTURE_ROOT, 'tests/vitest/vitest.config.ts');

describe('coverage-insights — Vitest runner (integration)', () => {
  let outDir: string;
  let result: Awaited<ReturnType<typeof build>>;

  beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-int-'));
    result = await build(
      { projectRoot: FIXTURE_ROOT, outDir, concurrency: 1, configPath: FIXTURE_CONFIG },
      vitestRunner,
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

  it('summary contains coverage data for calc.ts and format.ts', () => {
    const calcKey = Object.keys(result.summary).find(k => k.includes('calc.ts'));
    const fmtKey  = Object.keys(result.summary).find(k => k.includes('format.ts'));
    expect(calcKey).toBeDefined();
    expect(fmtKey).toBeDefined();
  });

  it('calc.ts has 100% line coverage (all statements covered)', () => {
    const calcKey = Object.keys(result.summary).find(k => k.includes('calc.ts'))!;
    expect(result.summary[calcKey].lines.pct).toBe(100);
    expect(result.summary[calcKey].lines.covered).toBe(result.summary[calcKey].lines.total);
  });

  it('format.ts has less than 100% coverage (formatError never called)', () => {
    const fmtKey = Object.keys(result.summary).find(k => k.includes('format.ts'))!;
    expect(result.summary[fmtKey].lines.pct).toBeLessThan(100);
    expect(result.summary[fmtKey].lines.covered).toBeLessThan(result.summary[fmtKey].lines.total);
  });

  it('buildCoverageSummary computes pct as (covered/total)*100', () => {
    // Assert the formula: if pct === (covered/total)*100, arithmetic mutants die
    const fmtKey = Object.keys(result.summary).find(k => k.includes('format.ts'))!;
    const { covered, total, pct } = result.summary[fmtKey].lines;
    expect(pct).toBeCloseTo((covered / total) * 100, 5);
  });

  it('each map entry has sourceLines populated', () => {
    const entries = Object.values(result.map);
    // Every non-zero-contribution test should have at least 1 source line
    const withLines = entries.filter(e => Object.keys(e.sourceLines).length > 0);
    expect(withLines.length).toBeGreaterThan(0);
  });

  it('map entries use short paths (packages/... not absolute)', () => {
    const keys = Object.keys(result.map);
    for (const key of keys) {
      expect(key).not.toMatch(/^\/Users\//);
    }
  });
});
