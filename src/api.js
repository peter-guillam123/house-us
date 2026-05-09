// Talks to the Cloudflare Worker (worker/src/index.js), which proxies
// api.govinfo.gov and adds the api.data.gov key server-side. Direct
// browser calls to GovInfo don't work — it sends no CORS headers.
// House UK uses the same `?u=<encoded_url>` shape; mirroring it here.

const PROXY = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  // Update this string after `wrangler deploy` if your account subdomain
  // differs. House UK lives at house-proxy.peter-guillam.workers.dev.
  : 'https://house-us-proxy.peter-guillam.workers.dev';

const GOVINFO = 'https://api.govinfo.gov';

// CREC goes back to 1994-01-01; using 1995 as a clean baseline for "all time".
export const EARLIEST = '1995-01-01';

function viaProxy(upstream) {
  return `${PROXY}/?u=${encodeURIComponent(upstream)}`;
}

// GovInfo's search query language uses field operators inside the query string:
//   collection:(CREC OR BILLS)   — multi-collection
//   publishdate:range(from,to)   — both endpoints required (half-open returns 0)
function buildQuery({ term, collections, fromDate, toDate }) {
  const parts = [];
  if (term && term.trim()) parts.push(term.trim());
  if (collections && collections.length) {
    parts.push(`collection:(${collections.join(' OR ')})`);
  }
  const from = fromDate || EARLIEST;
  const to = toDate || todayIso();
  parts.push(`publishdate:range(${from},${to})`);
  return parts.join(' AND ');
}

export async function searchGovInfo(opts) {
  const body = {
    query: buildQuery(opts),
    pageSize: String(opts.pageSize ?? 20),
    offsetMark: opts.offsetMark || '*',
    sorts: [{ field: opts.sortField || 'score', sortOrder: 'DESC' }],
  };
  const r = await fetch(viaProxy(`${GOVINFO}/search`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Search failed: ${r.status} ${r.statusText}${text ? ` — ${text.slice(0, 120)}` : ''}`);
  }
  const data = await r.json();
  if (data && data.error) throw new Error(data.error.message || 'GovInfo error');
  return {
    total: data.count ?? 0,
    nextOffset: data.offsetMark ?? null,
    items: (data.results ?? []).map(normaliseItem),
  };
}

function normaliseItem(r) {
  const collection = r.collectionCode || '';
  return {
    id: r.granuleId || r.packageId || '',
    title: deShout(r.title || ''),
    date: r.dateIssued || '',
    collection,
    packageId: r.packageId || '',
    granuleId: r.granuleId || '',
    link: publicLink(collection, r.packageId, r.granuleId),
  };
}

// govinfo.gov public-facing URLs differ by collection. CREC has per-granule
// pages; bills, hearings and reports get package-level details pages.
function publicLink(collection, pkg, gr) {
  if (!pkg) return 'https://www.govinfo.gov/';
  if (collection === 'CREC' && gr) {
    return `https://www.govinfo.gov/content/pkg/${pkg}/html/${gr}.htm`;
  }
  if (collection === 'FR' && gr) {
    return `https://www.govinfo.gov/content/pkg/${pkg}/html/${gr}.htm`;
  }
  return `https://www.govinfo.gov/app/details/${pkg}`;
}

// CREC titles arrive shouty — "CLIMATE CHANGE", "TRIBUTE TO MAJ. JOHN SMITH".
// De-shout to title case, keeping common short words (to, of, in) lowercase.
// Acronyms like CIA/FBI become Cia/Fbi — accepted as a v0 limitation rather
// than maintaining a whitelist; the click-through link reaches the real doc.
const STOPWORDS = new Set([
  'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'a', 'an', 'the',
  'as', 'by', 'with', 'into', 'from', 'vs',
]);
function deShout(s) {
  if (!s) return s;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters.length) return s;
  const upperRatio = letters.replace(/[^A-Z]/g, '').length / letters.length;
  if (upperRatio < 0.8) return s; // already mixed-case
  let first = true;
  return s.toLowerCase().replace(/\b(\w+)\b/g, (_, w) => {
    if (!first && STOPWORDS.has(w)) return w;
    first = false;
    return w[0].toUpperCase() + w.slice(1);
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
