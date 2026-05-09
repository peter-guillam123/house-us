# House US

A search tool for the US Congress, built for Guardian US journalists.
Sister to [House (UK)](https://github.com/peter-guillam123/House) and
[House (AU)](https://github.com/peter-guillam123/house-au).

**Internal newsroom tool, scaffold stage.** US federal works are
public domain throughout — materially cleaner than UK's Open
Parliament Licence and miles cleaner than AU's CC-BY-NC-ND. The
expectation is that this moves to the Guardian stack behind
authentication once it works.

## What this will be

Three surfaces, mirroring AU's discipline rather than UK's breadth:

1. **Search** — single field across the Congressional Record, bills,
   votes and committee report titles, plus a modest Hearings feed.
2. **Deep Dive** — party-stacked monthly timeline for a single term.
3. **Lobbying** *(headline feature)* — Lobbying Disclosure Act
   filings, searchable by registrant, client, lobbyist and the
   free-text issue-description field. The bit that doesn't exist in
   House UK or House AU because their lobbying registers are pitiful
   by comparison.

## Why the architecture is hybrid

The US sits between UK and AU on the data spectrum. The daily-news
layer is UK-shaped — `api.congress.gov`, `api.govinfo.gov`,
`federalregister.gov` and `api.open.fec.gov` are all CORS-friendly,
free, and called from a small Cloudflare Worker that injects API
keys. The accountability layer is AU-shaped — `lda.gov` resists with
no CORS and token auth, so a nightly GitHub Action harvests filings
into static JSON shards and the browser searches those client-side.

One Cloudflare Worker plus one nightly harvester. Both patterns
already exist in the UK and AU repos.

The full feasibility memo and the argument behind each call is on the
[About page](about.html).

## Status

| Piece | State |
|---|---|
| Visual scaffold (palette, layout, typography) | done |
| Search wiring | not yet written |
| Deep Dive | not yet started |
| Lobbying harvester | not yet started |
| Cloudflare Worker | scaffold — proxies CORS-blocked GovInfo and injects the api.data.gov key server-side |

## Local dev

The frontend is a static page; the Worker is a separate process.

```sh
# terminal 1: frontend
python3 -m http.server 8000
# open http://localhost:8000

# terminal 2: Worker (first time only)
cd worker
cp .dev.vars.example .dev.vars   # paste your api.data.gov key here
npx wrangler dev --port 8787
```

The Worker listens at `http://localhost:8787/?u=<encoded_target_url>`.
Allowed hosts: `api.govinfo.gov`, `api.congress.gov`, `api.open.fec.gov`,
`www.federalregister.gov`. The `api.data.gov` key is added server-side
for the first three; Federal Register doesn't need a key.

In scaffold mode the search box on the homepage is visually present
but inert — submit prints a status saying the wiring lands next.

## Worker deploy

```sh
cd worker
npx wrangler secret put API_DATA_GOV_KEY   # paste your key when prompted
npx wrangler deploy
```

Deployed URL is `https://house-us-proxy.<your-account>.workers.dev/`.

## Licence

US federal government works (the Congressional Record, Federal
Register, Congress.gov, FEC, FARA and LDA filings) are public domain.
C-SPAN transcripts are not federal and are not in scope for v1 —
copyright applies and the ToS forbids commercial redistribution.
If/when this moves to the Guardian stack the same internal-tool
framing applies.
