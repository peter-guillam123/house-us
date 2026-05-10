// Lobbying tab: loads gzipped LD-2 shards from the repo and searches
// client-side. AU-pattern. Each quarter is one ~5MB gzipped shard;
// decompression via the browser's native DecompressionStream.
//
// Why client-side: the data's published by quarter, doesn't change
// between drops, and the journalistic queries — full-text search of
// the issue-description field, plus filters on registrant/client/issue
// code — fit a "load shard, regex it" model perfectly. Same plumbing
// shape as House AU's Hansard search.

import { escapeHtml, formatDate, deShout, snippetHtml } from './format.js?v=12';

const $ = (id) => document.getElementById(id);
const $form = $('lobbying-form');
const $q = $('q');
const $stamp = $('index-stamp');
const $status = $('status');
const $aggregate = $('lda-aggregate');
const $overview = $('lda-overview');
const $filterChip = $('lda-filter-chip');
const $results = $('results');
const $loadMore = $('load-more');
const $quarter = $('quarter');
const $issueCode = $('issue-code');

// Manifest of available quarter shards. Add new entries as backfill lands.
const QUARTERS = [
  { year: 2026, quarter: 1, file: 'lda-2026-Q1.json.gz' },
];

const PAGE = 25;

const state = {
  shardKey: null,        // "2026-1"
  filings: [],           // all filings in current shard
  filtered: [],          // after term/code filter
  shown: 0,              // how many of `filtered` rendered so far
  term: '',
  code: '',
  loadingShard: null,    // promise while a shard's loading
  barMax: 1,             // 95th-percentile dollar value, scales the row bars
};

// ---------- shard loading ----------

const shardCache = new Map();

async function loadShard(year, quarter) {
  const key = `${year}-${quarter}`;
  if (shardCache.has(key)) return shardCache.get(key);
  const meta = QUARTERS.find((q) => q.year === year && q.quarter === quarter);
  if (!meta) throw new Error(`No data for ${year} Q${quarter}`);
  const p = (async () => {
    const r = await fetch(meta.file);
    if (!r.ok) throw new Error(`${meta.file}: ${r.status}`);
    const stream = r.body.pipeThrough(new DecompressionStream('gzip'));
    const data = await new Response(stream).json();
    return data;
  })();
  shardCache.set(key, p);
  return p;
}

// ---------- search ----------

function matches(f, needle, code) {
  if (code && !f.activities.some((a) => a.code === code)) return false;
  if (!needle) return true;
  if ((f.registrant || '').toLowerCase().includes(needle)) return true;
  if ((f.client || '').toLowerCase().includes(needle)) return true;
  for (const a of f.activities) {
    if ((a.description || '').toLowerCase().includes(needle)) return true;
    if ((a.lobbyists || []).some((l) => l.toLowerCase().includes(needle))) return true;
    if ((a.targets || []).some((t) => t.toLowerCase().includes(needle))) return true;
  }
  return false;
}

function runSearch() {
  const needle = state.term.trim().toLowerCase();
  state.filtered = state.filings.filter((f) => matches(f, needle, state.code));
  // Sort: most-recently-posted first, ties broken by registrant name.
  state.filtered.sort((a, b) => {
    if (b.posted !== a.posted) return (b.posted || '').localeCompare(a.posted || '');
    return (a.registrant || '').localeCompare(b.registrant || '');
  });
  // Aggregates: stats banner + 95th-percentile clamp for the per-row bars.
  // 95th-percentile rather than max protects readability when a single
  // outlier (a $40M in-house lobbying disclosure) would otherwise shrink
  // every other bar to nothing.
  const agg = computeAggregates(state.filtered);
  state.barMax = agg.p95 || 1;
  $aggregate.innerHTML = renderAggregate(agg);
  $overview.innerHTML = renderTopClientsChart(agg.topClients) + renderLeaderboards(agg);
  renderFilterChip();
  state.shown = 0;
  $results.replaceChildren();
  renderMore();
  setStatus(
    state.filtered.length === 0
      ? 'No filings match. Try a broader term or change the issue filter.'
      : `Showing ${Math.min(state.shown, state.filtered.length)} of ${state.filtered.length.toLocaleString()} filings.`
  );
}

function computeAggregates(filings) {
  let total = 0;
  const registrants = new Set();
  const lobbyists = new Set();
  const issues = new Map();
  const dollars = [];
  // Per-entity totals for the leaderboards and the top-clients chart.
  const clientMoney = new Map();
  const firmStats = new Map();   // registrant -> {count, money}
  const lobbyistCount = new Map();
  // Biggest single filings — kept as we iterate, sorted at the end.
  const biggestFilings = [];

  for (const f of filings) {
    const dollar = parseFloat(f.income || f.expenses || 0);
    if (dollar > 0) { total += dollar; dollars.push(dollar); }
    if (f.registrant) registrants.add(f.registrant);
    if (f.client) {
      clientMoney.set(f.client, (clientMoney.get(f.client) || 0) + dollar);
    }
    if (f.registrant) {
      const cur = firmStats.get(f.registrant) || { count: 0, money: 0 };
      cur.count += 1;
      cur.money += dollar;
      firmStats.set(f.registrant, cur);
    }
    if (dollar > 0) {
      biggestFilings.push({ key: f.client || f.registrant || '(unknown)', value: dollar, period: f.period, url: f.url });
    }
    for (const a of f.activities || []) {
      for (const l of a.lobbyists || []) {
        if (l) {
          lobbyists.add(l);
          lobbyistCount.set(l, (lobbyistCount.get(l) || 0) + 1);
        }
      }
      if (a.code) {
        const cur = issues.get(a.code) || { label: a.label || a.code, count: 0 };
        cur.count += 1;
        issues.set(a.code, cur);
      }
    }
  }
  let topIssue = null;
  for (const v of issues.values()) {
    if (!topIssue || v.count > topIssue.count) topIssue = v;
  }
  dollars.sort((a, b) => a - b);
  const p95 = dollars.length ? dollars[Math.floor(dollars.length * 0.95)] : 0;

  // Top 10 by relevant metric for each board.
  const topClients = [...clientMoney.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, value]) => ({ key, value }));
  const topFirms = [...firmStats.entries()]
    .sort((a, b) => b[1].money - a[1].money || b[1].count - a[1].count)
    .slice(0, 10)
    .map(([key, v]) => ({ key, value: v.money, count: v.count }));
  const topLobbyists = [...lobbyistCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, value]) => ({ key, value }));
  const topIssues = [...issues.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([, v]) => ({ key: v.label, value: v.count }));
  biggestFilings.sort((a, b) => b.value - a.value);
  const topBiggest = biggestFilings.slice(0, 10);

  return {
    count: filings.length, total,
    registrants: registrants.size,
    lobbyists: lobbyists.size,
    topIssue, p95,
    topClients, topFirms, topLobbyists, topIssues, topBiggest,
  };
}

// Stat block above the result list — serif display numbers with mono-caps
// captions, so the figures read as the dominant thing on the page rather
// than a footnote. Five cells: filings, total disclosed, firms, lobbyists,
// top issue. Wraps to a grid on narrow viewports.
function renderAggregate(agg) {
  if (!agg.count) return '';
  const cells = [
    { num: agg.count.toLocaleString(), label: agg.count === 1 ? 'filing' : 'filings' },
    { num: formatMoneyShort(agg.total), label: 'disclosed' },
    { num: agg.registrants.toLocaleString(), label: agg.registrants === 1 ? 'firm' : 'firms' },
    { num: agg.lobbyists.toLocaleString(), label: agg.lobbyists === 1 ? 'lobbyist' : 'lobbyists' },
  ];
  if (agg.topIssue) {
    cells.push({ num: escapeHtml(agg.topIssue.label), label: 'top issue' });
  }
  return cells.map((c) =>
    `<div class="lda-stat"><span class="lda-stat-num">${c.num}</span><span class="lda-stat-label">${c.label}</span></div>`
  ).join('');
}

function formatMoneyShort(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// Top-clients horizontal bar chart — fills the slot UK Deep Dive uses
// for the monthly volume chart. With one quarter we can't do time
// series, so the editorial question this answers is "who's spending
// most" rather than "when's the spend happening."
function renderTopClientsChart(items) {
  if (!items || !items.length) return '';
  const max = items[0].value || 1;
  const rows = items.map(({ key, value }) => {
    const pct = (value / max * 100).toFixed(1);
    return `<li class="lda-chart-row">
      <span class="lda-chart-label" title="${escapeHtml(deShout(key))}">${escapeHtml(deShout(key))}</span>
      <span class="lda-chart-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
      <span class="lda-chart-val">${formatMoneyShort(value)}</span>
    </li>`;
  }).join('');
  return `<section class="lda-overview-section">
    <h3 class="lda-overview-h">Top clients by disclosed spend</h3>
    <ol class="lda-chart">${rows}</ol>
  </section>`;
}

// Four leaderboards — UK Deep Dive's three-board pattern stretched
// to four because the editorial cuts that matter for lobbying don't
// collapse cleanly to three. Targets dropped (mostly noise: Congress
// targets dominate every list); top issues and biggest single filings
// added in their place. The grid wraps to 2x2 / 1-column on narrower
// viewports.
function renderLeaderboards(agg) {
  const boards = [
    {
      title: 'Top firms by disclosed',
      items: agg.topFirms,
      formatValue: (it) => formatMoneyShort(it.value),
    },
    {
      title: 'Most active lobbyists',
      items: agg.topLobbyists,
      formatValue: (it) => String(it.value),
    },
    {
      title: 'Top issues by activities',
      items: agg.topIssues,
      formatValue: (it) => String(it.value),
    },
    {
      title: 'Biggest single filings',
      items: agg.topBiggest,
      formatValue: (it) => formatMoneyShort(it.value),
    },
  ];
  const html = boards.map((b) => {
    if (!b.items || !b.items.length) return '';
    const rows = b.items.map((it, i) =>
      `<li>
        <span class="lda-rank">${i + 1}</span>
        <span class="lda-name" title="${escapeHtml(deShout(it.key))}">${escapeHtml(deShout(it.key))}</span>
        <span class="lda-val">${b.formatValue(it)}</span>
      </li>`
    ).join('');
    return `<div class="lda-board">
      <h3 class="lda-overview-h">${b.title}</h3>
      <ol class="lda-board-list">${rows}</ol>
    </div>`;
  }).join('');
  return html ? `<section class="lda-boards">${html}</section>` : '';
}

function renderMore() {
  const slice = state.filtered.slice(state.shown, state.shown + PAGE);
  const frag = document.createDocumentFragment();
  for (const f of slice) frag.appendChild(renderRow(f, state.term.trim(), state.barMax, state.code));
  $results.appendChild(frag);
  state.shown += slice.length;
  $loadMore.hidden = state.shown >= state.filtered.length;
  if (state.filtered.length > 0) {
    setStatus(`Showing ${state.shown} of ${state.filtered.length.toLocaleString()} filings.`);
  }
}

// ---------- rendering ----------

function formatMoney(income, expenses) {
  const n = income != null ? income : expenses;
  const label = income != null ? 'income' : 'expenses';
  if (n == null) return '';
  const num = parseFloat(n);
  if (isNaN(num) || num === 0) return income != null ? '$0 income' : '';
  return `$${Math.round(num).toLocaleString('en-US')} ${label}`;
}

function highlight(text, needle) {
  if (!text) return '';
  const safe = escapeHtml(text);
  if (!needle) return safe;
  const escNeedle = escapeRegex(escapeHtml(needle));
  return safe.replace(new RegExp(`(${escNeedle})`, 'ig'), '<mark>$1</mark>');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function renderRow(f, term, barMax, activeCode) {
  const li = document.createElement('li');
  li.className = 'result lda-result';

  const money = formatMoney(f.income, f.expenses);
  const dollar = parseFloat(f.income || f.expenses || 0);
  // Bar width is this filing's $ as a fraction of the 95th-percentile of
  // the filtered set. Filings above the p95 max out at 100%. No money
  // disclosed -> no bar.
  const barPct = barMax > 0 && dollar > 0
    ? Math.min(100, (dollar / barMax) * 100)
    : 0;
  const barHtml = barPct > 0
    ? `<span class="lda-money-bar" aria-hidden="true"><span style="width:${barPct.toFixed(1)}%"></span></span>`
    : '';
  // Bar + money grouped as one flex item so they sit tight together
  // rather than picking up the meta row's column gap between them.
  const moneyHtml = money
    ? `<span class="lda-money">${barHtml}<span class="result-money">${escapeHtml(money)}</span></span>`
    : '';

  const registrant = deShout(f.registrant || '(no registrant)');
  const client = deShout(f.client || '(no client)');
  const headline = `${escapeHtml(registrant)} <span class="lda-arrow" aria-hidden="true">→</span> <span class="lda-client">${escapeHtml(client)}</span>`;
  // Title is the link out to the filing — drops the redundant "View
  // filing" eyebrow that used to sit in the meta row.
  const titleHtml = f.url
    ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${headline}</a>`
    : headline;

  // Each filing has 1..N activities — issue + description. The issue
  // label sits inline at the start of the description as a small pill.
  // When a code filter is active we render only the matching activity
  // rows, so the user sees what scoped the result rather than a
  // mixed-issue block that reads as "the filter didn't work".
  const visible = activeCode
    ? (f.activities || []).filter((a) => a.code === activeCode)
    : (f.activities || []);
  const hidden = (f.activities || []).length - visible.length;
  const activitiesHtml = visible.map((a) => {
    const codeBit = a.code
      ? `<button type="button" class="lda-code" data-code="${escapeHtml(a.code)}" title="Filter to ${escapeHtml(a.label || a.code)}">${escapeHtml(a.label || a.code)}</button> `
      : '';
    const descBit = a.description
      ? `<p class="lda-desc">${codeBit}${snippetHtml(a.description, term, 360)}</p>`
      : `<p class="lda-desc muted">${codeBit}<span>(no description provided)</span></p>`;
    const lobByists = (a.lobbyists || []).map((l) => deShout(l));
    const lobBit = lobByists.length
      ? `<p class="lda-meta-line">Lobbyists: ${lobByists.map((l) => highlight(l, term)).join(', ')}</p>`
      : '';
    const targets = (a.targets || []).map((t) => deShout(t));
    const tgtBit = targets.length
      ? `<p class="lda-meta-line">Targets: ${targets.slice(0, 6).map((t) => highlight(t, term)).join(', ')}${targets.length > 6 ? `, +${targets.length - 6} more` : ''}</p>`
      : '';
    return `<div class="lda-activity">${descBit}${lobBit}${tgtBit}</div>`;
  }).join('');
  // Footnote when activities were hidden by the filter — clear cue that
  // there's more to this filing if the user clears the filter.
  const hiddenNote = hidden > 0
    ? `<p class="lda-hidden-note">+ ${hidden} other ${hidden === 1 ? 'activity' : 'activities'} not shown (cleared by removing the filter)</p>`
    : '';

  li.innerHTML = `
    <h2 class="result-title">${titleHtml}</h2>
    <div class="result-meta">
      <span class="badge src-bills">LD-2</span>
      <span class="result-date">${escapeHtml(f.period || '')} ${f.year || ''}</span>
      ${moneyHtml}
    </div>
    ${activitiesHtml}
    ${hiddenNote}
  `;
  return li;
}

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

// Visible cue when a code filter's active. Click the × to clear; the
// dropdown and the row activities re-render in sync.
function renderFilterChip() {
  if (!state.code) {
    $filterChip.hidden = true;
    $filterChip.innerHTML = '';
    return;
  }
  // Find the human label for the current code by looking it up in the
  // shard's first matching activity.
  let label = state.code;
  for (const f of state.filings) {
    const a = (f.activities || []).find((x) => x.code === state.code);
    if (a) { label = a.label || a.code; break; }
  }
  $filterChip.hidden = false;
  $filterChip.innerHTML = `
    <span class="lda-filter-chip-label">Filtered to <strong>${escapeHtml(label)}</strong></span>
    <button type="button" class="lda-filter-chip-clear" aria-label="Clear filter">×</button>
  `;
}

// ---------- filter wiring ----------

function populateQuarterDropdown() {
  $quarter.innerHTML = QUARTERS.map((q) =>
    `<option value="${q.year}-${q.quarter}">${q.year} Q${q.quarter}</option>`
  ).join('');
}

function populateIssueCodeDropdown(filings) {
  const codes = new Map();
  for (const f of filings) {
    for (const a of f.activities || []) {
      if (a.code) codes.set(a.code, a.label || a.code);
    }
  }
  const sorted = [...codes.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  $issueCode.innerHTML = '<option value="">Any issue</option>' +
    sorted.map(([code, label]) => `<option value="${escapeHtml(code)}">${escapeHtml(label)}</option>`).join('');
}

$quarter.addEventListener('change', async () => {
  const [year, quarter] = $quarter.value.split('-').map(Number);
  await switchToShard(year, quarter);
  if (state.term || state.code) runSearch();
});

$issueCode.addEventListener('change', () => {
  state.code = $issueCode.value;
  runSearch();
});

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.term = $q.value.trim();
  runSearch();
});

$loadMore.addEventListener('click', () => renderMore());

// Clear the active filter from the chip's × button.
$filterChip.addEventListener('click', (e) => {
  if (!e.target.closest('.lda-filter-chip-clear')) return;
  state.code = '';
  $issueCode.value = '';
  runSearch();
});

// Issue lozenges in result rows are filter shortcuts. Click toggles the
// code filter — clicking the same lozenge again clears it. Sync the
// dropdown so the canonical "current filter" UI stays coherent. Scroll
// the aggregate stat block back into view so the new result-set scope
// is what the user sees first.
$results.addEventListener('click', (e) => {
  const btn = e.target.closest('button.lda-code');
  if (!btn) return;
  const code = btn.dataset.code;
  if (!code) return;
  state.code = state.code === code ? '' : code;
  $issueCode.value = state.code;
  runSearch();
  $aggregate.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- init ----------

async function switchToShard(year, quarter) {
  const key = `${year}-${quarter}`;
  state.shardKey = key;
  setStatus(`Loading ${year} Q${quarter}…`);
  $stamp.textContent = `Loading ${year} Q${quarter}…`;
  try {
    const data = await loadShard(year, quarter);
    state.filings = data.filings || [];
    populateIssueCodeDropdown(state.filings);
    $stamp.textContent = `${data.count.toLocaleString()} filings · ${data.year} Q${data.quarter}`;
    setStatus(`Ready. ${data.count.toLocaleString()} filings loaded — type a term to search.`);
  } catch (err) {
    $stamp.textContent = '';
    setStatus(`Failed to load ${year} Q${quarter}: ${err.message}`, true);
  }
}

populateQuarterDropdown();
const first = QUARTERS[0];
switchToShard(first.year, first.quarter);
