#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rebuild_citations_openalex.py

Rebuilds citations(source,target) from OpenAlex for all papers in your DB.

Features:
- --db to specify which SQLite DB to use.
- Batches OpenAlex calls via ids.openalex (full URLs).
- DB-side batching of paper IDs so we don't hold everything in memory.
- Resumable:
    * By default, keeps the existing `citations` table and skips
      papers whose citations are already present.
    * Use --reset to drop and rebuild from scratch.
- Periodic progress logging and commits so you don't lose work
  if the script is interrupted.
"""

import argparse
import json
import sqlite3
import time
from typing import Iterable, List

import requests


MAILTO = "tom.hirsch3000@gmail.com"
BASE = "https://api.openalex.org/works"

# API batching (how many OpenAlex IDs per HTTP request)
BATCH_SIZE = 60          # conservative (keep query strings shorter)
SLEEP_BETWEEN = 0.6      # pacing between requests
HEADERS = {
    "User-Agent": f"arxiv-3d/edges (mailto:{MAILTO})",
    "Accept": "application/json",
}


# -----------------------------
# Helpers
# -----------------------------

def chunks(lst: List[str], n: int) -> Iterable[List[str]]:
    """Yield successive n-sized chunks from lst."""
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def fetch_batch_fullurls(url_ids: List[str]) -> dict:
    params = {
        "filter": "ids.openalex:" + "|".join(url_ids),
        "per_page": 200,
        "select": "id,referenced_works",
        "mailto": MAILTO,
    }
    r = requests.get(BASE, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()


def fetch_single_fullurl(url_id: str) -> dict:
    # url_id looks like https://openalex.org/W123...
    r = requests.get(
        url_id,
        params={"select": "id,referenced_works", "mailto": MAILTO},
        headers=HEADERS,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def ensure_citations_table(conn: sqlite3.Connection, reset: bool) -> None:
    """
    Ensure `citations` table exists with (source, target) columns.

    If reset=True, drop and recreate from scratch.
    Otherwise, keep existing data so the script can resume.
    """
    c = conn.cursor()

    if reset:
        print("[info] --reset specified: dropping existing citations table (if any)")
        c.execute("DROP TABLE IF EXISTS citations;")
        conn.commit()

    # Create table if it doesn't exist
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS citations (
            source TEXT,
            target TEXT
        );
        """
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source);"
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_citations_target ON citations(target);"
    )
    conn.commit()


def get_done_sources(conn: sqlite3.Connection) -> set:
    """
    Return a set of paperIds that already appear as `source`
    in the citations table. Used for resuming.
    """
    c = conn.cursor()
    c.execute("SELECT DISTINCT source FROM citations;")
    done = {row[0] for row in c.fetchall()}
    print(f"[info] Found {len(done)} source papers already in citations (will skip them)")
    return done


def iter_paper_id_chunks(
    conn: sqlite3.Connection,
    chunk_size: int = 2000,
) -> Iterable[List[str]]:
    """
    Iterate over paperIds in the papers table in chunks.

    This avoids loading all IDs into memory at once for very large tables.
    """
    c = conn.cursor()
    offset = 0
    while True:
        rows = c.execute(
            "SELECT paperId FROM papers LIMIT ? OFFSET ?;",
            (chunk_size, offset),
        ).fetchall()
        if not rows:
            break
        yield [row[0] for row in rows]
        offset += chunk_size


# -----------------------------
# Core logic
# -----------------------------

def rebuild_citations(
    db_path: str,
    reset: bool = False,
    id_chunk_size: int = 2000,
    batch_size: int = BATCH_SIZE,
) -> None:
    conn = sqlite3.connect(db_path, timeout=30)
    c = conn.cursor()
    print(f"[info] Opened DB: {db_path}")

    ensure_citations_table(conn, reset=reset)

    # For resume: which sources already have citations
    done_sources = set()
    if not reset:
        done_sources = get_done_sources(conn)

    total_papers = c.execute("SELECT COUNT(*) FROM papers;").fetchone()[0]
    print(f"[info] Found {total_papers} papers in DB")

    total_refs_seen = 0
    total_rows_inserted = 0
    processed_papers = 0

    # Iterate over all papers in DB in ID chunks
    for id_chunk in iter_paper_id_chunks(conn, chunk_size=id_chunk_size):
        # Filter out any that we've already processed as sources
        remaining_ids = [pid for pid in id_chunk if pid not in done_sources]
        if not remaining_ids:
            processed_papers += len(id_chunk)
            print(
                f"[skip] Chunk of {len(id_chunk)} papers already fully processed "
                f"(processed so far: {processed_papers}/{total_papers})"
            )
            continue

        print(
            f"[info] Processing chunk of {len(remaining_ids)} new papers "
            f"(chunk size={len(id_chunk)}, processed so far={processed_papers}/{total_papers})"
        )

        # Convert to full URLs
        id_urls = [f"https://openalex.org/{pid}" for pid in remaining_ids]

        for batch_idx, batch_urls in enumerate(chunks(id_urls, batch_size), start=1):
            print(
                f"[info]  API batch {batch_idx} "
                f"({len(batch_urls)} papers, "
                f"global processed {processed_papers}/{total_papers})"
            )

            try:
                data = fetch_batch_fullurls(batch_urls)
                results = data.get("results", [])
            except requests.HTTPError as e:
                status = e.response.status_code if e.response is not None else None
                print(
                    f"[warn]  Batch fetch failed with HTTP {status}. "
                    f"Falling back to per-ID for this batch."
                )
                results = []
                for u in batch_urls:
                    try:
                        item = fetch_single_fullurl(u)
                        results.append(item)
                        time.sleep(SLEEP_BETWEEN)
                    except requests.HTTPError as e2:
                        st2 = e2.response.status_code if e2.response else None
                        print(f"[error]   Single fetch failed {st2} for {u}")
                        continue
                    except Exception as e2:
                        print(f"[error]   Single fetch exception for {u}: {e2}")
                        continue
            except Exception as e:
                print(f"[error]  Unexpected error on batch fetch: {e}")
                # continue to next batch rather than dying
                time.sleep(SLEEP_BETWEEN)
                continue

            # Build rows for insertion
            rows = []
            for item in results:
                src = item["id"].rsplit("/", 1)[-1]  # W-id
                refs = item.get("referenced_works") or []
                total_refs_seen += len(refs)
                for r in refs:
                    rows.append((src, r.rsplit("/", 1)[-1]))

                # Mark this source as done (even if it had zero refs)
                done_sources.add(src)

            if rows:
                c.executemany(
                    "INSERT INTO citations (source, target) VALUES (?, ?);",
                    rows,
                )
                conn.commit()
                total_rows_inserted += len(rows)
                print(
                    f"[info]   Inserted {len(rows)} rows this batch "
                    f"(total rows_inserted={total_rows_inserted}, total_refs_seen={total_refs_seen})"
                )
            else:
                print("[info]   No references in this batch")

            time.sleep(SLEEP_BETWEEN)

        processed_papers += len(id_chunk)
        print(
            f"[info] Finished DB chunk. Processed papers: "
            f"{processed_papers}/{total_papers}, "
            f"rows_inserted={total_rows_inserted}"
        )

    cnt = c.execute("SELECT COUNT(*) FROM citations;").fetchone()[0]
    print(
        f"[done] refs_seen={total_refs_seen}, "
        f"rows_inserted={total_rows_inserted}, "
        f"rows_in_table={cnt}"
    )
    conn.close()


# -----------------------------
# CLI
# -----------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Rebuild citations(source,target) from OpenAlex for all papers in DB"
    )
    p.add_argument(
        "--db",
        type=str,
        default="papers.db",
        help="Path to SQLite DB (default: papers.db)",
    )
    p.add_argument(
        "--reset",
        action="store_true",
        help="Drop and recreate citations table before rebuilding",
    )
    p.add_argument(
        "--id-chunk-size",
        type=int,
        default=2000,
        help="How many papers to load from DB at a time (default: 2000)",
    )
    p.add_argument(
        "--batch-size",
        type=int,
        default=BATCH_SIZE,
        help="How many OpenAlex IDs per HTTP request (default: 60)",
    )
    return p.parse_args()


def main():
    args = parse_args()
    try:
        rebuild_citations(
            db_path=args.db,
            reset=args.reset,
            id_chunk_size=args.id_chunk_size,
            batch_size=args.batch_size,
        )
    except KeyboardInterrupt:
        print("\n[info] Interrupted by user (Ctrl+C). "
              "Any inserted citations up to this point are safely committed.")
    except Exception as e:
        print(f"[fatal] Unhandled error: {e}")


if __name__ == "__main__":
    main()
