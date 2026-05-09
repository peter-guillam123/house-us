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

// Render a single search result as an <li>. Title-only for v0; snippets
// arrive in a follow-up commit (lazy granule fetch with bounded concurrency).
export function renderResultRow(item) {
  const meta = collectionMeta(item.collection);
  const li = document.createElement('li');
  li.className = 'result';
  li.innerHTML = `
    <h2 class="result-title"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" title="${escapeHtml(item.title)}">${escapeHtml(item.title || '(untitled)')}</a></h2>
    <div class="result-meta">
      <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
      <span class="result-date">${escapeHtml(formatDate(item.date))}</span>
    </div>
  `;
  return li;
}
