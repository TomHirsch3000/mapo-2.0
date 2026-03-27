#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_openalex_topics.py — Fetch OpenAlex Topic hierarchy for every paper in the DB.

Adds 9 new columns (non-destructive — never touches existing fields):
  oa_topics_json        Full JSON array of all topics with all 4 hierarchy levels
  oa_primary_topic_id   OpenAlex ID of the primary (highest-scored) topic
  oa_primary_topic      display_name of the primary topic           (level 4 — Topic)
  oa_primary_subfield_id
  oa_primary_subfield   display_name of the subfield                (level 3 — maps to Galaxy)
  oa_primary_field_id
  oa_primary_field      display_name of the field                   (level 2)
  oa_primary_domain_id
  oa_primary_domain     display_name of the domain                  (level 1)

Usage:
  python fetch_openalex_topics.py --db papers_condensed_matter_physics.db \\
      --email tom.hirsch3000@gmail.com --api-key bVNdDQ4KnqpmomPUH3JifI

Resumable: papers that already have oa_topics_json are skipped.
"""

import sys, io
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import argparse
import json
import sqlite3
import time
import urllib.request
import urllib.parse
from typing import List, Dict, Any, Optional


BATCH_SIZE = 50          # paperIds per API request
THROTTLE_WITH_KEY = 0.05 # seconds between requests with API key
THROTTLE_NO_KEY   = 0.15 # seconds between requests without API key
MAX_RETRIES = 5


# -------------------------
# DB helpers
# -------------------------

NEW_COLUMNS = [
    ("oa_topics_json",        "TEXT"),
    ("oa_primary_topic_id",   "TEXT"),
    ("oa_primary_topic",      "TEXT"),
    ("oa_primary_subfield_id","TEXT"),
    ("oa_primary_subfield",   "TEXT"),
    ("oa_primary_field_id",   "TEXT"),
    ("oa_primary_field",      "TEXT"),
    ("oa_primary_domain_id",  "TEXT"),
    ("oa_primary_domain",     "TEXT"),
]


def ensure_columns(conn: sqlite3.Connection):
    existing = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, typ in NEW_COLUMNS:
        if col not in existing:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {typ}")
    conn.commit()
    print(f"[info] Columns ensured: {[c for c, _ in NEW_COLUMNS]}")


def get_pending_papers(conn: sqlite3.Connection, top_n: Optional[int] = None) -> List[str]:
    """Return paperIds that don't yet have oa_topics_json, ordered by citations desc."""
    q = "SELECT paperId FROM papers WHERE oa_topics_json IS NULL ORDER BY cited_by_count DESC"
    if top_n:
        q += f" LIMIT {top_n}"
    rows = conn.execute(q).fetchall()
    return [r[0] for r in rows]


def save_topics(conn: sqlite3.Connection, paper_id: str, topics: List[Dict], primary: Optional[Dict]):
    """Write topic data back to the DB for one paper."""
    topics_json = json.dumps(topics, ensure_ascii=False) if topics else "[]"

    if primary:
        topic_id   = primary.get("id", "")
        topic_name = primary.get("display_name", "")
        sf         = primary.get("subfield") or {}
        f          = primary.get("field") or {}
        d          = primary.get("domain") or {}
    else:
        topic_id = topic_name = ""
        sf = f = d = {}

    conn.execute("""
        UPDATE papers SET
            oa_topics_json        = ?,
            oa_primary_topic_id   = ?,
            oa_primary_topic      = ?,
            oa_primary_subfield_id= ?,
            oa_primary_subfield   = ?,
            oa_primary_field_id   = ?,
            oa_primary_field      = ?,
            oa_primary_domain_id  = ?,
            oa_primary_domain     = ?
        WHERE paperId = ?
    """, (
        topics_json,
        topic_id,
        topic_name,
        sf.get("id", ""),
        sf.get("display_name", ""),
        f.get("id", ""),
        f.get("display_name", ""),
        d.get("id", ""),
        d.get("display_name", ""),
        paper_id,
    ))


# -------------------------
# API helpers
# -------------------------

def fetch_batch(
    paper_ids: List[str],
    email: str,
    api_key: Optional[str],
) -> Dict[str, Dict]:
    """
    Fetch topics for a batch of paper IDs.
    Returns a dict of paperId -> {"topics": [...], "primary_topic": {...}}
    """
    # OpenAlex filter: openalex:W1|W2|...
    id_filter = "|".join(paper_ids)
    params = {
        "filter": f"openalex:{id_filter}",
        "select": "id,topics,primary_topic",
        "per-page": str(len(paper_ids)),
        "mailto": email,
    }
    if api_key:
        params["api_key"] = api_key

    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)

    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": f"mapo-research/1.0 ({email})"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                results = data.get("results", [])
                out = {}
                for r in results:
                    pid = r.get("id", "").replace("https://openalex.org/", "")
                    out[pid] = {
                        "topics":        r.get("topics", []),
                        "primary_topic": r.get("primary_topic"),
                    }
                return out
        except Exception as e:
            wait = 2 ** attempt
            print(f"[warn] Attempt {attempt+1}/{MAX_RETRIES} failed: {e} — retrying in {wait}s")
            time.sleep(wait)

    print(f"[error] All retries failed for batch starting {paper_ids[0]}")
    return {}


# -------------------------
# Main
# -------------------------

def main():
    parser = argparse.ArgumentParser(description="Fetch OpenAlex topic hierarchy for papers in DB")
    parser.add_argument("--db",      required=True, help="Path to SQLite DB")
    parser.add_argument("--email",   required=True, help="Email for OpenAlex polite pool")
    parser.add_argument("--api-key", default=None,  help="OpenAlex API key (optional, increases rate limit)")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help=f"Papers per API request (default: {BATCH_SIZE})")
    parser.add_argument("--top-n", type=int, default=None, help="Only fetch topics for the top N papers by citation count (useful for large DBs)")
    args = parser.parse_args()

    throttle = THROTTLE_WITH_KEY if args.api_key else THROTTLE_NO_KEY

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    ensure_columns(conn)

    pending = get_pending_papers(conn, top_n=args.top_n)
    total = len(pending)
    print(f"[info] {total} papers need topic data")

    if total == 0:
        print("[info] Nothing to do.")
        conn.close()
        return

    done = 0
    batch_size = args.batch_size

    for i in range(0, total, batch_size):
        batch = pending[i : i + batch_size]
        print(f"[info] Batch {i//batch_size + 1} — papers {i+1}–{min(i+batch_size, total)}/{total}")

        results = fetch_batch(batch, args.email, args.api_key)

        for pid in batch:
            data = results.get(pid, {})
            topics        = data.get("topics", [])
            primary_topic = data.get("primary_topic")

            # If API returned nothing for this paper, store empty so we don't retry forever
            if not data:
                print(f"  [warn] No data returned for {pid} — storing empty")
                topics = []
                primary_topic = None

            save_topics(conn, pid, topics, primary_topic)
            done += 1

        conn.commit()
        print(f"  -> committed {len(batch)} rows ({done}/{total} total)")
        time.sleep(throttle)

    conn.close()
    print(f"\n[info] Done. {done} papers updated.")


if __name__ == "__main__":
    main()
