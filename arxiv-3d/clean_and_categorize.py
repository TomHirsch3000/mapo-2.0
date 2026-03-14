#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clean_and_categorize.py — Data cleaning and field standardization.

1. Mislabel Detection: Checks if a paper belongs to a target field (LLM-based).
   Sets 'mislabelled_paper' = 1 if not relevant.
2. Field Standardization:
   - Counts all fields in AI_field_list.
   - Takes Top 50.
   - Re-assigns AI_primary_field to one of these 50 (preference: existing tag > LLM guess).
"""

import argparse
import ast
import json
import os
import sqlite3
import time
from collections import Counter
from typing import List, Optional, Tuple

# --- LLM CLIENT ---
try:
    from openai import OpenAI
    # Adjust base_url/api_key if needed for your local setup
    client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
    print("[info] LLM client initialised for http://localhost:11434")
except Exception as e:
    client = None
    print(f"[warn] Could not initialise LLM client: {e!r}")


def open_db(path: str) -> sqlite3.Connection:
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Database not found at {abs_path}")
    print(f"[info] Opening DB at {abs_path}")
    conn = sqlite3.connect(abs_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_columns(conn: sqlite3.Connection):
    """
    Ensure 'mislabelled_paper' (INTEGER) and 'AI_primary_field' (TEXT) exist.
    """
    cursor = conn.execute("PRAGMA table_info(papers)")
    cols = {r[1] for r in cursor.fetchall()}

    if "mislabelled_paper" not in cols:
        print("[info] Adding column 'mislabelled_paper' to papers")
        conn.execute("ALTER TABLE papers ADD COLUMN mislabelled_paper INTEGER DEFAULT 0")
    
    if "AI_primary_field" not in cols:
        print("[info] Adding column 'AI_primary_field' to papers")
        conn.execute("ALTER TABLE papers ADD COLUMN AI_primary_field TEXT")
    
    conn.commit()


# ---------------------------------------------------------
# PART 1: MISLABEL DETECTION
# ---------------------------------------------------------

def check_relevance_llm(title: str, abstract: str, target_field: str) -> bool:
    """
    Ask LLM if this paper belongs to 'target_field'.
    Returns True if relevant, False if mislabelled.
    """
    if not client:
        return True # Default to safe if no LLM

    prompt = (
        f"Title: {title}\n"
        f"Abstract: {abstract}\n\n"
        f"Is the scientific paper described above strictly relevant to the field of '{target_field}'? "
        "Biology papers or other non-relevant fields should be rejected. "
        "Answer only with 'YES' or 'NO'."
    )

    try:
        response = client.chat.completions.create(
            model="mistral", # or your preferred local model
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=10
        )
        content = (response.choices[0].message.content or "").strip().upper()
        # If explicitly NO, return False (mislabelled). Otherwise assume YES/Unsure -> True
        if "NO" in content and "YES" not in content:
            return False
        return True
    except Exception as e:
        print(f"[error] LLM relevance check failed: {e}")
        return True


def run_mislabel_detection(conn: sqlite3.Connection, target_field: str, limit: Optional[int] = None):
    print(f"\n--- Starting Mislabel Detection (Target: {target_field or 'AUTO (Per Paper)'}) ---")
    
    # Select papers that haven't been flagged as mislabelled yet (or check all?)
    # For now, let's just go through all.
    query = "SELECT paperId, title, abstract, mislabelled_paper, AI_primary_field FROM papers"
    if limit:
        query += f" LIMIT {limit}"
    
    rows = conn.execute(query).fetchall()
    print(f"[info] Checking {len(rows)} papers...")

    updates = []
    
    for i, row in enumerate(rows):
        pid = row["paperId"]
        title = row["title"] or ""
        abstract = row["abstract"] or ""
        
        # Determine target category
        # If target_field is explicitly provided (e.g. 'Astrophysics'), use it.
        # Otherwise, check against the paper's own assigned AI_primary_field.
        check_against = target_field
        if not check_against or check_against == 'AUTO':
            check_against = row["AI_primary_field"]

        # Skip if no text to judge or no category to check against
        if (not title and not abstract) or not check_against or check_against == 'Unknown':
            continue

        is_relevant = check_relevance_llm(title, abstract, check_against)
        
        if not is_relevant:
            print(f"[MISLABEL] {pid} | {title[:40]}... != {check_against}")
            updates.append((1, pid))
        else:
             # Option: Set to 0 if relevant? 
             pass

        if (i + 1) % 10 == 0:
            print(f" ... checked {i + 1}/{len(rows)}")

    if updates:
        print(f"[info] Updating {len(updates)} papers as mislabelled...")
        conn.executemany("UPDATE papers SET mislabelled_paper = ? WHERE paperId = ?", updates)
        conn.commit()
    else:
        print("[info] No new mislabelled papers found.")


# ---------------------------------------------------------
# PART 2: FIELD STANDARDIZATION
# ---------------------------------------------------------

def get_top_50_fields(conn: sqlite3.Connection) -> List[str]:
    print("[info] Census: Counting field frequencies from 'AI_field_list'...")
    # Fetch all AI_field_lists
    # Only consider papers that are NOT mislabelled?
    # Let's count globally for now to get the "Physics" landscape.
    query = "SELECT AI_field_list FROM papers WHERE AI_field_list IS NOT NULL AND AI_field_list != '[]'"
    rows = conn.execute(query).fetchall()
    
    counter = Counter()
    
    for r in rows:
        try:
            flist = json.loads(r["AI_field_list"])
            if isinstance(flist, list):
                # Normalise strings?
                clean_list = [str(f).strip() for f in flist if f]
                counter.update(clean_list)
        except:
            continue
            
    # Get top 50
    most_common = counter.most_common(50)
    top_50 = [tag for tag, count in most_common]
    
    print("\n--- TOP 50 DETECTED FIELDS ---")
    for i, (tag, count) in enumerate(most_common, 1):
        print(f"{i:02d}. {tag} ({count})")
    print("------------------------------\n")
    
    return top_50


def classify_single_field_llm(abstract: str, top_50: List[str]) -> str:
    """
    Force LLM to pick exactly one field from the list.
    """
    if not client:
        return "Unknown"

    categories_str = ", ".join(f"'{f}'" for f in top_50)
    
    prompt = (
        f"Abstract: {abstract[:2000]}\n\n" # Truncate massive abstracts
        f"Task: Classify this scientific paper into exactly one of the following categories:\n"
        f"[{categories_str}]\n\n"
        "Instructions:\n"
        "1. Select the single most appropriate category from the list above.\n"
        "2. Return ONLY the category name exactly as written in the list.\n"
        "3. Do not add any explanation or punctuation."
    )

    try:
        response = client.chat.completions.create(
            model="mistral",
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
        )
        text = (response.choices[0].message.content or "").strip()
        
        # Cleanup: remove quotes if LLM adds them
        text = text.replace("'", "").replace('"', "").strip()
        
        # Verify it's in the list (fuzzy match could be better but strict for now)
        if text in top_50:
            return text
        
        # Fallback: check if result is a substring of checks
        for cand in top_50:
            if cand.lower() == text.lower():
                return cand
                
        return "Unknown"
        
    except Exception as e:
        print(f"[error] LLM field classification failed: {e}")
        return "Unknown"


def run_field_standardization(conn: sqlite3.Connection, top_50: List[str], limit: Optional[int] = None):
    print("\n--- Starting Field Standardization ---")
    
    # Process papers. 
    # Logic: 
    # 1. Does AI_field_list have a match in top_50? -> Use first match.
    # 2. No? -> LLM classify.
    
    query = "SELECT paperId, title, abstract, AI_field_list, AI_primary_field FROM papers"
    if limit:
        query += f" LIMIT {limit}"
        
    rows = conn.execute(query).fetchall()
    updates = []
    
    print(f"[info] Processing {len(rows)} papers...")
    
    for i, row in enumerate(rows):
        pid = row["paperId"]
        existing_primary = row["AI_primary_field"]
        raw_list = row["AI_field_list"]
        abstract = row["abstract"]
        
        # 1. Check existing list
        match_found = None
        current_list = []
        try:
            if raw_list:
                current_list = json.loads(raw_list)
                if isinstance(current_list, list):
                    for tag in current_list:
                        if tag in top_50:
                            match_found = tag
                            break
        except:
            pass
            
        final_field = "Unknown"
        
        if match_found:
            final_field = match_found
            # print(f"[Match] {pid} -> {final_field}")
        else:
            # 2. LLM Fallback
            # Only if abstract exists
            if abstract and len(abstract) > 10:
                print(f"[LLM Classify] {pid} ({row['title'][:30]}...)...")
                final_field = classify_single_field_llm(abstract, top_50)
                print(f"   -> Assigned: {final_field}")
            else:
                final_field = "Unknown"

        # Always update? Or only if different/empty?
        # User said: "Output this into the AI primary field column, even if that is already populated"
        updates.append((final_field, pid))
        
        if (i + 1) % 50 == 0:
            print(f" ... processed {i + 1}/{len(rows)}")

    # Batch update
    print(f"[info] Updating {len(updates)} papers with standardized fields...")
    conn.executemany("UPDATE papers SET AI_primary_field = ? WHERE paperId = ?", updates)
    conn.commit()


# ---------------------------------------------------------
# MAIN
# ---------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Clean and Categorize Papers")
    parser.add_argument("--db", required=True, help="Path to SQLite database")
    parser.add_argument("--field", default="AUTO", help="Target field for mislabel detection. Use 'AUTO' to check against each paper's primary field.")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of rows to process")
    parser.add_argument("--skip-mislabel", action="store_true", help="Skip mislabel detection step")
    parser.add_argument("--skip-standardize", action="store_true", help="Skip field standardization step")
    
    args = parser.parse_args()
    
    conn = open_db(args.db)
    ensure_columns(conn)
    
    try:
        # Step 1: Mislabel Detection
        if not args.skip_mislabel:
            run_mislabel_detection(conn, args.field, args.limit)
            
        # Step 2: Field Standardization
        if not args.skip_standardize:
            # First, generate the census
            top_50 = get_top_50_fields(conn)
            if not top_50:
                print("[error] Could not generate Top 50 fields list. Is AI_field_list populated?")
            else:
                run_field_standardization(conn, top_50, args.limit)
                
    finally:
        conn.close()
        print("[info] Done. DB connection closed.")

if __name__ == "__main__":
    main()
