#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
import_openalex.py — Import OpenAlex works into SQLite with DOI & arXiv stored.
Supports either --concept-id or --topic-name. Use --reset to overwrite from scratch.

Examples:
  python import_openalex.py --topic-name "particle physics" --db papers_particle_physics.db --sample 500 --email you@example.com
  python import_openalex.py --concept-id C154945302 --from-year 2018 --db papers.db --sample 200 --email you@example.com
  python import_openalex.py --topic-name "particle physics" --db papers_particle_physics.db --sample 500 --email you@example.com --reset
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Dict, Any, Optional

OPENALEX_BASE = "https://api.openalex.org"
WORKS_URL     = f"{OPENALEX_BASE}/works"
CONCEPTS_URL  = f"{OPENALEX_BASE}/concepts"

# -----------------------------
# HTTP utils
# -----------------------------
def safe_get_json(url: str, params: Dict[str, Any], max_retries: int = 6, base_sleep: float = 0.8) -> Dict[str, Any]:
    """
    GET with query params + basic retry/backoff (handles 429/5xx/URLError).
    `params` should be a dict of querystring parameters.
    """
    qs = urllib.parse.urlencode(params, doseq=True, safe=":,")
    full = f"{url}?{qs}" if qs else url
    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(full, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            if e.code in (429, 500, 502, 503) and attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"[warn] HTTP {e.code} → retry {attempt}/{max_retries} in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
            raise RuntimeError(f"HTTP {e.code} on {full}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"[warn] URL error '{e}' → retry {attempt}/{max_retries} in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
            raise

def reconstruct_openalex_abstract(inv_idx: Optional[Dict[str, Any]]) -> str:
    """Rebuild abstract text from OpenAlex abstract_inverted_index."""
    if not inv_idx:
        return ""
    pos2tok = {}
    for tok, positions in inv_idx.items():
        for p in positions:
            pos2tok[p] = tok
    return " ".join(pos2tok[i] for i in range(0, max(pos2tok.keys()) + 1))

# -----------------------------
# DB utils
# -----------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS papers (
    paperId TEXT PRIMARY KEY,          -- OpenAlex W-id (short form, e.g. W2752782242)
    title TEXT,
    abstract TEXT,
    cited_by_count INTEGER,
    year INTEGER,
    publicationDate TEXT,
    doi TEXT,
    arxivId TEXT
);
"""

def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def ensure_schema(conn: sqlite3.Connection, reset: bool = False):
    """Ensure the 'papers' table exists with the expected columns. If reset=True, drop and recreate."""
    if reset:
        conn.execute("DROP TABLE IF EXISTS papers")
        conn.commit()
    conn.executescript(SCHEMA_SQL)
    # Upgrade path: if table pre-existed, add missing columns
    existing = {row[1] for row in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, ctype in [
        ("title","TEXT"),
        ("abstract","TEXT"),
        ("cited_by_count","INTEGER"),
        ("year","INTEGER"),
        ("publicationDate","TEXT"),
        ("doi","TEXT"),
        ("arxivId","TEXT"),
    ]:
        if col not in existing:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {ctype}")
    conn.commit()

def insert_or_replace_work(conn: sqlite3.Connection, work: Dict[str, Any]):
    """Insert/replace one row using the canonical schema."""
    paper_id_full = work.get("id")
    if not paper_id_full:
        return
    paper_id = paper_id_full.split("/")[-1]  # keep short W-id

    title = work.get("title")
    abstract = reconstruct_openalex_abstract(work.get("abstract_inverted_index"))
    cited_by_count = work.get("cited_by_count")
    year = work.get("publication_year")
    pub_date = work.get("publication_date")
    doi = work.get("doi") or None
    ids = work.get("ids") or {}
    arxiv_url = ids.get("arxiv")
    arxiv_id = (arxiv_url.split("/")[-1] if arxiv_url else None)

    conn.execute("""
        INSERT OR REPLACE INTO papers
        (paperId, title, abstract, cited_by_count, year, publicationDate, doi, arxivId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        paper_id, title, abstract, cited_by_count, year, pub_date, doi, arxiv_id
    ))

# -----------------------------
# Concept resolution
# -----------------------------
def resolve_concept_name(name: str, mailto: str) -> str:
    """
    Resolve a concept display name to its OpenAlex concept ID (C#######).
    1) Try filter=display_name.search:<name>
    2) Fallback to search=<name>
    """
    params = {
        "filter": f"display_name.search:{name}",
        "sort": "relevance_score:desc",
        "per_page": 1,
        "mailto": mailto,
    }
    data = safe_get_json(CONCEPTS_URL, params)
    results = data.get("results", [])
    if not results:
        params = {
            "search": name,
            "sort": "relevance_score:desc",
            "per_page": 1,
            "mailto": mailto,
        }
        data = safe_get_json(CONCEPTS_URL, params)
        results = data.get("results", [])
    if not results:
        raise RuntimeError(f"No OpenAlex concept found for name '{name}'")
    cid_url = results[0].get("id") or ""
    cid = cid_url.split("/")[-1] if cid_url else ""
    if not cid.startswith("C"):
        raise RuntimeError(f"Unexpected concept id for '{name}': {cid_url}")
    return cid

# -----------------------------
# Import logic
# -----------------------------
def build_filter(concept_id: Optional[str], from_year: Optional[int]) -> str:
    filters = []
    if concept_id:
        filters.append(f"concepts.id:https://openalex.org/{concept_id}")
    if from_year:
        filters.append(f"publication_year:{from_year}-2100")
    return ",".join(filters)

def import_openalex(args):
    conn = open_db(args.db)
    print("[debug] Opening DB…")
    ensure_schema(conn, reset=args.reset)
    print("[debug] Ensuring SQLite schema…")
    print("[debug] Schema ready")

    # Resolve topic-name → concept-id if provided
    if args.topic_name and not args.concept_id:
        print(f"[info] Resolving topic name '{args.topic_name}' to concept-id via OpenAlex…")
        args.concept_id = resolve_concept_name(args.topic_name, args.email)

    if not args.concept_id and not args.topic_name:
        raise SystemExit("Please provide either --concept-id or --topic-name")

    filter_str = build_filter(args.concept_id, args.from_year)
    print("[debug] Building filters…")
    filters_dbg = []
    if args.concept_id:
        filters_dbg.append(f"concepts.id:https://openalex.org/{args.concept_id}")
    if args.from_year:
        filters_dbg.append(f"publication_year:{args.from_year}-2100")
    print(f"[debug] Filters = {filters_dbg}")

    cursor   = "*"
    per_page = 200
    inserted = 0
    target   = args.sample if args.sample and args.sample > 0 else float("inf")

    debug_first = {
        'per_page': per_page,
        'cursor': '*',
        'sort': 'cited_by_count:desc',
        'filter': filter_str,
        'mailto': args.email,
        'select': 'id,title,abstract_inverted_index,cited_by_count,publication_year,publication_date,doi,ids'
    }
    print(f"[debug] First request params = {debug_first}")

    while cursor and inserted < target:
        params = {
            "per_page": per_page,
            "cursor": cursor,
            "sort": "cited_by_count:desc",
            "filter": filter_str,
            "mailto": args.email,
            # ask explicitly for the fields we need
            "select": "id,title,abstract_inverted_index,cited_by_count,publication_year,publication_date,doi,ids",
        }
        print(f"[debug] Requesting works page (cursor={cursor})…")
        data = safe_get_json(WORKS_URL, params)
        results = data.get("results", [])
        next_cursor = (data.get("meta") or {}).get("next_cursor")

        with conn:
            for w in results:
                insert_or_replace_work(conn, w)
                inserted += 1
                if inserted >= target:
                    break

        print(f"[debug] Got {len(results)} works in this page")
        print(f"[debug] Total inserted so far: {inserted}")

        cursor = next_cursor
        time.sleep(0.2)  # polite pacing

    print(f"[info] Finished. Inserted total: {inserted}")
    conn.close()

# -----------------------------
# CLI
# -----------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Import OpenAlex works into SQLite (with DOI + arXiv).")
    p.add_argument("--concept-id", type=str, default=None,
                   help="OpenAlex concept id (e.g., C154945302).")
    p.add_argument("--topic-name", type=str, default=None,
                   help="Human-readable concept/topic name (e.g., 'particle physics'). "
                        "Will be resolved to a concept-id via OpenAlex.")
    p.add_argument("--from-year", type=int, default=None,
                   help="Lower bound of publication_year (e.g., 2018).")
    p.add_argument("--db", type=str, default="papers.db", help="SQLite database path.")
    p.add_argument("--sample", type=int, default=0,
                   help="Stop after inserting this many works (0 = no limit).")
    p.add_argument("--email", type=str, required=True, help="mailto parameter for OpenAlex.")
    p.add_argument("--reset", action="store_true",
                   help="Drop and recreate the 'papers' table before importing.")
    return p.parse_args(argv)

def main():
    args = parse_args()
    try:
        import_openalex(args)
    except KeyboardInterrupt:
        print("\n[info] Interrupted by user.")
        sys.exit(130)

if __name__ == "__main__":
    main()
