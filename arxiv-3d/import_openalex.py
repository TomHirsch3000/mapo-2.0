#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
import_openalex.py — Import OpenAlex works into SQLite with rich metadata.
Supports either --concept-id or --topic-name. Use --reset to overwrite from scratch.
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, List

OPENALEX_BASE = "https://api.openalex.org"
WORKS_URL     = f"{OPENALEX_BASE}/works"
CONCEPTS_URL  = f"{OPENALEX_BASE}/concepts"

# -----------------------------
# WHAT WE ASK FOR FROM OPENALEX
# -----------------------------
# host_venue is NOT valid → removed
OPENALEX_SELECT_FIELDS: List[str] = [
    "id",
    "title",
    "abstract_inverted_index",
    "cited_by_count",
    "publication_year",
    "publication_date",
    "type",
    "language",
    "doi",
    "ids",
    "authorships",
    "primary_location",    # contains source info (journal)
    "concepts",
    "open_access",
]

# -----------------------------
# HTTP utils
# -----------------------------
def safe_get_json(url: str, params: Dict[str, Any],
                  max_retries: int = 6, base_sleep: float = 0.8) -> Dict[str, Any]:
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
            if e.code in (429,500,502,503) and attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"[warn] HTTP {e.code} → retry in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
            raise RuntimeError(f"HTTP {e.code} on {full}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"[warn] URL error '{e}' → retry in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
            raise

def reconstruct_openalex_abstract(inv_idx: Optional[Dict[str, Any]]) -> str:
    """
    Rebuild abstract text from OpenAlex abstract_inverted_index.

    OpenAlex does NOT guarantee that every integer from 0..max_pos appears,
    so we must handle missing positions gracefully instead of indexing dict[]
    directly.
    """
    if not inv_idx:
        return ""

    pos2tok = {}
    for tok, positions in inv_idx.items():
        for p in positions:
            pos2tok[p] = tok

    if not pos2tok:
        return ""

    max_pos = max(pos2tok.keys())
    # Use .get() and drop missing positions instead of raising KeyError
    tokens = [pos2tok.get(i) for i in range(max_pos + 1)]
    return " ".join(t for t in tokens if t)


def uniq_preserve_order(seq):
    seen = set()
    out = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out

# -----------------------------
# DB schema
# -----------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS papers (
    paperId TEXT PRIMARY KEY,
    title TEXT,
    abstract TEXT,
    cited_by_count INTEGER,
    year INTEGER,
    publicationDate TEXT,
    doi TEXT,
    arxivId TEXT,
    journal_name TEXT,
    journal_type TEXT,
    journal_id TEXT,
    first_author_name TEXT,
    all_author_names TEXT,
    all_institution_names TEXT,
    primary_concept TEXT,
    concepts_json TEXT,
    landing_page_url TEXT,
    is_oa INTEGER,
    oa_url TEXT,
    work_type TEXT,
    language TEXT
);
"""

def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def ensure_schema(conn: sqlite3.Connection, reset=False):
    if reset:
        conn.execute("DROP TABLE IF EXISTS papers")
        conn.commit()
    conn.executescript(SCHEMA_SQL)

    existing = {row[1] for row in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, ctype in [
        ("journal_name","TEXT"),
        ("journal_type","TEXT"),
        ("journal_id","TEXT"),
        ("first_author_name","TEXT"),
        ("all_author_names","TEXT"),
        ("all_institution_names","TEXT"),
        ("primary_concept","TEXT"),
        ("concepts_json","TEXT"),
        ("landing_page_url","TEXT"),
        ("is_oa","INTEGER"),
        ("oa_url","TEXT"),
        ("work_type","TEXT"),
        ("language","TEXT"),
    ]:
        if col not in existing:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {ctype}")
    conn.commit()

# -----------------------------
# INSERT WORK
# -----------------------------
def insert_or_replace_work(conn: sqlite3.Connection, work: Dict[str, Any]):
    paper_id_full = work.get("id")
    if not paper_id_full:
        return
    paper_id = paper_id_full.split("/")[-1]

    title = work.get("title")
    abstract = reconstruct_openalex_abstract(work.get("abstract_inverted_index"))
    cited_by_count = work.get("cited_by_count")
    year = work.get("publication_year")
    pub_date = work.get("publication_date")
    work_type = work.get("type")
    language = work.get("language")

    # DOI + arXiv ID
    doi = work.get("doi")
    ids = work.get("ids") or {}
    arxiv_url = ids.get("arxiv")
    arxiv_id = arxiv_url.split("/")[-1] if arxiv_url else None

    # Journal info via primary_location.source
    primary_loc = work.get("primary_location") or {}
    source = primary_loc.get("source") or {}

    journal_name = source.get("display_name")
    journal_type = source.get("type")
    journal_id = source.get("id")

    landing_page_url = primary_loc.get("landing_page_url")

    # Open access info
    oa = work.get("open_access") or {}
    is_oa_val = 1 if oa.get("is_oa") else 0
    oa_url = oa.get("oa_url")

    # Authors + institutions
    authorships = work.get("authorships") or []
    authors = []
    insts = []
    for a in authorships:
        auth = a.get("author") or {}
        name = auth.get("display_name") or a.get("raw_author_name")
        if name:
            authors.append(name)
        for inst in a.get("institutions") or []:
            nm = inst.get("display_name")
            if nm:
                insts.append(nm)

    authors_u = uniq_preserve_order(authors)
    insts_u = uniq_preserve_order(insts)

    first_author_name = authors_u[0] if authors_u else None
    all_author_names = "; ".join(authors_u) if authors_u else None
    all_institution_names = "; ".join(insts_u) if insts_u else None

    # Concepts
    concepts = work.get("concepts") or []
    if concepts:
        best = max(concepts, key=lambda c: c.get("score", 0))
        primary_concept = best.get("display_name")
        concepts_json = json.dumps(concepts, ensure_ascii=False)
    else:
        primary_concept = None
        concepts_json = None

    conn.execute(
        """
        INSERT OR REPLACE INTO papers (
            paperId, title, abstract, cited_by_count, year, publicationDate,
            doi, arxivId,
            journal_name, journal_type, journal_id,
            first_author_name, all_author_names, all_institution_names,
            primary_concept, concepts_json,
            landing_page_url, is_oa, oa_url,
            work_type, language
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            paper_id, title, abstract, cited_by_count, year, pub_date,
            doi, arxiv_id,
            journal_name, journal_type, journal_id,
            first_author_name, all_author_names, all_institution_names,
            primary_concept, concepts_json,
            landing_page_url, is_oa_val, oa_url,
            work_type, language,
        ),
    )

# -----------------------------
# Concept resolution
# -----------------------------
def resolve_concept_name(name: str, mailto: str) -> str:
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
        raise RuntimeError(f"No OpenAlex concept found for '{name}'")
    cid_url = results[0].get("id")
    cid = cid_url.split("/")[-1]
    return cid

# -----------------------------
# Import loop
# -----------------------------
def build_filter(concept_id: Optional[str], from_year: Optional[int], to_year: Optional[int]) -> str:
    """Build OpenAlex filter string from concept + optional year range.

    - If both from_year and to_year: use "from-to".
    - If only from_year: from_year-2100.
    - If only to_year: 1900-to_year (arbitrary early year).
    """
    f = []
    if concept_id:
        f.append(f"concepts.id:https://openalex.org/{concept_id}")
    if from_year and to_year:
        f.append(f"publication_year:{from_year}-{to_year}")
    elif from_year:
        f.append(f"publication_year:{from_year}-2100")
    elif to_year:
        f.append(f"publication_year:1900-{to_year}")
    return ",".join(f)


def import_openalex(args):
    conn = open_db(args.db)
    ensure_schema(conn, reset=args.reset)

    if args.topic_name and not args.concept_id:
        print(f"[info] Resolving topic '{args.topic_name}' → concept ID")
        args.concept_id = resolve_concept_name(args.topic_name, args.email)

    if not args.concept_id:
        raise SystemExit("Provide --topic-name or --concept-id")

    filter_str = build_filter(args.concept_id, args.from_year, getattr(args, "to_year", None))

    cursor = "*"
    per_page = 200
    inserted = 0
    target = args.sample if args.sample > 0 else float("inf")

    select_str = ",".join(OPENALEX_SELECT_FIELDS)

    while cursor and inserted < target:
        params = {
            "per_page": per_page,
            "cursor": cursor,
            "sort": "cited_by_count:desc",
            "filter": filter_str,
            "mailto": args.email,
            "select": select_str,
        }

        print(f"[debug] Requesting page cursor={cursor}…")
        data = safe_get_json(WORKS_URL, params)
        results = data.get("results", [])
        next_cursor = (data.get("meta") or {}).get("next_cursor")

        with conn:
            for w in results:
                insert_or_replace_work(conn, w)
                inserted += 1
                if inserted >= target:
                    break

        print(f"[debug] Inserted so far: {inserted}")
        cursor = next_cursor
        time.sleep(0.2)

    print(f"[info] Done. Total inserted: {inserted}")
    conn.close()

# -----------------------------
# CLI
# -----------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Import OpenAlex works into SQLite with rich metadata.")
    p.add_argument("--concept-id", type=str)
    p.add_argument("--topic-name", type=str)
    p.add_argument("--from-year", type=int, help="Lower bound (inclusive) for publication_year")
    p.add_argument("--to-year", type=int, help="Upper bound (inclusive) for publication_year")
    p.add_argument("--db", type=str, default="papers.db")
    p.add_argument("--sample", type=int, default=0)
    p.add_argument("--email", type=str, required=True)
    p.add_argument("--reset", action="store_true")
    return p.parse_args(argv)

def main():
    args = parse_args()
    try:
        import_openalex(args)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)

if __name__ == "__main__":
    main()
