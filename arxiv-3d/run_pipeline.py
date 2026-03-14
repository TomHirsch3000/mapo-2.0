#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_pipeline.py — Orchestrate the full pipeline to download and process a new physics topic.

Usage:
    python run_pipeline.py \
        --topic "Astrophysics" \
        --db papers_astrophysics.db \
        --email your@email.com \
        --sample 2000

Steps run in order:
    1. import_openalex.py        — Fetch papers from OpenAlex API
    2. rebuild_citations_openalex.py — Build citation edges
    3. fetch_abstracts_s2_arxiv.py   — Fill missing abstracts
    4. process_ai_metadata.py    — Generate AI categories, summaries
    5. clean_and_categorize.py   — Standardize fields, detect mislabels
    6. build_frontend_json.py    — Generate nodes/edges JSON for visualization
    7. build_universe_json.py    — Update universe view with all known topics

Skip any step with --skip-step N (e.g. --skip-step 1 --skip-step 2).
Resume from a specific step with --from-step N.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(cmd: list[str], step_name: str) -> None:
    """Run a subprocess command and exit on failure."""
    print(f"\n{'='*60}")
    print(f"  STEP: {step_name}")
    print(f"  CMD: {' '.join(cmd)}")
    print(f"{'='*60}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print(f"\n[FATAL] Step '{step_name}' failed with exit code {result.returncode}.")
        print("Fix the error and re-run with --from-step to resume from this point.")
        sys.exit(result.returncode)
    print(f"\n[OK] {step_name} completed successfully.")


def topic_to_slug(topic: str) -> str:
    """Convert topic name to a safe lowercase slug, e.g. 'Astrophysics' -> 'astrophysics'."""
    return topic.lower().replace(" ", "_")


def find_existing_galaxy_args(current_topic_slug: str, current_db: str) -> list[str]:
    """
    Scan for existing topic JSON files in SCRIPT_DIR and build --galaxies args
    for build_universe_json.py. Includes the current topic being built.

    Each galaxy arg format: "N:TopicName:nodes.json:edges.json:metadata.json"
    """
    # Find all *_nodes.json files (excluding the generic nodes.json for particle physics)
    node_files = sorted(glob.glob(str(SCRIPT_DIR / "*_nodes.json")))

    # Also include generic nodes.json (particle physics default)
    generic_nodes = SCRIPT_DIR / "nodes.json"
    if generic_nodes.exists():
        node_files = [str(generic_nodes)] + node_files

    galaxies = []
    idx = 1

    for nodes_path in node_files:
        nodes_file = Path(nodes_path).name

        # Derive edges + metadata filenames
        if nodes_file == "nodes.json":
            edges_file = "edges.json"
            meta_file = "metadata.json"
            name = "Particle Physics"
        else:
            base = nodes_file.replace("_nodes.json", "")
            edges_file = f"{base}_edges.json"
            meta_file = f"{base}_metadata.json"
            name = base.replace("_", " ").title()

        # Only include if all three files exist
        edges_path = SCRIPT_DIR / edges_file
        meta_path = SCRIPT_DIR / meta_file
        if not edges_path.exists() or not meta_path.exists():
            continue

        galaxies.append(f"{idx}:{name}:{nodes_file}:{edges_file}:{meta_file}")
        idx += 1

    return galaxies


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run the full pipeline to add a new physics topic to the database.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    p.add_argument("--topic", required=True,
                   help="Human-readable topic name, e.g. 'Astrophysics' or 'Nuclear Physics'")
    p.add_argument("--db", required=True,
                   help="SQLite DB filename, e.g. papers_astrophysics.db")
    p.add_argument("--email", required=True,
                   help="Email for OpenAlex polite pool (required by their API)")

    p.add_argument("--sample", type=int, default=2000,
                   help="Max papers to import (default: 2000). Use 0 for unlimited.")
    p.add_argument("--min-citations", type=int, default=5,
                   help="Min citations for visualization (default: 5)")
    p.add_argument("--from-step", type=int, default=1,
                   help="Resume from this step number (default: 1 = start from beginning)")
    p.add_argument("--skip-step", type=int, action="append", default=[],
                   help="Skip this step number. Can be repeated.")
    p.add_argument("--reset-import", action="store_true",
                   help="Pass --reset to import_openalex (wipes existing papers table)")
    p.add_argument("--reset-citations", action="store_true",
                   help="Pass --reset to rebuild_citations (wipes existing citations table)")
    p.add_argument("--skip-mislabel", action="store_true", default=True,
                   help="Skip mislabel detection in clean_and_categorize (default: True, saves time)")
    p.add_argument("--frontend-dir", type=str,
                   default=str(SCRIPT_DIR.parent / "arxiv-3d-frontend" / "public"),
                   help="Directory to copy JSON files into for the frontend")

    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()

    slug = topic_to_slug(args.topic)
    db = args.db

    # Derived output filenames (scoped to this topic)
    if slug in ("particle_physics",):
        # Particle physics uses the generic filenames (existing convention)
        nodes_out = "nodes.json"
        edges_out = "edges.json"
        meta_out = "metadata.json"
    else:
        nodes_out = f"{slug}_nodes.json"
        edges_out = f"{slug}_edges.json"
        meta_out = f"{slug}_metadata.json"

    skip = set(args.skip_step)

    def should_run(step: int) -> bool:
        return step >= args.from_step and step not in skip

    # ------------------------------------------------------------------
    # STEP 1: Import papers
    # ------------------------------------------------------------------
    if should_run(1):
        cmd = [
            sys.executable, "import_openalex.py",
            "--topic-name", args.topic,
            "--db", db,
            "--email", args.email,
        ]
        if args.sample > 0:
            cmd += ["--sample", str(args.sample)]
        if args.reset_import:
            cmd.append("--reset")
        run(cmd, "1 — Import papers from OpenAlex")

    # ------------------------------------------------------------------
    # STEP 2: Build citation edges
    # ------------------------------------------------------------------
    if should_run(2):
        cmd = [sys.executable, "rebuild_citations_openalex.py", "--db", db]
        if args.reset_citations:
            cmd.append("--reset")
        run(cmd, "2 — Rebuild citation edges")

    # ------------------------------------------------------------------
    # STEP 3: Fetch missing abstracts
    # ------------------------------------------------------------------
    if should_run(3):
        cmd = [sys.executable, "fetch_abstracts_s2_arxiv.py", "--db", db]
        run(cmd, "3 — Fetch missing abstracts (Semantic Scholar / arXiv)")

    # ------------------------------------------------------------------
    # STEP 4: Generate AI metadata
    # ------------------------------------------------------------------
    if should_run(4):
        cmd = [
            sys.executable, "process_ai_metadata.py",
            "--db", db,
            "--only-unprocessed", "1",
        ]
        run(cmd, "4 — Generate AI categories + summaries (requires Ollama)")

    # ------------------------------------------------------------------
    # STEP 5: Clean and standardize fields
    # ------------------------------------------------------------------
    if should_run(5):
        cmd = [
            sys.executable, "clean_and_categorize.py",
            "--db", db,
            "--field", args.topic,
        ]
        if args.skip_mislabel:
            cmd.append("--skip-mislabel")
        run(cmd, "5 — Clean and standardize field classifications")

    # ------------------------------------------------------------------
    # STEP 6: Build frontend JSON
    # ------------------------------------------------------------------
    if should_run(6):
        cmd = [
            sys.executable, "build_frontend_json.py",
            "--db", db,
            "--output-nodes", nodes_out,
            "--output-edges", edges_out,
            "--output-metadata", meta_out,
            "--min-citations", str(args.min_citations),
            "--compute-clusters",
        ]
        if args.frontend_dir:
            cmd += ["--frontend-dir", args.frontend_dir]
        run(cmd, "6 — Build nodes/edges JSON for frontend")

    # ------------------------------------------------------------------
    # STEP 7: Update universe view
    # ------------------------------------------------------------------
    if should_run(7):
        galaxies = find_existing_galaxy_args(slug, db)
        if not galaxies:
            print("[warn] No galaxy JSON files found — skipping universe build.")
        else:
            cmd = [
                sys.executable, "build_universe_json.py",
                "--email", args.email,
                "--output", "universe.json",
            ]
            if args.frontend_dir:
                cmd += ["--frontend-dir", args.frontend_dir]
            for g in galaxies:
                cmd += ["--galaxies", g]
            run(cmd, "7 — Build universe view (all topics)")

    print(f"\n{'='*60}")
    print(f"  Pipeline complete for topic: {args.topic}")
    print(f"  Database: {db}")
    print(f"  Nodes:    {nodes_out}")
    print(f"  Edges:    {edges_out}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
