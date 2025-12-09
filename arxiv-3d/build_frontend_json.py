#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
build_frontend_json.py — Build nodes & edges JSON for the frontend.

Now supports:
- Filtering by citations / field / keyword / author / year range.
- Taking top-N by citations.
- Stable Y-axis bands by AI_primary_field.

Included node fields:
- id               (alias of paperId)
- paperId
- title
- summary          (from AI_summary)
- primaryField     (from AI_primary_field)
- year
- publicationDate
- doi
- journal
- firstAuthor
- allAuthors
- institutions
- workType
- language
- citationCount    (from cited_by_count)
- url
- position         [x, y, z]
- size             (derived from citationCount)
"""

import argparse
import json
import math
import os
import shutil
import sqlite3
from typing import Iterable, List, Dict, Any, Optional


# -------------------------
# DB helpers
# -------------------------

def open_db(path: str) -> sqlite3.Connection:
    abs_path = os.path.abspath(path)
    print("[info] Opening DB:", abs_path)
    conn = sqlite3.connect(abs_path)
    conn.row_factory = sqlite3.Row
    return conn


# -------------------------
# Sizing & edges
# -------------------------

def get_size_from_citations(citations: Optional[int],
                            base: float = 0.5,
                            max_size: float = 2.0) -> float:
    c = citations or 0
    if c <= 0:
        return base
    size = base + 0.5 * (c ** 0.4)
    return round(min(size, max_size), 2)


def detect_citation_columns(conn: sqlite3.Connection):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(citations)")]
    candidates = [
        ("source", "target"),
        ("citingPaperId", "citedPaperId"),
        ("citing", "cited"),
        ("from_id", "to_id"),
    ]
    for a, b in candidates:
        if a in cols and b in cols:
            return a, b
    return None


# -------------------------
# Y-axis mapping
# -------------------------

def build_field_bands(conn: sqlite3.Connection) -> Dict[str, float]:
    """
    Stable mapping AI_primary_field -> Y coordinate band.
    """
    rows = conn.execute("""
        SELECT DISTINCT AI_primary_field
        FROM papers
        WHERE AI_primary_field IS NOT NULL AND TRIM(AI_primary_field) <> ''
    """).fetchall()
    fields = sorted(r[0] for r in rows)
    if not fields:
        print("[warn] No AI_primary_field values found; Y=0 for all nodes")
        return {}

    band_step = 3.0
    offset = - (len(fields) - 1) * band_step / 2.0
    mapping = {f: offset + i * band_step for i, f in enumerate(fields)}

    print(f"[info] Field bands: {len(mapping)} distinct AI_primary_field values")
    return mapping


# -------------------------
# Build nodes
# -------------------------

def build_nodes(
    conn: sqlite3.Connection,
    min_citations: int = 0,
    top_n: int = 0,
    fields: Optional[List[str]] = None,
    keywords: Optional[List[str]] = None,
    authors: Optional[List[str]] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Build node dicts for the frontend using the requested fields and filters.
    """

    print("[info] Building nodes…")

    base_query = """
        SELECT
            paperId,
            title,
            AI_summary,
            AI_primary_field,
            cited_by_count,
            year,
            publicationDate,
            doi,
            journal_name,
            first_author_name,
            all_author_names,
            all_institution_names,
            work_type,
            language
        FROM papers
    """

    conditions: List[str] = []
    params: List[Any] = []

    if min_citations and min_citations > 0:
        conditions.append("cited_by_count >= ?")
        params.append(min_citations)

    if year_from is not None:
        conditions.append("year >= ?")
        params.append(year_from)

    if year_to is not None:
        conditions.append("year <= ?")
        params.append(year_to)

    if fields:
        # (AI_primary_field = ? OR AI_primary_field = ? ...)
        conditions.append(
            "(" + " OR ".join("AI_primary_field = ?" for _ in fields) + ")"
        )
        params.extend(fields)

    if keywords:
        # For each keyword, require it to appear in title OR summary
        for kw in keywords:
            conditions.append("(title LIKE ? OR AI_summary LIKE ?)")
            like = f"%{kw}%"
            params.extend([like, like])

    if authors:
        for a in authors:
            conditions.append("all_author_names LIKE ?")
            params.append(f"%{a}%")

    q = base_query
    if conditions:
        q += " WHERE " + " AND ".join(f"({c})" for c in conditions)

    # Always order by citations desc so top_n is meaningful
    q += " ORDER BY cited_by_count DESC NULLS LAST"

    if top_n and top_n > 0:
        q += " LIMIT ?"
        params.append(top_n)

    print("[debug] Final node SQL:")
    print("   ", q.strip())
    print("[debug] Params:", params)

    rows = conn.execute(q, params).fetchall()
    print(f"[info] Rows fetched for nodes: {len(rows)}")

    field_bands = build_field_bands(conn)

    nodes: List[Dict[str, Any]] = []

    for r in rows:
        paperId               = r["paperId"]
        title                 = r["title"]
        ai_summary            = r["AI_summary"]
        ai_primary_field      = r["AI_primary_field"]
        cited_by_count        = r["cited_by_count"]
        year                  = r["year"]
        publicationDate       = r["publicationDate"]
        doi                   = r["doi"]
        journal_name          = r["journal_name"]
        first_author_name     = r["first_author_name"]
        all_author_names      = r["all_author_names"]
        all_institution_names = r["all_institution_names"]
        work_type             = r["work_type"]
        language              = r["language"]

        # Position heuristic:
        # X: time axis
        # Y: field band (stable per AI_primary_field)
        # Z: log citations
        x = (year or 0) - 1950
        y = field_bands.get(ai_primary_field, 0.0)
        z = math.log1p(cited_by_count or 0) * 10.0

        size = get_size_from_citations(cited_by_count)

        node = {
            "id": paperId,
            "paperId": paperId,
            "title": title,
            "summary": ai_summary,
            "primaryField": ai_primary_field,
            "year": year,
            "publicationDate": publicationDate,
            "doi": doi,
            "journal": journal_name,
            "firstAuthor": first_author_name,
            "allAuthors": all_author_names,
            "institutions": all_institution_names,
            "workType": work_type,
            "language": language,
            "citationCount": cited_by_count,
            "url": f"https://openalex.org/{paperId}",
            "position": [x, y, z],
            "size": size,
        }

        nodes.append(node)

    print(f"[info] Nodes built: {len(nodes)}")
    return nodes


# -------------------------
# Build edges
# -------------------------

def build_edges(conn: sqlite3.Connection,
                nodes: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Build edges from the citations table.

    Edges use paperId as the node identifier:
    - edge["source"] = source paperId
    - edge["target"] = target paperId

    Only edges where both ends are in `nodes` are kept.
    """

    print("[info] Building edges…")

    pid_set = {n["paperId"] for n in nodes}
    colpair = detect_citation_columns(conn)

    if not colpair:
        print("[warn] No suitable citation columns found on `citations` table.")
        return []

    src_col, dst_col = colpair
    print(f"[info] Using citation columns: {src_col} → {dst_col}")

    edges: List[Dict[str, Any]] = []
    cur = conn.execute(f"SELECT {src_col}, {dst_col} FROM citations")

    total = 0
    kept = 0
    for src, dst in cur.fetchall():
        total += 1
        if src in pid_set and dst in pid_set:
            edges.append({"source": src, "target": dst, "weight": 1.0})
            kept += 1

    print(f"[info] Edges built: kept {kept} of {total} citation rows")
    return edges


# -------------------------
# Save helpers
# -------------------------

def save_json(obj: Any, path: str, frontend_dir: Optional[str]):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    print("[info] Wrote:", path)

    if frontend_dir:
        os.makedirs(frontend_dir, exist_ok=True)
        dst = os.path.join(frontend_dir, os.path.basename(path))
        shutil.copy(path, dst)
        print("[info] Copied to:", dst)


# -------------------------
# CLI
# -------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Build nodes/edges JSON from SQLite DB for the frontend"
    )
    parser.add_argument("--db", type=str, default="papers.db",
                        help="Path to SQLite DB")
    parser.add_argument("--frontend-dir", type=str, default=None,
                        help="Optional: directory to copy nodes.json / edges.json into")

    # Filtering / selection options
    parser.add_argument("--min-citations", type=int, default=0,
                        help="Minimum cited_by_count for a paper to be included")
    parser.add_argument("--top-n", type=int, default=0,
                        help="If >0, keep only the top N papers by citation count after filters")
    parser.add_argument("--field", action="append", default=None,
                        help="Filter by AI_primary_field (can be passed multiple times)")
    parser.add_argument("--keyword", action="append", default=None,
                        help="Filter by keyword in title or AI_summary (can be passed multiple times)")
    parser.add_argument("--author", action="append", default=None,
                        help="Filter by substring match in all_author_names (can be passed multiple times)")
    parser.add_argument("--year-from", type=int, default=None,
                        help="Minimum publication year (inclusive)")
    parser.add_argument("--year-to", type=int, default=None,
                        help="Maximum publication year (inclusive)")

    args = parser.parse_args()

    conn = open_db(args.db)

    nodes = build_nodes(
        conn,
        min_citations=args.min_citations,
        top_n=args.top_n,
        fields=args.field,
        keywords=args.keyword,
        authors=args.author,
        year_from=args.year_from,
        year_to=args.year_to,
    )
    edges = build_edges(conn, nodes)

    save_json(nodes, "nodes.json", args.frontend_dir)
    save_json(edges, "edges.json", args.frontend_dir)

    conn.close()
    print("[info] Done.")


if __name__ == "__main__":
    main()
