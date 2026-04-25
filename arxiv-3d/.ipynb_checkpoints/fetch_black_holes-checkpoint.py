#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_black_holes.py — Fetch papers about black holes from OpenAlex,
organised into narrative chapters covering precursor observations,
theoretical development, and confirmatory evidence.

Output:
  black_holes.db          — SQLite with all papers + chapter assignments
  black_holes_raw.json    — Full structured dump ready for curation

Usage:
  python fetch_black_holes.py --email you@example.com
  python fetch_black_holes.py --email you@example.com --dry-run
"""

import argparse
import io
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, List

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

OPENALEX_BASE = "https://api.openalex.org"
WORKS_URL = f"{OPENALEX_BASE}/works"

OPENALEX_SELECT_FIELDS = [
    "id", "title", "abstract_inverted_index", "cited_by_count",
    "publication_year", "publication_date", "type", "language",
    "doi", "ids", "authorships", "primary_location",
    "concepts", "open_access",
]

# ---------------------------------------------------------------------------
# Narrative chapter definitions
# ---------------------------------------------------------------------------
# Each chapter has:
#   id           — machine-readable slug
#   title        — display title
#   era          — human date range for context
#   role         — "precursor" | "theory" | "evidence"
#   narrative    — placeholder paragraph (fill in by hand / LLM in notebook)
#   queries      — list of OpenAlex search strings to run
#   year_range   — optional (from_year, to_year) tuple to narrow results
#   per_query    — max papers to fetch per search query
#
# Strategy: multiple targeted searches per chapter, then deduplicate.
# OpenAlex `search` hits title + abstract; we also layer in concept filters
# where a concept ID is known.
# ---------------------------------------------------------------------------
CHAPTERS = [
    {
        "id": "precursor_stellar_theory",
        "title": "The Mass Limit Problem: Stars That Cannot Stop Collapsing",
        "era": "1920s – 1950s",
        "role": "precursor",
        "narrative": "",
        "queries": [
            "Chandrasekhar limit white dwarf mass",
            "gravitational collapse stellar evolution",
            "neutron star Tolman Oppenheimer Volkoff",
            "degenerate matter stellar pressure",
            "Oppenheimer Snyder gravitational collapse",
        ],
        "year_range": (1920, 1960),
        "per_query": 30,
    },
    {
        "id": "precursor_redshift",
        "title": "Extreme Redshifts: Light Struggling to Escape",
        "era": "1910s – 1960s",
        "role": "precursor",
        "narrative": "",
        "queries": [
            "gravitational redshift prediction general relativity",
            "pound rebka gravitational redshift experiment",
            "spectral lines gravitational field",
            "redshift compact massive object",
        ],
        "year_range": (1910, 1970),
        "per_query": 30,
    },
    {
        "id": "precursor_quasars",
        "title": "Quasars: Impossibly Bright Objects at the Edge of the Universe",
        "era": "1960s – 1980s",
        "role": "precursor",
        "narrative": "",
        "queries": [
            "quasar quasi-stellar object discovery",
            "quasar redshift energy source",
            "3C 273 quasar spectrum",
            "active galactic nucleus energy mechanism",
            "supermassive black hole quasar power",
        ],
        "year_range": (1960, 1990),
        "per_query": 40,
    },
    {
        "id": "precursor_xray_sky",
        "title": "The X-ray Sky: Sources Too Bright to Ignore",
        "era": "1960s – 1975",
        "role": "precursor",
        "narrative": "",
        "queries": [
            "X-ray astronomy Uhuru satellite discovery",
            "X-ray source binary stellar",
            "cosmic X-ray background compact object",
            "Giacconi X-ray telescope observation",
        ],
        "year_range": (1960, 1978),
        "per_query": 30,
    },
    {
        "id": "theory_foundation",
        "title": "The Mathematics of No Return: Schwarzschild to Penrose",
        "era": "1916 – 1975",
        "role": "theory",
        "narrative": "",
        "queries": [
            "Schwarzschild solution general relativity spherical symmetry",
            "event horizon Kerr black hole solution",
            "singularity theorem Penrose Hawking",
            "black hole thermodynamics Bekenstein",
            "black hole area theorem",
            "Wheeler black hole name",
        ],
        "year_range": (1916, 1980),
        "per_query": 30,
    },
    {
        "id": "theory_hawking",
        "title": "Hawking Radiation: Black Holes Are Not Perfectly Black",
        "era": "1974 – 1990s",
        "role": "theory",
        "narrative": "",
        "queries": [
            "Hawking radiation black hole evaporation",
            "black hole information paradox",
            "quantum effects black hole horizon",
            "particle creation black hole",
        ],
        "year_range": (1970, 2000),
        "per_query": 40,
    },
    {
        "id": "evidence_cygnus_x1",
        "title": "Cygnus X-1: The First Black Hole Candidate",
        "era": "1972 – 1990",
        "role": "evidence",
        "narrative": "",
        "queries": [
            "Cygnus X-1 black hole candidate",
            "X-ray binary compact object mass",
            "black hole X-ray binary accretion disk",
            "HDE 226868 companion star",
        ],
        "year_range": (1970, 1995),
        "per_query": 40,
    },
    {
        "id": "evidence_sgr_a",
        "title": "Sagittarius A*: Watching Stars Orbit the Dark Centre",
        "era": "1990s – 2022",
        "role": "evidence",
        "narrative": "",
        "queries": [
            "Sgr A* galactic center black hole",
            "stellar orbits galactic center S2",
            "Ghez Genzel galactic center stellar motion",
            "supermassive black hole Milky Way",
            "infrared observations galactic center",
        ],
        "year_range": (1990, 2023),
        "per_query": 50,
    },
    {
        "id": "evidence_agn_accretion",
        "title": "Active Galaxies: Accretion Disks Across the Universe",
        "era": "1980s – 2010s",
        "role": "evidence",
        "narrative": "",
        "queries": [
            "active galactic nucleus accretion disk black hole",
            "broad emission line region AGN",
            "reverberation mapping black hole mass",
            "M87 jet black hole",
            "NGC 4258 water maser black hole mass",
        ],
        "year_range": (1980, 2020),
        "per_query": 40,
    },
    {
        "id": "evidence_gravitational_waves",
        "title": "LIGO: Hearing Two Black Holes Merge",
        "era": "2015 – present",
        "role": "evidence",
        "narrative": "",
        "queries": [
            "GW150914 gravitational wave black hole merger",
            "LIGO gravitational wave detection",
            "binary black hole merger gravitational wave",
            "LISA gravitational wave space",
        ],
        "year_range": (2015, 2026),
        "per_query": 50,
    },
    {
        "id": "evidence_eht",
        "title": "The Event Horizon Telescope: A Shadow Photographed",
        "era": "2017 – present",
        "role": "evidence",
        "narrative": "",
        "queries": [
            "Event Horizon Telescope M87 black hole image",
            "black hole shadow photon ring",
            "Sagittarius A* Event Horizon Telescope image",
            "very long baseline interferometry black hole",
        ],
        "year_range": (2017, 2026),
        "per_query": 50,
    },
]

# ---------------------------------------------------------------------------
# HTTP helpers (matches import_openalex.py style)
# ---------------------------------------------------------------------------
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
            if e.code in (429, 500, 502, 503) and attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"  [warn] HTTP {e.code} → retry in {sleep_s:.1f}s", flush=True)
                time.sleep(sleep_s)
                continue
            raise RuntimeError(f"HTTP {e.code} on {full}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"  [warn] URL error '{e}' → retry in {sleep_s:.1f}s", flush=True)
                time.sleep(sleep_s)
                continue
            raise
    return {}


def reconstruct_abstract(inv_idx: Optional[Dict]) -> str:
    if not inv_idx:
        return ""
    pos2tok = {}
    for tok, positions in inv_idx.items():
        for p in positions:
            pos2tok[p] = tok
    if not pos2tok:
        return ""
    max_pos = max(pos2tok.keys())
    return " ".join(pos2tok.get(i, "") for i in range(max_pos + 1)).strip()


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS papers (
    paper_id            TEXT PRIMARY KEY,
    title               TEXT,
    abstract            TEXT,
    cited_by_count      INTEGER,
    year                INTEGER,
    publication_date    TEXT,
    doi                 TEXT,
    arxiv_id            TEXT,
    journal_name        TEXT,
    first_author        TEXT,
    all_authors         TEXT,
    institutions        TEXT,
    primary_concept     TEXT,
    concepts_json       TEXT,
    landing_page_url    TEXT,
    is_oa               INTEGER,
    oa_url              TEXT,
    work_type           TEXT,
    language            TEXT
);

CREATE TABLE IF NOT EXISTS paper_chapters (
    paper_id    TEXT NOT NULL,
    chapter_id  TEXT NOT NULL,
    query_used  TEXT,
    PRIMARY KEY (paper_id, chapter_id),
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id)
);
"""


def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    return conn


def upsert_paper(conn: sqlite3.Connection, work: Dict[str, Any]):
    pid_full = work.get("id", "")
    if not pid_full:
        return None
    pid = pid_full.split("/")[-1]

    abstract = reconstruct_abstract(work.get("abstract_inverted_index"))

    ids = work.get("ids") or {}
    arxiv_url = ids.get("arxiv")
    arxiv_id = arxiv_url.split("/")[-1] if arxiv_url else None

    primary_loc = work.get("primary_location") or {}
    source = primary_loc.get("source") or {}
    journal_name = source.get("display_name")
    landing_url = primary_loc.get("landing_page_url")

    oa = work.get("open_access") or {}
    is_oa = 1 if oa.get("is_oa") else 0
    oa_url = oa.get("oa_url")

    authorships = work.get("authorships") or []
    authors, insts = [], []
    for a in authorships:
        name = (a.get("author") or {}).get("display_name") or a.get("raw_author_name")
        if name:
            authors.append(name)
        for inst in a.get("institutions") or []:
            nm = inst.get("display_name")
            if nm:
                insts.append(nm)

    seen = set()
    authors_u = [x for x in authors if not (x in seen or seen.add(x))]
    seen = set()
    insts_u = [x for x in insts if not (x in seen or seen.add(x))]

    concepts = work.get("concepts") or []
    primary_concept = None
    if concepts:
        best = max(concepts, key=lambda c: c.get("score", 0))
        primary_concept = best.get("display_name")

    conn.execute(
        """
        INSERT OR IGNORE INTO papers (
            paper_id, title, abstract, cited_by_count, year, publication_date,
            doi, arxiv_id, journal_name, first_author, all_authors, institutions,
            primary_concept, concepts_json, landing_page_url, is_oa, oa_url,
            work_type, language
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            pid,
            work.get("title"),
            abstract,
            work.get("cited_by_count"),
            work.get("publication_year"),
            work.get("publication_date"),
            work.get("doi"),
            arxiv_id,
            journal_name,
            authors_u[0] if authors_u else None,
            "; ".join(authors_u) if authors_u else None,
            "; ".join(insts_u) if insts_u else None,
            primary_concept,
            json.dumps(concepts, ensure_ascii=False) if concepts else None,
            landing_url,
            is_oa,
            oa_url,
            work.get("type"),
            work.get("language"),
        ),
    )
    return pid


def link_chapter(conn: sqlite3.Connection, paper_id: str, chapter_id: str, query: str):
    conn.execute(
        "INSERT OR IGNORE INTO paper_chapters (paper_id, chapter_id, query_used) VALUES (?,?,?)",
        (paper_id, chapter_id, query),
    )


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
def fetch_chapter(chapter: Dict, email: str, dry_run: bool = False) -> List[Dict]:
    """Fetch papers for all queries in a chapter, return raw works list."""
    all_works = []
    seen_ids = set()

    from_y, to_y = chapter.get("year_range", (None, None))
    per_query = chapter["per_query"]

    for query in chapter["queries"]:
        print(f"  query: {query!r}", flush=True)

        if dry_run:
            print(f"    [dry-run] skipping fetch")
            continue

        filter_parts = []
        if from_y and to_y:
            filter_parts.append(f"publication_year:{from_y}-{to_y}")
        elif from_y:
            filter_parts.append(f"publication_year:{from_y}-2100")
        elif to_y:
            filter_parts.append(f"publication_year:1900-{to_y}")

        params = {
            "search": query,
            "per_page": min(per_query, 200),
            "sort": "cited_by_count:desc",
            "select": ",".join(OPENALEX_SELECT_FIELDS),
            "mailto": email,
        }
        if filter_parts:
            params["filter"] = ",".join(filter_parts)

        try:
            data = safe_get_json(WORKS_URL, params)
        except Exception as e:
            print(f"    [error] {e}")
            continue

        results = data.get("results", [])
        new = 0
        for w in results:
            pid = (w.get("id") or "").split("/")[-1]
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                w["_query"] = query
                all_works.append(w)
                new += 1

        total_available = (data.get("meta") or {}).get("count", "?")
        print(f"    fetched {len(results)}, new unique {new} (OpenAlex total: {total_available})", flush=True)
        time.sleep(0.2)

    return all_works


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def export_json(conn: sqlite3.Connection, chapters: List[Dict], out_path: str):
    chapter_rows = conn.execute(
        "SELECT paper_id, chapter_id FROM paper_chapters"
    ).fetchall()

    chapter_paper_map: Dict[str, List[str]] = {}
    for row in chapter_rows:
        chapter_paper_map.setdefault(row["chapter_id"], []).append(row["paper_id"])

    papers_cache = {}
    for row in conn.execute("SELECT * FROM papers").fetchall():
        papers_cache[row["paper_id"]] = dict(row)

    output = {"topic": "black_holes", "chapters": []}

    for ch in chapters:
        cid = ch["id"]
        paper_ids = chapter_paper_map.get(cid, [])

        chapter_papers = []
        for pid in paper_ids:
            p = papers_cache.get(pid)
            if not p:
                continue
            chapter_papers.append({
                "paper_id": p["paper_id"],
                "title": p["title"],
                "abstract": p["abstract"],
                "year": p["year"],
                "cited_by_count": p["cited_by_count"],
                "first_author": p["first_author"],
                "all_authors": p["all_authors"],
                "institutions": p["institutions"],
                "journal": p["journal_name"],
                "doi": p["doi"],
                "arxiv_id": p["arxiv_id"],
                "landing_page_url": p["landing_page_url"],
                "oa_url": p["oa_url"],
                "is_oa": bool(p["is_oa"]),
                "primary_concept": p["primary_concept"],
            })

        chapter_papers.sort(key=lambda x: (x["year"] or 9999, -(x["cited_by_count"] or 0)))

        output["chapters"].append({
            "id": cid,
            "title": ch["title"],
            "era": ch["era"],
            "role": ch["role"],
            "narrative": ch["narrative"],
            "paper_count": len(chapter_papers),
            "papers": chapter_papers,
        })

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n[export] Written to {out_path}")


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------
def print_summary(conn: sqlite3.Connection, chapters: List[Dict]):
    total = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    print(f"\n{'='*60}")
    print(f"  Total unique papers in DB: {total}")
    print(f"{'='*60}")
    for ch in chapters:
        n = conn.execute(
            "SELECT COUNT(*) FROM paper_chapters WHERE chapter_id = ?", (ch["id"],)
        ).fetchone()[0]
        print(f"  [{ch['role']:9s}] {ch['id']}: {n} papers")
    print(f"{'='*60}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Fetch black hole papers from OpenAlex by narrative chapter.")
    p.add_argument("--email", required=True, help="Email for OpenAlex polite pool")
    p.add_argument("--db", default="black_holes.db", help="SQLite output path")
    p.add_argument("--json-out", default="black_holes_raw.json", help="JSON output path")
    p.add_argument("--dry-run", action="store_true", help="Print queries without fetching")
    p.add_argument("--chapters", nargs="*", help="Run only these chapter IDs (default: all)")
    args = p.parse_args()

    conn = open_db(args.db)

    selected = set(args.chapters) if args.chapters else None

    for chapter in CHAPTERS:
        if selected and chapter["id"] not in selected:
            continue

        print(f"\n{'='*60}")
        print(f"  Chapter: {chapter['title']}")
        print(f"  Era:     {chapter['era']}   Role: {chapter['role']}")
        print(f"{'='*60}", flush=True)

        works = fetch_chapter(chapter, args.email, dry_run=args.dry_run)

        if not args.dry_run:
            inserted = 0
            with conn:
                for w in works:
                    pid = upsert_paper(conn, w)
                    if pid:
                        link_chapter(conn, pid, chapter["id"], w.get("_query", ""))
                        inserted += 1
            print(f"  → saved {inserted} papers for this chapter", flush=True)

    if not args.dry_run:
        print_summary(conn, CHAPTERS)
        export_json(conn, CHAPTERS, args.json_out)

    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
