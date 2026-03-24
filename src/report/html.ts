import type { AnalysisReport, AnalysisOptions } from '../types.js';

export interface PlayControllerEntry {
  relativePath: string;
  simpleName:   string;
  status:       'routed' | 'view-referenced' | 'java-referenced' | 'test-only' | 'unreferenced';
  refs: { inRoutes: boolean; inViews: boolean; inJava: boolean; inTests: boolean };
}

export interface PlayReportData {
  controllers: PlayControllerEntry[];
}

interface Row {
  cat:      string;
  catLabel: string;
  catColor: string;
  subject:  string; // plain text — escaped on render
  detail:   string; // HTML-ready (may contain badge markup)
  rec:      string; // plain text — escaped on render
}

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(label: string, color: string): string {
  return `<span class="badge badge-${color}">${esc(label)}</span>`;
}

function overlapRec(aLines: number, bLines: number, sharedLines: number, jaccard: number): string {
  if (aLines === sharedLines && bLines > sharedLines) return 'A is entirely inside B. Consider removing A.';
  if (bLines === sharedLines && aLines > sharedLines) return 'B is entirely inside A. Consider removing B.';
  return `Significant overlap (${(jaccard * 100).toFixed(1)}%). Investigate before removing either.`;
}

function deadStatusBadge(status: PlayControllerEntry['status']): string {
  if (status === 'unreferenced')    return badge('unreferenced', 'red');
  if (status === 'test-only')       return badge('test-only', 'amber');
  if (status === 'view-referenced') return badge('view-referenced', 'grey');
  return badge('java-referenced', 'grey');
}

function deadRec(status: PlayControllerEntry['status']): string {
  if (status === 'unreferenced')    return 'No routes, views, or code references found. Consider removing.';
  if (status === 'test-only')       return 'Referenced only in tests. Verify it is not a forgotten feature.';
  if (status === 'view-referenced') return 'Referenced in views but not routes. Check for direct template calls.';
  return 'Referenced in non-controller Java. Check usage before removing.';
}

export function htmlReport(report: AnalysisReport, _opts: AnalysisOptions = {}, playData?: PlayReportData): string {
  const { highOverlapPairs, zeroContribution, hotLines, consolidationGroups } = report.redundancy;
  const { fragileLines } = report.coverageDepth;

  const partialOverlapPairs = highOverlapPairs.filter(p => p.jaccard < 1.0);

  // ── Build unified row list ──────────────────────────────────────────────────
  const rows: Row[] = [];

  for (const tc of zeroContribution) {
    rows.push({
      cat: 'zero', catLabel: 'Zero-contribution', catColor: 'grey',
      subject: tc.fullName,
      detail:  esc(tc.supersetTest),
      rec:     'All lines covered by a larger test. Consider deleting or merging assertions.',
    });
  }

  for (const p of partialOverlapPairs) {
    rows.push({
      cat: 'overlap', catLabel: 'Overlap', catColor: 'indigo',
      subject: `${p.a} / ${p.b}`,
      detail:  `${(p.jaccard * 100).toFixed(1)}% shared (${p.sharedLines} lines)`,
      rec:     overlapRec(p.aLines, p.bLines, p.sharedLines, p.jaccard),
    });
  }

  for (const g of consolidationGroups) {
    const label = g.describePath ? `${g.describePath} (${g.tests.length} tests)` : `${g.file} (${g.tests.length} tests)`;
    rows.push({
      cat: 'consolidate', catLabel: 'Consolidation', catColor: 'blue',
      subject: label,
      detail:  esc(g.file),
      rec:     g.suggestion === 'it.each'
        ? 'Collapse into a parameterised it.each test.'
        : 'Merge assertions into a single test.',
    });
  }

  for (const h of hotLines) {
    rows.push({
      cat: 'hot', catLabel: 'Hot line', catColor: 'red',
      subject: `${h.source}:${h.line}`,
      detail:  `${h.coveredBy} tests`,
      rec:     `Covered by ${h.coveredBy} tests. Check for redundant variations.`,
    });
  }

  for (const f of fragileLines) {
    rows.push({
      cat: 'fragile', catLabel: 'Fragile', catColor: 'amber',
      subject: `${f.source}:${f.line}`,
      detail:  esc(f.coveredBy),
      rec:     'Only one test covers this line. Add a second for safety.',
    });
  }

  const deadControllers = playData?.controllers.filter(c => c.status !== 'routed') ?? [];
  for (const c of deadControllers) {
    rows.push({
      cat: 'dead', catLabel: 'Dead controller', catColor: 'grey',
      subject: c.relativePath,
      detail:  deadStatusBadge(c.status),
      rec:     deadRec(c.status),
    });
  }

  // ── Categories ──────────────────────────────────────────────────────────────
  type Cat = { cat: string; label: string; color: string; tooltip: string };
  const categories: Cat[] = [
    { cat: 'zero',        label: 'Zero-contribution', color: 'grey',   tooltip: 'Tests whose lines are all covered by a larger test. Safe to delete or merge.' },
    { cat: 'overlap',     label: 'Overlap',            color: 'indigo', tooltip: 'Test pairs with many shared lines. One may be redundant if contained within the other.' },
    { cat: 'consolidate', label: 'Consolidation',      color: 'blue',   tooltip: 'Tests with identical line coverage in the same describe block. Collapse into a parameterised test.' },
    { cat: 'hot',         label: 'Hot lines',          color: 'red',    tooltip: 'Lines hit by many tests. May indicate redundant variations in the test suite.' },
    { cat: 'fragile',     label: 'Fragile lines',      color: 'amber',  tooltip: 'Lines covered by a single test only. A break here would go undetected without a second.' },
    ...(playData ? [{ cat: 'dead', label: 'Dead controllers', color: 'grey', tooltip: 'Controllers not referenced by routes, views, or application code. Candidates for removal.' }] : []),
  ];

  const countByCat: Record<string, number> = {};
  for (const r of rows) countByCat[r.cat] = (countByCat[r.cat] ?? 0) + 1;

  // ── Summary cards ───────────────────────────────────────────────────────────
  function card(cat: string, label: string, count: number, color: string, tooltip: string): string {
    return `<a class="card card-${color}" onclick="return ciFilter('${cat}',this)" title="${esc(tooltip)}">
  <div class="card-count">${count}</div>
  <div class="card-label">${esc(label)}</div>
</a>`;
  }

  const summaryGrid = `<div class="summary-grid">
  ${categories.map(c => card(c.cat, c.label, countByCat[c.cat] ?? 0, c.color, c.tooltip)).join('\n  ')}
</div>`;

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  const toolbar = `<div class="toolbar">
  <input id="ci-search" type="search" placeholder="Filter…" oninput="ciApply()">
</div>`;

  // ── Table ───────────────────────────────────────────────────────────────────
  const tableRows = rows.length === 0
    ? '<tr class="ci-prompt"><td colspan="4" class="none">No findings.</td></tr>'
    : rows.map(r => `<tr data-cat="${r.cat}" class="ci-hidden">
  <td>${badge(r.catLabel, r.catColor)}</td>
  <td class="cell-subject">${esc(r.subject)}</td>
  <td class="cell-detail">${r.detail}</td>
  <td class="cell-rec">${esc(r.rec)}</td>
</tr>`).join('\n');

  const tableHtml = `<table id="ci-table">
<thead>
  <tr>
    <th>Category</th>
    <th>Subject</th>
    <th>Larger test / Detail</th>
    <th>Recommendation</th>
  </tr>
</thead>
<tbody>
${rows.length > 0 ? '<tr class="ci-prompt"><td colspan="4" class="none">Select a category above to filter findings.</td></tr>' : ''}
${tableRows}
</tbody>
</table>`;

  const intro = `<p class="intro">Generated from per-test coverage data. Each finding highlights a specific inefficiency in your test suite. Click a category card to filter the table, or use the search box to narrow by file or test name.</p>`;

  const body = [
    `<h1>coverage-insights</h1>`,
    `<p class="generated">Generated: ${new Date().toISOString()}</p>`,
    intro,
    summaryGrid,
    toolbar,
    tableHtml,
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coverage-insights report</title>
<style>
  :root {
    --blue:   #2563eb; --indigo: #4f46e5; --red:   #dc2626;
    --amber:  #d97706; --green:  #16a34a; --grey:  #6b7280;
    --orange: #ea580c;
    --blue-bg:   #eff6ff; --indigo-bg: #eef2ff; --red-bg:   #fef2f2;
    --amber-bg:  #fffbeb; --green-bg:  #f0fdf4; --grey-bg:  #f9fafb;
    --orange-bg: #fff7ed;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1.5rem 2rem; color: #111; line-height: 1.5; background: #f8f9fa; }
  h1 { font-size: 1.6rem; margin: 0 0 .2rem; }
  .generated { color: #888; font-size: .85rem; margin: 0 0 .75rem; }
  .intro { color: #555; font-size: .88rem; margin: 0 0 1.25rem; max-width: 72ch; }

  /* Summary cards */
  .summary-grid { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: 1.5rem; }
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: .75rem 1rem; border-radius: 8px; min-width: 100px; text-decoration: none; color: inherit; border: 1px solid transparent; cursor: pointer; transition: opacity .15s; }
  .card:hover { opacity: .8; }
  .card-count { font-size: 1.75rem; font-weight: 700; line-height: 1; }
  .card-label { font-size: .72rem; text-align: center; margin-top: .2rem; color: #555; }
  .card-red    { background: var(--red-bg);    border-color: #fecaca; }
  .card-amber  { background: var(--amber-bg);  border-color: #fde68a; }
  .card-blue   { background: var(--blue-bg);   border-color: #bfdbfe; }
  .card-indigo { background: var(--indigo-bg); border-color: #c7d2fe; }
  .card-green  { background: var(--green-bg);  border-color: #bbf7d0; }
  .card-orange { background: var(--orange-bg); border-color: #fed7aa; }
  .card-grey   { background: var(--grey-bg);   border-color: #e5e7eb; }
  .card.card-active { box-shadow: 0 0 0 3px #111; }

  /* Badges */
  .badge { display: inline-block; padding: .15rem .45rem; border-radius: 4px; font-size: .76rem; font-weight: 600; white-space: nowrap; }
  .badge-blue   { background: var(--blue-bg);   color: var(--blue);   border: 1px solid #bfdbfe; }
  .badge-indigo { background: var(--indigo-bg); color: var(--indigo); border: 1px solid #c7d2fe; }
  .badge-red    { background: var(--red-bg);    color: var(--red);    border: 1px solid #fecaca; }
  .badge-amber  { background: var(--amber-bg);  color: var(--amber);  border: 1px solid #fde68a; }
  .badge-green  { background: var(--green-bg);  color: var(--green);  border: 1px solid #bbf7d0; }
  .badge-orange { background: var(--orange-bg); color: var(--orange); border: 1px solid #fed7aa; }
  .badge-grey   { background: var(--grey-bg);   color: var(--grey);   border: 1px solid #e5e7eb; }

  /* Toolbar */
  .toolbar { margin-bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; }
  #ci-search { padding: 7px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; width: 300px; font-family: inherit; outline: none; }
  #ci-search:focus { border-color: #6b7280; }
  .filter-btns { display: flex; gap: .4rem; flex-wrap: wrap; }
  .fbtn { padding: 4px 12px; border-radius: 20px; border: 1px solid #d1d5db; background: white; cursor: pointer; font-size: 12px; font-family: inherit; transition: background .1s; }
  .fbtn:hover { background: #f3f4f6; }
  .fbtn.active { background: #111; color: white; border-color: #111; }

  /* Table */
  #ci-table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); font-size: 13px; }
  #ci-table th { text-align: left; padding: 9px 12px; background: #f3f4f6; border-bottom: 2px solid #e5e7eb; font-size: 12px; white-space: nowrap; cursor: pointer; user-select: none; }
  #ci-table th:hover { background: #e5e7eb; }
  #ci-table td { padding: 7px 12px; border-bottom: 1px solid #f3f4f6; vertical-align: top; font-size: 12px; }
  #ci-table tr:hover td { background: #fafafa; }
  #ci-table tr.ci-hidden { display: none; }
  #ci-table { table-layout: fixed; }
  #ci-table th:nth-child(1) { width: 11%; }
  #ci-table th:nth-child(2) { width: 30%; }
  #ci-table th:nth-child(3) { width: 27%; }
  #ci-table th:nth-child(4) { width: 32%; }
  .cell-subject { font-family: monospace; word-break: break-all; }
  .cell-detail  { font-family: monospace; color: #555; word-break: break-all; }
  .cell-rec     { color: #374151; }
  .none { color: #9ca3af; font-style: italic; padding: 1rem; display: block; }
</style>
<script>
  let ciActive = null;

  function ciFilter(cat, btn) {
    if (ciActive === cat) {
      ciActive = null;
    } else {
      ciActive = cat;
      document.querySelectorAll('.summary-grid .card').forEach(c => c.classList.remove('card-active'));
      btn.classList.add('card-active');
    }
    ciApply();
    return false;
  }

  function ciApply() {
    const q       = (document.getElementById('ci-search')?.value ?? '').toLowerCase().trim();
    const prompt  = document.querySelector('#ci-table .ci-prompt');
    const hasFilter = ciActive !== null || q.length > 0;
    if (prompt) prompt.classList.toggle('ci-hidden', hasFilter);
    document.querySelectorAll('#ci-table tbody tr[data-cat]').forEach(row => {
      const matchCat  = ciActive === null || row.dataset.cat === ciActive;
      const matchText = !q || (row.textContent ?? '').toLowerCase().includes(q);
      row.classList.toggle('ci-hidden', !(hasFilter && matchCat && matchText));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Sortable column headers
    document.querySelectorAll('#ci-table th').forEach((th, i) => {
      th.addEventListener('click', () => {
        const tbody = th.closest('table').querySelector('tbody');
        const rows  = Array.from(tbody.querySelectorAll('tr[data-cat]'));
        const asc   = th.dataset.sort !== 'asc';
        rows.sort((a, b) => {
          const at = a.cells[i]?.textContent ?? '';
          const bt = b.cells[i]?.textContent ?? '';
          const an = parseFloat(at), bn = parseFloat(bt);
          return (!isNaN(an) && !isNaN(bn) ? an - bn : at.localeCompare(bt)) * (asc ? 1 : -1);
        });
        th.dataset.sort = asc ? 'asc' : 'desc';
        rows.forEach(r => tbody.appendChild(r));
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
