// Format helpers for result rows. Kept separate from app.js so the
// rendering shape can grow (snippets, witness lists, lobbying issue
// fields) without bloating the orchestrator.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GovInfo collection codes → human label and CSS class.
const COLLECTIONS = {
  CREC: { label: 'Cong. Record', cls: 'src-crec' },
  BILLS: { label: 'Bill', cls: 'src-bills' },
  CHRG: { label: 'Hearing', cls: 'src-chrg' },
  FR: { label: 'Fed. Register', cls: 'src-fr' },
  CRPT: { label: 'Cmte report', cls: 'src-crpt' },
};

export function collectionMeta(code) {
  return COLLECTIONS[code] || { label: code || 'Other', cls: '' };
}

// CREC titles often carry a parenthetical eyebrow — "Climate Change
// (Executive Session)", "Tribute (Continued)". Split it off so the
// main title carries the weight and the context ghosts in muted ink.
function splitTitle(title) {
  const m = title.match(/^(.+?)\s+(\(.+\))\s*$/);
  if (m && m[1].trim().length) return { main: m[1].trim(), context: m[2].trim() };
  return { main: title, context: '' };
}

// Render a single search result as an <li>. The snippet <p> starts empty
// and gets filled asynchronously by app.js once the granule fetch returns.
export function renderResultRow(item) {
  const meta = collectionMeta(item.collection);
  const { main, context } = splitTitle(item.title || '');
  const titleHtml = main
    ? escapeHtml(main) + (context ? ` <span class="title-context">${escapeHtml(context)}</span>` : '')
    : '(untitled)';
  const li = document.createElement('li');
  li.className = 'result';
  li.dataset.id = item.id;
  li.innerHTML = `
    <h2 class="result-title"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" title="${escapeHtml(item.title)}">${titleHtml}</a></h2>
    <div class="result-meta">
      <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
      <span class="result-date">${escapeHtml(formatDate(item.date))}</span>
    </div>
    <p class="result-snippet" data-snippet="pending"></p>
  `;
  return li;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

// Build a snippet centred on the first match of `term`, with the term
// highlighted via <mark>. Falls back to the opening of the text if the
// term doesn't appear in the body (e.g. the search matched on title or
// metadata only).
export function snippetHtml(text, term, maxLen = 260) {
  if (!text) return '';
  let start = 0;
  let end = Math.min(text.length, maxLen);
  if (term) {
    const re = new RegExp(escapeRegex(term), 'i');
    const m = text.match(re);
    if (m && m.index !== undefined) {
      const before = Math.floor(maxLen / 3);
      start = Math.max(0, m.index - before);
      end = Math.min(text.length, start + maxLen);
      if (end === text.length) start = Math.max(0, end - maxLen);
    }
  }
  const slice = text.slice(start, end);
  let html = escapeHtml(slice);
  if (term) {
    const escTerm = escapeRegex(escapeHtml(term));
    html = html.replace(new RegExp(`(${escTerm})`, 'ig'), '<mark>$1</mark>');
  }
  if (start > 0) html = '…' + html;
  if (end < text.length) html += '…';
  return html;
}
