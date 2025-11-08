#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stage 0 — discover rows needing enrichment.

Reads your SQLite DB and writes a JSON array of objects like:
  {"db_id":"W123...", "doi":"10.xxxx/...", "arxiv":"2401.01234", "title":"..."}

Usage:
  python stage_0_discover_rows_needing_enrichment.py --db papers_particle_physics.db --limit 100

Arguments:
  --db     Path to SQLite DB (default: papers.db)
  --limit  Max rows to return (default: 0 → no limit)
"""

import argparse, json, sqlite3

def ensure_identifier_columns(conn: sqlite3.Connection):
    """Add doi/arxivId columns if an older DB is missing them."""
    cur = conn.execute("PRAGMA table_info(papers)")
    cols = {row[1] for row in cur.fetchall()}
    changed = False
    if "doi" not in cols:
        conn.execute("ALTER TABLE papers ADD COLUMN doi TEXT"); changed = True
    if "arxivId" not in cols:
        conn.execute("ALTER TABLE papers ADD COLUMN arxivId TEXT"); changed = True
    if changed:
        conn.commit()

def discover(db_path: str, limit: int):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    ensure_identifier_columns(conn)

    q = """
      SELECT
        paperId     AS db_id,
        doi         AS doi,
        arxivId     AS arxiv,
        title       AS title
      FROM papers
      WHERE abstract IS NULL OR abstract = ''
    """
    params = ()
    if limit > 0:
        q += " LIMIT ?"
        params = (limit,)

    rows = conn.execute(q, params).fetchall()
    conn.close()

    payload = []
    for r in rows:
        payload.append({
            "db_id":  (r["db_id"] or "").split("/")[-1],   # keep short W-id if a URL slipped in
            "doi":    (r["doi"] or None),
            "arxiv":  (r["arxiv"] or None),
            "title":  (r["title"] or None),
        })

    with open("stage0_missing_ids.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"[stage0] wrote {len(payload)} rows → stage0_missing_ids.json "
          f"(fields: db_id, doi, arxiv, title)")

def parse_args():
    p = argparse.ArgumentParser(description="Stage 0: discover rows needing enrichment")
    p.add_argument("--db", type=str, default="papers.db", help="Path to SQLite database")
    p.add_argument("--limit", type=int, default=0, help="Max rows (0 = no limit)")
    return p.parse_args()

def main():
    args = parse_args()
    discover(args.db, args.limit)

if __name__ == "__main__":
    main()
