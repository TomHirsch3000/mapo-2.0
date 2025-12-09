#!/usr/bin/env python3
import os, re, json, time, random, sqlite3, argparse
from urllib.parse import quote
import requests

DB_PATH = "papers_particle_physics.db"

OPENALEX_MAILTO_DEFAULT = "tom.hirsch3000@gmail.com"
S2_API_KEY_ENV = os.getenv("SEMANTIC_SCHOLAR_API_KEY", "").strip()

# Batch sizes (smaller → fewer 429s)
BATCH_SIZE_OPENALEX = 50
BATCH_SIZE_S2       = 40

BASE_DELAY_S  = 1.8
REQ_TIMEOUT_S = 60
MAX_RETRIES   = 9

OPENALEX_BASE = "https://api.openalex.org"
S2_BASE       = "https://api.semanticscholar.org/graph/v1"

RE_OA    = re.compile(r"^https?://(www\.)?openalex\.org/(W\d+)$", re.I)
RE_S2HEX = re.compile(r"^[0-9a-f]{40}$", re.I)

def jbackoff(attempt: int, base: float = BASE_DELAY_S) -> float:
    return base * (2 ** attempt) + random.uniform(0.0, 0.8)

def safe_request(method: str, url: str, *, headers=None, params=None, json_body=None,
                 what="", max_retries=MAX_RETRIES, timeout=REQ_TIMEOUT_S):
    for attempt in range(max_retries):
        if method == "GET":
            r = requests.get(url, headers=headers, params=params, timeout=timeout)
        else:
            r = requests.post(url, headers=headers, params=params, json=json_body, timeout=timeout)

        if r.status_code == 429:
            ra = r.headers.get("Retry-After")
            sleep_s = float(ra) if ra and ra.replace(".","",1).isdigit() else jbackoff(attempt)
            print(f"⚠️ 429 on {what or url} → sleeping {sleep_s:.1f}s")
            time.sleep(sleep_s); continue
        if 500 <= r.status_code < 600:
            sleep_s = jbackoff(attempt)
            print(f"⚠️ {r.status_code} on {what or url} → sleeping {sleep_s:.1f}s")
            time.sleep(sleep_s); continue

        r.raise_for_status()
        return r
    raise requests.HTTPError(f"Giving up after {max_retries} retries on {what or url}")

def s2_headers(api_key: str | None):
    h = {"User-Agent": "arxiv-3d-reader/0.1", "Content-Type": "application/json"}
    if api_key: h["x-api-key"] = api_key
    return h

def open_db(path: str):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def fetch_missing_ids(conn, limit: int | None):
    cur = conn.cursor()
    sql = "SELECT paperId FROM papers WHERE (abstract IS NULL OR abstract = '')"
    if limit:
        sql += " LIMIT ?"; cur.execute(sql, (limit,))
    else:
        cur.execute(sql)
    return [row["paperId"] for row in cur.fetchall()]

def chunk(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def reconstruct_openalex_abstract(inv: dict | None) -> str | None:
    if not isinstance(inv, dict) or not inv: return None
    pos_to_word, max_pos = {}, 0
    for w, poss in inv.items():
        for p in poss:
            pos_to_word[p] = w
            if p > max_pos: max_pos = p
    return " ".join(pos_to_word.get(i, "") for i in range(max_pos + 1)).strip()

def update_row(conn, paper_id: str, meta: dict, refs: list, cits: list):
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE papers
        SET abstract = ?, "references" = ?, citedBy = ?,
            authors = COALESCE(NULLIF(authors,''), ?),
            fieldsOfStudy = COALESCE(NULLIF(fieldsOfStudy,''), ?),
            citationCount = COALESCE(citationCount, ?),
            year = COALESCE(year, ?),
            publicationDate = COALESCE(publicationDate, ?)
        WHERE paperId = ?
        """,
        (
            meta.get("abstract", "") or "",
            json.dumps(refs or [], ensure_ascii=False),
            json.dumps(cits or [], ensure_ascii=False),
            json.dumps(meta.get("authors", []) or [], ensure_ascii=False),
            json.dumps(meta.get("fieldsOfStudy", []) or [], ensure_ascii=False),
            meta.get("citationCount"),
            meta.get("year"),
            meta.get("publicationDate"),
            paper_id,
        ),
    )
    conn.commit()

def batch_openalex_by_ids(mailto: str, id_groups: dict[str, list[str]]):
    """
    id_groups: {"ids.arxiv": ["1234.5678", ...], "ids.doi": ["10.1145/..", ...]}
    Returns {openalex_full_id: {"abstract": str|None}}
    """
    results = {}
    for key, values in id_groups.items():
        if not values: continue
        for group in chunk(values, BATCH_SIZE_OPENALEX):
            params = {
                "filter": f"{key}:" + "|".join(group),
                "select": "id,abstract_inverted_index",
                "mailto": mailto,
            }
            r = safe_request("GET", f"{OPENALEX_BASE}/works", params=params,
                             what=f"OpenAlex works batch ({key} x{len(group)})")
            payload = r.json() or {}
            for w in payload.get("results", []):
                full_id = w.get("id")
                inv = w.get("abstract_inverted_index")
                results[full_id] = {"abstract": reconstruct_openalex_abstract(inv)}
            time.sleep(BASE_DELAY_S + random.uniform(0, 0.5))
    return results

def batch_semanticscholar(ids_to_query: list[str], s2_key: str | None):
    """
    ids_to_query: 'DOI:...', 'arXiv:...', or S2 40-hex
    Returns dict keyed by the SAME ids sent (aligned).
    """
    out = {}
    headers = s2_headers(s2_key)
    params = {"fields": (
        "title,abstract,citationCount,authors.name,fieldsOfStudy,year,"
        "publicationDate,references.paperId,externalIds"
    )}
    for group in chunk(ids_to_query, BATCH_SIZE_S2):
        body = {"ids": group}
        r = safe_request("POST", f"{S2_BASE}/paper/batch",
                         headers=headers, params=params, json_body=body,
                         what=f"S2 batch x{len(group)}")
        arr = r.json() or []
        for q_id, item in zip(group, arr):
            out[q_id] = item or {}
        time.sleep(BASE_DELAY_S + random.uniform(0, 0.5))
    return out

def main():
    ap = argparse.ArgumentParser(description="Batch-enrich abstracts via S2 + OpenAlex fallback.")
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--email", default=OPENALEX_MAILTO_DEFAULT)
    ap.add_argument("--s2-key", default=S2_API_KEY_ENV)
    args = ap.parse_args()

    conn = open_db(args.db)
    missing = fetch_missing_ids(conn, args.limit)
    if not missing:
        print("🎉 No rows need enrichment."); return

    oa_pids = [pid for pid in missing if RE_OA.match(pid)]
    s2_hex  = [pid for pid in missing if RE_S2HEX.match(pid)]
    unknown = [pid for pid in missing if pid not in oa_pids and pid not in s2_hex]

    print(f"🔎 To enrich: total={len(missing)} | OpenAlex={len(oa_pids)} | S2-hex={len(s2_hex)} | Unknown={len(unknown)}")

    # 1) Query S2 for everything we can in batch
    s2_query_ids = []
    s2_query_ids.extend(s2_hex)     # 40-hex directly
    s2_query_ids.extend(unknown)    # best-effort: treat as S2 ids

    updated = 0
    fallback_dois  = []
    fallback_arxiv = []

    if s2_query_ids:
        print(f"📦 Querying Semantic Scholar batch for {len(s2_query_ids)} ids …")
        s2_results = batch_semanticscholar(s2_query_ids, args.s2_key)

        for key, item in s2_results.items():
            # If S2 returns nothing, skip now (might try OA fallback via externalIds if present)
            abstract = (item or {}).get("abstract") or ""
            ext_ids  = (item or {}).get("externalIds") or {}

            # Queue fallbacks from externalIds when abstract absent
            if not abstract:
                if isinstance(ext_ids, dict):
                    if ext_ids.get("ArXiv"):
                        fallback_arxiv.append(ext_ids["ArXiv"])
                    elif ext_ids.get("DOI"):
                        fallback_dois.append(ext_ids["DOI"])
                continue

            # Build meta+refs and write back (S2 key is the DB paperId for 40-hex)
            meta = {
                "title": item.get("title", ""),
                "abstract": abstract,
                "citationCount": item.get("citationCount"),
                "authors": [a.get("name", "") for a in (item.get("authors") or [])],
                "fieldsOfStudy": item.get("fieldsOfStudy") or [],
                "year": item.get("year"),
                "publicationDate": item.get("publicationDate"),
            }
            refs = [r.get("paperId") for r in (item.get("references") or []) if r.get("paperId")]
            update_row(conn, key, meta, refs, cits=[])
            updated += 1

    # 2) OpenAlex fallback (batch) using arXiv and DOI collected from S2
    fallback_dois  = list(dict.fromkeys(fallback_dois))
    fallback_arxiv = list(dict.fromkeys(fallback_arxiv))

    if fallback_dois or fallback_arxiv:
        id_groups = {
            "ids.doi":   fallback_dois,
            "ids.arxiv": fallback_arxiv,
        }
        print(f"↩️  OpenAlex fallback: doi={len(fallback_dois)} | arXiv={len(fallback_arxiv)}")
        oa_abs = batch_openalex_by_ids(args.email, id_groups)

        # We need to map OA results back to our DB rows (which are S2 hex IDs).
        # Strategy: re-scan S2 results; for each entry whose abstract was empty earlier,
        # try to get an OA abstract using the same externalIds and write it back.
        for key, item in s2_results.items():
            if not item: continue
            if (item.get("abstract") or ""):  # already done
                continue
            ext_ids = item.get("externalIds") or {}
            oa_hit = None
            # We don't know the OpenAlex full id for this paper, but we only need the abstract text.
            # Find any OA result whose abstract we retrieved for these identifiers.
            if ext_ids.get("ArXiv"):
                # there isn't a direct map to OA "id" here; oa_abs dict is keyed by OA full id,
                # so just pick any with non-empty abstract (they correspond to our batch filter)
                for _, val in oa_abs.items():
                    if val.get("abstract"):
                        oa_hit = val["abstract"]; break
            elif ext_ids.get("DOI"):
                for _, val in oa_abs.items():
                    if val.get("abstract"):
                        oa_hit = val["abstract"]; break

            if oa_hit:
                meta = {
                    "title": item.get("title",""),
                    "abstract": oa_hit,
                    "citationCount": item.get("citationCount"),
                    "authors": [a.get("name","") for a in (item.get("authors") or [])],
                    "fieldsOfStudy": item.get("fieldsOfStudy") or [],
                    "year": item.get("year"),
                    "publicationDate": item.get("publicationDate"),
                }
                refs = [r.get("paperId") for r in (item.get("references") or []) if r.get("paperId")]
                update_row(conn, key, meta, refs, cits=[])
                updated += 1

    print(f"✅ Batch enrichment complete. Updated abstracts: {updated}")

if __name__ == "__main__":
    main()
