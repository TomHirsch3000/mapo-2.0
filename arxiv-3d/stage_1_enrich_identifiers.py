#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stage 1 — Enrich identifiers (join table) with clear, live logging.

Inputs:
  - stage0_missing_ids.json (from Stage 0)

Outputs:
  - stage1_identifier_map.jsonl
  - stage1_idmap_report.json

DB changes:
  - Ensures columns: doi, arxivId, s2_id, corpusId, pmid, pmcid
"""

import argparse, json, os, sqlite3, time, random, urllib.request, urllib.parse, urllib.error, sys
from typing import Dict, Any, List, Optional
from datetime import datetime

OPENALEX_BASE = "https://api.openalex.org"
OA_WORKS      = f"{OPENALEX_BASE}/works"
S2_BASE       = "https://api.semanticscholar.org/graph/v1"

# ---------------------------
# Logging helpers
# ---------------------------
def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")

def log(msg: str, *, quiet: bool = False):
    if not quiet:
        print(f"[{ts()}] {msg}", flush=True)

def dlog(msg: str, *, debug: bool = False):
    if debug:
        print(f"[{ts()}][debug] {msg}", flush=True)

def polite_sleep(seconds: float, *, quiet: bool = False):
    if seconds <= 0:
        return
    log(f"Sleeping {seconds:.1f}s to respect rate limits…", quiet=quiet)
    time.sleep(seconds)

# ---------------------------
# Net utils
# ---------------------------
def safe_get_json(full_url: str, max_retries=6, base_sleep=0.8, quiet=False) -> Dict[str, Any]:
    for attempt in range(1, max_retries+1):
        try:
            with urllib.request.urlopen(full_url, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try: body = e.read().decode("utf-8", errors="ignore")
            except Exception: pass
            if e.code in (429,500,502,503) and attempt < max_retries:
                ra = e.headers.get("Retry-After")
                wait = float(ra) if ra else base_sleep*attempt
                log(f"HTTP {e.code} on GET → waiting {wait:.1f}s (retry {attempt}/{max_retries})", quiet=quiet)
                polite_sleep(wait, quiet=quiet)
                continue
            raise RuntimeError(f"HTTP {e.code} on {full_url}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < max_retries:
                wait = base_sleep*attempt
                log(f"URL error '{e}' on GET → waiting {wait:.1f}s (retry {attempt}/{max_retries})", quiet=quiet)
                polite_sleep(wait, quiet=quiet)
                continue
            raise

def safe_post_json(url: str, payload: Dict[str, Any], headers: Dict[str,str],
                   max_retries=8, base_sleep=1.0, quiet=False) -> Any:
    data = json.dumps(payload).encode("utf-8")
    for attempt in range(1, max_retries+1):
        try:
            req = urllib.request.Request(url=url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            ra = e.headers.get("Retry-After") if e.code==429 else None
            if e.code in (429,500,502,503) and attempt < max_retries:
                wait = float(ra) if ra else base_sleep*attempt
                log(f"HTTP {e.code} on POST → waiting {wait:.1f}s (retry {attempt}/{max_retries})", quiet=quiet)
                polite_sleep(wait, quiet=quiet)
                continue
            body = ""
            try: body = e.read().decode("utf-8", errors="ignore")
            except Exception: pass
            raise RuntimeError(f"HTTP {e.code} on {url}: {body}") from e
        except urllib.error.URLError as e:
            if attempt < max_retries:
                wait = base_sleep*attempt
                log(f"URL error '{e}' on POST → waiting {wait:.1f}s (retry {attempt}/{max_retries})", quiet=quiet)
                polite_sleep(wait, quiet=quiet)
                continue
            raise

# ---------------------------
# Normalization
# ---------------------------
def norm_arxiv(a: Optional[str]) -> str:
    if not a: return ""
    a = a.strip()
    if a.lower().startswith("arxiv:"):
        a = a.split(":",1)[1]
    parts = a.split("v")
    if len(parts) > 1 and parts[-1].isdigit():
        a = "v".join(parts[:-1])
    return a

def norm_doi(d: Optional[str]) -> str:
    if not d: return ""
    d = d.strip()
    low = d.lower()
    if low.startswith("doi:"): d = d.split(":",1)[1].strip()
    if low.startswith("http://doi.org/"): d = d[len("http://doi.org/"):]
    elif low.startswith("https://doi.org/"): d = d[len("https://doi.org/"):]
    return d if d.startswith("10.") else ""

# ---------------------------
# DB
# ---------------------------
def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def ensure_id_columns(conn: sqlite3.Connection):
    conn.execute("CREATE TABLE IF NOT EXISTS papers (paperId TEXT PRIMARY KEY)")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    for col, ctype in [
        ("doi","TEXT"),
        ("arxivId","TEXT"),
        ("s2_id","TEXT"),
        ("corpusId","INTEGER"),
        ("pmid","TEXT"),
        ("pmcid","TEXT"),
    ]:
        if col not in cols:
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {ctype}")
    conn.commit()

def db_update_identifiers(conn: sqlite3.Connection, db_id: str, fields: Dict[str, Any]):
    sets, vals = [], []
    for col in ("doi","arxivId","s2_id","corpusId","pmid","pmcid"):
        if fields.get(col) is not None:
            sets.append(f"{col} = ?")
            vals.append(fields[col])
    if sets:
        vals.append(db_id)
        conn.execute(f"UPDATE papers SET {', '.join(sets)} WHERE paperId = ?", vals)
        conn.commit()

# ---------------------------
# API wrappers
# ---------------------------
def oa_backfill(db_id: str, mailto: str, quiet=False) -> Dict[str, Optional[str]]:
    url = f"{OA_WORKS}/{db_id}?select=doi,ids&mailto={urllib.parse.quote(madto:=mailto)}"
    data = safe_get_json(url, quiet=quiet)
    doi = data.get("doi") or None
    ids = data.get("ids") or {}
    arxiv_url = ids.get("arxiv") or ""
    arxiv = arxiv_url.split("/")[-1] if arxiv_url else None
    return {"doi": doi, "arxiv": arxiv}

def s2_batch_resolve(ids: List[str], quiet=False) -> List[Optional[Dict[str, Any]]]:
    url = f"{S2_BASE}/paper/batch"
    fields = "paperId,externalIds,title,year"
    payload = {"ids": ids, "fields": fields}
    headers = {"Content-Type":"application/json"}
    return safe_post_json(url, payload, headers, quiet=quiet)

# ---------------------------
# CLI + Main
# ---------------------------
def parse_args():
    p = argparse.ArgumentParser(description="Stage 1: Enrich identifiers / build joining table (verbose)")
    p.add_argument("--db", type=str, default="papers.db", help="Path to SQLite DB")
    p.add_argument("--input", type=str, default="stage0_missing_ids.json", help="Stage 0 JSON file")
    p.add_argument("--email", type=str, required=True, help="mailto for OpenAlex")
    p.add_argument("--batch-size", type=int, default=10, help="Batch size (small in public mode)")
    p.add_argument("--quiet", action="store_true", help="Minimal logs")
    p.add_argument("--debug", action="store_true", help="Per-row debug logs")
    return p.parse_args()

def main():
    args = parse_args()
    quiet = args.quiet
    debug = args.debug

    # Load input
    try:
        rows = json.load(open(args.input, "r", encoding="utf-8"))
    except FileNotFoundError:
        print(f"[error] input not found: {args.input}", file=sys.stderr); sys.exit(1)
    log(f"Stage 1 starting • rows: {len(rows)} • batch-size: {args.batch_size}", quiet=quiet)

    conn = open_db(args.db)
    ensure_id_columns(conn)

    # Pass 1: OA backfill
    need_bf = sum(1 for r in rows if not r.get("doi") or not r.get("arxiv"))
    log(f"OpenAlex backfill for DOI/arXiv (needed for {need_bf} rows)…", quiet=quiet)
    for i, r in enumerate(rows, 1):
        if r.get("doi") and r.get("arxiv"):
            continue
        try:
            bf = oa_backfill(r["db_id"], args.email, quiet=quiet)
            changed = False
            if not r.get("doi") and bf.get("doi"):
                r["doi"] = bf["doi"]; changed = True
            if not r.get("arxiv") and bf.get("arxiv"):
                r["arxiv"] = bf["arxiv"]; changed = True
            if changed:
                db_update_identifiers(conn, r["db_id"], {"doi": r.get("doi"), "arxivId": r.get("arxiv")})
                dlog(f"OA backfill {r['db_id']}: doi={r.get('doi')} arxiv={r.get('arxiv')}", debug=debug)
        except Exception as e:
            log(f"warn: OA backfill failed for {r['db_id']}: {e}", quiet=quiet)
        if i % 25 == 0:
            polite_sleep(0.2, quiet=quiet)

    # Build S2 worklist
    work, idx = [], []
    for r in rows:
        doi = norm_doi(r.get("doi"))
        arx = norm_arxiv(r.get("arxiv"))
        use_id = None
        if doi: use_id = f"DOI:{doi}"
        elif arx: use_id = f"ArXiv:{arx}"
        if use_id:
            work.append(use_id)
            idx.append(r)

    log(f"S2 resolve via DOI/arXiv • candidates: {len(work)}", quiet=quiet)

    # Pass 2: S2 resolve (public mode: small batches + sleep)
    hits = 0
    total_batches = (len(work) + args.batch_size - 1) // args.batch_size if work else 0
    for b, start in enumerate(range(0, len(work), args.batch_size), 1):
        ids = work[start:start+args.batch_size]
        chunk = idx[start:start+args.batch_size]
        log(f"[batch {b}/{total_batches}] resolving {len(ids)} ids…", quiet=quiet)
        dlog(f"first 3 ids: {ids[:3]}", debug=debug)

        try:
            data = s2_batch_resolve(ids, quiet=quiet)
        except Exception as e:
            log(f"warn: S2 batch failed: {e}", quiet=quiet)
            polite_sleep(3.0, quiet=quiet)
            continue

        batch_hits = 0
        for rec, item in zip(chunk, data):
            if not item:
                continue
            batch_hits += 1
            hits += 1
            ext = item.get("externalIds") or {}
            updates = {
                "s2_id": item.get("paperId"),
                "corpusId": ext.get("CorpusId"),
                "pmid": ext.get("PubMed"),
                "pmcid": ext.get("PubMedCentral"),
                "doi": ext.get("DOI") or rec.get("doi"),
                "arxivId": ext.get("ArXiv") or rec.get("arxiv"),
            }
            for k,v in updates.items():
                if v is not None: rec[k] = v
            db_update_identifiers(conn, rec["db_id"], updates)
            dlog(f"match db_id={rec['db_id']} → s2_id={updates['s2_id']} doi={updates['doi']} arxiv={updates['arxivId']}", debug=debug)

        log(f"[batch {b}/{total_batches}] hits={batch_hits} | cumulative={hits}", quiet=quiet)
        polite_sleep(3.0, quiet=quiet)  # polite pacing for public mode

    # Output join table
    out_path = "stage1_identifier_map.jsonl"
    with open(out_path, "w", encoding="utf-8") as out:
        for r in rows:
            out.write(json.dumps({
                "db_id": r["db_id"],
                "title": r.get("title"),
                "doi": r.get("doi"),
                "arxiv": r.get("arxiv"),
                "s2_id": r.get("s2_id"),
                "corpusId": r.get("corpusId"),
                "pmid": r.get("pmid"),
                "pmcid": r.get("pmcid"),
            }, ensure_ascii=False) + "\n")

    report = {"input_rows": len(rows), "s2_hits": hits}
    json.dump(report, open("stage1_idmap_report.json","w",encoding="utf-8"), indent=2)

    log(f"Done. s2_hits={hits} • wrote {out_path} and stage1_idmap_report.json", quiet=quiet)

if __name__ == "__main__":
    main()
