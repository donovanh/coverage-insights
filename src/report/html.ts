import type { AnalysisReport, AnalysisOptions } from '../types.js';

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="none">No findings.</p>';
  const th = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const trs = rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('\n');
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function badge(label: string, type: 'blue' | 'indigo' | 'red' | 'amber' | 'grey'): string {
  return `<span class="badge badge-${type}">${esc(label)}</span>`;
}

function actionBadge(action: string): string {
  if (action === 'it.each')           return badge('it.each', 'blue');
  if (action === 'merge-assertions')  return badge('merge-assertions', 'indigo');
  if (action.startsWith('delete'))    return badge(action, 'red');
  if (action === 'add test')          return badge('add test', 'amber');
  if (action === 'check')             return badge('check', 'amber');
  return badge('investigate', 'grey');
}

function badgeGuide(items: Array<{ action: string; desc: string; count: number }>): string {
  const parts = items.map(({ action, desc, count }) =>
    `${actionBadge(action)} <span class="guide-text">${esc(desc)} <strong>(${count})</strong></span>`,
  );
  return `<p class="badge-guide">${parts.join('')}</p>`;
}

function tips(items: string[]): string {
  if (items.length === 0) return '';
  const li = items.map(t => `<li>${t}</li>`).join('');
  return `<details class="tips"><summary>How to use this</summary><div class="tip-body"><ul>${li}</ul></div></details>`;
}

function section(
  id: string,
  title: string,
  oneLiner: string,
  guide: string,
  content: string,
  topN?: number,
  total?: number,
  tipItems?: string[],
): string {
  const note = topN !== undefined && total !== undefined && total >= topN
    ? `<p class="note">Showing top ${topN} of ${total} findings.</p>`
    : '';
  return `<section id="${id}">
  <h2>${esc(title)}</h2>
  <p class="section-desc">${oneLiner}</p>
  ${guide}
  ${tips(tipItems ?? [])}
  <div class="section-body">${note}${content}</div>
</section>`;
}

function summaryCard(id: string, count: number, label: string, colorClass: string, tooltip: string): string {
  return `<a href="#${id}" class="card ${colorClass}" title="${esc(tooltip)}">
  <div class="card-count">${count}</div>
  <div class="card-label">${esc(label)}</div>
</a>`;
}

export function htmlReport(report: AnalysisReport, opts: AnalysisOptions = {}): string {
  const { topN } = opts;
  const { highOverlapPairs, zeroContribution, hotLines, consolidationGroups } = report.redundancy;
  const { fragileLines, uncoveredFunctions, lowCoverageFiles } = report.coverageDepth;

  // Filter out jaccard=1.0 pairs — already shown in consolidation groups
  const partialOverlapPairs = highOverlapPairs.filter(p => p.jaccard < 1.0);

  // ── Computed action counts for badge guides ──

  const itEachCount   = consolidationGroups.filter(g => g.suggestion === 'it.each').length;
  const mergeCount    = consolidationGroups.filter(g => g.suggestion === 'merge-assertions').length;
  const _consolidationTestTotal = consolidationGroups.reduce((n, g) => n + g.tests.length, 0);

  type OverlapAction = 'delete a?' | 'delete b?' | 'investigate';
  function overlapAction(p: typeof partialOverlapPairs[0]): OverlapAction {
    if (p.aLines === p.sharedLines && p.bLines > p.sharedLines) return 'delete a?';
    if (p.bLines === p.sharedLines && p.aLines > p.sharedLines) return 'delete b?';
    return 'investigate';
  }
  const deleteACount      = partialOverlapPairs.filter(p => overlapAction(p) === 'delete a?').length;
  const deleteBCount      = partialOverlapPairs.filter(p => overlapAction(p) === 'delete b?').length;
  const investigateCount  = partialOverlapPairs.filter(p => overlapAction(p) === 'investigate').length;

  // Group fragile lines by source file for count-by-file summary
  const fragileByFile = new Map<string, number>();
  for (const f of fragileLines) {
    fragileByFile.set(f.source, (fragileByFile.get(f.source) ?? 0) + 1);
  }

  // ── Overlap table ──
  const overlapRows = partialOverlapPairs.map(p => {
    const action = overlapAction(p);
    return [
      esc(p.a),
      esc(p.b),
      `${(p.jaccard * 100).toFixed(1)}%`,
      esc(p.sharedLines),
      actionBadge(action),
    ];
  });
  const overlapTable = table(
    ['Test A', 'Test B', 'Jaccard', 'Shared lines', 'Action'],
    overlapRows,
  );

  // ── Zero contribution — add delete? badge per row ──
  const zeroTable = table(
    ['Test', 'File', 'Action'],
    zeroContribution.map(t => [esc(t.fullName), esc(t.file), actionBadge('delete?')]),
  );

  // ── Hot lines ──
  const hotTable = table(
    ['Source', 'Line', 'Tests covering'],
    hotLines.map(h => [esc(h.source), esc(h.line), esc(h.coveredBy)]),
  );

  // ── Consolidation groups as cards ──
  function consolidationCards(): string {
    if (consolidationGroups.length === 0) return '<p class="none">No findings.</p>';
    return consolidationGroups.map(g => {
      const testList = g.tests.map(t => `<li>${esc(t)}</li>`).join('');
      const fileShort = g.file.split('/').slice(-2).join('/');
      const savings = g.tests.length - 1;
      return `<div class="consolidation-card">
  <div class="consolidation-header">
    ${actionBadge(g.suggestion)}
    <span class="consolidation-file">${esc(fileShort)}</span>
    ${g.describePath ? `<span class="consolidation-describe">${esc(g.describePath)}</span>` : ''}
    <span class="consolidation-savings">−${savings} test${savings !== 1 ? 's' : ''}</span>
  </div>
  <ul class="test-list">${testList}</ul>
</div>`;
    }).join('\n');
  }

  // ── Fragile lines — add "add test" badge per row ──
  const fragileTable = table(
    ['Source', 'Line', 'Sole covering test', 'Action'],
    fragileLines.map(f => [esc(f.source), esc(f.line), esc(f.coveredBy), actionBadge('add test')]),
  );

  // ── Uncovered functions — add "add test" or "check" badge ──
  const uncoveredTable = table(
    ['Source', 'Function', 'Line', 'Action'],
    uncoveredFunctions.map(u => [esc(u.source), esc(u.name), esc(u.line), actionBadge('check')]),
  );

  // ── Low coverage files ──
  const lowTable = table(
    ['Source', 'Line coverage', 'Action'],
    lowCoverageFiles.map(lf => [esc(lf.source), `${lf.lineCoverage.toFixed(1)}%`, actionBadge('add test')]),
  );

  // ── Tooltip text per card (one-liners) ──
  const tooltips = {
    consolidate: 'Tests in the same describe block with identical line coverage.',
    overlap:     'Test pairs sharing a high proportion of covered lines.',
    zero:        'Tests whose every covered line is also covered by a single larger test.',
    hot:         'Source lines covered by an unusually high number of tests.',
    fragile:     'Source lines covered by exactly one test.',
    uncovered:   'Functions never called during the test run.',
    lowcoverage: 'Source files below the line coverage threshold.',
  };

  const summaryGrid = `<div class="summary-grid">
  ${summaryCard('consolidate', consolidationGroups.length, 'Consolidation candidates', 'card-blue',   tooltips.consolidate)}
  ${summaryCard('overlap',     partialOverlapPairs.length, 'Overlapping test pairs',   'card-indigo', tooltips.overlap)}
  ${summaryCard('zero',        zeroContribution.length,    'Zero-contribution tests',  'card-red',    tooltips.zero)}
  ${summaryCard('hot',         hotLines.length,            'Hot lines',                'card-amber',  tooltips.hot)}
  ${summaryCard('fragile',     fragileLines.length,        'Fragile lines',            'card-amber',  tooltips.fragile)}
  ${summaryCard('uncovered',   uncoveredFunctions.length,  'Uncovered functions',      'card-red',    tooltips.uncovered)}
  ${summaryCard('lowcoverage', lowCoverageFiles.length,    'Low coverage files',       'card-grey',   tooltips.lowcoverage)}
</div>`;

  const body = [
    `<h1>coverage-insights</h1>`,
    `<p class="generated">Generated: ${new Date().toISOString()}</p>`,
    summaryGrid,

    `<h2 class="group-heading">Redundancy</h2>`,

    section('consolidate', 'Consolidation candidates',
      tooltips.consolidate,
      badgeGuide([
        { action: 'it.each',          desc: 'Collapse into a parameterised test',        count: itEachCount },
        { action: 'merge-assertions', desc: 'Combine assertions into one test',           count: mergeCount },
      ]),
      consolidationCards(), topN, consolidationGroups.length,
      [
        '<code>it.each</code> suits input/output variations of the same behaviour; <code>merge-assertions</code> suits multiple <code>expect</code> calls on one shared setup.',
        'Merging reduces test count but check readability — sometimes separate tests are clearer.',
        'Don\'t merge tests with different mock setups even if their line coverage matches.',
      ]),

    section('overlap', 'High-overlap pairs',
      tooltips.overlap,
      badgeGuide([
        { action: 'delete a?',   desc: 'Test A is fully inside test B — remove A',         count: deleteACount },
        { action: 'delete b?',   desc: 'Test B is fully inside test A — remove B',         count: deleteBCount },
        { action: 'investigate', desc: 'Significant overlap — review for intentional diff', count: investigateCount },
      ]),
      overlapTable, topN, partialOverlapPairs.length,
      [
        'Jaccard similarity measures shared <em>line coverage</em>, not shared behaviour — two tests on the same lines can assert very different things.',
        '<strong>delete a?</strong> means test A\'s lines are fully contained in B — A adds no new coverage.',
        '<strong>investigate</strong> means partial overlap — verify the tests cover genuinely different code paths before removing either.',
      ]),

    section('zero', 'Zero-contribution tests',
      tooltips.zero,
      badgeGuide([
        { action: 'delete?', desc: 'Every line this test covers is also covered by a larger test', count: zeroContribution.length },
      ]),
      zeroTable, topN, zeroContribution.length,
      [
        'Don\'t just delete. Check if the flagged test\'s <em>assertions</em> differ from the superset test.',
        'If assertions are unique, merge them into the covering test instead of deleting.',
        'Unit tests for utility functions often appear here because a higher-level test calls them indirectly — these are usually worth keeping.',
      ]),

    section('hot', 'Hot lines',
      tooltips.hot,
      badgeGuide([]),
      hotTable, topN, hotLines.length,
      [
        'Many tests covering one line doesn\'t mean it\'s well-tested — they may all hit the same happy path.',
        'Check whether each covering test asserts something meaningfully different, or whether they\'re redundant variations.',
        'Shared setup code (constructors, imports) often appears here and is not actionable.',
      ]),

    `<h2 class="group-heading">Coverage depth</h2>`,

    section('fragile', 'Fragile lines',
      tooltips.fragile,
      badgeGuide([
        { action: 'add test', desc: 'Add a second test covering this line', count: fragileLines.length },
      ]),
      fragileTable, topN, fragileLines.length,
      [
        'A line covered by exactly one test will go undetected if that test is deleted or changed.',
        'Only actionable for critical behaviour — some code paths are only reachable one way and a single test is fine.',
      ]),

    section('uncovered', 'Uncovered functions',
      tooltips.uncovered,
      badgeGuide([
        { action: 'check', desc: 'Add tests or confirm this function is intentionally untested', count: uncoveredFunctions.length },
      ]),
      uncoveredTable, topN, uncoveredFunctions.length,
      [
        'These functions were never called during any test run.',
        'Check if the function is reachable at all — if not, consider removing it.',
        'If reachable but untested, add a test before the next refactor.',
      ]),

    section('lowcoverage', 'Low coverage files',
      tooltips.lowcoverage,
      badgeGuide([
        { action: 'add test', desc: 'Add tests to bring coverage above threshold', count: lowCoverageFiles.length },
      ]),
      lowTable, topN, lowCoverageFiles.length,
      [
        'Focus here first when adding new tests.',
        'Look at which branches are missing, not just the percentage — 60% with all critical paths covered may be healthier than 90% with untested error handling.',
      ]),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coverage-insights report</title>
<style>
  :root {
    --blue:   #2563eb;
    --indigo: #4f46e5;
    --red:    #dc2626;
    --amber:  #d97706;
    --grey:   #6b7280;
    --blue-bg:   #eff6ff;
    --indigo-bg: #eef2ff;
    --red-bg:    #fef2f2;
    --amber-bg:  #fffbeb;
    --grey-bg:   #f9fafb;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1.5rem; color: #111; line-height: 1.5; }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; }
  .generated { color: #888; font-size: .85rem; margin: 0 0 2rem; }
  h2 { font-size: 1.2rem; margin: 0 0 .4rem; color: #111; }
  .group-heading { font-size: 1.4rem; margin: 2.5rem 0 1rem; border-bottom: 2px solid #e5e7eb; padding-bottom: .4rem; }
  section { margin-bottom: 2rem; }
  .section-desc { color: #555; font-size: .9rem; margin: 0 0 .5rem; }
  .section-body { max-height: 420px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 6px; padding: .5rem; background: #fff; }
  .section-body .none { padding: .25rem .25rem; }
  .section-body table { border: none; }
  .section-body .consolidation-card:last-child { margin-bottom: 0; }

  /* Badge guide */
  .badge-guide { display: flex; flex-wrap: wrap; gap: .5rem .75rem; align-items: center; margin: 0 0 .75rem; font-size: .85rem; }
  .guide-text { color: #555; }
  .badge-guide:empty { display: none; }

  /* Tips */
  details.tips { margin: 0.4rem 0 0.75rem; }
  details.tips summary { font-size: 0.8rem; color: #3b82f6; cursor: pointer; list-style: none; display: flex; align-items: center; gap: 0.3rem; }
  details.tips summary::marker { display: none; }
  details.tips summary::before { content: '▶'; font-size: 0.6rem; transition: transform 0.15s; }
  details[open].tips summary::before { transform: rotate(90deg); }
  details.tips .tip-body { background: #f0f9ff; border-left: 3px solid #3b82f6; padding: 0.6rem 0.8rem; margin-top: 0.4rem; font-size: 0.8rem; color: #334155; border-radius: 0 4px 4px 0; line-height: 1.6; }
  details.tips .tip-body ul { margin: 0.25rem 0 0 1rem; padding: 0; }
  details.tips .tip-body li { margin-bottom: 0.2rem; }

  /* Summary cards */
  .summary-grid { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 2.5rem; }
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1rem 1.25rem; border-radius: 8px; min-width: 120px; text-decoration: none; color: inherit; border: 1px solid transparent; transition: opacity .15s; cursor: pointer; }
  .card:hover { opacity: .8; }
  .card-count { font-size: 2rem; font-weight: 700; line-height: 1; }
  .card-label { font-size: .75rem; text-align: center; margin-top: .25rem; color: #555; }
  .card-blue   { background: var(--blue-bg);   border-color: #bfdbfe; }
  .card-indigo { background: var(--indigo-bg); border-color: #c7d2fe; }
  .card-red    { background: var(--red-bg);    border-color: #fecaca; }
  .card-amber  { background: var(--amber-bg);  border-color: #fde68a; }
  .card-grey   { background: var(--grey-bg);   border-color: #e5e7eb; }

  /* Badges */
  .badge { display: inline-block; padding: .15rem .5rem; border-radius: 4px; font-size: .78rem; font-weight: 600; white-space: nowrap; }
  .badge-blue   { background: var(--blue-bg);   color: var(--blue);   border: 1px solid #bfdbfe; }
  .badge-indigo { background: var(--indigo-bg); color: var(--indigo); border: 1px solid #c7d2fe; }
  .badge-red    { background: var(--red-bg);    color: var(--red);    border: 1px solid #fecaca; }
  .badge-amber  { background: var(--amber-bg);  color: var(--amber);  border: 1px solid #fde68a; }
  .badge-grey   { background: var(--grey-bg);   color: var(--grey);   border: 1px solid #e5e7eb; }

  /* Consolidation cards */
  .consolidation-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: .75rem 1rem; margin-bottom: .75rem; background: #fff; }
  .consolidation-header { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: .5rem; }
  .consolidation-file { font-family: monospace; font-size: .85rem; color: #374151; }
  .consolidation-describe { font-family: monospace; font-size: .8rem; color: #6b7280; background: #f3f4f6; padding: .1rem .4rem; border-radius: 4px; }
  .consolidation-savings { font-size: .78rem; color: var(--red); font-weight: 600; margin-left: auto; }
  .test-list { margin: 0; padding-left: 1.25rem; }
  .test-list li { font-size: .85rem; color: #374151; padding: .1rem 0; font-family: monospace; }

  /* Tables */
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  th { background: #f9fafb; text-align: left; padding: .5rem .75rem; border-bottom: 2px solid #e5e7eb; font-weight: 600; cursor: pointer; user-select: none; }
  th:hover { background: #f3f4f6; }
  td { padding: .4rem .75rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; font-family: monospace; font-size: .82rem; }
  td:last-child { font-family: system-ui, sans-serif; }
  tr:hover td { background: #fafafa; }
  .none { color: #9ca3af; font-style: italic; }
  .note { color: #6b7280; font-style: italic; font-size: .85rem; }
  code { background: #f3f4f6; padding: .1rem .3rem; border-radius: 3px; font-size: .85em; }
</style>
<script>
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('th').forEach((th, i) => {
      th.addEventListener('click', () => {
        const tbl = th.closest('table');
        const rows = Array.from(tbl.querySelectorAll('tbody tr'));
        const asc = th.dataset.sort !== 'asc';
        rows.sort((a, b) => {
          const at = a.cells[i]?.textContent ?? '';
          const bt = b.cells[i]?.textContent ?? '';
          const an = parseFloat(at), bn = parseFloat(bt);
          return (!isNaN(an) && !isNaN(bn) ? an - bn : at.localeCompare(bt)) * (asc ? 1 : -1);
        });
        th.dataset.sort = asc ? 'asc' : 'desc';
        rows.forEach(r => tbl.querySelector('tbody').appendChild(r));
      });
    });
  });
</script>
</head>
<body>
${body}
</body>
</html>`;
}
