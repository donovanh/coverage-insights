import { describe, it, expect } from 'vitest';
import { htmlReport } from '../../src/report/html.js';
import type { AnalysisReport } from '../../src/types.js';

function makeZero(fullName: string, supersetTest = 'superset test'): import('../../src/types.js').ZeroContributionEntry {
  return { file: 'a.ts', fullName, title: fullName, describePath: '', sourceLines: {}, supersetTest };
}

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    redundancy: { highOverlapPairs: [], zeroContribution: [], hotLines: [], consolidationGroups: [] },
    coverageDepth: { fragileLines: [], uncoveredFunctions: [], lowCoverageFiles: [] },
    ...overrides,
  };
}

// ─── Structure ───────────────────────────────────────────────────────────────
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

  it('contains a single unified table with id="ci-table"', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('id="ci-table"');
  });

  it('shows "No findings." when all sections are empty', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('No findings.');
  });
});

// ─── Filter buttons ───────────────────────────────────────────────────────────
describe('htmlReport — filter buttons', () => {
  it('contains category labels in the summary cards', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('Zero-contribution');
    expect(html).toContain('Hot lines');
    expect(html).toContain('Fragile lines');
    expect(html).toContain('Overlap');
    expect(html).toContain('Consolidation');
  });

  it('does NOT contain a separate row of pill filter buttons', () => {
    const html = htmlReport(makeReport());
    expect(html).not.toContain('class="filter-btns"');
    expect(html).not.toContain('class="fbtn"');
  });

  it('shows "Select a category" prompt when findings exist but no filter active', () => {
    const report = makeReport({
      coverageDepth: { fragileLines: [{ source: 'src/a.ts', line: 1, coveredBy: 'x' }], uncoveredFunctions: [], lowCoverageFiles: [] },
    });
    const html = htmlReport(report);
    expect(html).toContain('Select a category');
  });

  it('does NOT have an "All findings" card', () => {
    const html = htmlReport(makeReport());
    expect(html).not.toContain('All findings');
  });

  it('contains Dead controllers button when playData is provided', () => {
    const html = htmlReport(makeReport(), {}, { controllers: [] });
    expect(html).toContain('Dead controllers');
  });

  it('does NOT contain Dead controllers button when no playData', () => {
    const html = htmlReport(makeReport());
    expect(html).not.toContain('Dead controllers');
  });

  it('contains a search input', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('id="ci-search"');
    expect(html).toContain('type="search"');
  });
});

// ─── Summary cards ────────────────────────────────────────────────────────────
describe('htmlReport — summary cards', () => {
  it('shows correct count for zero-contribution tests', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [makeZero('test 1'), makeZero('test 2')],
        hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('<div class="card-count">2</div>');
  });

  it('shows 0 for empty sections', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('<div class="card-count">0</div>');
  });

  it('each category shows its own count in the summary card', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [makeZero('test 1'), makeZero('test 2')],
        hotLines: [{ source: 'src/Foo.java', line: 1, coveredBy: 5 }],
        consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    // 2 zero-contribution, 1 hot
    const counts = [...html.matchAll(/<div class="card-count">(\d+)<\/div>/g)].map(m => parseInt(m[1]));
    expect(counts).toContain(2); // zero-contribution card
    expect(counts).toContain(1); // hot lines card
  });
});

// ─── Table rows: data-cat attributes ─────────────────────────────────────────
describe('htmlReport — table rows', () => {
  it('zero-contribution tests get data-cat="zero"', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [makeZero('my redundant test', 'the big test')],
        hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('data-cat="zero"');
    expect(html).toContain('my redundant test');
  });

  it('zero-contribution rows show the superset test in the detail column', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [makeZero('tiny test', 'the covering test')],
        hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('the covering test');
  });

  it('overlap pairs get data-cat="overlap" and show jaccard percentage', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'test alpha', b: 'test beta', jaccard: 0.93, sharedLines: 8, aLines: 10, bLines: 9 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('data-cat="overlap"');
    expect(html).toContain('93.0%');
    expect(html).toContain('test alpha');
    expect(html).toContain('test beta');
  });

  it('formats jaccard=0.857 as 85.7%', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'A', b: 'B', jaccard: 0.857142, sharedLines: 6, aLines: 7, bLines: 7 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report)).toContain('85.7%');
  });

  it('jaccard=1.0 pairs are excluded from the table', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'dup A', b: 'dup B', jaccard: 1.0, sharedLines: 5, aLines: 5, bLines: 5 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).not.toContain('dup A');
    expect(html).not.toContain('dup B');
  });

  it('consolidation groups get data-cat="consolidate"', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{ file: 'a.ts', describePath: 'x', tests: ['x > A', 'x > B'], suggestion: 'it.each' }],
      },
    });
    expect(htmlReport(report)).toContain('data-cat="consolidate"');
  });

  it('hot lines get data-cat="hot"', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [],
        hotLines: [{ source: 'src/Foo.java', line: 42, coveredBy: 12 }],
        consolidationGroups: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('data-cat="hot"');
    expect(html).toContain('src/Foo.java');
  });

  it('fragile lines get data-cat="fragile"', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [{ source: 'src/Bar.java', line: 7, coveredBy: 'sole test' }],
        uncoveredFunctions: [], lowCoverageFiles: [],
      },
    });
    const html = htmlReport(report);
    expect(html).toContain('data-cat="fragile"');
    expect(html).toContain('src/Bar.java');
  });
});

// ─── Recommendations ──────────────────────────────────────────────────────────
describe('htmlReport — recommendation text', () => {
  it('zero-contribution recommendation says "consider deleting or merging assertions"', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [makeZero('test X')],
        hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report).toLowerCase()).toContain('consider deleting or merging assertions');
  });

  it('overlap where A is inside B recommends removing A', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'test small', b: 'test large', jaccard: 0.9, sharedLines: 5, aLines: 5, bLines: 8 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report).toLowerCase()).toMatch(/consider removing a|remove a/);
  });

  it('overlap where B is inside A recommends removing B', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'test large', b: 'test small', jaccard: 0.9, sharedLines: 5, aLines: 8, bLines: 5 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report).toLowerCase()).toMatch(/consider removing b|remove b/);
  });

  it('partial overlap recommends investigating', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'test A', b: 'test B', jaccard: 0.8, sharedLines: 4, aLines: 6, bLines: 6 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report).toLowerCase()).toContain('investigat');
  });

  it('fragile line recommendation mentions adding a second test', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [{ source: 'src/a.ts', line: 1, coveredBy: 'sole test' }],
        uncoveredFunctions: [], lowCoverageFiles: [],
      },
    });
    expect(htmlReport(report).toLowerCase()).toMatch(/add a second|add another/);
  });

  it('hot line recommendation mentions redundant coverage or variations', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [],
        hotLines: [{ source: 'src/x.ts', line: 1, coveredBy: 20 }],
        consolidationGroups: [],
      },
    });
    expect(htmlReport(report).toLowerCase()).toMatch(/redundant|variations/);
  });

  it('does NOT include old "saving X tests" impact text', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{ file: 'a.ts', describePath: 'x', tests: ['x > A', 'x > B', 'x > C'], suggestion: 'it.each' }],
      },
    });
    const html = htmlReport(report);
    expect(html).not.toContain('class="impact"');
    expect(html).not.toMatch(/saving \d+ tests/i);
  });
});

// ─── Badge colours ────────────────────────────────────────────────────────────
describe('htmlReport — category badge colours', () => {
  it('zero-contribution rows use grey badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [makeZero('test X')],
        hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report)).toContain('badge-grey');
  });

  it('hot line rows use red badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [],
        hotLines: [{ source: 'src/x.ts', line: 1, coveredBy: 10 }],
        consolidationGroups: [],
      },
    });
    expect(htmlReport(report)).toContain('badge-red');
  });

  it('fragile line rows use amber badge', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [{ source: 'src/a.ts', line: 1, coveredBy: 'sole test' }],
        uncoveredFunctions: [], lowCoverageFiles: [],
      },
    });
    expect(htmlReport(report)).toContain('badge-amber');
  });

  it('overlap rows use indigo badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'A', b: 'B', jaccard: 0.9, sharedLines: 5, aLines: 7, bLines: 7 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    expect(htmlReport(report)).toContain('badge-indigo');
  });

  it('consolidation rows use blue badge', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{ file: 'a.ts', describePath: 'x', tests: ['x > A', 'x > B'], suggestion: 'it.each' }],
      },
    });
    expect(htmlReport(report)).toContain('badge-blue');
  });
});

// ─── Tooltips ─────────────────────────────────────────────────────────────────
describe('htmlReport — card tooltips', () => {
  it('zero-contribution card has a descriptive tooltip mentioning larger test', () => {
    const html = htmlReport(makeReport());
    expect(html).toMatch(/title="[^"]*larger test[^"]*"/i);
  });

  it('hot lines card has a descriptive tooltip mentioning many tests', () => {
    const html = htmlReport(makeReport());
    expect(html).toMatch(/title="[^"]*many tests[^"]*"/i);
  });

  it('fragile lines card has a descriptive tooltip mentioning single test', () => {
    const html = htmlReport(makeReport());
    expect(html).toMatch(/title="[^"]*single test[^"]*"/i);
  });

  it('overlap card has a descriptive tooltip mentioning shared lines', () => {
    const html = htmlReport(makeReport());
    expect(html).toMatch(/title="[^"]*shared lines[^"]*"/i);
  });

  it('consolidation card has a descriptive tooltip mentioning identical', () => {
    const html = htmlReport(makeReport());
    expect(html).toMatch(/title="[^"]*identical[^"]*"/i);
  });

  it('dead controllers card tooltip mentions routes when play data provided', () => {
    const html = htmlReport(makeReport(), {}, { controllers: [] });
    expect(html).toMatch(/title="[^"]*routes[^"]*"/i);
  });
});

// ─── Intro text ───────────────────────────────────────────────────────────────
describe('htmlReport — intro text', () => {
  it('contains an intro paragraph above the summary grid', () => {
    const html = htmlReport(makeReport());
    expect(html).toContain('class="intro"');
  });

  it('intro text mentions per-test coverage', () => {
    const html = htmlReport(makeReport());
    const introIdx = html.indexOf('class="intro"');
    expect(introIdx).toBeGreaterThan(-1);
    const snippet = html.slice(introIdx, introIdx + 400);
    expect(snippet.toLowerCase()).toContain('per-test');
  });

  it('intro text appears before the summary grid', () => {
    const html = htmlReport(makeReport());
    const introIdx = html.indexOf('class="intro"');
    const gridIdx  = html.indexOf('class="summary-grid"');
    expect(introIdx).toBeLessThan(gridIdx);
  });
});

// ─── Play controller analysis ─────────────────────────────────────────────────
describe('htmlReport — Play controller analysis', () => {
  const playData = {
    controllers: [
      { relativePath: 'app/controllers/HomeController.java', simpleName: 'HomeController', status: 'routed' as const,       refs: { inRoutes: true,  inViews: false, inJava: false, inTests: false } },
      { relativePath: 'app/controllers/DeadController.java', simpleName: 'DeadController', status: 'unreferenced' as const, refs: { inRoutes: false, inViews: false, inJava: false, inTests: false } },
      { relativePath: 'app/controllers/TestOnlyCtrl.java',   simpleName: 'TestOnlyCtrl',   status: 'test-only' as const,    refs: { inRoutes: false, inViews: false, inJava: false, inTests: true  } },
    ],
  };

  it('renders dead controller rows when play data is provided', () => {
    const html = htmlReport(makeReport(), {}, playData);
    expect(html).toContain('DeadController');
    expect(html).toContain('TestOnlyCtrl');
  });

  it('does NOT render dead controller rows when play data is absent', () => {
    const html = htmlReport(makeReport());
    expect(html).not.toContain('data-cat="dead"');
    expect(html).not.toContain('Dead controllers');
  });

  it('dead controller rows have data-cat="dead"', () => {
    const html = htmlReport(makeReport(), {}, playData);
    expect(html).toContain('data-cat="dead"');
  });

  it('unreferenced controllers get a red status badge', () => {
    const html = htmlReport(makeReport(), {}, playData);
    const deadIdx = html.indexOf('DeadController');
    const snippet = html.slice(Math.max(0, deadIdx - 400), deadIdx + 400);
    expect(snippet).toMatch(/badge-red/);
  });

  it('test-only controllers get an amber status badge', () => {
    const html = htmlReport(makeReport(), {}, playData);
    const idx = html.indexOf('TestOnlyCtrl');
    const snippet = html.slice(Math.max(0, idx - 400), idx + 400);
    expect(snippet).toMatch(/badge-amber/);
  });

  it('routed controllers do NOT appear in dead rows', () => {
    const html = htmlReport(makeReport(), {}, playData);
    // Find all data-cat="dead" rows and check none contain HomeController
    const deadSection = html.match(/data-cat="dead"[\s\S]*?<\/tr>/g) ?? [];
    expect(deadSection.every(r => !r.includes('HomeController'))).toBe(true);
  });

  it('dead controller recommendation says "consider removing" for unreferenced', () => {
    const html = htmlReport(makeReport(), {}, playData);
    expect(html.toLowerCase()).toContain('consider removing');
  });
});
