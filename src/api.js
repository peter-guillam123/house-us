// Talks to the Cloudflare Worker (worker/src/index.js), which proxies
// api.govinfo.gov and adds the api.data.gov key server-side. Direct
// browser calls to GovInfo don't work — it sends no CORS headers.
// House UK uses the same `?u=<encoded_url>` shape; mirroring it here.

// deShout lives in format.js so the Lobbying tab can use the same
// heuristic on LDA registrant/client names.
import { deShout } from './format.js?v=4';

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
    // Default to chronological — most recent first. Score-relevance sort
    // available via opts.sortField='score' (a UI toggle is on the list).
    sorts: [{ field: opts.sortField || 'dateIssued', sortOrder: 'DESC' }],
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
  // The API hands us the canonical text URL per result. Use it rather
  // than constructing one from packageId/granuleId — bills have no
  // granuleId, FR documents do, CREC speeches do, and txtLink papers
  // over all three patterns.
  const txtLink = (r.download && r.download.txtLink) || '';
  return {
    id: r.granuleId || r.packageId || '',
    title: deShout(r.title || ''),
    date: r.dateIssued || '',
    collection,
    packageId: r.packageId || '',
    granuleId: r.granuleId || '',
    txtLink,
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Fetch the plain-text body of a GovInfo document (CREC granule, bill
// package, FR notice, etc.). All collections wrap the body in
// <html><body><pre>...</pre></body></html>, which makes extraction
// uniform: pull the <pre> content, strip residual tags, decode entities.
// The proxy edge-caches these for 5 minutes, so re-running the same
// search is fast. Pass the txtLink straight from the search result —
// the API gives the canonical URL per item.
export async function fetchGranuleText(txtLink) {
  if (!txtLink) return '';
  const r = await fetch(viaProxy(txtLink));
  if (!r.ok) throw new Error(`Granule fetch failed: ${r.status}`);
  const html = await r.text();
  const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const inner = m ? m[1] : html;
  return inner
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
