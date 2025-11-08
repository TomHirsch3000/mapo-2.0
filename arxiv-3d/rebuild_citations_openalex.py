# rebuild_citations_openalex.py
# Rebuilds citations(source,target) for your 500-source sample.
# Batches with ids.openalex (full URLs). If a batch 403s, falls back to per-ID requests.

import sqlite3, json, time, requests

DB = "papers_particle_physics.db"
MAILTO = "tom.hirsch3000@gmail.com"
BASE = "https://api.openalex.org/works"
BATCH_SIZE = 60          # conservative (keep query strings shorter)
SLEEP_BETWEEN = 0.6      # pacing
HEADERS = {"User-Agent": f"arxiv-3d/edges (mailto:{MAILTO})", "Accept": "application/json"}

def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

def fetch_batch_fullurls(url_ids):
    params = {
        "filter": "ids.openalex:" + "|".join(url_ids),
        "per_page": 200,
        "select": "id,referenced_works",
        "mailto": MAILTO,
    }
    r = requests.get(BASE, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()

def fetch_single_fullurl(url_id):
    # url_id looks like https://openalex.org/W123...
    r = requests.get(
        url_id,
        params={"select": "id,referenced_works", "mailto": MAILTO},
        headers=HEADERS,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()

def main():
    conn = sqlite3.connect(DB, timeout=30)
    c = conn.cursor()

    # Drop any existing artifacts
    c.execute("DROP TABLE IF EXISTS citations;")
    c.execute("DROP VIEW IF EXISTS citations;")
    c.execute("DROP TABLE IF EXISTS citations_raw;")

    # Load your 500 sample
    ids = [row[0] for row in c.execute("SELECT paperId FROM papers")]
    id_urls = [f"https://openalex.org/{pid}" for pid in ids]
    print(f"[info] Found {len(ids)} papers in DB (sample)")

    # Fresh table
    c.execute("CREATE TABLE citations (source TEXT, target TEXT);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_citations_target ON citations(target);")
    conn.commit()

    total_refs = 0
    inserted = 0

    for batch_urls in chunks(id_urls, BATCH_SIZE):
        try:
            data = fetch_batch_fullurls(batch_urls)
            results = data.get("results", [])
        except requests.HTTPError as e:
            # If the batch is forbidden, gracefully fall back to per-ID
            status = e.response.status_code if e.response is not None else None
            print(f"[warn] Batch fetch  failed with {status}. Falling back to per-ID for this batch.")
            results = []
            for u in batch_urls:
                try:
                    item = fetch_single_fullurl(u)
                    results.append(item)
                    time.sleep(SLEEP_BETWEEN)
                except requests.HTTPError as e2:
                    print(f"[error] Single fetch failed {e2.response.status_code if e2.response else ''} for {u}")
                    continue

        rows = []
        for item in results:
            src = item["id"].rsplit("/", 1)[-1]  # normalize to W-id
            refs = item.get("referenced_works") or []
            total_refs += len(refs)
            for r in refs:
                rows.append((src, r.rsplit("/", 1)[-1]))

        if rows:
            c.executemany("INSERT INTO citations (source, target) VALUES (?,?)", rows)
            inserted += len(rows)
            conn.commit()

        time.sleep(SLEEP_BETWEEN)

    cnt = c.execute("SELECT COUNT(*) FROM citations").fetchone()[0]
    print(f"[done] refs_seen={total_refs}, rows_inserted={inserted}, rows_in_table={cnt}")
    conn.close()

if __name__ == "__main__":
    main()
