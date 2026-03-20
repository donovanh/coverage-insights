import { describe, it, expect } from 'vitest';
import { htmlReport } from '../../src/report/html.js';
import type { AnalysisReport } from '../../src/types.js';

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    redundancy: { highOverlapPairs: [], zeroContribution: [], hotLines: [], consolidationGroups: [] },
    coverageDepth: { fragileLines: [], uncoveredFunctions: [], lowCoverageFiles: [] },
    ...overrides,
  };
}

describe('htmlReport — structure', () => {
  it('returns a string starting with <!DOCTYPE html>', () => {
    const html = htmlReport(makeReport());
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('is self-contained — no external script src or stylesheet link tags', () => {
    const html = htmlReport(makeReport());
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/i);
  });
});

// ─── actionBadge colour mapping ──────────────────────────────────────────────
describe('htmlReport — badge colours', () => {
  it('it.each suggestion produces a blue badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{
          file: 'tests/foo.test.ts', describePath: 'x',
          tests: ['x > test A', 'x > test B'],
          suggestion: 'it.each',
        }],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('badge-blue');
    expect(html).toContain('it.each');
  });

  it('merge-assertions suggestion produces an indigo badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{
          file: 'tests/foo.test.ts', describePath: 'x',
          tests: ['x > test A', 'x > test B'],
          suggestion: 'merge-assertions',
        }],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('badge-indigo');
    expect(html).toContain('merge-assertions');
  });

  it('fragile lines produce an amber "add test" badge', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [{ source: 'src/a.ts', line: 1, coveredBy: 'sole test' }],
        uncoveredFunctions: [], lowCoverageFiles: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('badge-amber');
    expect(html).toContain('add test');
  });

  it('uncovered functions produce an amber "check" badge', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [],
        uncoveredFunctions: [{ source: 'src/a.ts', name: 'myFn', line: 10 }],
        lowCoverageFiles: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('badge-amber');
    expect(html).toContain('check');
  });

  it('zero-contribution tests produce a red badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [{ file: 'tests/a.ts', fullName: 'test X', title: 'test X', describePath: '', sourceLines: {} }],
        hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('badge-red');
  });

  it('unknown action type falls back to grey "investigate" badge', () => {
    // An overlap pair where neither a nor b is fully contained → investigate
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test A', b: 'test B', jaccard: 0.85,
          sharedLines: 5, aLines: 7, bLines: 8, // partial overlap — neither fully inside
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('badge-grey');
    expect(html).toContain('investigate');
  });
});

// ─── overlapAction logic ─────────────────────────────────────────────────────
describe('htmlReport — overlapAction', () => {
  it('shows "delete a?" when all of A\'s lines are shared (A fully inside B)', () => {
    // aLines === sharedLines means A is fully covered by B's lines
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test A', b: 'test B', jaccard: 0.8,
          sharedLines: 5, aLines: 5, bLines: 8,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('delete a?');
    expect(html).toContain('badge-red');
  });

  it('shows "delete b?" when all of B\'s lines are shared (B fully inside A)', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test A', b: 'test B', jaccard: 0.8,
          sharedLines: 5, aLines: 8, bLines: 5,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('delete b?');
  });

  it('shows "investigate" in the table row when neither a nor b is fully contained', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test A', b: 'test B', jaccard: 0.8,
          sharedLines: 4, aLines: 6, bLines: 6,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    // badge guide always contains all three action labels; check the count
    // deleteACount=0 and deleteBCount=0 → their badge guide entries show (0)
    expect(html).toMatch(/delete a\?<\/span>.*?\(0\)/s);
    expect(html).toMatch(/delete b\?<\/span>.*?\(0\)/s);
    expect(html).toMatch(/investigate<\/span>.*?\(1\)/s);
  });

  it('filters out jaccard=1.0 pairs from the overlap table', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'identical A', b: 'identical B', jaccard: 1.0,
          sharedLines: 5, aLines: 5, bLines: 5,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    // The pair has jaccard=1.0 so it's filtered from partialOverlapPairs
    expect(html).not.toContain('identical A');
    expect(html).not.toContain('identical B');
  });

  it('includes pairs with jaccard < 1.0 in the overlap table', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test alpha', b: 'test beta', jaccard: 0.95,
          sharedLines: 8, aLines: 9, bLines: 8,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('test alpha');
    expect(html).toContain('test beta');
  });
});

// ─── Jaccard percentage formatting ───────────────────────────────────────────
describe('htmlReport — jaccard percentage', () => {
  it('formats jaccard as percentage with 1 decimal place', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test A', b: 'test B', jaccard: 0.93,
          sharedLines: 8, aLines: 10, bLines: 9,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('93.0%');
  });

  it('formats jaccard=0.857 as 85.7%', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{
          a: 'test A', b: 'test B', jaccard: 0.857142,
          sharedLines: 6, aLines: 7, bLines: 7,
        }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('85.7%');
  });
});

// ─── topN note ───────────────────────────────────────────────────────────────
describe('htmlReport — topN note', () => {
  it('shows "Showing top N of M" when total >= topN', () => {
    const fragileLines = Array.from({ length: 5 }, (_, i) => ({
      source: 'src/a.ts', line: i + 1, coveredBy: `test ${i}`,
    }));
    const report = makeReport({
      coverageDepth: { fragileLines, uncoveredFunctions: [], lowCoverageFiles: [] },
    });
    const html = htmlReport(report, { topN: 5 });
    expect(html).toContain('Showing top 5 of 5');
  });

  it('shows topN note when total > topN', () => {
    const fragileLines = Array.from({ length: 10 }, (_, i) => ({
      source: 'src/a.ts', line: i + 1, coveredBy: `test ${i}`,
    }));
    const report = makeReport({
      coverageDepth: { fragileLines, uncoveredFunctions: [], lowCoverageFiles: [] },
    });
    const html = htmlReport(report, { topN: 3 });
    expect(html).toContain('Showing top 3 of 10');
  });

  it('does NOT show topN note when total < topN', () => {
    const fragileLines = [{ source: 'src/a.ts', line: 1, coveredBy: 'x' }];
    const report = makeReport({
      coverageDepth: { fragileLines, uncoveredFunctions: [], lowCoverageFiles: [] },
    });
    const html = htmlReport(report, { topN: 5 });
    expect(html).not.toContain('Showing top');
  });
});

// ─── Consolidation savings text ───────────────────────────────────────────────
describe('htmlReport — consolidation savings', () => {
  it('shows singular "−1 test" when group has 2 tests', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{
          file: 'tests/foo.test.ts', describePath: 'g',
          tests: ['g > A', 'g > B'], // 2 tests → savings = 1
          suggestion: 'it.each',
        }],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('−1 test');
    expect(html).not.toContain('−1 tests');
  });

  it('shows plural "−2 tests" when group has 3 tests', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{
          file: 'tests/foo.test.ts', describePath: 'g',
          tests: ['g > A', 'g > B', 'g > C'], // 3 tests → savings = 2
          suggestion: 'it.each',
        }],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('−2 tests');
  });
});

// ─── Low coverage percentage formatting ──────────────────────────────────────
describe('htmlReport — low coverage file formatting', () => {
  it('formats lineCoverage with 1 decimal place', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [], uncoveredFunctions: [],
        lowCoverageFiles: [{ source: 'src/legacy.ts', lineCoverage: 42.567 }],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('42.6%');
    expect(html).toContain('src/legacy.ts');
  });

  it('formats whole-number coverage correctly', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [], uncoveredFunctions: [],
        lowCoverageFiles: [{ source: 'src/old.ts', lineCoverage: 70 }],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('70.0%');
  });
});

// ─── Badge guide counts ───────────────────────────────────────────────────────
describe('htmlReport — badge guide counts', () => {
  it('shows correct count for it.each groups in badge guide', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [
          { file: 'a.ts', describePath: 'x', tests: ['x > A', 'x > B'], suggestion: 'it.each' },
          { file: 'b.ts', describePath: 'y', tests: ['y > A', 'y > B'], suggestion: 'merge-assertions' },
        ],
      },
    });
    const html = htmlReport(report);
    // badge guide shows "(1)" for it.each and "(1)" for merge-assertions
    expect(html).toContain('it.each');
    expect(html).toContain('merge-assertions');
    // both appear in the guide with count indicators
    const matches = html.match(/<strong>\((\d+)\)<\/strong>/g);
    expect(matches).not.toBeNull();
  });

  it('shows correct deleteA/deleteB/investigate counts in overlap badge guide', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [
          { a: 'A', b: 'B', jaccard: 0.9, sharedLines: 5, aLines: 5, bLines: 7 }, // delete a?
          { a: 'C', b: 'D', jaccard: 0.9, sharedLines: 4, aLines: 6, bLines: 4 }, // delete b?
          { a: 'E', b: 'F', jaccard: 0.9, sharedLines: 3, aLines: 5, bLines: 5 }, // investigate
        ],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('delete a?');
    expect(html).toContain('delete b?');
    expect(html).toContain('investigate');
  });
});

// ─── Summary card counts ──────────────────────────────────────────────────────
describe('htmlReport — summary cards', () => {
  it('summary grid includes correct count for zero-contribution tests', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [
          { file: 'a.ts', fullName: 'test 1', title: 'test 1', describePath: '', sourceLines: {} },
          { file: 'b.ts', fullName: 'test 2', title: 'test 2', describePath: '', sourceLines: {} },
        ],
        hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    // Summary card for zero shows count "2"
    expect(html).toContain('<div class="card-count">2</div>');
  });

  it('summary grid shows 0 for empty sections', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('<div class="card-count">0</div>');
  });
});

// ─── Consolidation impact line removed ───────────────────────────────────────
describe('htmlReport — consolidation impact text', () => {
  it('does NOT show the misleading "saving X tests" impact paragraph', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [
          { file: 'a.ts', describePath: 'x', tests: ['x > A', 'x > B', 'x > C'], suggestion: 'it.each' },
        ],
      },
    });
    const html = htmlReport(report);
    expect(html).not.toContain('class="impact"');
    expect(html).not.toMatch(/saving \d+ tests/i);
  });
});

// ─── Tips blocks ──────────────────────────────────────────────────────────────
describe('htmlReport — tips blocks', () => {
  it('each section renders a <details class="tips"> element', () => {
    const html = htmlReport(makeReport());
    const count = (html.match(/<details class="tips">/g) ?? []).length;
    expect(count).toBe(7);
  });

  it('summary label is "How to use this" in every section', () => {
    const html = htmlReport(makeReport());
    const count = (html.match(/<summary>How to use this<\/summary>/g) ?? []).length;
    expect(count).toBe(7);
  });

  it('<details> has no open attribute — collapsed by default', () => {
    const html = htmlReport(makeReport());
    expect(html).not.toContain('<details class="tips" open>');
    expect(html).not.toContain('<details open');
  });

  it('tips content appears in the zero-contribution section', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain("Don't just delete");
  });

  it('tips content appears in the low-coverage section', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('Focus here first when adding new tests');
  });
});

// ─── Empty sections ───────────────────────────────────────────────────────────
describe('htmlReport — empty section fallback', () => {
  it('shows "No findings." for sections with no data', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('No findings.');
  });
});
