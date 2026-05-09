// House US — CORS proxy with api.data.gov key injection.
//
// The frontend can call api.congress.gov, api.open.fec.gov and
// www.federalregister.gov directly (all CORS-open), but api.govinfo.gov
// sends no CORS headers, so any GovInfo request from a browser is blocked.
// Routing everything through this Worker buys three things at once:
// (1) a CORS-friendly proxy for GovInfo, (2) server-side injection of
// the api.data.gov key so it stays out of client JS, and (3) edge
// caching of GET responses for 5 minutes — the same pattern House UK uses.

const ALLOWED_HOSTS = new Set([
  'api.congress.gov',
  'api.govinfo.gov',
  'api.open.fec.gov',
  'www.federalregister.gov',
]);

// Hosts that accept the api.data.gov key. Federal Register does not.
const KEYED_HOSTS = new Set([
  'api.congress.gov',
  'api.govinfo.gov',
  'api.open.fec.gov',
]);

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return new Response('GET or POST only', { status: 405, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const target = url.searchParams.get('u');
    if (!target) {
      return new Response('missing ?u=', { status: 400, headers: corsHeaders });
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch {
      return new Response('bad ?u=', { status: 400, headers: corsHeaders });
    }
    if (upstream.protocol !== 'https:' || !ALLOWED_HOSTS.has(upstream.hostname)) {
      return new Response('host not allowed', { status: 403, headers: corsHeaders });
    }

    if (KEYED_HOSTS.has(upstream.hostname)) {
      const key = env.API_DATA_GOV_KEY || 'DEMO_KEY';
      upstream.searchParams.set('api_key', key);
    }

    const init = {
      method: req.method,
      headers: { Accept: 'application/json' },
    };
    if (req.method === 'POST') {
      init.body = await req.arrayBuffer();
      const ct = req.headers.get('content-type');
      if (ct) init.headers['content-type'] = ct;
    } else {
      // GET responses are cacheable at the edge.
      init.cf = { cacheTtl: 300, cacheEverything: true };
    }

    const upstreamRes = await fetch(upstream.toString(), init);
    const body = await upstreamRes.arrayBuffer();
    return new Response(body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders,
        'content-type': upstreamRes.headers.get('content-type') || 'application/json',
        'cache-control': req.method === 'GET' ? 'public, max-age=300' : 'no-store',
      },
    });
  },
};
