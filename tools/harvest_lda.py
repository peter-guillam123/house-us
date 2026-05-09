#!/usr/bin/env python3
"""
Harvest LD-2 quarterly lobbying disclosure filings from the Senate's
public API. Writes a stripped, gzipped JSON shard per quarter to the
repo root for the browser to search client-side. Pure stdlib — no pip
install needed.

Run:
  python3 tools/harvest_lda.py --year 2026 --quarter 1
  python3 tools/harvest_lda.py --year 2025 --quarter 4 --limit 200

The Senate API at lda.senate.gov sunsets on Tue, 30 Jun 2026 23:59:59
GMT. The successor at https://lda.gov/api/v1/ is currently broken at
the Akamai edge (returns 403 from any scripted client); when that's
fixed it should be a drop-in URL swap. Keep an eye on it from June.
"""

import argparse
import gzip
import json
import os
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

BASE_URL = "https://lda.senate.gov/api/v1"
USER_AGENT = "house-us-lda-harvester/1.0 (chris.moran@guardian.co.uk)"

# Anonymous: 15 req/min = one every 4s. Registered: 120 req/min = 0.5s.
SLEEP_ANON = 4.0
SLEEP_AUTH = 0.5
# The API silently caps page_size at 25 regardless of what's requested.
# At 25/page and ~21k filings per recent quarter, that's ~840 pages. The
# anonymous rate limit (15/min) makes a full quarter ~56 min anonymous,
# ~7 min with a registered token. Register at lda.senate.gov/api/register/
# to skip the wait.
PAGE_SIZE = 25


def get_json(url, headers, retries=3):
    for attempt in range(retries):
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                wait = 10 * (attempt + 1)
                print(f"  429, sleeping {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"too many retries on {url}")


def fetch_quarter(year, quarter, token=None, limit=None):
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Token {token}"
    sleep = SLEEP_AUTH if token else SLEEP_ANON

    params = {
        "filing_year": str(year),
        "filing_type": f"Q{quarter}",
        "page_size": str(PAGE_SIZE),
    }
    url = f"{BASE_URL}/filings/?{urlencode(params)}"
    page = 1
    seen = 0
    while url:
        data = get_json(url, headers)
        total = data.get("count")
        for r in data.get("results") or []:
            yield r
            seen += 1
            if limit and seen >= limit:
                return
        nxt = data.get("next")
        if nxt and (not limit or seen < limit):
            print(f"  page {page} done ({seen}/{total})", file=sys.stderr)
            page += 1
            time.sleep(sleep)
        url = nxt


def strip_filing(f):
    """Drop fields the frontend doesn't need; keep what's editorially useful.

    The free-text issue description is the gold seam — preserved verbatim.
    Lobbyists collapse to "First Last" strings; the full lobbyist record
    has covered_position info we may want later but isn't searched in v0.
    """
    activities = []
    for a in f.get("lobbying_activities") or []:
        activities.append({
            "code": a.get("general_issue_code") or "",
            "label": a.get("general_issue_code_display") or "",
            "description": (a.get("description") or "").strip(),
            "lobbyists": [
                f"{(l.get('lobbyist') or {}).get('first_name', '')} "
                f"{(l.get('lobbyist') or {}).get('last_name', '')}".strip()
                for l in (a.get("lobbyists") or [])
            ],
            "targets": [g.get("name") or "" for g in (a.get("government_entities") or [])],
        })
    return {
        "id": f.get("filing_uuid") or "",
        "year": f.get("filing_year"),
        "period": f.get("filing_period_display") or f.get("filing_period") or "",
        "type": f.get("filing_type_display") or f.get("filing_type") or "",
        "registrant": (f.get("registrant") or {}).get("name") or "",
        "client": (f.get("client") or {}).get("name") or "",
        "income": f.get("income"),
        "expenses": f.get("expenses"),
        "url": f.get("filing_document_url") or "",
        "posted": (f.get("dt_posted") or "")[:10],
        "activities": activities,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--quarter", type=int, required=True, choices=[1, 2, 3, 4])
    ap.add_argument("--out-dir", default=".",
                    help="Where to write the shard (default: cwd)")
    ap.add_argument("--token", default=os.environ.get("LDA_TOKEN"),
                    help="Optional API token (LDA_TOKEN env). Anonymous works fine, just slower.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Stop after N filings — for smoke-testing")
    args = ap.parse_args()

    print(f"Harvesting LD-2 {args.year} Q{args.quarter} from {BASE_URL}")
    print(f"  auth: {'registered (120/min)' if args.token else 'anonymous (15/min)'}")
    items = []
    t0 = time.time()
    for filing in fetch_quarter(args.year, args.quarter,
                                token=args.token, limit=args.limit):
        items.append(strip_filing(filing))
    elapsed = time.time() - t0
    print(f"  fetched {len(items)} filings in {elapsed:.0f}s")

    out_path = os.path.join(args.out_dir, f"lda-{args.year}-Q{args.quarter}.json.gz")
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        json.dump({
            "year": args.year,
            "quarter": args.quarter,
            "source": BASE_URL,
            "harvested_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "count": len(items),
            "filings": items,
        }, f, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"  wrote {out_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
