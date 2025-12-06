import argparse
import logging
import sqlite3
import time
from typing import Optional, Dict, Any

import requests
import xml.etree.ElementTree as ET


# ================================
# CONFIG
# ================================
S2_BASE_URL = "https://api.semanticscholar.org/graph/v1/paper"

# Global adaptive delay between ALL S2 requests (seconds)
global_delay = 0.4

# Counts 429 bursts
consecutive_429 = 0


# ================================
# DOI Normaliser
# ================================
def norm_doi(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    doi = raw.strip().strip('"').strip("'")

    prefixes = [
        "https://doi.org/", "http://doi.org/",
        "https://dx.doi.org/", "http://dx.doi.org/",
        "doi:", "DOI:",
    ]
    for p in prefixes:
        if doi.lower().startswith(p.lower()):
            doi = doi[len(p):].strip()
            break

    if " " in doi or "/" not in doi:
        return None

    return doi


# ================================
# arXiv Fetch
# ================================
def fetch_arxiv_abstract(arxiv_id: str, timeout: int = 12) -> Optional[str]:
    url = f"http://export.arxiv.org/api/query?id_list={arxiv_id}"
    try:
        resp = requests.get(url, timeout=timeout)
    except Exception as e:
        logging.warning("arXiv request error for %s: %s", arxiv_id, e)
        return None

    if resp.status_code != 200:
        return None

    try:
        root = ET.fromstring(resp.text)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        entry = root.find("atom:entry", ns)
        if entry is None:
            return None
        summary = entry.find("atom:summary", ns)
        if summary is None:
            return None
        return summary.text.strip()
    except Exception as e:
        logging.warning("arXiv parse error %s: %s", arxiv_id, e)
        return None


# ================================
# Semantic Scholar Fetch (with long cooldown)
# ================================
def fetch_s2_by_doi(
    doi: str,
    fields: str = "title,abstract,year,publicationDate,citationCount,externalIds,paperId",
    api_key: Optional[str] = None,
    timeout: int = 15,
    max_local_retries: int = 2,
):
    global global_delay, consecutive_429

    url = f"{S2_BASE_URL}/DOI:{doi}"
    params = {"fields": fields}
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key

    attempt = 0

    while attempt <= max_local_retries:
        # global pacing before EVERY request
        time.sleep(global_delay)

        try:
            resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        except KeyboardInterrupt:
            raise
        except Exception as e:
            logging.warning("Network error for DOI %s: %s", doi, e)
            global_delay = min(10, global_delay * 1.5)
            attempt += 1
            continue

        # ========= 200 OK =========
        if resp.status_code == 200:
            consecutive_429 = 0
            try:
                data = resp.json()
            except Exception:
                return None

            # Speed up slightly (but not below 0.2s)
            global_delay = max(0.2, global_delay * 0.95)
            return data

        # ========= 404 =========
        if resp.status_code == 404:
            consecutive_429 = 0
            return None

        # ========= 429 Too Many Requests =========
        if resp.status_code == 429:
            consecutive_429 += 1

            # Increase delay sharply
            old_delay = global_delay
            global_delay = min(12.0, global_delay * 2.5)

            logging.warning(
                "429 for DOI %s. Delay %.2fs → %.2fs (%d consecutive 429s)",
                doi, old_delay, global_delay, consecutive_429
            )

            # If too many 429s → LONG COOLDOWN (3 minutes)
            if consecutive_429 >= 5:
                logging.error("🚨 Semantic Scholar very unhappy — cooling down for 3 minutes...")
                time.sleep(180)  # 3 min
                logging.info("Cooldown done. Slowing down requests.")
                global_delay = 6.0
                consecutive_429 = 0

            # retry the same DOI (don't count as a local attempt)
            continue

        # ========= 5xx server errors =========
        if 500 <= resp.status_code < 600:
            global_delay = min(12.0, global_delay * 1.5)
            attempt += 1
            continue

        # ========= Other errors =========
        return None

    return None


# ================================
# DB update helper
# ================================
def update_row(conn, table, pid, s2, arxiv_abs):
    cur = conn.cursor()

    updates = {}

    if s2:
        if s2.get("title"):
            updates["title"] = s2["title"]
        if s2.get("abstract"):
            updates["abstract"] = s2["abstract"]
        if s2.get("year") is not None:
            updates["year"] = s2["year"]
        if s2.get("publicationDate"):
            updates["publicationDate"] = s2["publicationDate"]
        if s2.get("citationCount") is not None:
            updates["cited_by_count"] = s2["citationCount"]

        ext = s2.get("externalIds") or {}
        if ext.get("ArXiv"):
            updates["arxivId"] = ext["ArXiv"]

    # arXiv fallback only if still missing abstract
    if not updates.get("abstract") and arxiv_abs:
        updates["abstract"] = arxiv_abs

    if not updates:
        return False

    set_clause = ", ".join(f"{k}=?" for k in updates)
    params = list(updates.values()) + [pid]
    cur.execute(f"UPDATE {table} SET {set_clause} WHERE paperId=?", params)
    conn.commit()
    return True


# ================================
# MAIN
# ================================
def main():
    parser = argparse.ArgumentParser(description="Fetch abstracts via Semantic Scholar + arXiv fallback")
    parser.add_argument("--db", required=True)
    parser.add_argument("--table", default="papers")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--s2-api-key", default=None)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    q = f"""
        SELECT paperId, doi, arxivId
        FROM {args.table}
        WHERE (abstract IS NULL OR TRIM(abstract) = '')
          AND doi IS NOT NULL
    """
    if args.limit > 0:
        q += f" LIMIT {args.limit}"

    cur.execute(q)
    rows = cur.fetchall()
    logging.info("Found %d papers with missing abstracts", len(rows))

    updated = 0
    s2_hits = 0
    arxiv_hits = 0

    for row in rows:
        pid = row["paperId"]
        doi = norm_doi(row["doi"])
        arxiv_id = row["arxivId"]

        if not doi:
            continue

        # ===== STEP 1: Semantic Scholar =====
        s2_data = fetch_s2_by_doi(doi, api_key=args.s2_api_key)
        if s2_data:
            s2_hits += 1
            ext = s2_data.get("externalIds") or {}
            if ext.get("ArXiv"):
                arxiv_id = ext["ArXiv"]

        # ===== STEP 2: arXiv fallback =====
        arxiv_abs = None
        if (not s2_data or not s2_data.get("abstract")) and arxiv_id:
            arxiv_abs = fetch_arxiv_abstract(arxiv_id)
            if arxiv_abs:
                arxiv_hits += 1

        # ===== UPDATE ROW =====
        if update_row(conn, args.table, pid, s2_data, arxiv_abs):
            updated += 1

    logging.info("Done.")
    logging.info("Updated rows: %d", updated)
    logging.info("Semantic Scholar hits: %d", s2_hits)
    logging.info("arXiv fallback hits: %d", arxiv_hits)


if __name__ == "__main__":
    main()
