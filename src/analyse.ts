import type {
  TestLineMap,
  CoverageSummary,
  AnalysisOptions,
  AnalysisReport,
  OverlapPair,
  ConsolidationGroup,
  HotLine,
  FragileLine,
  UncoveredFunction,
  LowCoverageFile,
  TestEntry,
} from './types.js';

function isDistFile(src: string): boolean {
  return src.includes('/dist/') || src.includes('/node_modules/');
}

export function analyse(
  map: TestLineMap,
  summary: CoverageSummary,
  opts: AnalysisOptions = {},
): AnalysisReport {
  const {
    threshold = 0.9,
    hotLineMin = 20,
    lowCoverageThreshold = 80,
    sourceFilter,
    topN,
  } = opts;

  // Flatten entries to working set with Set<"src:line"> for fast intersection
  const entries = Object.values(map).map(entry => {
    const lines = new Set<string>();
    for (const [src, lineNums] of Object.entries(entry.sourceLines)) {
      if (sourceFilter && !src.includes(sourceFilter)) continue;
      for (const ln of lineNums) lines.add(`${src}:${ln}`);
    }
    return { entry, lines };
  });

  const scoped = sourceFilter ? entries.filter(e => e.lines.size > 0) : entries;

  // Line frequency: "src:line" → [fullName, ...] — skip dist/node_modules files
  const lineFreq = new Map<string, string[]>();
  for (const { entry, lines } of scoped) {
    for (const l of lines) {
      const src = l.slice(0, l.lastIndexOf(':'));
      if (isDistFile(src)) continue;
      if (!lineFreq.has(l)) lineFreq.set(l, []);
      lineFreq.get(l)!.push(entry.fullName);
    }
  }

  // ── High-overlap pairs (3-line minimum to exclude noise) ──
  const eligible = scoped.filter(e => e.lines.size >= 3);
  const highOverlapPairs: OverlapPair[] = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      let intersection = 0;
      for (const l of a.lines) if (b.lines.has(l)) intersection++;
      if (intersection === 0) continue;
      const union = a.lines.size + b.lines.size - intersection;
      const jaccard = intersection / union;
      if (jaccard >= threshold) {
        highOverlapPairs.push({
          a: a.entry.fullName,
          b: b.entry.fullName,
          jaccard,
          sharedLines: intersection,
          aLines: a.lines.size,
          bLines: b.lines.size,
        });
      }
    }
  }
  highOverlapPairs.sort((x, y) => y.jaccard - x.jaccard);

  // ── Zero contribution: only flag if another test is a STRICT superset ──
  // (covers all same lines AND has more lines — avoids flagging identical-coverage tests)
  const zeroContribution: TestEntry[] = [];
  for (const { entry, lines } of scoped) {
    if (lines.size === 0) continue;
    const isSubsumed = scoped.some(other => {
      if (other.entry.fullName === entry.fullName) return false;
      return other.lines.size > lines.size && [...lines].every(l => other.lines.has(l));
    });
    if (isSubsumed) zeroContribution.push(entry);
  }

  // ── Hot lines ──
  const hotLines: HotLine[] = [];
  for (const [lineKey, testers] of lineFreq) {
    if (testers.length >= hotLineMin) {
      const lastColon = lineKey.lastIndexOf(':');
      hotLines.push({
        source: lineKey.slice(0, lastColon),
        line: parseInt(lineKey.slice(lastColon + 1), 10),
        coveredBy: testers.length,
      });
    }
  }
  hotLines.sort((a, b) => b.coveredBy - a.coveredBy);

  // ── Consolidation groups (no line-count minimum) ──
  const byGroup = new Map<string, Array<{ entry: TestEntry; lines: Set<string> }>>();
  for (const { entry, lines } of scoped) {
    if (lines.size === 0) continue;
    const gk = `${entry.file}\x00${entry.describePath}`;
    if (!byGroup.has(gk)) byGroup.set(gk, []);
    byGroup.get(gk)!.push({ entry, lines });
  }
  const consolidationGroups: ConsolidationGroup[] = [];
  for (const [gk, members] of byGroup) {
    const components = findIdenticalLineSets(members);
    if (components.length === 0) continue;
    const nullIdx = gk.indexOf('\x00');
    const file = gk.slice(0, nullIdx);
    const describePath = gk.slice(nullIdx + 1);
    for (const comp of components) {
      consolidationGroups.push({
        file,
        describePath,
        tests: comp.map(m => m.entry.fullName),
        suggestion: classifyGroup(comp.map(m => m.entry.title)),
      });
    }
  }

  // ── Fragile lines ──
  const fragileLines: FragileLine[] = [];
  for (const [lineKey, testers] of lineFreq) {
    if (testers.length === 1) {
      const lastColon = lineKey.lastIndexOf(':');
      fragileLines.push({
        source: lineKey.slice(0, lastColon),
        line: parseInt(lineKey.slice(lastColon + 1), 10),
        coveredBy: testers[0],
      });
    }
  }

  // ── Uncovered functions (from CoverageSummary) ──
  const uncoveredFunctions: UncoveredFunction[] = [];
  for (const [src, entry] of Object.entries(summary)) {
    if (isDistFile(src)) continue;
    if (sourceFilter && !src.includes(sourceFilter)) continue;
    for (const [fnId, callCount] of Object.entries(entry.f)) {
      if (callCount === 0 && entry.fnMap[fnId]) {
        uncoveredFunctions.push({
          source: src,
          name: entry.fnMap[fnId].name,
          line: entry.fnMap[fnId].decl.start.line,
        });
      }
    }
  }

  // ── Low coverage files ──
  const lowCoverageFiles: LowCoverageFile[] = [];
  for (const [src, entry] of Object.entries(summary)) {
    if (isDistFile(src)) continue;
    if (sourceFilter && !src.includes(sourceFilter)) continue;
    if (entry.lines.pct < lowCoverageThreshold) {
      lowCoverageFiles.push({ source: src, lineCoverage: entry.lines.pct });
    }
  }
  lowCoverageFiles.sort((a, b) => a.lineCoverage - b.lineCoverage);

  const slice = <T>(arr: T[]): T[] => topN !== undefined ? arr.slice(0, topN) : arr;

  return {
    redundancy: {
      highOverlapPairs: slice(highOverlapPairs),
      zeroContribution: slice(zeroContribution),
      hotLines: slice(hotLines),
      consolidationGroups: slice(consolidationGroups),
    },
    coverageDepth: {
      fragileLines: slice(fragileLines),
      uncoveredFunctions: slice(uncoveredFunctions),
      lowCoverageFiles: slice(lowCoverageFiles),
    },
  };
}

function findIdenticalLineSets(
  members: Array<{ entry: TestEntry; lines: Set<string> }>,
): Array<Array<{ entry: TestEntry; lines: Set<string> }>> {
  const n = members.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = members[i].lines;
      const b = members[j].lines;
      if (a.size !== b.size) continue;
      let match = true;
      for (const l of a) { if (!b.has(l)) { match = false; break; } }
      if (match) { adj[i].push(j); adj[j].push(i); }
    }
  }
  const visited = new Array<boolean>(n).fill(false);
  const components: Array<Array<{ entry: TestEntry; lines: Set<string> }>> = [];
  for (let i = 0; i < n; i++) {
    if (visited[i] || adj[i].length === 0) continue;
    const comp: number[] = [];
    const queue = [i];
    visited[i] = true;
    while (queue.length) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const nb of adj[cur]) {
        if (!visited[nb]) { visited[nb] = true; queue.push(nb); }
      }
    }
    if (comp.length >= 2) components.push(comp.map(idx => members[idx]));
  }
  return components;
}

function classifyGroup(titles: string[]): 'it.each' | 'merge-assertions' {
  const words = titles.map(t => t.split(/\s+/));
  const minLen = Math.min(...words.map(w => w.length));
  let common = 0;
  for (let i = 0; i < minLen; i++) {
    if (words.every(w => w[i] === words[0][i])) common++;
    else break;
  }
  return common > minLen / 2 ? 'it.each' : 'merge-assertions';
}
