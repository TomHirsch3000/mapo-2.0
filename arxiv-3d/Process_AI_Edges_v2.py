#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Process_AI_Edges_v2.py — Build nodes & edges JSON for the 3D frontend
compatible with the updated OpenAlex+S2 schema and a separate `citations` table.

Changes vs the original:
- Uses `cited_by_count` (OpenAlex) instead of `citationCount`.
- Drops reliance on `authors`, `fieldsOfStudy`, `references`, `citedBy` columns.
- Builds edges from a standalone `citations` table (see autodetect below).
- Creates AI_field_list / AI_primary_field columns if missing, and fills them
  lazily via a local Ollama-compatible endpoint (same behavior as original).

Assumed DB:
- Table `papers(paperId PRIMARY KEY, title, abstract, cited_by_count, year, publicationDate, doi, arxivId, ... )`
- Table `citations` with one of these column pairs (autodetected):
    * (source, target)
    * (citing, cited)
    * (citingPaperId, citedPaperId)
    * (from_id, to_id)
    * (paperId, citedPaperId)  # rare; treated as (source,target)

Usage:
  python Process_AI_Edges_v2.py \
      --db papers.db \
      --frontend-dir ../arxiv-3d-frontend/public \
      --overwrite-ai 0 \
      --only-unprocessed 1
"""

import argparse
import ast
import json
import math
import os
import shutil
import sqlite3
import time
from datetime import datetime
from typing import List, Tuple, Optional

# --- LLM client (local Ollama-compatible) ---
try:
    from openai import OpenAI
    client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
except Exception:
    client = None


def summarize_text(text: str) -> str:
    if not client or not text:
        return ""
    try:
        r = client.chat.completions.create(
            model="mistral",
            messages=[{"role": "user", "content": f"Summarize this scientific abstract:\n\n{text}"}],
        )
        return (r.choices[0].message.content or "").strip()
    except Exception:
        return ""


def AI_category_one(text: str) -> List[str]:
    if not client or not text:
        return ["Unknown"]
    try:
        r = client.chat.completions.create(
            model="mistral",
            messages=[{"role": "user", "content": (
                "in a few key words pick the closest field of physics for this scientific "
                "paper based on this abstract, format the result as python list:\n\n" + text
            )}],
            temperature=0,
            top_p=0,
        )
        raw = (r.choices[0].message.content or "").strip()
        try:
            out = ast.literal_eval(raw)
            if isinstance(out, list) and out:
                return [str(x) for x in out]
        except Exception:
            pass
        return ["Unknown"]
    except Exception:
        return ["Unknown"]


def get_size_from_citations(citations: Optional[int], base: float = 0.5, max_size: float = 2.0) -> float:
    c = citations or 0
    if c <= 0:
        return base
    size = base + 0.5 * (c ** 0.4)
    return round(min(size, max_size), 2)


# --- DB helpers ---

def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_ai_columns(conn: sqlite3.Connection):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, ctype in [("AI_field_list", "TEXT"), ("AI_primary_field", "TEXT")]:
        if col not in cols:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {ctype}")
    conn.commit()


def detect_citation_columns(conn):
    objs = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
    )}
    if "citations" not in objs:
        return None
    cols = [r[1] for r in conn.execute("PRAGMA table_info(citations)").fetchall()]
    candidates = [
        ("source", "target"),
        ("citing", "cited"),
        ("citingPaperId", "citedPaperId"),
        ("from_id", "to_id"),
        ("paperId", "citedPaperId"),
        # add your pair if needed:
        ("source_id", "target_id"),
    ]
    for a, b in candidates:
        if a in cols and b in cols:
            return a, b
    return None


# --- Core ---

def build_nodes(conn: sqlite3.Connection, overwrite_ai: bool, only_unprocessed: bool) -> List[dict]:
    ensure_ai_columns(conn)

    base_query = (
        "SELECT paperId, title, abstract, cited_by_count, year, publicationDate, "
        "AI_field_list, AI_primary_field FROM papers"
    )

    if only_unprocessed:
        q = base_query + " WHERE AI_field_list IS NULL OR AI_field_list = '[]'"
    else:
        q = base_query

    rows = conn.execute(q).fetchall()

    nodes = []
    for r in rows:
        paperId = r["paperId"]
        title = r["title"]
        abstract = r["abstract"]
        cited_by_count = r["cited_by_count"]
        year = r["year"]
        publicationDate = r["publicationDate"]
        ai_field_list = r["AI_field_list"]
        ai_primary = r["AI_primary_field"]

        AI_field_list: List[str]
        AI_primary_field: str

        if not overwrite_ai and ai_field_list and ai_field_list != "[]":
            try:
                AI_field_list = json.loads(ai_field_list)
                AI_primary_field = (ai_primary or (AI_field_list[0] if AI_field_list else "Unknown"))
            except Exception:
                AI_field_list = ["Unknown"]
                AI_primary_field = "Unknown"
        else:
            print(f"[ai] Categorizing: {title[:60] if title else paperId}…")
            AI_field_list = AI_category_one(abstract or "")
            AI_primary_field = AI_field_list[0] if AI_field_list else "Unknown"
            conn.execute(
                "UPDATE papers SET AI_field_list=?, AI_primary_field=? WHERE paperId=?",
                (json.dumps(AI_field_list, ensure_ascii=False), AI_primary_field, paperId),
            )
            conn.commit()

        # Simple deterministic position heuristic
        x = ((year or 0) - 1950) * 10
        y = hash(AI_primary_field) % 50 - 25
        z = math.log1p((cited_by_count or 0)) * 10
        position = [x, y, z]

        size = get_size_from_citations(cited_by_count)

        nodes.append({
            "id": paperId,
            "title": title,
            "citationCount": cited_by_count,  # keep field name expected by frontend
            "AI_field_list": AI_field_list,
            "AI_primary_field": AI_primary_field,
            "url": f"https://openalex.org/{paperId}",
            "authors": [],                # no authors in current schema
            "fieldsOfStudy": [],          # not present in current schema
            "references": [],             # not present in current schema
            "citedBy": [],                # not present in current schema
            "year": year,
            "publicationDate": publicationDate,
            "position": position,
            "size": size,
        })

        time.sleep(0.2)  # gentle pacing for local LLMs

    return nodes


def build_edges_from_citations(conn: sqlite3.Connection, nodes: List[dict]) -> List[dict]:
    """Build edges by reading the `citations` table and keeping only edges where
    both ends exist in `nodes`.
    """
    pid_set = {n["id"] for n in nodes}
    colpair = detect_citation_columns(conn)
    if not colpair:
        print("[warn] No compatible `citations` table found — writing empty edges.")
        return []

    src_col, dst_col = colpair
    print(f"[info] Using citations columns: ({src_col} → {dst_col})")

    # Fetch in chunks to avoid huge memory spikes on very large graphs
    edges: List[dict] = []
    cur = conn.execute(f"SELECT {src_col}, {dst_col} FROM citations")
    batch = cur.fetchmany(10000)
    kept = 0
    total = 0
    while batch:
        for src, dst in batch:
            total += 1
            if src in pid_set and dst in pid_set:
                # weight can later be made smarter (e.g., based on age/distance)
                edges.append({"source": src, "target": dst, "weight": 1.0})
                kept += 1
        batch = cur.fetchmany(10000)
    print(f"[edges] scanned={total} kept={kept}")
    return edges


def write_and_copy(obj: object, out_path: str, frontend_dir: Optional[str]):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    if frontend_dir:
        try:
            os.makedirs(frontend_dir, exist_ok=True)
            shutil.copy(out_path, os.path.join(frontend_dir, os.path.basename(out_path)))
            print(f"📁 Copied {os.path.basename(out_path)} → {frontend_dir}")
        except Exception as e:
            print(f"❌ Failed to copy {os.path.basename(out_path)}: {e}")


def parse_args():
    p = argparse.ArgumentParser(description="Build nodes/edges JSON from SQLite DB (OpenAlex+S2 schema)")
    p.add_argument("--db", type=str, default="papers.db", help="Path to SQLite DB")
    p.add_argument("--frontend-dir", type=str, default="../arxiv-3d-frontend/public", help="Frontend public dir")
    p.add_argument("--overwrite-ai", type=int, default=0, help="1=force re-categorize all papers")
    p.add_argument("--only-unprocessed", type=int, default=1, help="1=only categorize rows missing AI_field_list")
    return p.parse_args()


def main():
    args = parse_args()
    conn = open_db(args.db)

    nodes = build_nodes(conn, overwrite_ai=bool(args.overwrite_ai), only_unprocessed=bool(args.only_unprocessed))
    write_and_copy(nodes, "nodes.json", args.frontend_dir)

    edges = build_edges_from_citations(conn, nodes)
    write_and_copy(edges, "edges.json", args.frontend_dir)

    conn.close()


if __name__ == "__main__":
    main()
