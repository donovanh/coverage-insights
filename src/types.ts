// Discovered test case — input to the per-test runner
export interface TestCase {
  filePath: string;     // absolute path to the test file
  fullName: string;     // full test name including describe path
  title: string;        // test title only (no describe prefix)
  describePath: string; // describe block path, e.g. "outer > inner"; empty for top-level
}

// Output of the build step
export interface TestEntry {
  file: string;           // test file path (relative to project root)
  fullName: string;       // describe path + test name, e.g. "foo > bar > does thing"
  title: string;          // test name only
  describePath: string;   // describe block path — empty string for top-level tests
  sourceLines: Record<string, number[]>;  // source file → covered line numbers
}
export type TestLineMap = Record<string, TestEntry>; // keyed by "<file> > <fullName>"

// Subset of Istanbul's coverage-final.json shape (one entry per source file)
export interface CoverageSummaryEntry {
  lines:      { total: number; covered: number; pct: number };
  functions:  { total: number; covered: number; pct: number };
  statements: { total: number; covered: number; pct: number };
  fnMap:     Record<string, { name: string; decl: { start: { line: number } } }>;
  f:         Record<string, number>; // function call counts keyed by fnMap id
  branchMap: Record<string, unknown>; // present in Istanbul output, not used by analyse.ts
}
export type CoverageSummary = Record<string, CoverageSummaryEntry>;

export interface AnalysisOptions {
  threshold?: number;            // Jaccard cutoff for high-overlap pairs (default: 0.9)
  hotLineMin?: number;           // min tests per line to flag as hot (default: 20)
  lowCoverageThreshold?: number; // line % below which a file is flagged (default: 80)
  sourceFilter?: string;         // restrict findings to source files containing this substring
  topN?: number;                 // limit each section to N worst offenders
}

export interface OverlapPair {
  a: string;        // test fullName
  b: string;        // test fullName
  jaccard: number;  // 0–1
  sharedLines: number;
  aLines: number;   // total lines covered by a
  bLines: number;   // total lines covered by b
}

export interface ConsolidationGroup {
  file: string;
  describePath: string; // empty string for top-level tests with no describe block
  tests: string[];      // test fullNames with identical line sets; look up in TestLineMap for full entry
  suggestion: 'it.each' | 'merge-assertions';
}

export interface HotLine {
  source: string;
  line: number;
  coveredBy: number; // count of tests covering this line
}

export interface FragileLine {
  source: string;
  line: number;
  coveredBy: string; // fullName of the single test covering it
}

export interface UncoveredFunction {
  source: string;
  name: string;
  line: number;
}

export interface LowCoverageFile {
  source: string;
  lineCoverage: number; // 0–100
}

export interface AnalysisReport {
  redundancy: {
    highOverlapPairs: OverlapPair[];
    zeroContribution: TestEntry[];
    hotLines: HotLine[];
    consolidationGroups: ConsolidationGroup[];
  };
  coverageDepth: {
    fragileLines: FragileLine[];
    uncoveredFunctions: UncoveredFunction[];
    lowCoverageFiles: LowCoverageFile[];
  };
}
