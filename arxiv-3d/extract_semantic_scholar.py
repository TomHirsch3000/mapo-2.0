#!/usr/bin/env python3
import sqlite3, json, time, random, re, requests
from urllib.parse import quote

DB_PATH = "papers.db"
OPENALEX_BASE = "https://api.openalex.org"
S2_BASE = "https://api.semanticscholar.org/graph/v1"

OPENALEX_MAILTO = "tom.hirsch3000@gmail.com"   # set your email for OpenAlex politeness
PAGE_SIZE = 200
SLEEP_BASE = 1.0
S2_API_KEY = None  # if you have one, add it

OPENALEX_ID_RE = re.compile(r"^https?://(www\.)?openalex\.org/W\d+$", re.I)
S2_HEX_RE = re.compile(r"^[0-9a-f]{40}$", re.I)

def db_connect(path=DB_PATH):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def yield_missing_papers(conn, limit=None):
    cur = conn.cursor()
    q = """
      SELECT paperId
      FROM papers
      WHERE (abstract IS NULL OR abstract = '')
    """
    if limit:
        q += " LIMIT ?"
        cur.execute(q, (limit,))
    else:
        cur.execute(q)
    while True:
        rows = cur.fetchmany(PAGE_SIZE)
        if not rows:
            break
        for r in rows:
            yield r["paperId"]

def id_kind(pid: str):
    if not pid:
        return "unknown"
    if OPENALEX_ID_RE.match(pid):
        return "openalex"
    if S2_HEX_RE.match(pid):
        return "s2_paper"
    return "unknown"

def reconstruct_openalex_abstract(inverted_index: dict) -> str:
    pos_to_word, max_pos = {}, 0
    for word, positions in inverted_index.items():
        for p in positions:
            pos_to_word[p] = word
            if p > max_pos: max_pos = p
    return " ".join(pos_to_word.get(i, "") for i in range(max_pos + 1)).strip()

def s2_headers():
    h = {"User-Agent": "arxiv-3d-reader/0.1"}
    if S2_API_KEY:
        h["x-api-key"] = S2_API_KEY
    return h

def s2_get_by_paperid(paper_id):
    fields = ("title,abstract,citationCount,authors.name,fieldsOfStudy,year,"
              "publicationDate,references.paperId")
    meta_url = f"{S2_BASE}/paper/{paper_id}"
    r = requests.get(meta_url, headers=s2_headers(), params={"fields": fields}, timeout=60)
    if r.status_code == 404:
        return None, [], []
    r.raise_for_status()
    data = r.json() or {}

    meta = {
        "title": data.get("title", ""),
        "abstract": data.get("abstract", "") or "",
        "citationCount": data.get("citationCount", 0),
        "authors": [a.get("name", "") for a in (data.get("authors") or [])],
        "fieldsOfStudy": data.get("fieldsOfStudy", []) or [],
        "year": data.get("year"),
        "publicationDate": data.get("publicationDate"),
    }
    refs = [x.get("paperId") for x in (data.get("references") or []) if x.get("paperId")]

    # citations
    cit_url = f"{S2_BASE}/paper/{paper_id}/citations"
    c = requests.get(cit_url, headers=s2_headers(), params={"fields": "citingPaper.paperId"}, timeout=60)
    cits = []
    if c.status_code == 200:
        cj = c.json() or {}
        for row in cj.get("data", []):
            cp = row.get("citingPaper")
            if cp and cp.get("paperId"):
                cits.append(cp["paperId"])
    return meta, refs, cits

def s2_get_by_key(tag, value):
    key = f"{tag}:{value}"
    enc = quote(key, safe='')
    fields = ("title,abstract,citationCount,authors.name,fieldsOfStudy,year,"
              "publicationDate,references.paperId")
    r = requests.get(f"{S2_BASE}/paper/{enc}", headers=s2_headers(), params={"fields": fields}, timeout=60)
    if r.status_code == 404:
        return None, [], []
    r.raise_for_status()
    data = r.json() or {}
    meta = {
        "title": data.get("title", ""),
        "abstract": data.get("abstract", "") or "",
        "citationCount": data.get("citationCount", 0),
        "authors": [a.get("name", "") for a in (data.get("authors") or [])],
        "fieldsOfStudy": data.get("fieldsOfStudy", []) or [],
        "year": data.get("year"),
        "publicationDate": data.get("publicationDate"),
    }
    refs = [x.get("paperId") for x in (data.get("references") or []) if x.get("paperId")]

    c = requests.get(f"{S2_BASE}/paper/{enc}/citations", headers=s2_headers(), params={"fields": "citingPaper.paperId"}, timeout=60)
    cits = []
    if c.status_code == 200:
        cj = c.json() or {}
        for row in cj.get("data", []):
            cp = row.get("citingPaper")
            if cp and cp.get("paperId"):
                cits.append(cp["paperId"])
    return meta, refs, cits

def openalex_get_ids_and_abstract(openalex_id):
    params = {"select": "ids,abstract_inverted_index"}
    if OPENALEX_MAILTO:
        params["mailto"] = OPENALEX_MAILTO
    r = requests.get(f"{OPENALEX_BASE}/works/{openalex_id}", params=params, timeout=60)
    r.raise_for_status()
    data = r.json() or {}
    ids = (data.get("ids") or {})
    doi = ids.get("doi")
    arxiv = ids.get("arxiv")
    inv = data.get("abstract_inverted_index")
    abstract = reconstruct_openalex_abstract(inv) if isinstance(inv, dict) and inv else None
    return {"doi": doi, "arxiv": arxiv, "abstract": abstract}

def update_row(conn, paper_id, meta, refs, cits, source):
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
            meta.get("abstract", "") if meta else "",
            json.dumps(refs or []),
            json.dumps(cits or []),
            json.dumps(meta.get("authors", [])) if meta else json.dumps([]),
            json.dumps(meta.get("fieldsOfStudy", [])) if meta else json.dumps([]),
            meta.get("citationCount") if meta else None,
            meta.get("year") if meta else None,
            meta.get("publicationDate") if meta else None,
            paper_id,
        ),
    )
    conn.commit()
    title = meta.get("title") if meta else "(title unknown)"
    print(f"✅ Updated: {title[:80]} — via {source}")

def enrich_one(conn, pid):
    kind = id_kind(pid)

    # 1) If S2 paperId (40-hex), go straight to S2
    if kind == "s2_paper":
        try:
            meta, refs, cits = s2_get_by_paperid(pid)
            if meta and (meta.get("abstract") or refs or cits):
                update_row(conn, pid, meta, refs, cits, "Semantic Scholar (paperId)")
            else:
                update_row(conn, pid, {"abstract": ""}, [], [], "(none)")
        except Exception as e:
            print(f"⚠️ S2 fetch failed for {pid}: {e}")
        time.sleep(SLEEP_BASE + random.uniform(0, 0.5))
        return

    # 2) If OpenAlex ID, try OpenAlex first (abstract_inverted_index or DOI/arXiv)
    if kind == "openalex":
        try:
            ids = openalex_get_ids_and_abstract(pid)
            time.sleep(SLEEP_BASE + random.uniform(0, 0.5))
        except Exception as e:
            print(f"⚠️ OpenAlex fetch failed for {pid}: {e}")
            return

        if ids.get("abstract"):
            meta = {"title": "", "abstract": ids["abstract"],
                    "citationCount": None, "authors": [], "fieldsOfStudy": [],
                    "year": None, "publicationDate": None}
            update_row(conn, pid, meta, [], [], "OpenAlex abstract_inverted_index")
            return

        # fall back to S2 by DOI then arXiv
        for tag in [("DOI", ids.get("doi")), ("arXiv", ids.get("arxiv"))]:
            key, val = tag
            if not val: continue
            try:
                meta, refs, cits = s2_get_by_key(key, val)
                if meta and meta.get("abstract"):
                    update_row(conn, pid, meta, refs, cits, f"Semantic Scholar ({key})")
                    return
            except Exception as e:
                print(f"⚠️ S2 {key} lookup failed for {pid} ({val}): {e}")
            time.sleep(SLEEP_BASE + random.uniform(0, 0.5))

        # nothing found
        update_row(conn, pid, {"abstract": ""}, [], [], "(none)")
        return

    # 3) Unknown ID shape → best effort: try S2 by treating it as paperId
    try:
        meta, refs, cits = s2_get_by_paperid(pid)
        if meta and (meta.get("abstract") or refs or cits):
            update_row(conn, pid, meta, refs, cits, "Semantic Scholar (best-effort)")
        else:
            update_row(conn, pid, {"abstract": ""}, [], [], "(none)")
    except Exception as e:
        print(f"⚠️ Unknown ID {pid}, S2 best-effort failed: {e}")
    time.sleep(SLEEP_BASE + random.uniform(0, 0.5))

def main():
    conn = db_connect()
    n = 0
    for pid in yield_missing_papers(conn):
        n += 1
        enrich_one(conn, pid)
    print("🎉 No rows need enrichment." if n == 0 else f"✅ Finished enrichment pass over {n} rows.")

if __name__ == "__main__":
    main()
