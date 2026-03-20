import { describe, it, expect } from 'vitest';
import { analyse } from '../src/analyse.js';
import type { TestLineMap, CoverageSummary } from '../src/types.js';

const SRC_A = 'src/foo.ts';
const SRC_B = 'src/bar.ts';

function makeMap(
  entries: Array<{
    file: string;
    fullName: string;
    title?: string;
    describePath?: string;
    sourceLines: Record<string, number[]>;
  }>,
): TestLineMap {
  const map: TestLineMap = {};
  for (const e of entries) {
    const key = `${e.file} > ${e.fullName}`;
    map[key] = {
      file: e.file,
      fullName: e.fullName,
      title: e.title ?? e.fullName,
      describePath: e.describePath ?? '',
      sourceLines: e.sourceLines,
    };
  }
  return map;
}

const EMPTY_SUMMARY: CoverageSummary = {};

// ─── High-overlap pairs ────────────────────────────────────────────────────────
describe('high-overlap pairs', () => {
  it('detects pairs with Jaccard >= threshold', () => {
    // A covers 1–10, B covers 1–9: intersection=9, union=10, jaccard=0.9
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', sourceLines: { [SRC_A]: [1,2,3,4,5,6,7,8,9,10] } },
      { file: 'tests/foo.test.ts', fullName: 'test B', sourceLines: { [SRC_A]: [1,2,3,4,5,6,7,8,9] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.highOverlapPairs).toHaveLength(1);
    expect(report.redundancy.highOverlapPairs[0].jaccard).toBeCloseTo(0.9);
    expect(report.redundancy.highOverlapPairs[0].sharedLines).toBe(9);
    expect(report.redundancy.highOverlapPairs[0].aLines).toBe(10);
    expect(report.redundancy.highOverlapPairs[0].bLines).toBe(9);
  });

  it('excludes pairs where both tests cover fewer than 3 lines', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'tiny A', sourceLines: { [SRC_A]: [1, 2] } },
      { file: 'tests/foo.test.ts', fullName: 'tiny B', sourceLines: { [SRC_A]: [1, 2] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.highOverlapPairs).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    // Jaccard = 0.5: flagged only when threshold <= 0.5
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test X', sourceLines: { [SRC_A]: [1,2,3,4] } },
      { file: 'tests/foo.test.ts', fullName: 'test Y', sourceLines: { [SRC_A]: [3,4,5,6] } },
    ]);
    expect(analyse(map, EMPTY_SUMMARY, { threshold: 0.9 }).redundancy.highOverlapPairs).toHaveLength(0);
    expect(analyse(map, EMPTY_SUMMARY, { threshold: 0.3 }).redundancy.highOverlapPairs).toHaveLength(1);
  });

  it('sorts pairs by jaccard descending', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'A', sourceLines: { [SRC_A]: [1,2,3,4,5,6,7,8,9,10] } },
      { file: 'tests/foo.test.ts', fullName: 'B', sourceLines: { [SRC_A]: [1,2,3,4,5,6,7,8,9] } },
      { file: 'tests/foo.test.ts', fullName: 'C', sourceLines: { [SRC_A]: [1,2,3,4,5,6,7,8,9,10,11] } },
    ]);
    const pairs = analyse(map, EMPTY_SUMMARY, { threshold: 0.8 }).redundancy.highOverlapPairs;
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].jaccard).toBeGreaterThanOrEqual(pairs[i].jaccard);
    }
  });
});

// ─── Zero contribution ─────────────────────────────────────────────────────────
describe('zero contribution', () => {
  it('flags tests whose covered lines are all covered by other tests', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'main test', sourceLines: { [SRC_A]: [1,2,3,4,5] } },
      { file: 'tests/foo.test.ts', fullName: 'redundant test', sourceLines: { [SRC_A]: [2,3] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.zeroContribution).toHaveLength(1);
    expect(report.redundancy.zeroContribution[0].fullName).toBe('redundant test');
  });

  it('does NOT apply the 3-line minimum', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'main', sourceLines: { [SRC_A]: [1,2,3] } },
      { file: 'tests/foo.test.ts', fullName: 'single line redundant', sourceLines: { [SRC_A]: [1] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.zeroContribution.some(t => t.fullName === 'single line redundant')).toBe(true);
  });

  it('does not flag a test that covers at least one unique line', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', sourceLines: { [SRC_A]: [1,2,3] } },
      { file: 'tests/foo.test.ts', fullName: 'test B', sourceLines: { [SRC_A]: [3,4] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.zeroContribution).toHaveLength(0);
  });

  it('does NOT flag tests with identical line coverage as zero contribution', () => {
    // Two tests covering the exact same lines — neither subsumes the other
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', sourceLines: { [SRC_A]: [1,2,3] } },
      { file: 'tests/foo.test.ts', fullName: 'test B', sourceLines: { [SRC_A]: [1,2,3] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.zeroContribution).toHaveLength(0);
  });

  it('requires superset to have strictly MORE lines, not equal', () => {
    // superset check is `other.lines.size > lines.size` — equal size with same lines is NOT a superset
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', sourceLines: { [SRC_A]: [1,2,3,4] } },
      { file: 'tests/foo.test.ts', fullName: 'test B', sourceLines: { [SRC_A]: [1,2,3] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    // B is subsumed by A (A has 4 lines, B has 3, all of B's are in A)
    expect(report.redundancy.zeroContribution).toHaveLength(1);
    expect(report.redundancy.zeroContribution[0].fullName).toBe('test B');
    // A is NOT subsumed — nothing has more lines that includes all of A
    expect(report.redundancy.zeroContribution.some(t => t.fullName === 'test A')).toBe(false);
  });
});

// ─── Hot lines ────────────────────────────────────────────────────────────────
describe('hot lines', () => {
  it('flags source lines covered by >= hotLineMin tests', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      file: 'tests/foo.test.ts',
      fullName: `test ${i}`,
      sourceLines: { [SRC_A]: [42] },
    }));
    const report = analyse(makeMap(entries), EMPTY_SUMMARY, { hotLineMin: 20 });
    expect(report.redundancy.hotLines).toHaveLength(1);
    expect(report.redundancy.hotLines[0].line).toBe(42);
    expect(report.redundancy.hotLines[0].coveredBy).toBe(20);
  });

  it('does not flag lines below the threshold', () => {
    const entries = Array.from({ length: 19 }, (_, i) => ({
      file: 'tests/foo.test.ts',
      fullName: `test ${i}`,
      sourceLines: { [SRC_A]: [42] },
    }));
    const report = analyse(makeMap(entries), EMPTY_SUMMARY, { hotLineMin: 20 });
    expect(report.redundancy.hotLines).toHaveLength(0);
  });

  it('sorts hot lines by coveredBy descending', () => {
    const mapA = Array.from({ length: 25 }, (_, i) => ({
      file: 'tests/foo.test.ts', fullName: `t${i}`, sourceLines: { [SRC_A]: [1] },
    }));
    const mapB = Array.from({ length: 20 }, (_, i) => ({
      file: 'tests/foo.test.ts', fullName: `u${i}`, sourceLines: { [SRC_A]: [2] },
    }));
    const report = analyse(makeMap([...mapA, ...mapB]), EMPTY_SUMMARY, { hotLineMin: 20 });
    expect(report.redundancy.hotLines[0].coveredBy).toBeGreaterThanOrEqual(report.redundancy.hotLines[1].coveredBy);
  });
});

// ─── Consolidation groups ──────────────────────────────────────────────────────
describe('consolidation groups', () => {
  it('groups tests with identical line sets in the same file + describePath', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'validation > accepts valid email', title: 'accepts valid email', describePath: 'validation', sourceLines: { [SRC_A]: [10,11,12] } },
      { file: 'tests/foo.test.ts', fullName: 'validation > accepts valid phone', title: 'accepts valid phone', describePath: 'validation', sourceLines: { [SRC_A]: [10,11,12] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.redundancy.consolidationGroups).toHaveLength(1);
    expect(report.redundancy.consolidationGroups[0].tests).toHaveLength(2);
    expect(report.redundancy.consolidationGroups[0].file).toBe('tests/foo.test.ts');
    expect(report.redundancy.consolidationGroups[0].describePath).toBe('validation');
  });

  it('suggests it.each when test names share a common word prefix', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'validates input A', title: 'validates input A', describePath: '', sourceLines: { [SRC_A]: [1,2] } },
      { file: 'tests/foo.test.ts', fullName: 'validates input B', title: 'validates input B', describePath: '', sourceLines: { [SRC_A]: [1,2] } },
    ]);
    expect(analyse(map, EMPTY_SUMMARY).redundancy.consolidationGroups[0].suggestion).toBe('it.each');
  });

  it('suggests merge-assertions when names are dissimilar', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'checks the value', title: 'checks the value', describePath: '', sourceLines: { [SRC_A]: [1,2] } },
      { file: 'tests/foo.test.ts', fullName: 'returns correct result', title: 'returns correct result', describePath: '', sourceLines: { [SRC_A]: [1,2] } },
    ]);
    expect(analyse(map, EMPTY_SUMMARY).redundancy.consolidationGroups[0].suggestion).toBe('merge-assertions');
  });

  it('applies to tests with only 2 covered lines (no line-count minimum)', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'small test A', title: 'small test A', describePath: 'small', sourceLines: { [SRC_A]: [5, 6] } },
      { file: 'tests/foo.test.ts', fullName: 'small test B', title: 'small test B', describePath: 'small', sourceLines: { [SRC_A]: [5, 6] } },
    ]);
    expect(analyse(map, EMPTY_SUMMARY).redundancy.consolidationGroups).toHaveLength(1);
  });

  it('does NOT group tests in different describePaths', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'group A > test', title: 'test', describePath: 'group A', sourceLines: { [SRC_A]: [1,2,3] } },
      { file: 'tests/foo.test.ts', fullName: 'group B > test', title: 'test', describePath: 'group B', sourceLines: { [SRC_A]: [1,2,3] } },
    ]);
    expect(analyse(map, EMPTY_SUMMARY).redundancy.consolidationGroups).toHaveLength(0);
  });

  it('does NOT group tests in different files', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', title: 'test A', describePath: 'g', sourceLines: { [SRC_A]: [1,2,3] } },
      { file: 'tests/bar.test.ts', fullName: 'test B', title: 'test B', describePath: 'g', sourceLines: { [SRC_A]: [1,2,3] } },
    ]);
    expect(analyse(map, EMPTY_SUMMARY).redundancy.consolidationGroups).toHaveLength(0);
  });
});

// ─── Fragile lines ────────────────────────────────────────────────────────────
describe('fragile lines', () => {
  it('identifies lines covered by exactly 1 test', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test alpha', sourceLines: { [SRC_A]: [99] } },
      { file: 'tests/foo.test.ts', fullName: 'test beta', sourceLines: { [SRC_A]: [100, 101] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    const lines = report.coverageDepth.fragileLines.map(f => f.line);
    expect(lines).toContain(99);
    expect(lines).toContain(100);
    expect(lines).toContain(101);
  });

  it('does not flag lines covered by 2+ tests', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', sourceLines: { [SRC_A]: [50] } },
      { file: 'tests/foo.test.ts', fullName: 'test B', sourceLines: { [SRC_A]: [50] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY);
    expect(report.coverageDepth.fragileLines.filter(f => f.line === 50)).toHaveLength(0);
  });

  it('records the name of the sole covering test', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'the guardian', sourceLines: { [SRC_A]: [77] } },
    ]);
    const fl = analyse(map, EMPTY_SUMMARY).coverageDepth.fragileLines.find(f => f.line === 77);
    expect(fl?.coveredBy).toBe('the guardian');
  });
});

// ─── Uncovered functions ───────────────────────────────────────────────────────
describe('uncovered functions', () => {
  it('identifies functions with 0 call count', () => {
    const summary: CoverageSummary = {
      [SRC_A]: {
        lines: { total: 10, covered: 10, pct: 100 },
        functions: { total: 2, covered: 1, pct: 50 },
        statements: { total: 10, covered: 10, pct: 100 },
        fnMap: {
          '0': { name: 'add',      decl: { start: { line: 5 } } },
          '1': { name: 'subtract', decl: { start: { line: 10 } } },
        },
        f: { '0': 3, '1': 0 },
        branchMap: {},
      },
    };
    const report = analyse({}, summary);
    expect(report.coverageDepth.uncoveredFunctions).toHaveLength(1);
    expect(report.coverageDepth.uncoveredFunctions[0].name).toBe('subtract');
    expect(report.coverageDepth.uncoveredFunctions[0].line).toBe(10);
    expect(report.coverageDepth.uncoveredFunctions[0].source).toBe(SRC_A);
  });

  it('does not flag functions that were called', () => {
    const summary: CoverageSummary = {
      [SRC_A]: {
        lines: { total: 5, covered: 5, pct: 100 },
        functions: { total: 1, covered: 1, pct: 100 },
        statements: { total: 5, covered: 5, pct: 100 },
        fnMap: { '0': { name: 'add', decl: { start: { line: 1 } } } },
        f: { '0': 5 },
        branchMap: {},
      },
    };
    expect(analyse({}, summary).coverageDepth.uncoveredFunctions).toHaveLength(0);
  });
});

// ─── Low coverage files ────────────────────────────────────────────────────────
describe('low coverage files', () => {
  it('flags files below the line coverage threshold', () => {
    const summary: CoverageSummary = {
      [SRC_A]: { lines: { total: 100, covered: 70, pct: 70 }, functions: { total: 0, covered: 0, pct: 100 }, statements: { total: 100, covered: 70, pct: 70 }, fnMap: {}, f: {}, branchMap: {} },
      [SRC_B]: { lines: { total: 100, covered: 90, pct: 90 }, functions: { total: 0, covered: 0, pct: 100 }, statements: { total: 100, covered: 90, pct: 90 }, fnMap: {}, f: {}, branchMap: {} },
    };
    const report = analyse({}, summary, { lowCoverageThreshold: 80 });
    expect(report.coverageDepth.lowCoverageFiles).toHaveLength(1);
    expect(report.coverageDepth.lowCoverageFiles[0].source).toBe(SRC_A);
    expect(report.coverageDepth.lowCoverageFiles[0].lineCoverage).toBe(70);
  });

  it('sorts low-coverage files ascending by coverage (worst first)', () => {
    const summary: CoverageSummary = {
      'src/a.ts': { lines: { total: 10, covered: 5, pct: 50 }, functions: { total: 0, covered: 0, pct: 100 }, statements: { total: 10, covered: 5, pct: 50 }, fnMap: {}, f: {}, branchMap: {} },
      'src/b.ts': { lines: { total: 10, covered: 3, pct: 30 }, functions: { total: 0, covered: 0, pct: 100 }, statements: { total: 10, covered: 3, pct: 30 }, fnMap: {}, f: {}, branchMap: {} },
    };
    const files = analyse({}, summary, { lowCoverageThreshold: 80 }).coverageDepth.lowCoverageFiles;
    expect(files[0].lineCoverage).toBeLessThanOrEqual(files[1].lineCoverage);
  });

  it('does not flag a file at exactly the threshold', () => {
    const summary: CoverageSummary = {
      [SRC_A]: { lines: { total: 100, covered: 80, pct: 80 }, functions: { total: 0, covered: 0, pct: 100 }, statements: { total: 100, covered: 80, pct: 80 }, fnMap: {}, f: {}, branchMap: {} },
    };
    expect(analyse({}, summary, { lowCoverageThreshold: 80 }).coverageDepth.lowCoverageFiles).toHaveLength(0);
  });
});

// ─── topN ─────────────────────────────────────────────────────────────────────
describe('topN option', () => {
  it('limits fragile lines to topN entries', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      file: 'tests/foo.test.ts', fullName: `test ${i}`, sourceLines: { [SRC_A]: [i + 1] },
    }));
    const report = analyse(makeMap(entries), EMPTY_SUMMARY, { topN: 3 });
    expect(report.coverageDepth.fragileLines.length).toBeLessThanOrEqual(3);
  });
});

// ─── sourceFilter ─────────────────────────────────────────────────────────────
describe('sourceFilter option', () => {
  it('restricts fragile line findings to matching source files', () => {
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'test A', sourceLines: { [SRC_A]: [1], [SRC_B]: [5] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY, { sourceFilter: 'foo' });
    const sources = report.coverageDepth.fragileLines.map(f => f.source);
    expect(sources.every(s => s.includes('foo'))).toBe(true);
    expect(sources.some(s => s.includes('bar'))).toBe(false);
  });

  it('excludes entries with no lines in the filtered source from analysis', () => {
    // When sourceFilter is active, entries whose lines.size === 0 after filtering
    // are dropped from the scoped set entirely
    const map = makeMap([
      { file: 'tests/foo.test.ts', fullName: 'only bar test', sourceLines: { [SRC_B]: [1,2,3] } },
    ]);
    const report = analyse(map, EMPTY_SUMMARY, { sourceFilter: 'foo' });
    // The entry covers only SRC_B (bar), which doesn't match 'foo', so lines.size === 0 post-filter
    // It should be excluded — no fragile lines reported
    expect(report.coverageDepth.fragileLines).toHaveLength(0);
  });
});
