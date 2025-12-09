#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
process_ai_metadata.py — Run all AI work on the SQLite DB *only*.
- AI_field_list / AI_primary_field (categories)
- AI_summary (2–3 sentence summary of the abstract)
- AI_abstract (copy of the AI-generated abstract)

Behaviour:
- If a paper is missing an abstract, an AI abstract is generated FIRST,
  written into:
    - abstract        (prefixed 'AI abstract - ')
    - AI_abstract     (same content)
- Categories and summary are then computed from the final abstract
  (real or AI).

This script does NOT write nodes.json / edges.json.
"""

import argparse
import ast
import json
import os
import sqlite3
import time
from typing import List, Optional

# --- LLM client (local Ollama-compatible) ---
try:
    from openai import OpenAI
    client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
    print("[info] LLM client initialised for http://localhost:11434 (Ollama-style)")
except Exception as e:
    client = None
    print(f"[warn] Could not initialise LLM client: {e!r} — all AI calls will return empty values")


# -------------------------
# LLM HELPERS
# -------------------------
def summarize_text(
    abstract: str | None,
    title: str | None = None,
    journal_name: str | None = None,
    authors: str | None = None,
    primary_concept: str | None = None,
    concepts_json: str | None = None,
) -> str:
    """2–3 sentence summary using abstract + metadata."""
    if not client:
        print("[warn] summarize_text: no LLM client; returning empty summary")
        return ""
    if not abstract:
        print("[warn] summarize_text: no abstract; returning empty summary")
        return ""

    # Build a small metadata block for the prompt
    meta_lines = []
    if title:
        meta_lines.append(f"Title: {title}")
    if journal_name:
        meta_lines.append(f"Journal: {journal_name}")
    if authors:
        meta_lines.append(f"Authors: {authors}")
    if primary_concept:
        meta_lines.append(f"Primary concept: {primary_concept}")
    if concepts_json:
        meta_lines.append(f"Concepts JSON: {concepts_json[:800]}")  # truncate for safety

    meta_block = "\n".join(meta_lines)

    prompt = (
        "Create a headline and 2 to 3 sentence summary of this scientific paper in the style of a short newspaper article.\n"
        "- Use the abstract as the main source of information.\n"
        "- Use the title, authors, journal and concepts only to understand context "
        "and where the work sits within the broader theme.\n"
        "- Focus on: (1) what broader area this paper belongs to, "
        "(2) which important ideas or prior work it builds upon, and "
        "(3) what direction or lines of thought it is trying to support.\n\n"
        "Metadata:\n"
        f"{meta_block}\n\n"
        "Abstract:\n"
        f"{abstract}"
    )

    try:
        print("[debug] summarize_text: calling LLM…")
        r = client.chat.completions.create(
            model="mistral",
            messages=[{"role": "user", "content": prompt}],
        )
        out = (r.choices[0].message.content or "").strip()
        print(f"[debug] summarize_text: received {len(out)} chars")
        return out
    except Exception as e:
        print(f"[error] summarize_text: LLM call failed: {e}")
        return ""


def AI_category_one(text: str) -> List[str]:
    """Return a list of physics fields for this paper."""
    if not client:
        print("[warn] AI_category_one: no LLM client; returning ['Unknown']")
        return ["Unknown"]
    if not text:
        print("[warn] AI_category_one: empty text; returning ['Unknown']")
        return ["Unknown"]
    try:
        print("[debug] AI_category_one: calling LLM…")
        r = client.chat.completions.create(
            model="mistral",
            messages=[{"role": "user", "content": (
                "In a few key words pick the closest field of physics for this "
                "scientific paper based on this abstract. "
                "Return ONLY a Python list of strings, e.g. "
                "['High energy physics', 'Particle physics'].\n\n" + text
            )}],
            temperature=0,
            top_p=0,
        )
        raw = (r.choices[0].message.content or "").strip()
        print(f"[debug] AI_category_one: raw LLM output = {raw!r}")
        try:
            out = ast.literal_eval(raw)
            if isinstance(out, list) and out:
                return [str(x) for x in out]
        except Exception:
            print(f"[warn] AI_category_one: could not parse LLM output as list")
        return ["Unknown"]
    except Exception as e:
        print(f"[error] AI_category_one: LLM call failed: {e}")
        return ["Unknown"]


def build_ai_abstract(
    title: Optional[str],
    journal_name: Optional[str],
    authors: Optional[str],
    primary_concept: Optional[str],
    concepts_json: Optional[str],
    year: Optional[int],
) -> str:
    """
    Generate a 2-line AI abstract for papers missing a real abstract.
    The result MUST start with 'AI abstract - '.
    """
    if not client:
        print("[warn] build_ai_abstract: no LLM client; returning empty abstract")
        return ""

    meta_lines = []
    if title:
        meta_lines.append(f"Title: {title}")
    if journal_name:
        meta_lines.append(f"Journal: {journal_name}")
    if authors:
        meta_lines.append(f"Authors: {authors}")
    if year:
        meta_lines.append(f"Year: {year}")
    if primary_concept:
        meta_lines.append(f"Primary concept: {primary_concept}")
    if concepts_json:
        meta_lines.append(f"Concepts JSON: {concepts_json[:800]}")  # truncate just in case

    meta_block = "\n".join(meta_lines)

    prompt = (
        "You are an assistant that guesses a likely scientific abstract "
        "from metadata when the true abstract is missing.\n\n"
        f"{meta_block}\n\n"
        "Task:\n"
        "- Based on this metadata, write a *plausible* two-line scientific abstract.\n"
        "- It should be written in a standard physics-paper abstract style.\n"
        "- The VERY FIRST line must start exactly with 'AI abstract - ' "
        "(for example: 'AI abstract - We investigate ...').\n"
        "- Use two sentences total, broken on a newline between them."
    )

    try:
        print("[debug] build_ai_abstract: calling LLM…")
        r = client.chat.completions.create(
            model="mistral",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.5,
            top_p=0.95,
        )
        txt = (r.choices[0].message.content or "").strip()
        print(f"[debug] build_ai_abstract: raw LLM output starts: {txt[:120]!r}")
        # Ensure prefix if model forgot
        if not txt.lower().startswith("ai abstract -"):
            txt = "AI abstract - " + txt.lstrip()
        return txt
    except Exception as e:
        print(f"[error] build_ai_abstract: LLM call failed: {e}")
        return ""


# -------------------------
# DB HELPERS
# -------------------------
def open_db(path: str) -> sqlite3.Connection:
    abs_path = os.path.abspath(path)
    print(f"[info] Opening DB at {abs_path!r}")
    conn = sqlite3.connect(abs_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_ai_columns(conn: sqlite3.Connection):
    """
    Ensure all AI-related columns exist on `papers`:
    - AI_field_list (TEXT, JSON list of strings)
    - AI_primary_field (TEXT)
    - AI_summary (TEXT)
    - AI_abstract (TEXT)
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    print(f"[debug] Existing columns in 'papers': {sorted(cols)}")
    for col, ctype in [
        ("AI_field_list", "TEXT"),
        ("AI_primary_field", "TEXT"),
        ("AI_summary", "TEXT"),
        ("AI_abstract", "TEXT"),
    ]:
        if col not in cols:
            print(f"[info] Adding missing column {col} ({ctype}) to papers")
            conn.execute(f"ALTER TABLE papers ADD COLUMN {col} {ctype}")
    conn.commit()


# -------------------------
# CORE LOOP
# -------------------------

def process_ai(
    conn: sqlite3.Connection,
    overwrite_ai_fields: bool,
    overwrite_summary: bool,
    overwrite_ai_abstract: bool,
    only_unprocessed: bool,
    paper_id_filter: Optional[str],
    title_contains_filter: Optional[str],
    limit_rows: Optional[int],
    min_citations: Optional[int],
    max_citations: Optional[int],
    field_contains: Optional[str],
    author_contains: Optional[str],
):
    ensure_ai_columns(conn)

    base_query = """
        SELECT
            paperId,
            title,
            abstract,
            year,
            journal_name,
            first_author_name,
            all_author_names,
            primary_concept,
            concepts_json,
            AI_field_list,
            AI_primary_field,
            AI_summary,
            AI_abstract
        FROM papers
    """

    conditions = []
    params: list = []

    if only_unprocessed:
        conditions.append("""
            (AI_field_list IS NULL OR AI_field_list = '[]'
             OR AI_summary IS NULL OR TRIM(AI_summary) = ''
             OR ((abstract IS NULL OR TRIM(abstract) = '')
                 AND (AI_abstract IS NULL OR TRIM(AI_abstract) = '')))
        """)

    if paper_id_filter:
        conditions.append("paperId = ?")
        params.append(paper_id_filter)

    if title_contains_filter:
        conditions.append("title LIKE ?")
        params.append(f"%{title_contains_filter}%")

    # Filter by citation count
    if min_citations is not None:
        conditions.append("cited_by_count >= ?")
        params.append(min_citations)

    if max_citations is not None:
        conditions.append("cited_by_count <= ?")
        params.append(max_citations)

    # Filter by field (primary_concept or AI_primary_field)
    if field_contains:
        conditions.append("(primary_concept LIKE ? OR AI_primary_field LIKE ?)")
        like_val = f"%{field_contains}%"
        params.extend([like_val, like_val])

    # Filter by author name (anywhere in the author list or first author)
    if author_contains:
        conditions.append("(all_author_names LIKE ? OR first_author_name LIKE ?)")
        like_val = f"%{author_contains}%"
        params.extend([like_val, like_val])

    q = base_query
    if conditions:
        q += " WHERE " + " AND ".join(f"({c})" for c in conditions)

    if limit_rows is not None:
        q += " LIMIT ?"
        params.append(limit_rows)

    print("[debug] Final SQL query:")
    print(q.strip())
    print("[debug] Query params:", params)

    rows = conn.execute(q, params).fetchall()
    print(f"[info] AI-processing {len(rows)} rows")

    for idx, r in enumerate(rows, start=1):
        paperId = r["paperId"]
        title = r["title"]
        abstract = r["abstract"]
        year = r["year"]
        journal_name = r["journal_name"]
        first_author_name = r["first_author_name"]
        all_author_names = r["all_author_names"]
        primary_concept = r["primary_concept"]
        concepts_json = r["concepts_json"]
        ai_field_list = r["AI_field_list"]
        ai_primary = r["AI_primary_field"]
        ai_summary = r["AI_summary"]
        ai_abstract = r["AI_abstract"]

        print(
            f"\n[info] Row {idx}/{len(rows)} — paperId={paperId}, "
            f"title={(title or '')[:60]!r}"
        )
        print(
            "    BEFORE: "
            f"len(abstract)={len(abstract or '')}, "
            f"len(AI_abstract)={len(ai_abstract or '')}, "
            f"len(AI_summary)={len(ai_summary or '')}"
        )

        # ---------- AUTHORS STRING ----------
        authors_str = all_author_names or first_author_name

        # ---------- AI ABSTRACT FIRST ----------
        real_abs_missing = (abstract is None) or (str(abstract).strip() == "")
        need_ai_abs = real_abs_missing and (
            overwrite_ai_abstract or not ai_abstract or str(ai_abstract).strip() == ""
        )

        generated_ai_abs = None
        if need_ai_abs:
            print("[info] No real abstract found — generating AI abstract…")
            generated_ai_abs = build_ai_abstract(
                title=title,
                journal_name=journal_name,
                authors=authors_str,
                primary_concept=primary_concept,
                concepts_json=concepts_json,
                year=year,
            )
            if not generated_ai_abs:
                print("[warn] AI abstract generation failed; leaving abstract empty")
        else:
            print("[debug] Skipping AI abstract generation (already present or overwrite disabled)")

        working_abstract = generated_ai_abs or abstract
        ai_abstract_to_store = ai_abstract
        if generated_ai_abs:
            ai_abstract_to_store = generated_ai_abs

        # ---------- AI CATEGORY ----------
        need_ai_fields = overwrite_ai_fields or not ai_field_list or ai_field_list == "[]"
        if need_ai_fields:
            print("[info] Generating AI category list…")
            AI_field_list: List[str] = AI_category_one(working_abstract or "")
            AI_primary_field: str = AI_field_list[0] if AI_field_list else "Unknown"
            print(f"[debug] AI_field_list = {AI_field_list}, AI_primary_field = {AI_primary_field!r}")
        else:
            print("[debug] Reusing existing AI_field_list / AI_primary_field")
            try:
                parsed = json.loads(ai_field_list)
                AI_field_list = parsed if isinstance(parsed, list) else ["Unknown"]
                AI_primary_field = ai_primary or (AI_field_list[0] if AI_field_list else "Unknown")
            except Exception:
                print("[warn] Failed to parse existing AI_field_list; defaulting to ['Unknown']")
                AI_field_list = ["Unknown"]
                AI_primary_field = "Unknown"

        # ---------- AI SUMMARY ----------
        need_summary = overwrite_summary or not ai_summary or str(ai_summary).strip() == ""
        new_summary = ai_summary
        if need_summary:
            if working_abstract or title:
                print("[info] Generating AI summary…")
                new_summary = summarize_text(
                    abstract=working_abstract or "",
                    title=title,
                    journal_name=journal_name,
                    authors=authors_str,
                    primary_concept=primary_concept,
                    concepts_json=concepts_json,
                )
                if not new_summary:
                    print("[warn] AI summary generation failed; leaving summary empty")
            else:
                print("[warn] No abstract or title available for summary; skipping")
        else:
            print("[debug] Reusing existing AI_summary")

        updated_abstract = working_abstract

        # ---------- WRITE BACK ----------
        print("[debug] Writing results back to DB…")
        conn.execute(
            """
            UPDATE papers
            SET abstract        = ?,
                AI_field_list   = ?,
                AI_primary_field = ?,
                AI_summary      = ?,
                AI_abstract     = ?
            WHERE paperId = ?
            """,
            (
                updated_abstract,
                json.dumps(AI_field_list, ensure_ascii=False),
                AI_primary_field,
                new_summary,
                ai_abstract_to_store,
                paperId,
            ),
        )
        conn.commit()
        print("[debug] Commit done")

        # ---------- VERIFY AFTER ----------
        row2 = conn.execute(
            """
            SELECT abstract, AI_abstract, AI_summary
            FROM papers
            WHERE paperId = ?
            """,
            (paperId,),
        ).fetchone()

        print(
            "    AFTER:  "
            f"len(abstract)={len(row2['abstract'] or '') if row2 else 'NA'}, "
            f"len(AI_abstract)={len(row2['AI_abstract'] or '') if row2 else 'NA'}, "
            f"len(AI_summary)={len(row2['AI_summary'] or '') if row2 else 'NA'}"
        )

        time.sleep(0.2)

    print(f"[info] Total DB changes in this connection: {conn.total_changes}")


# -------------------------
# CLI
# -------------------------
def parse_args():
    p = argparse.ArgumentParser(
        description="Run AI categorisation / summaries / AI abstracts on DB only"
    )
    p.add_argument("--db", type=str, default="papers.db", help="Path to SQLite DB")

    p.add_argument(
        "--overwrite-ai-fields", type=int, default=0,
        help="1 = recalc AI_field_list / AI_primary_field even if present"
    )
    p.add_argument(
        "--overwrite-summary", type=int, default=0,
        help="1 = recalc AI_summary even if present"
    )
    p.add_argument(
        "--overwrite-ai-abstract", type=int, default=0,
        help="1 = regenerate AI abstract even if present & missing real abstract"
    )
    p.add_argument(
        "--only-unprocessed", type=int, default=1,
        help="1 = only rows missing some AI fields; 0 = process all matching filters"
    )

    # Filters
    p.add_argument(
        "--paper-id", type=str, default=None,
        help="If set, restrict processing to this exact paperId"
    )
    p.add_argument(
        "--title-contains", type=str, default=None,
        help="If set, restrict processing to papers whose title contains this substring"
    )
    p.add_argument(
        "--limit", type=int, default=None,
        help="If set, only process the first N matching rows"
    )

    p.add_argument(
        "--min-citations", type=int, default=None,
        help="Only process papers with cited_by_count >= this"
    )
    p.add_argument(
        "--max-citations", type=int, default=None,
        help="Only process papers with cited_by_count <= this"
    )
    p.add_argument(
        "--field-contains", type=str, default=None,
        help="Filter by field name (matches primary_concept or AI_primary_field)"
    )
    p.add_argument(
        "--author-contains", type=str, default=None,
        help="Filter by author name (matches first_author_name / all_author_names)"
    )

    return p.parse_args()


def main():
    args = parse_args()
    conn = open_db(args.db)
    try:
        process_ai(
            conn,
            overwrite_ai_fields=bool(args.overwrite_ai_fields),
            overwrite_summary=bool(args.overwrite_summary),
            overwrite_ai_abstract=bool(args.overwrite_ai_abstract),
            only_unprocessed=bool(args.only_unprocessed),
            paper_id_filter=args.paper_id,
            title_contains_filter=args.title_contains,
            limit_rows=args.limit,
            min_citations=args.min_citations,
            max_citations=args.max_citations,
            field_contains=args.field_contains,
            author_contains=args.author_contains,
        )
    finally:
        conn.close()
        print("[info] DB connection closed")


if __name__ == "__main__":
    main()
