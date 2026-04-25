#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_openalex_taxonomy.py — Download the full OpenAlex topic hierarchy with paper counts.

Fetches all 4 levels of the OpenAlex classification system and saves them as JSON and CSV:
  Level 1 — Domains   (~5)
  Level 2 — Fields    (~25)
  Level 3 — Subfields (~250)  ← these are the Mapo galaxy groupings
  Level 4 — Topics    (~4500)

Outputs (written to OUTPUT_DIR):
  domains.json / domains.csv
  fields.json  / fields.csv
  subfields.json / subfields.csv
  topics.json  / topics.csv
  taxonomy_summary.json   — full nested hierarchy with counts

Usage:
  python fetch_openalex_taxonomy.py
"""

import csv
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────
# PARAMETERS — adjust as needed
# ──────────────────────────────────────────────

EMAIL = "tom.hirsch3000@gmail.com"   # OpenAlex polite-pool email
OUTPUT_DIR = "openalex_taxonomy"      # Directory to write output files
PER_PAGE = 200                        # Max results per page (OpenAlex max is 200)
THROTTLE_S = 0.12                     # Seconds between requests (polite pool: ~10 req/s)
MAX_RETRIES = 5                       # Retry attempts on transient errors

# Set to True to also save a flattened CSV with every topic's full ancestry
SAVE_FULL_FLAT_CSV = True

# Minimum works_count to include a topic in the galaxy candidate list
# (set to 0 to include everything)
MIN_WORKS_FOR_GALAXY = 0

# ──────────────────────────────────────────────


BASE_URL = "https://api.openalex.org"

ENDPOINTS = {
    "domains":   f"{BASE_URL}/domains",
    "fields":    f"{BASE_URL}/fields",
    "subfields": f"{BASE_URL}/subfields",
    "topics":    f"{BASE_URL}/topics",
}

# Fields to select per level — keeps responses small and focused
SELECT_FIELDS = {
    "domains":   "id,display_name,description,works_count,cited_by_count,siblings",
    "fields":    "id,display_name,description,works_count,cited_by_count,domain,siblings",
    "subfields": "id,display_name,description,works_count,cited_by_count,field,domain,siblings",
    "topics":    "id,display_name,description,works_count,cited_by_count,subfield,field,domain,keywords,wikipedia,ids",
}


def fetch_page(url: str, params: Dict[str, str], attempt: int = 0) -> Optional[Dict]:
    full_url = url + "?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(
            full_url,
            headers={"User-Agent": f"mapo-research/1.0 (mailto:{EMAIL})"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        if attempt >= MAX_RETRIES:
            print(f"  [error] All {MAX_RETRIES} retries failed: {e}")
            return None
        wait = 2 ** attempt
        print(f"  [warn] Attempt {attempt+1} failed ({e}) — retrying in {wait}s")
        time.sleep(wait)
        return fetch_page(url, params, attempt + 1)


def fetch_all(level: str) -> List[Dict]:
    """Paginate through all results for a given level endpoint."""
    url = ENDPOINTS[level]
    select = SELECT_FIELDS[level]
    items: List[Dict] = []
    cursor = "*"
    page_num = 0

    print(f"\n[{level}] Fetching…")
    while True:
        params = {
            "select": select,
            "per-page": str(PER_PAGE),
            "cursor": cursor,
            "mailto": EMAIL,
        }
        data = fetch_page(url, params)
        if not data:
            print(f"  [error] Empty response on page {page_num + 1}")
            break

        results = data.get("results", [])
        meta = data.get("meta", {})
        items.extend(results)
        page_num += 1

        total = meta.get("count", "?")
        print(f"  Page {page_num}: +{len(results)} items  (total so far: {len(items)}/{total})")

        next_cursor = meta.get("next_cursor")
        if not next_cursor or not results:
            break
        cursor = next_cursor
        time.sleep(THROTTLE_S)

    print(f"  -> Done: {len(items)} {level} fetched")
    return items


def strip_id(oa_id: str) -> str:
    """'https://openalex.org/T12345' -> 'T12345'"""
    return oa_id.replace("https://openalex.org/", "") if oa_id else ""


def flatten_item(item: Dict, level: str) -> Dict:
    """Normalise a raw API item into a flat dict with consistent keys."""
    flat: Dict[str, Any] = {
        "id":           strip_id(item.get("id", "")),
        "display_name": item.get("display_name", ""),
        "description":  item.get("description", ""),
        "works_count":  item.get("works_count", 0),
        "cited_by_count": item.get("cited_by_count", 0),
    }

    if level in ("fields", "subfields", "topics"):
        domain = item.get("domain") or {}
        flat["domain_id"]   = strip_id(domain.get("id", ""))
        flat["domain_name"] = domain.get("display_name", "")

    if level in ("subfields", "topics"):
        field = item.get("field") or {}
        flat["field_id"]   = strip_id(field.get("id", ""))
        flat["field_name"] = field.get("display_name", "")

    if level == "topics":
        subfield = item.get("subfield") or {}
        flat["subfield_id"]   = strip_id(subfield.get("id", ""))
        flat["subfield_name"] = subfield.get("display_name", "")
        keywords = item.get("keywords") or []
        flat["keywords"] = "; ".join(keywords) if isinstance(keywords, list) else str(keywords)
        ids = item.get("ids") or {}
        flat["wikipedia"] = ids.get("wikipedia", "") or item.get("wikipedia", "")

    return flat


def save_json(data: Any, path: str):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  Saved: {path}")


def save_csv(rows: List[Dict], path: str):
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Saved: {path}")


def build_nested_hierarchy(
    domains: List[Dict],
    fields: List[Dict],
    subfields: List[Dict],
    topics: List[Dict],
) -> List[Dict]:
    """Build a fully nested dict: domain > field > subfield > [topics]."""
    # Index everything by ID for fast lookup
    fields_by_domain: Dict[str, List] = {}
    for f in fields:
        did = f["domain_id"]
        fields_by_domain.setdefault(did, []).append(f)

    subfields_by_field: Dict[str, List] = {}
    for sf in subfields:
        fid = sf["field_id"]
        subfields_by_field.setdefault(fid, []).append(sf)

    topics_by_subfield: Dict[str, List] = {}
    for t in topics:
        sfid = t["subfield_id"]
        topics_by_subfield.setdefault(sfid, []).append(t)

    hierarchy = []
    for d in sorted(domains, key=lambda x: x["display_name"]):
        domain_entry = {**d, "fields": []}
        for f in sorted(fields_by_domain.get(d["id"], []), key=lambda x: x["display_name"]):
            field_entry = {**f, "subfields": []}
            for sf in sorted(subfields_by_field.get(f["id"], []), key=lambda x: x["display_name"]):
                sf_entry = {
                    **sf,
                    "topics": sorted(
                        topics_by_subfield.get(sf["id"], []),
                        key=lambda x: -x["works_count"],
                    ),
                }
                field_entry["subfields"].append(sf_entry)
            domain_entry["fields"].append(field_entry)
        hierarchy.append(domain_entry)
    return hierarchy


def print_summary(domains, fields, subfields, topics):
    print("\n" + "=" * 60)
    print("TAXONOMY SUMMARY")
    print("=" * 60)
    print(f"  Domains:   {len(domains):>5}")
    print(f"  Fields:    {len(fields):>5}")
    print(f"  Subfields: {len(subfields):>5}  ← Mapo galaxy groups")
    print(f"  Topics:    {len(topics):>5}")

    total_works = sum(d["works_count"] for d in domains)
    print(f"\n  Total works indexed by OpenAlex: {total_works:,}")

    print("\nTop 10 subfields by paper count:")
    top_sf = sorted(subfields, key=lambda x: -x["works_count"])[:10]
    for i, sf in enumerate(top_sf, 1):
        print(f"  {i:>2}. {sf['display_name']:<40} {sf['works_count']:>10,}  ({sf['field_name']})")

    print("\nDomains:")
    for d in sorted(domains, key=lambda x: -x["works_count"]):
        print(f"       {d['display_name']:<35} {d['works_count']:>10,} papers")
    print("=" * 60)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # ── Fetch all four levels ──
    raw_domains   = fetch_all("domains")
    raw_fields    = fetch_all("fields")
    raw_subfields = fetch_all("subfields")
    raw_topics    = fetch_all("topics")

    # ── Flatten ──
    domains   = [flatten_item(x, "domains")   for x in raw_domains]
    fields    = [flatten_item(x, "fields")    for x in raw_fields]
    subfields = [flatten_item(x, "subfields") for x in raw_subfields]
    topics    = [flatten_item(x, "topics")    for x in raw_topics]

    # Filter topics by min works if configured
    if MIN_WORKS_FOR_GALAXY > 0:
        topics = [t for t in topics if t["works_count"] >= MIN_WORKS_FOR_GALAXY]

    # ── Save individual level files ──
    for name, data in [("domains", domains), ("fields", fields),
                       ("subfields", subfields), ("topics", topics)]:
        save_json(data, os.path.join(OUTPUT_DIR, f"{name}.json"))
        save_csv(data, os.path.join(OUTPUT_DIR, f"{name}.csv"))

    # ── Save nested hierarchy ──
    hierarchy = build_nested_hierarchy(domains, fields, subfields, topics)
    save_json(hierarchy, os.path.join(OUTPUT_DIR, "taxonomy_summary.json"))

    # ── Save full flat CSV with complete ancestry ──
    if SAVE_FULL_FLAT_CSV:
        flat_path = os.path.join(OUTPUT_DIR, "topics_full_ancestry.csv")
        columns = [
            "id", "display_name", "description", "works_count", "cited_by_count",
            "subfield_id", "subfield_name",
            "field_id", "field_name",
            "domain_id", "domain_name",
            "keywords", "wikipedia",
        ]
        with open(flat_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(sorted(topics, key=lambda x: -x["works_count"]))
        print(f"  Saved: {flat_path}")

    print_summary(domains, fields, subfields, topics)
    print(f"\n[done] All files written to: {os.path.abspath(OUTPUT_DIR)}/")


if __name__ == "__main__":
    main()
