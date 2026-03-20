import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleReport } from '../../src/report/console.js';
import type { AnalysisReport, AnalysisOptions } from '../../src/types.js';

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    redundancy: {
      highOverlapPairs: [],
      zeroContribution: [],
      hotLines: [],
      consolidationGroups: [],
    },
    coverageDepth: {
      fragileLines: [],
      uncoveredFunctions: [],
      lowCoverageFiles: [],
    },
    ...overrides,
  };
}

describe('consoleReport', () => {
  let output: string;

  beforeEach(() => {
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints without throwing on an empty report', () => {
    expect(() => consoleReport(makeReport())).not.toThrow();
    expect(output.length).toBeGreaterThan(0);
  });

  it('prints the coverage-insights heading', () => {
    consoleReport(makeReport());
    expect(output).toContain('coverage-insights');
  });

  it('shows high-overlap pairs count', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [{ a: 'foo > bar', b: 'foo > baz', jaccard: 0.92, sharedLines: 12, aLines: 13, bLines: 12 }],
        zeroContribution: [], hotLines: [], consolidationGroups: [],
      },
    });
    consoleReport(report);
    expect(output).toContain('1');
  });

  it('shows zero-contribution count', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [],
        zeroContribution: [{
          file: 'tests/foo.test.ts', fullName: 'the redundant one',
          title: 'the redundant one', describePath: '', sourceLines: {},
        }],
        hotLines: [], consolidationGroups: [],
      },
    });
    consoleReport(report);
    expect(output).toContain('Zero-contribution');
    expect(output).toContain('1');
  });

  it('shows consolidation groups count', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [], hotLines: [],
        consolidationGroups: [{
          file: 'tests/foo.test.ts',
          describePath: 'validate',
          tests: ['validate > accepts A', 'validate > accepts B'],
          suggestion: 'it.each',
        }],
      },
    });
    consoleReport(report);
    expect(output).toContain('Consolidation');
    expect(output).toContain('1');
  });

  it('shows fragile lines count', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [{ source: 'src/bar.ts', line: 99, coveredBy: 'the only test' }],
        uncoveredFunctions: [], lowCoverageFiles: [],
      },
    });
    consoleReport(report);
    expect(output).toContain('Fragile');
    expect(output).toContain('1');
  });

  it('shows uncovered functions count', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [],
        uncoveredFunctions: [{ source: 'src/baz.ts', name: 'myFunc', line: 15 }],
        lowCoverageFiles: [],
      },
    });
    consoleReport(report);
    expect(output).toContain('Uncovered');
    expect(output).toContain('1');
  });

  it('shows low-coverage files count', () => {
    const report = makeReport({
      coverageDepth: {
        fragileLines: [], uncoveredFunctions: [],
        lowCoverageFiles: [{ source: 'src/weak.ts', lineCoverage: 45 }],
      },
    });
    consoleReport(report);
    expect(output).toContain('Low-coverage');
    expect(output).toContain('1');
  });

  it('shows hot lines count', () => {
    const report = makeReport({
      redundancy: {
        highOverlapPairs: [], zeroContribution: [],
        hotLines: [{ source: 'src/foo.ts', line: 42, coveredBy: 25 }],
        consolidationGroups: [],
      },
    });
    consoleReport(report);
    expect(output).toContain('Hot lines');
    expect(output).toContain('1');
  });

  it('accepts opts without throwing', () => {
    const opts: AnalysisOptions = { topN: 1 };
    expect(() => consoleReport(makeReport(), opts)).not.toThrow();
  });
});
