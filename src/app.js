// Search orchestrator. State is the URL — every search updates the
// query string so a result page is shareable and the back button works.
//
// The stat block and monthly bar chart used to live on a separate
// "Deep Dive" page; now they sit between the filters and the results
// here so a single search produces both the temporal shape and the
// readable hits in one view. Bars on the chart act as date-range
// filter shortcuts: click a month, the result list scopes to it.

import { searchGovInfo, fetchGranuleText } from './api.js?v=19';
import { escapeHtml, renderResultRow, snippetHtml } from './format.js?v=19';

const $ = (id) => document.getElementById(id);
const $form = $('search-form');
const $q = $('q');
const $stamp = $('index-stamp');
const $status = $('status');
const $stats = $('stats');
const $chartWrap = $('chart-wrap');
const $chart = $('chart');
const $results = $('results');
const $loadMore = $('load-more');
const $datePresets = $('date-presets');
const $customDates = $('custom-dates');
const $fromDate = $('from-date');
const $toDate = $('to-date');
const $collections = $('collections');

const ALL_COLLECTIONS = ['CREC', 'BILLS', 'CHRG', 'FR', 'CRPT'];
const DEFAULT_COLLECTIONS = new Set(['CREC']);

const state = {
  term: '',
  collections: new Set(DEFAULT_COLLECTIONS),
  preset: 'year',
  fromDate: '',
  toDate: '',
  // monthFilter is the inner filter set by clicking a chart bar.
  // Format "YYYY-MM" or null. The chart always uses the outer range
  // (preset/from/to) so it doesn't collapse to a single bar; the
  // result list scopes to monthFilter when set, otherwise outer range.
  monthFilter: null,
  offsetMark: '*',
  items: [],
  total: 0,
};

// ---------- date presets ----------

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

function dateRangeForPreset(preset) {
  const today = todayIso();
  if (preset === 'month') return { from: isoDaysAgo(31), to: today };
  if (preset === 'year') return { from: isoDaysAgo(365), to: today };
  if (preset === 'five') return { from: isoDaysAgo(365 * 5), to: today };
  return { from: state.fromDate, to: state.toDate };
}

// ---------- URL state ----------

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.term = p.get('q') || '';
  const cols = p.get('col');
  if (cols) {
    state.collections = new Set(cols.split(',').filter((c) => ALL_COLLECTIONS.includes(c)));
    if (!state.collections.size) state.collections = new Set(DEFAULT_COLLECTIONS);
  }
  const preset = p.get('range');
  if (['month', 'year', 'five', 'custom'].includes(preset)) state.preset = preset;
  if (state.preset === 'custom') {
    state.fromDate = p.get('from') || '';
    state.toDate = p.get('to') || '';
  }
  const month = p.get('month');
  if (month && /^\d{4}-\d{2}$/.test(month)) state.monthFilter = month;
}

function writeUrl({ replace = false } = {}) {
  const p = new URLSearchParams();
  if (state.term) p.set('q', state.term);
  if (state.collections.size && !sameSet(state.collections, DEFAULT_COLLECTIONS)) {
    p.set('col', [...state.collections].join(','));
  }
  if (state.preset !== 'year') p.set('range', state.preset);
  if (state.preset === 'custom') {
    if (state.fromDate) p.set('from', state.fromDate);
    if (state.toDate) p.set('to', state.toDate);
  }
  if (state.monthFilter) p.set('month', state.monthFilter);
  const url = `${location.pathname}${p.toString() ? '?' + p.toString() : ''}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------- search ----------

async function runSearch({ append = false, monthOnly = false } = {}) {
  if (!state.term.trim()) {
    setStatus('Type a term to search.');
    return;
  }
  if (!state.collections.size) {
    setStatus('Pick at least one collection.');
    return;
  }
  // Outer (chart) range from the preset/custom inputs.
  const { from: outerFrom, to: outerTo } = dateRangeForPreset(state.preset);
  if (!outerFrom || !outerTo) {
    setStatus('Pick a date range.');
    return;
  }
  // Inner (result) range — the month filter clamps onto the outer range.
  const resultFrom = state.monthFilter ? monthStart(state.monthFilter) : outerFrom;
  const resultTo = state.monthFilter ? monthEnd(state.monthFilter) : outerTo;

  setStatus(append ? 'Loading more…' : 'Searching…');
  $loadMore.disabled = true;
  $form.classList.add('is-loading');
  // Fresh search (not append, not month-only) clears the visible chart
  // so the user knows it's about to refresh. monthOnly preserves the
  // chart entirely; append touches neither.
  if (!append && !monthOnly) {
    $stats.innerHTML = '';
    $chart.innerHTML = '';
    $chartWrap.hidden = true;
  }
  paintMonthFilter();
  try {
    const collections = [...state.collections];
    // Chart only re-fans-out on a fresh search. Append and month-only
    // skip — the chart is unchanged in those cases.
    const chartPromise = !append && !monthOnly
      ? buildOverview({ from: outerFrom, to: outerTo, collections })
      : null;

    const res = await searchGovInfo({
      term: state.term,
      collections,
      fromDate: resultFrom,
      toDate: resultTo,
      pageSize: 20,
      offsetMark: append ? state.offsetMark : '*',
    });
    if (!append) {
      state.items = res.items;
      $results.replaceChildren();
    } else {
      state.items = state.items.concat(res.items);
    }
    state.total = res.total;
    state.offsetMark = res.nextOffset || '*';
    appendRows(res.items);
    fillSnippets(res.items, state.term);
    const moreAvailable = state.items.length < state.total;
    $loadMore.hidden = !moreAvailable;
    $loadMore.disabled = false;
    if (state.total === 0) {
      setStatus(state.monthFilter
        ? `No results in ${monthLabel(state.monthFilter)}. Click the active bar again to clear the month filter.`
        : `No results. Try broadening the date range or removing collections.`);
    } else if (state.monthFilter) {
      setStatus(`Showing ${state.items.length} of ${state.total.toLocaleString()} results in ${monthLabel(state.monthFilter)}.`);
    } else {
      setStatus(`Showing ${state.items.length} of ${state.total.toLocaleString()} results.`);
    }

    if (chartPromise) {
      try {
        const overview = await chartPromise;
        if (overview) {
          renderOverview(overview);
          paintMonthFilter();
        }
      } catch { /* chart silent fail */ }
    }
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
    $loadMore.disabled = false;
  } finally {
    $form.classList.remove('is-loading');
  }
}

// Apply / clear the visual highlight on the chart bar matching
// state.monthFilter, and toggle the chip showing what's filtered.
function paintMonthFilter() {
  const buttons = $chart.querySelectorAll('button.dd-col');
  for (const btn of buttons) {
    btn.classList.toggle('is-active', btn.dataset.month === state.monthFilter);
  }
  const chip = $('month-filter-chip');
  if (!chip) return;
  if (state.monthFilter) {
    chip.hidden = false;
    chip.innerHTML = `
      <span>Scoped to <strong>${escapeHtml(monthLabel(state.monthFilter))}</strong></span>
      <button type="button" class="lda-filter-chip-clear" aria-label="Clear month filter">×</button>
    `;
  } else {
    chip.hidden = true;
    chip.innerHTML = '';
  }
}

// ---------- overview: stat block + monthly chart ----------

async function buildOverview({ from, to, collections }) {
  const months = monthsInRange(from, to);
  if (months.length === 0 || months.length > 144) return null;
  const counts = new Array(months.length).fill(0);
  let i = 0;
  const worker = async () => {
    while (i < months.length) {
      const idx = i++;
      const m = months[idx];
      try {
        const r = await searchGovInfo({
          term: state.term, collections,
          fromDate: monthStart(m), toDate: monthEnd(m), pageSize: 1,
        });
        counts[idx] = r.total;
      } catch { /* leave as 0 */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Bookends: first mention (ASC) + most recent (DESC). Most recent is
  // already the top of the visible result list, but we want the date
  // alone for the stat cell — separate pageSize=1 query is fine.
  let firstMention = null, mostRecent = null;
  try {
    const [oldest, newest] = await Promise.all([
      searchGovInfo({
        term: state.term, collections, fromDate: from, toDate: to,
        pageSize: 1, sortField: 'dateIssued', sortOrder: 'ASC',
      }),
      searchGovInfo({
        term: state.term, collections, fromDate: from, toDate: to,
        pageSize: 1, sortField: 'dateIssued', sortOrder: 'DESC',
      }),
    ]);
    firstMention = oldest.items[0] || null;
    mostRecent = newest.items[0] || null;
  } catch { /* let stats render without bookends */ }

  const total = counts.reduce((a, b) => a + b, 0);
  const peakIdx = counts.reduce((bi, v, i) => v > counts[bi] ? i : bi, 0);
  return {
    months, counts, total,
    peakMonth: total > 0 ? months[peakIdx] : null,
    peakCount: total > 0 ? counts[peakIdx] : 0,
    firstMention, mostRecent,
  };
}

function renderOverview({ months, counts, total, peakMonth, peakCount, firstMention, mostRecent }) {
  if (total === 0) {
    $stats.innerHTML = '';
    $chartWrap.hidden = true;
    return;
  }
  // Stat block
  const cells = [
    { num: total.toLocaleString(), label: total === 1 ? 'contribution' : 'contributions' },
    {
      num: peakMonth ? monthLabel(peakMonth) : '—',
      label: peakCount ? `peak: ${peakCount.toLocaleString()} hit${peakCount === 1 ? '' : 's'}` : 'peak month',
    },
    {
      num: firstMention ? formatDateShort(firstMention.date) : '—',
      label: firstMention ? `first: ${truncate(firstMention.title, 36)}` : 'first mention',
    },
    {
      num: mostRecent ? formatDateShort(mostRecent.date) : '—',
      label: mostRecent ? `latest: ${truncate(mostRecent.title, 36)}` : 'most recent',
    },
  ];
  $stats.innerHTML = cells.map((c) =>
    `<div class="lda-stat"><span class="lda-stat-num">${escapeHtml(c.num)}</span><span class="lda-stat-label">${escapeHtml(c.label)}</span></div>`
  ).join('');
  // Chart
  renderChart(months, counts);
  $chartWrap.hidden = false;
}

function renderChart(months, counts) {
  const max = Math.max(...counts, 1);
  // Year labels: empty for every month except the first month of each
  // distinct year in the range. That gives 1-2 labels for a year-long
  // range, 5-6 for a five-year range — clean horizontal axis with no
  // truncated month-name clutter.
  const yearLabels = months.map((m, i) => {
    const y = m.split('-')[0];
    if (i === 0 || y !== months[i - 1].split('-')[0]) return y;
    return '';
  });
  const cols = months.map((m, i) => {
    const v = counts[i] || 0;
    const h = max > 0 ? (v / max * 100) : 0;
    return `<button type="button" class="dd-col" data-month="${m}" data-count="${v}" title="${escapeHtml(monthLabel(m))}: ${v.toLocaleString()} — click to scope results to this month">
      <div class="dd-col-bar" style="height:${h.toFixed(1)}%"></div>
    </button>`;
  }).join('');
  const xLabels = yearLabels.map((label) =>
    `<div class="dd-x-label">${escapeHtml(label)}</div>`
  ).join('');
  $chart.innerHTML = `
    <div class="dd-axis-y"><span>${max.toLocaleString()}</span><span>0</span></div>
    <div class="dd-cols">${cols}</div>
    <div class="dd-axis-y-spacer" aria-hidden="true"></div>
    <div class="dd-axis-x">${xLabels}</div>
  `;
}

// ---------- chart helpers (month math, date formatting) ----------

function monthsInRange(fromIso, toIso) {
  const months = [];
  const [fy, fm] = fromIso.split('-').map(Number);
  const [ty, tm] = toIso.split('-').map(Number);
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}
function monthStart(ym) { return `${ym}-01`; }
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${y}`;
}
function formatDateShort(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}
function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function appendRows(items) {
  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(renderResultRow(item));
  $results.appendChild(frag);
}

// Fetch document text for each visible result and inject a snippet
// around the search term. Bounded concurrency 4 — high enough to feel
// quick on a typical 20-row page, low enough to stay polite to the
// proxy and friendly to mobile memory. Failures are silent: a row that
// can't load a snippet just stays title-only. Works across CREC, BILLS,
// CHRG, FR, CRPT — they all wrap the body in <pre> the same way.
async function fillSnippets(items, term) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      if (!item.txtLink) continue; // some collections lack a text URL
      const row = $results.querySelector(`li[data-id="${cssEscapeAttr(item.id)}"] .result-snippet`);
      if (!row) continue;
      try {
        const text = await fetchGranuleText(item.txtLink);
        if (!text) { row.dataset.snippet = 'empty'; continue; }
        row.innerHTML = snippetHtml(text, term);
        row.dataset.snippet = 'loaded';
      } catch {
        row.dataset.snippet = 'failed';
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// CSS attribute selectors don't tolerate quotes / brackets in the value.
// CREC granule IDs only contain ASCII alphanumerics and hyphens, but
// belt-and-braces: escape the few characters that could trip the parser.
function cssEscapeAttr(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

// ---------- filter UI wiring ----------

function paintDatePresets() {
  for (const btn of $datePresets.querySelectorAll('button')) {
    const active = btn.dataset.preset === state.preset;
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  }
  $customDates.hidden = state.preset !== 'custom';
  if (state.preset === 'custom') {
    $fromDate.value = state.fromDate || '';
    $toDate.value = state.toDate || '';
  }
}

function paintCollections() {
  for (const btn of $collections.querySelectorAll('button')) {
    const on = state.collections.has(btn.dataset.collection);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

$datePresets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-preset]');
  if (!btn) return;
  state.preset = btn.dataset.preset;
  paintDatePresets();
});

$collections.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-collection]');
  if (!btn) return;
  const code = btn.dataset.collection;
  if (state.collections.has(code)) state.collections.delete(code);
  else state.collections.add(code);
  if (!state.collections.size) state.collections.add(code); // never empty
  paintCollections();
});

$fromDate.addEventListener('change', () => { state.fromDate = $fromDate.value; });
$toDate.addEventListener('change', () => { state.toDate = $toDate.value; });

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.term = $q.value.trim();
  // A fresh term invalidates any month scope — clear it so the chart
  // and result list both reflect the new search cleanly.
  state.monthFilter = null;
  writeUrl();
  runSearch({ append: false });
});

$loadMore.addEventListener('click', () => runSearch({ append: true }));

// Bars are filter shortcuts — click a month, the result list scopes
// to it (chart stays put, the bar tints red). Click the same bar
// again to clear. Click a different bar to switch in place.
$chart.addEventListener('click', (e) => {
  const btn = e.target.closest('button.dd-col');
  if (!btn) return;
  const month = btn.dataset.month;
  const count = Number(btn.dataset.count) || 0;
  if (!month || count === 0) return;
  state.monthFilter = state.monthFilter === month ? null : month;
  writeUrl();
  runSearch({ append: false, monthOnly: true });
});

// Chip × clears the month filter and re-runs the result query.
const $monthChip = $('month-filter-chip');
if ($monthChip) {
  $monthChip.addEventListener('click', (e) => {
    if (!e.target.closest('.lda-filter-chip-clear')) return;
    state.monthFilter = null;
    writeUrl();
    runSearch({ append: false, monthOnly: true });
  });
}

window.addEventListener('popstate', () => {
  readUrl();
  $q.value = state.term;
  paintDatePresets();
  paintCollections();
  if (state.term) runSearch({ append: false });
});

// ---------- init ----------

readUrl();
$q.value = state.term;
paintDatePresets();
paintCollections();
$stamp.textContent = '';
if (state.term) {
  runSearch({ append: false });
} else {
  setStatus('Type a term to search the Congressional Record.');
}
