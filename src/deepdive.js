// Deep Dive v0: a topic over time across Congress.
//
// Data shape: GovInfo Search returns counts but no speaker info, so the
// UK Deep Dive's "Most Contributions" leaderboard isn't possible without
// a separate granule-level harvest. v0 ships the parts the search API
// directly supports — stat block + monthly bar chart — and skips the
// three leaderboards. Speaker leaderboards come back if/when we add a
// CREC harvester.
//
// Implementation: fan out one count query per month across the date
// range. With Worker edge-cache, repeats are instant. Bounded
// concurrency 4 so a five-year span (60 queries) stays polite to the
// proxy and the user's network.

import { searchGovInfo } from './api.js?v=18';
import { escapeHtml } from './format.js?v=18';

const $ = (id) => document.getElementById(id);
const $form = $('dd-form');
const $q = $('dd-q');
const $stamp = $('index-stamp');
const $status = $('dd-status');
const $stats = $('dd-stats');
const $chartWrap = $('dd-chart-wrap');
const $chart = $('dd-chart');
const $datePresets = $('dd-date-presets');
const $customDates = $('dd-custom-dates');
const $fromDate = $('dd-from-date');
const $toDate = $('dd-to-date');
const $collections = $('dd-collections');

const ALL_COLLECTIONS = ['CREC', 'BILLS', 'CHRG', 'FR', 'CRPT'];
const DEFAULT_COLLECTIONS = new Set(['CREC']);

const state = {
  term: '',
  collections: new Set(DEFAULT_COLLECTIONS),
  preset: 'five',
  fromDate: '',
  toDate: '',
};

// ---------- date helpers ----------

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dateRangeForPreset(preset) {
  const today = todayIso();
  if (preset === 'year') return { from: isoDaysAgo(365), to: today };
  if (preset === 'five') return { from: isoDaysAgo(365 * 5), to: today };
  if (preset === 'ten')  return { from: isoDaysAgo(365 * 10), to: today };
  return { from: state.fromDate, to: state.toDate };
}

// "2025-03" + 1 -> "2025-04". Returns YYYY-MM strings between from/to inclusive.
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
  // Last day = first day of next month - 1
  const next = new Date(Date.UTC(y, m, 1));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${y}`;
}
function monthLabelShort(ym) {
  const [y, m] = ym.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ’${String(y).slice(-2)}`;
}

// ---------- the dive ----------

async function runDive() {
  if (!state.term.trim()) { setStatus('Type a term to dive into.'); return; }
  if (!state.collections.size) { setStatus('Pick at least one collection.'); return; }
  const { from, to } = dateRangeForPreset(state.preset);
  if (!from || !to) { setStatus('Pick a date range.'); return; }

  const months = monthsInRange(from, to);
  if (months.length > 144) {  // 12 years sanity cap
    setStatus('Date range too wide — pick a tighter window.', true);
    return;
  }
  const collections = [...state.collections];
  const monthlyCounts = new Array(months.length).fill(0);
  const failed = [];

  setStatus(`Fetching ${months.length} months across ${collections.length} collection${collections.length === 1 ? '' : 's'}…`);
  $stats.innerHTML = '';
  $chart.innerHTML = '';
  $chartWrap.hidden = true;
  $form.classList.add('is-loading');

  // Bounded concurrency 4: high enough to feel quick, low enough to stay
  // polite to the proxy and avoid hammering api.data.gov's per-key limit.
  let i = 0;
  const worker = async () => {
    while (i < months.length) {
      const idx = i++;
      const m = months[idx];
      try {
        const r = await searchGovInfo({
          term: state.term,
          collections,
          fromDate: monthStart(m),
          toDate: monthEnd(m),
          pageSize: 1,
        });
        monthlyCounts[idx] = r.total;
      } catch (e) {
        failed.push(m);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  if (failed.length === months.length) {
    setStatus('All monthly fetches failed — check the Worker is running.', true);
    $form.classList.remove('is-loading');
    return;
  }

  // First mention + most recent: two count-1 queries, one ASC, one DESC.
  // No bigger result list — Deep Dive's job is the chart and the bookends;
  // clicking a bar takes you to Search to read the hits.
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
  } catch { /* let stats render without the bookend dates */ }

  const total = monthlyCounts.reduce((a, b) => a + b, 0);
  const peakIdx = monthlyCounts.reduce((bi, v, i) => v > monthlyCounts[bi] ? i : bi, 0);
  const peakMonth = total > 0 ? months[peakIdx] : null;
  const peakCount = total > 0 ? monthlyCounts[peakIdx] : 0;

  renderStats({ total, peakMonth, peakCount, firstMention, mostRecent });
  renderChart(months, monthlyCounts);
  $chartWrap.hidden = total === 0;
  if (total === 0) {
    setStatus('No contributions in that range. Try broadening the date filter or adding collections.');
  } else if (failed.length) {
    setStatus(`Showing ${total.toLocaleString()} contributions across ${months.length} months. ${failed.length} month${failed.length === 1 ? '' : 's'} failed to fetch — refresh to retry.`, true);
  } else {
    setStatus(`Showing ${total.toLocaleString()} contributions across ${months.length} months. Click a bar to read the hits.`);
  }
  $form.classList.remove('is-loading');
}

// ---------- render: stat block ----------

function renderStats({ total, peakMonth, peakCount, firstMention, mostRecent }) {
  if (total === 0) {
    $stats.innerHTML = '';
    return;
  }
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

// ---------- render: chart ----------

function renderChart(months, counts) {
  const max = Math.max(...counts, 1);
  // Show fewer x-axis labels on long ranges so they don't collide.
  const labelStride = months.length <= 14 ? 1 : months.length <= 36 ? 3 : 6;
  const cols = months.map((m, i) => {
    const v = counts[i] || 0;
    const h = max > 0 ? (v / max * 100) : 0;
    return `<button type="button" class="dd-col" data-month="${m}" data-count="${v}" title="${escapeHtml(monthLabel(m))}: ${v.toLocaleString()} — click to read in Search">
      <div class="dd-col-bar" style="height:${h.toFixed(1)}%"></div>
    </button>`;
  }).join('');
  const xLabels = months.map((m, i) => {
    const showLabel = i % labelStride === 0 || i === months.length - 1;
    return `<div class="dd-x-label">${showLabel ? escapeHtml(monthLabelShort(m)) : ''}</div>`;
  }).join('');
  $chart.innerHTML = `
    <div class="dd-axis-y"><span>${max.toLocaleString()}</span><span>0</span></div>
    <div class="dd-cols">${cols}</div>
    <div class="dd-axis-y-spacer" aria-hidden="true"></div>
    <div class="dd-axis-x">${xLabels}</div>
  `;
}

// ---------- filter UI ----------

function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
}

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
  if (!state.collections.size) state.collections.add(code);
  paintCollections();
});

$fromDate.addEventListener('change', () => { state.fromDate = $fromDate.value; });
$toDate.addEventListener('change', () => { state.toDate = $toDate.value; });

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.term = $q.value.trim();
  writeUrl();
  runDive();
});

// Click a bar -> go to Search with the term + that month's date range
// pre-filled. Deep Dive shows the shape; Search reads the hits.
$chart.addEventListener('click', (e) => {
  const btn = e.target.closest('button.dd-col');
  if (!btn) return;
  const month = btn.dataset.month;
  const count = Number(btn.dataset.count) || 0;
  if (!month || count === 0) return;
  const params = new URLSearchParams();
  if (state.term) params.set('q', state.term);
  if (!sameSet(state.collections, DEFAULT_COLLECTIONS)) {
    params.set('col', [...state.collections].join(','));
  }
  params.set('range', 'custom');
  params.set('from', monthStart(month));
  params.set('to', monthEnd(month));
  window.location.href = `./?${params.toString()}`;
});

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
  if (['year', 'five', 'ten', 'custom'].includes(preset)) state.preset = preset;
  if (state.preset === 'custom') {
    state.fromDate = p.get('from') || '';
    state.toDate = p.get('to') || '';
  }
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.term) p.set('q', state.term);
  if (!sameSet(state.collections, DEFAULT_COLLECTIONS)) {
    p.set('col', [...state.collections].join(','));
  }
  if (state.preset !== 'five') p.set('range', state.preset);
  if (state.preset === 'custom') {
    if (state.fromDate) p.set('from', state.fromDate);
    if (state.toDate) p.set('to', state.toDate);
  }
  history.pushState(null, '', `${location.pathname}${p.toString() ? '?' + p.toString() : ''}`);
}

window.addEventListener('popstate', () => {
  readUrl();
  $q.value = state.term;
  paintDatePresets();
  paintCollections();
  if (state.term) runDive();
});

// ---------- init ----------

readUrl();
$q.value = state.term;
paintDatePresets();
paintCollections();
$stamp.textContent = '';
if (state.term) {
  runDive();
} else {
  setStatus('Type a term to plot it month by month.');
}
