#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
process_ai_for_landmarks.py — Process AI metadata for papers that will appear in frontend

New feature: --from-json mode reads nodes.json and processes only those papers
"""

import argparse
import json
import sqlite3
import sys
import os

# Import the main processing function from your existing script
sys.path.insert(0, os.path.dirname(__file__))

try:
    from process_ai_metadata import process_ai, open_db, ensure_ai_columns
except ImportError:
    print("[error] Could not import from process_ai_metadata.py")
    print("[error] Make sure process_ai_metadata.py is in the same directory")
    sys.exit(1)


def get_paper_ids_from_json(json_path: str) -> list:
    """Extract paper IDs from nodes.json"""
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            nodes = json.load(f)
        
        if not isinstance(nodes, list):
            print(f"[error] {json_path} does not contain a list of nodes")
            return []
        
        ids = [n.get('id') or n.get('paperId') for n in nodes]
        ids = [str(i) for i in ids if i]
        
        print(f"[info] Found {len(ids)} paper IDs in {json_path}")
        return ids
    
    except FileNotFoundError:
        print(f"[error] File not found: {json_path}")
        return []
    except json.JSONDecodeError as e:
        print(f"[error] Invalid JSON in {json_path}: {e}")
        return []


def check_missing_ai_data(conn: sqlite3.Connection, paper_ids: list) -> dict:
    """Check which papers are missing AI metadata"""
    
    placeholders = ','.join('?' * len(paper_ids))
    query = f"""
        SELECT 
            paperId,
            CASE WHEN AI_summary IS NULL OR TRIM(AI_summary) = '' THEN 1 ELSE 0 END as missing_summary,
            CASE WHEN AI_primary_field IS NULL OR TRIM(AI_primary_field) = '' THEN 1 ELSE 0 END as missing_field,
            CASE WHEN abstract IS NULL OR TRIM(abstract) = '' THEN 1 ELSE 0 END as missing_abstract,
            CASE WHEN AI_abstract IS NULL OR TRIM(AI_abstract) = '' THEN 1 ELSE 0 END as missing_ai_abstract
        FROM papers
        WHERE paperId IN ({placeholders})
    """
    
    rows = conn.execute(query, paper_ids).fetchall()
    
    stats = {
        'total': len(rows),
        'missing_summary': sum(r['missing_summary'] for r in rows),
        'missing_field': sum(r['missing_field'] for r in rows),
        'missing_abstract': sum(r['missing_abstract'] for r in rows),
        'missing_ai_abstract': sum(r['missing_ai_abstract'] for r in rows),
    }
    
    # Papers missing ANY required data
    missing_any = [
        r['paperId'] for r in rows 
        if r['missing_summary'] or r['missing_field']
    ]
    
    stats['missing_any'] = len(missing_any)
    stats['missing_ids'] = missing_any
    
    return stats


def process_from_json_list(
    db_path: str,
    json_path: str,
    overwrite_ai_fields: bool = False,
    overwrite_summary: bool = False,
    overwrite_ai_abstract: bool = False,
    batch_size: int = 50,
    check_only: bool = False
):
    """Process AI metadata for papers listed in nodes.json"""
    
    # Get paper IDs from JSON
    paper_ids = get_paper_ids_from_json(json_path)
    if not paper_ids:
        print("[error] No valid paper IDs found in JSON")
        return
    
    # Open DB
    conn = open_db(db_path)
    ensure_ai_columns(conn)
    
    # Check status
    print("\n" + "="*60)
    print("AI METADATA STATUS CHECK")
    print("="*60)
    
    stats = check_missing_ai_data(conn, paper_ids)
    
    print(f"\nTotal papers in JSON: {stats['total']}")
    print(f"Missing AI summary: {stats['missing_summary']}")
    print(f"Missing AI field: {stats['missing_field']}")
    print(f"Missing abstract (real): {stats['missing_abstract']}")
    print(f"Missing AI abstract: {stats['missing_ai_abstract']}")
    print(f"\nPapers needing AI processing: {stats['missing_any']}")
    
    if check_only:
        print("\n[info] Check-only mode. No processing performed.")
        if stats['missing_any'] > 0:
            print(f"\n[info] To process these papers, run:")
            print(f"python {sys.argv[0]} --db {db_path} --from-json {json_path}")
        conn.close()
        return
    
    if stats['missing_any'] == 0:
        print("\n[info] ✓ All papers have complete AI metadata!")
        conn.close()
        return
    
    # Process in batches
    print("\n" + "="*60)
    print("PROCESSING AI METADATA")
    print("="*60 + "\n")
    
    missing_ids = stats['missing_ids']
    
    for i in range(0, len(missing_ids), batch_size):
        batch = missing_ids[i:i+batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(missing_ids) + batch_size - 1) // batch_size
        
        print(f"\n[info] Processing batch {batch_num}/{total_batches} ({len(batch)} papers)...")
        
        # Create temporary filter that matches this batch
        # We'll call process_ai with a special filter
        for paper_id in batch:
            try:
                process_ai(
                    conn,
                    overwrite_ai_fields=overwrite_ai_fields,
                    overwrite_summary=overwrite_summary,
                    overwrite_ai_abstract=overwrite_ai_abstract,
                    only_unprocessed=True,
                    paper_id_filter=paper_id,
                    title_contains_filter=None,
                    limit_rows=None,
                    min_citations=None,
                    max_citations=None,
                    field_contains=None,
                    author_contains=None,
                )
            except Exception as e:
                print(f"[error] Failed to process {paper_id}: {e}")
                continue
    
    # Final check
    print("\n" + "="*60)
    print("FINAL STATUS")
    print("="*60)
    
    final_stats = check_missing_ai_data(conn, paper_ids)
    print(f"\nPapers still missing AI data: {final_stats['missing_any']}")
    
    if final_stats['missing_any'] == 0:
        print("\n[success] ✓ All landmark papers now have complete AI metadata!")
        print(f"[success] ✓ Ready to rebuild frontend JSON")
    else:
        print(f"\n[warn] {final_stats['missing_any']} papers still incomplete")
        print("[warn] You may need to run with --overwrite flags or check for errors above")
    
    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Process AI metadata for papers that will appear in frontend"
    )
    
    parser.add_argument("--db", type=str, required=True,
                        help="Path to SQLite database")
    
    # Mode selection
    mode_group = parser.add_mutually_exclusive_group(required=True)
    mode_group.add_argument("--from-json", type=str,
                           help="Process only papers listed in nodes.json file")
    mode_group.add_argument("--all-missing", action="store_true",
                           help="Process all papers missing AI data (original behavior)")
    
    # Options
    parser.add_argument("--check-only", action="store_true",
                        help="Only check status, don't process anything")
    parser.add_argument("--batch-size", type=int, default=50,
                        help="Process N papers at a time (default: 50)")
    
    # Overwrite flags
    parser.add_argument("--overwrite-fields", action="store_true",
                        help="Regenerate AI fields even if present")
    parser.add_argument("--overwrite-summary", action="store_true",
                        help="Regenerate AI summary even if present")
    parser.add_argument("--overwrite-abstract", action="store_true",
                        help="Regenerate AI abstract even if present")
    
    args = parser.parse_args()
    
    if args.from_json:
        process_from_json_list(
            db_path=args.db,
            json_path=args.from_json,
            overwrite_ai_fields=args.overwrite_fields,
            overwrite_summary=args.overwrite_summary,
            overwrite_ai_abstract=args.overwrite_abstract,
            batch_size=args.batch_size,
            check_only=args.check_only
        )
    elif args.all_missing:
        # Fall back to original process_ai behavior
        conn = open_db(args.db)
        try:
            process_ai(
                conn,
                overwrite_ai_fields=args.overwrite_fields,
                overwrite_summary=args.overwrite_summary,
                overwrite_ai_abstract=args.overwrite_abstract,
                only_unprocessed=True,
                paper_id_filter=None,
                title_contains_filter=None,
                limit_rows=None,
                min_citations=None,
                max_citations=None,
                field_contains=None,
                author_contains=None,
            )
        finally:
            conn.close()


if __name__ == "__main__":
    main()
