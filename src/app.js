// Search v0 orchestrator. State is the URL — every search updates the
// query string so a result page is shareable and the back button works.
// Title-only results for now; snippet extraction (lazy granule fetch)
// is the next commit.

import { searchGovInfo, fetchGranuleText } from './api.js?v=17';
import { renderResultRow, snippetHtml } from './format.js?v=17';

const $ = (id) => document.getElementById(id);
const $form = $('search-form');
const $q = $('q');
const $stamp = $('index-stamp');
const $status = $('status');
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

async function runSearch({ append = false } = {}) {
  if (!state.term.trim()) {
    setStatus('Type a term to search.');
    return;
  }
  if (!state.collections.size) {
    setStatus('Pick at least one collection.');
    return;
  }
  const { from, to } = dateRangeForPreset(state.preset);
  if (!from || !to) {
    setStatus('Pick a date range.');
    return;
  }
  setStatus(append ? 'Loading more…' : 'Searching…');
  $loadMore.disabled = true;
  $form.classList.add('is-loading');
  try {
    const res = await searchGovInfo({
      term: state.term,
      collections: [...state.collections],
      fromDate: from,
      toDate: to,
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
    // Kick off snippet fetches for the new batch (don't await — let the
    // status line and load-more update immediately; snippets fade in).
    fillSnippets(res.items, state.term);
    const moreAvailable = state.items.length < state.total;
    $loadMore.hidden = !moreAvailable;
    $loadMore.disabled = false;
    if (state.total === 0) {
      setStatus(`No results. Try broadening the date range or removing collections.`);
    } else {
      setStatus(`Showing ${state.items.length} of ${state.total.toLocaleString()} results.`);
    }
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
    $loadMore.disabled = false;
  } finally {
    $form.classList.remove('is-loading');
  }
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
  writeUrl();
  runSearch({ append: false });
});

$loadMore.addEventListener('click', () => runSearch({ append: true }));

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
