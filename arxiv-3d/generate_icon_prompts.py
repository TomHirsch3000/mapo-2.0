#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_icon_prompts.py — Generate image prompts for each icon_category
by sampling real paper abstracts and using Claude to create descriptive prompts.

Reads distinct icon_category values from the DB, samples 3-5 abstracts per
category, sends them to Claude API to generate an image generation prompt,
and saves everything to icon_prompts.json for review before image generation.

Usage:
  python generate_icon_prompts.py                                    # default DB
  python generate_icon_prompts.py --db papers_particle_physics_all.db
  python generate_icon_prompts.py --db papers_particle_physics_all.db --categories atlas-detector cms-detector
  python generate_icon_prompts.py --resume  # skip categories already in icon_prompts.json

Requirements:
  pip install anthropic
  Set ANTHROPIC_API_KEY environment variable
"""

import argparse
import json
import os
import sqlite3
import time
from typing import Optional

try:
    import anthropic
except ImportError:
    print("ERROR: 'anthropic' package not installed. Run: pip install anthropic")
    exit(1)


META_PROMPT = """You are creating an image generation prompt for Stable Diffusion XL.

I will give you the name of a sub-category of particle physics experiments/observations,
along with 3-5 real paper abstracts from that category.

Based on these, write a single image generation prompt that captures the visual essence
of this type of experiment or observation. The generated image should:

- Be a clean, visually striking scientific illustration or diagram
- Be recognizable and distinct even at small sizes (64-128px thumbnail)
- Convey what makes this type of experiment unique (the detector, the phenomenon, the measurement)
- Use a clean white or light background
- Have NO text, labels, numbers, or equations in the image
- Be in a modern, clean scientific illustration style (think textbook diagrams or science magazine covers)

Focus on the VISUAL aspects: What does the detector look like? What particles are involved?
What does the collision/interaction look like? What is being measured?

Respond with ONLY the image prompt, nothing else. Keep it under 100 words."""


def open_db(path: str) -> sqlite3.Connection:
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Database not found at {abs_path}")
    conn = sqlite3.connect(abs_path)
    conn.row_factory = sqlite3.Row
    return conn


def get_categories(conn: sqlite3.Connection, specific: Optional[list] = None) -> list:
    """Get all distinct icon_category values (non-null) from the DB."""
    if specific:
        placeholders = ','.join(['?'] * len(specific))
        rows = conn.execute(
            f"SELECT DISTINCT icon_category FROM papers WHERE icon_category IN ({placeholders})",
            specific
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT DISTINCT icon_category FROM papers WHERE icon_category IS NOT NULL AND icon_category != '' ORDER BY icon_category"
        ).fetchall()
    return [r['icon_category'] for r in rows]


def sample_abstracts(conn: sqlite3.Connection, category: str, n: int = 5) -> list:
    """Sample n paper abstracts from a given icon_category, preferring high-citation papers."""
    rows = conn.execute(
        """SELECT title, abstract FROM papers
           WHERE icon_category = ? AND abstract IS NOT NULL AND abstract != ''
           ORDER BY cited_by_count DESC
           LIMIT ?""",
        (category, n)
    ).fetchall()
    return [{"title": r['title'], "abstract": r['abstract']} for r in rows]


def generate_prompt(client: anthropic.Anthropic, category: str, abstracts: list) -> str:
    """Use Claude to generate an image prompt based on sample abstracts."""
    abstracts_text = "\n\n---\n\n".join(
        f"**{a['title']}**\n{a['abstract']}" for a in abstracts
    )

    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": f"Category: {category}\n\nSample abstracts:\n\n{abstracts_text}\n\n{META_PROMPT}"
        }]
    )

    return message.content[0].text.strip()


def run(db_path: str, specific_categories: Optional[list] = None, resume: bool = False):
    # Load existing prompts if resuming
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon_prompts.json")
    existing = {}
    if resume and os.path.exists(output_path):
        with open(output_path, 'r') as f:
            existing = json.load(f)
        print(f"[info] Resuming — {len(existing)} categories already generated")

    conn = open_db(db_path)
    categories = get_categories(conn, specific_categories)
    print(f"[info] Found {len(categories)} icon categories in DB")

    if resume:
        categories = [c for c in categories if c not in existing]
        print(f"[info] {len(categories)} remaining after skipping existing")

    if not categories:
        print("[info] Nothing to do.")
        conn.close()
        return

    client = anthropic.Anthropic()  # Uses ANTHROPIC_API_KEY env var
    results = dict(existing)  # Start with existing if resuming

    for i, category in enumerate(categories):
        print(f"[{i+1}/{len(categories)}] Generating prompt for: {category}")

        abstracts = sample_abstracts(conn, category, n=5)
        if not abstracts:
            print(f"  WARNING: No abstracts found for {category}, skipping")
            continue

        try:
            prompt = generate_prompt(client, category, abstracts)
            results[category] = {
                "prompt": prompt,
                "sample_titles": [a['title'] for a in abstracts],
                "abstract_count": len(abstracts)
            }
            print(f"  ✓ Generated ({len(prompt)} chars)")

            # Save after each to avoid losing work
            with open(output_path, 'w') as f:
                json.dump(results, f, indent=2)

            # Small delay to avoid rate limits
            time.sleep(0.5)

        except Exception as e:
            print(f"  ERROR: {e}")
            # Save what we have and continue
            with open(output_path, 'w') as f:
                json.dump(results, f, indent=2)
            time.sleep(2)

    conn.close()

    # Final save
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\n[done] Generated {len(results)} prompts → {output_path}")
    print("Review and edit the prompts in the JSON file before generating images.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate image prompts for icon categories.")
    parser.add_argument(
        "--db", default="papers_particle_physics_all.db",
        help="Path to SQLite database"
    )
    parser.add_argument(
        "--categories", nargs="+",
        help="Only generate for these specific categories"
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Skip categories already present in icon_prompts.json"
    )
    args = parser.parse_args()
    run(args.db, specific_categories=args.categories, resume=args.resume)
