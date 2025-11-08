#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stage 2 — Fetch abstracts with multi-source fallback (no API key required).

Order:
  1) Semantic Scholar (by s2_id)        — often empty without key
  2) OpenAlex (by OpenAlex W-id)        — uses abstract_inverted_index
  3) arXiv (by arXiv ID)                — via export.arxiv.org

Inputs:
  - stage1_identifier_map.jsonl  (from Stage 1; includes db_id, s2_id, arxiv)
Outputs:
  - stage2_abstracts_raw.jsonl   (source-tagged results)
  - stage2_report.json
"""

import argparse, json, os, sqlite3, time, random, urllib.request, urllib.parse, urllib.error, sys
from typing import Dict, Any, List, Optional
from datetime import datetime

S2_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
S2_FIELDS = "paperId,title,abstract,year,publicationDate,citationCount"
OA_BASE = "https://api.openalex.org/works"
ARXIV_API = "https://export.arxiv.org/api/query"

def ts(): return datetime.now().strftime("%H:%M:%S")
def log(msg): print(f"[{ts()}] {msg}", flush=True)
def sleep_polite(seconds: float): time.sleep(seconds + random.uniform(0, 0.4))

def open_db(path: str):
    conn = sqlite3.connect(path); conn.row_factory = sqlite3.Row; return conn

def ensure_cols(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS papers (paperId TEXT PRIMARY KEY)")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, ctype in [
        ("title","TEXT"),
        ("abstract","TEXT"),
        ("cited_by_count","INTEGER"),
        ("year","INTEGER"),
        ("publicationDate","TEXT"),
        ("doi","TEXT"),
        ("arxivId","TEXT"),
        ("s2_id","TEXT"),
    ]:
        if col not in cols:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {ctype}")
    conn.commit()

def update_row(conn, db_id: str, meta: Dict[str, Any]) -> bool:
    abstract = (meta.get("abstract") or "").strip()
    if not abstract: return False
    conn.execute("""
        UPDATE papers SET
          title = COALESCE(?, title),
          abstract = ?,
          cited_by_count = COALESCE(?, cited_by_count),
          year = COALESCE(?, year),
          publicationDate = COALESCE(?, publicationDate)
        WHERE paperId = ?
    """, (
        meta.get("title"),
        abstract,
        meta.get("citationCount"),
        meta.get("year"),
        meta.get("publicationDate"),
        db_id
    ))
    conn.commit()
    return True

# ---------- HTTP ----------
def http_get(url: str, headers: Optional[Dict[str,str]] = None, retries=6, base_sleep=1.2) -> str:
    headers = headers or {}
    for attempt in range(1, retries+1):
        try:
            req = urllib.request.Request(url=url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            ra = e.headers.get("Retry-After")
            if e.code in (429,500,502,503) and attempt < retries:
                wait = float(ra) if ra else base_sleep * attempt
                log(f"HTTP {e.code} GET → waiting {wait:.1f}s (retry {attempt}/{retries})")
                sleep_polite(wait); continue
            body = ""
            try: body = e.read().decode("utf-8", errors="ignore")
            except Exception: pass
            raise RuntimeError(f"HTTP {e.code} on {url}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < retries:
                wait = base_sleep * attempt
                log(f"URL error '{e}' → waiting {wait:.1f}s (retry {attempt}/{retries})")
                sleep_polite(wait); continue
            raise

def http_post_json(url: str, payload: Dict[str, Any], headers: Optional[Dict[str,str]] = None,
                   retries=8, base_sleep=1.2) -> Any:
    headers = headers or {}
    data = json.dumps(payload).encode("utf-8")
    for attempt in range(1, retries+1):
        try:
            req = urllib.request.Request(url=url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            ra = e.headers.get("Retry-After")
            if e.code in (429,500,502,503) and attempt < retries:
                wait = float(ra) if ra else base_sleep * attempt
                log(f"HTTP {e.code} POST → waiting {wait:.1f}s (retry {attempt}/{retries})")
                sleep_polite(wait); continue
            body = ""
            try: body = e.read().decode("utf-8", errors="ignore")
            except Exception: pass
            raise RuntimeError(f"HTTP {e.code} on {url}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < retries:
                wait = base_sleep * attempt
                log(f"URL error '{e}' → waiting {wait:.1f}s (retry {attempt}/{retries})")
                sleep_polite(wait); continue
            raise

# ---------- Sources ----------
def s2_fetch_batch_by_ids(s2_ids: List[str]) -> List[Optional[Dict[str, Any]]]:
    if not s2_ids: return []
    payload = {"ids": s2_ids, "fields": S2_FIELDS}
    headers = {"Content-Type": "application/json"}  # no API key header in public mode
    data = http_post_json(S2_URL, payload, headers=headers)
    return data  # aligned with input

def oa_fetch_abstract_by_wid(db_id: str, mailto: str) -> Optional[str]:
    url = f"{OA_BASE}/{db_id}?select=abstract_inverted_index,doi,ids&mailto={urllib.parse.quote(mailto)}"
    raw = http_get(url)
    obj = json.loads(raw)
    inv = obj.get("abstract_inverted_index")
    if not inv: return None
    # reconstruct text
    idx = {}
    for tok, pos_list in inv.items():
        for p in pos_list: idx[p] = tok
    return " ".join(idx[i] for i in range(0, max(idx.keys())+1))

def arxiv_fetch_abstract(arxiv_id: str) -> Optional[str]:
    if not arxiv_id: return None
    params = urllib.parse.urlencode({"search_query": f"id:{arxiv_id}", "start": 0, "max_results": 1})
    url = f"{ARXIV_API}?{params}"
    xml = http_get(url)
    # super-lightweight parse: look for <summary>…</summary>
    start = xml.find("<summary>")
    end = xml.find("</summary>")
    if start == -1 or end == -1: return None
    summary = xml[start+9:end].strip()
    # arXiv returns HTML-escaped content; replace common entities
    return (summary
            .replace("&lt;", "<").replace("&gt;", ">")
            .replace("&amp;", "&").replace("&#13;", "").replace("\n", " ").strip())

# ---------- CLI / Main ----------
def parse_args():
    p = argparse.ArgumentParser(description="Stage 2: Fetch abstracts with multi-source fallback")
    p.add_argument("--db", type=str, default="papers.db")
    p.add_argument("--input", type=str, default="stage1_identifier_map.jsonl")
    p.add_argument("--batch-size", type=int, default=10, help="S2 batch (public mode friendly)")
    p.add_argument("--mailto", type=str, default="you@example.com", help="mailto for OpenAlex")
    p.add_argument("--pace", type=float, default=3.0, help="sleep between S2 batches (seconds)")
    return p.parse_args()

def main():
    args = parse_args()
    conn = open_db(args.db)
    ensure_cols(conn)

    # Load id map
    work = []
    with open(args.input, "r", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            work.append({
                "db_id": rec["db_id"],
                "s2_id": rec.get("s2_id"),
                "arxiv": rec.get("arxiv")
            })

    log(f"Stage 2: {len(work)} records to process (S2→OA→arXiv fallback)")

    raw_out = open("stage2_abstracts_raw.jsonl","w",encoding="utf-8")
    updated = 0
    queried = 0

    # Pass 1 — S2 batch by s2_id (public mode: small batches, often abstract==None)
    s2_items = [(w["db_id"], w["s2_id"]) for w in work if w.get("s2_id")]
    for i in range(0, len(s2_items), args.batch_size):
        chunk = s2_items[i:i+args.batch_size]
        ids = [sid for _, sid in chunk]
        log(f"S2 batch {i//args.batch_size+1}/{(len(s2_items)+args.batch_size-1)//args.batch_size}: {len(ids)} ids")
        try:
            data = s2_fetch_batch_by_ids(ids)
        except Exception as e:
            log(f"warn: S2 batch failed: {e}")
            sleep_polite(args.pace)
            continue
        for (db_id, sid), item in zip(chunk, data):
            raw_out.write(json.dumps({"source":"S2","db_id":db_id,"s2_id":sid,"result":item}, ensure_ascii=False)+"\n")
            if item and update_row(conn, db_id, item):
                updated += 1
        queried += len(chunk)
        sleep_polite(args.pace)

    # Collect which still need abstracts
    need_more = set()
    cur = conn.execute("SELECT paperId FROM papers WHERE abstract IS NULL OR abstract=''")
    need_more.update([row["paperId"] for row in cur.fetchall()])

    # Pass 2 — OpenAlex fallback (abstract_inverted_index)
    log(f"OpenAlex fallback for {len(need_more)} rows lacking abstracts…")
    for count, db_id in enumerate(list(need_more), 1):
        try:
            abstract = oa_fetch_abstract_by_wid(db_id, args.mailto)
        except Exception as e:
            log(f"warn: OA fetch failed for {db_id}: {e}")
            abstract = None
        if abstract:
            ok = update_row(conn, db_id, {"abstract": abstract})
            raw_out.write(json.dumps({"source":"OpenAlex","db_id":db_id,"abstract_found":bool(ok)}, ensure_ascii=False)+"\n")
        if count % 15 == 0:
            sleep_polite(0.2)

    # Recompute missing
    need_more = set()
    cur = conn.execute("SELECT paperId, arxivId FROM papers WHERE (abstract IS NULL OR abstract='') AND arxivId IS NOT NULL")
    need_more.update([(row["paperId"], row["arxivId"]) for row in cur.fetchall()])

    # Pass 3 — arXiv fallback
    log(f"arXiv fallback for {len(need_more)} rows…")
    for count, (db_id, arx) in enumerate(list(need_more), 1):
        try:
            abstract = arxiv_fetch_abstract(arx)
        except Exception as e:
            log(f"warn: arXiv fetch failed for {db_id}/{arx}: {e}")
            abstract = None
        if abstract:
            ok = update_row(conn, db_id, {"abstract": abstract})
            raw_out.write(json.dumps({"source":"arXiv","db_id":db_id,"arxiv":arx,"abstract_found":bool(ok)}, ensure_ascii=False)+"\n")
        if count % 10 == 0:
            sleep_polite(0.5)

    raw_out.close()

    # Report
    row = conn.execute("SELECT COUNT(*) AS n FROM papers WHERE abstract IS NOT NULL AND abstract!=''").fetchone()
    have_abs = row["n"]
    total = conn.execute("SELECT COUNT(*) AS n FROM papers").fetchone()["n"]
    report = {"updated_abstract_rows": have_abs, "total_rows": total}
    json.dump(report, open("stage2_report.json","w",encoding="utf-8"), indent=2)
    log(f"Done. Abstracts present: {have_abs}/{total} • wrote stage2_abstracts_raw.jsonl & stage2_report.json")

if __name__ == "__main__":
    main()
