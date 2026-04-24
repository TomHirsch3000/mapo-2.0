#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_pipeline.py — Orchestrate the full pipeline with checkpointing and batching.

Handles crashes/shutdowns by saving progress to a checkpoint file after every
completed batch or step. Re-running the same command resumes from where it stopped.

QUICK START — add a new physics topic:
    python run_pipeline.py \\
        --topic "Nuclear Physics" \\
        --db papers_nuclear_physics.db \\
        --email your@email.com

STEP-BY-STEP DEFAULTS:
    Step 1 — Import      : downloads papers in 10-year batches (1800 → now), no per-batch limit
    Step 2 — Citations   : builds citation edges (already resumable internally)
    Step 3 — Abstracts   : fills missing abstracts (already resumable internally)
    Step 4 — AI metadata : runs AI on up to --ai-sample papers, --ai-batch-size at a time
    Step 5 — Standardize : cleans field labels (skip-mislabel by default)
    Step 6 — Frontend    : generates nodes/edges JSON
    Step 7 — Universe    : rebuilds universe.json with all known topics

TUNING PARAMETERS:
    --papers-per-batch 500   Limit papers fetched per year-range (0 = no limit)
    --year-batch-size  10    How many years per import batch (default: 10)
    --year-start       1800  First publication year to import (default: 1800)
    --year-end         2025  Last publication year to import (default: current year)
    --ai-sample        500   Total papers to run AI on (0 = all; can run again for more)
    --ai-batch-size    200   Papers processed per AI subprocess call

RESUMING:
    Just re-run the exact same command — completed batches and steps are skipped.
    To force a step to re-run: --force-step 4
    To skip a step entirely:   --skip-step 3
"""

import argparse
import datetime
import glob
import json
import sqlite3
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"
CHECKPOINT_VERSION = 2


# ---------------------------------------------------------------------------
# Checkpoint helpers
# ---------------------------------------------------------------------------

def checkpoint_path(db: str) -> Path:
    stem = Path(db).stem
    return SCRIPT_DIR / f"{stem}_checkpoint.json"


def load_checkpoint(db: str) -> dict:
    p = checkpoint_path(db)
    if p.exists():
        try:
            with open(p) as f:
                data = json.load(f)
            if data.get("version") == CHECKPOINT_VERSION:
                return data
            print(f"[checkpoint] Version mismatch — starting fresh (old: {data.get('version')})")
        except Exception as e:
            print(f"[checkpoint] Could not read {p}: {e} — starting fresh")
    return {"version": CHECKPOINT_VERSION, "import_batches_done": [], "steps_done": [], "ai_processed": 0}


def save_checkpoint(db: str, cp: dict) -> None:
    cp["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
    p = checkpoint_path(db)
    with open(p, "w") as f:
        json.dump(cp, f, indent=2)


def mark_step_done(db: str, cp: dict, step: int) -> None:
    if step not in cp["steps_done"]:
        cp["steps_done"].append(step)
    save_checkpoint(db, cp)


def mark_import_batch_done(db: str, cp: dict, batch_key: str) -> None:
    if batch_key not in cp["import_batches_done"]:
        cp["import_batches_done"].append(batch_key)
    save_checkpoint(db, cp)


# ---------------------------------------------------------------------------
# DB helpers (read-only queries from orchestrator)
# ---------------------------------------------------------------------------

def count_unprocessed_ai(db: str) -> int:
    """Count papers that still need AI processing."""
    db_path = SCRIPT_DIR / db
    if not db_path.exists():
        return 0
    try:
        conn = sqlite3.connect(str(db_path))
        # Check if AI columns exist first
        cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
        if "AI_field_list" not in cols:
            n = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        else:
            n = conn.execute("""
                SELECT COUNT(*) FROM papers
                WHERE AI_field_list IS NULL OR AI_field_list = '[]'
                   OR AI_summary IS NULL OR TRIM(AI_summary) = ''
            """).fetchone()[0]
        conn.close()
        return n
    except Exception as e:
        print(f"[warn] Could not query DB for AI count: {e}")
        return 0


def count_total_papers(db: str) -> int:
    db_path = SCRIPT_DIR / db
    if not db_path.exists():
        return 0
    try:
        conn = sqlite3.connect(str(db_path))
        n = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Subprocess runner
# ---------------------------------------------------------------------------

def run_cmd(cmd: list, label: str, fatal: bool = True) -> bool:
    """Run a subprocess. Returns True on success. Exits if fatal=True on failure."""
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    print(f"{'='*60}")
    result = subprocess.run([str(c) for c in cmd], cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print(f"\n[FAIL] Exit code {result.returncode}")
        if fatal:
            print("Re-run the same command to resume from this point.")
            sys.exit(result.returncode)
        return False
    print(f"[OK] Done.")
    return True


# ---------------------------------------------------------------------------
# Year-range batching helpers
# ---------------------------------------------------------------------------

def make_year_batches(year_start: int, year_end: int, batch_size: int) -> list:
    """Return list of (from_year, to_year) tuples covering year_start..year_end."""
    batches = []
    y = year_start
    while y <= year_end:
        end = min(y + batch_size - 1, year_end)
        batches.append((y, end))
        y = end + 1
    return batches


def batch_key(from_year: int, to_year: int) -> str:
    return f"{from_year}-{to_year}"


# ---------------------------------------------------------------------------
# Galaxy discovery for universe step
# ---------------------------------------------------------------------------

def find_galaxy_args() -> list:
    node_files = sorted(glob.glob(str(DATA_DIR / "*_nodes.json")))

    galaxies = []
    for idx, nodes_path in enumerate(node_files, start=1):
        nodes_file = Path(nodes_path).name
        base = nodes_file.replace("_nodes.json", "")
        edges_file = f"{base}_edges.json"
        meta_file = f"{base}_metadata.json"
        name = base.replace("_", " ").title()
        if not (DATA_DIR / edges_file).exists() or not (DATA_DIR / meta_file).exists():
            continue
        galaxies.append(f"{idx}:{name}:data/{nodes_file}:data/{edges_file}:data/{meta_file}")
    return galaxies


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run the full pipeline to download and process a new physics topic.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # Required
    p.add_argument("--topic", required=True,
                   help="Topic name, e.g. 'Astrophysics'")
    p.add_argument("--db", required=True,
                   help="SQLite DB filename, e.g. papers_astrophysics.db")
    p.add_argument("--email", required=True,
                   help="Email for OpenAlex polite pool")
    p.add_argument("--api-key", type=str, default=None,
                   help="OpenAlex API key for higher rate limits")

    # Import batching
    p.add_argument("--year-start", type=int, default=1800,
                   help="First publication year to import (default: 1800)")
    p.add_argument("--year-end", type=int, default=datetime.date.today().year,
                   help="Last publication year to import (default: current year)")
    p.add_argument("--year-batch-size", type=int, default=1,
                   help="Years per import batch (default: 1). Use 10+ for very sparse topics.")
    p.add_argument("--papers-per-batch", type=int, default=0,
                   help="Max papers per year-range batch (default: 0 = no limit). "
                        "Use e.g. 500 to cap each decade.")

    # AI sampling
    p.add_argument("--ai-sample", type=int, default=500,
                   help="Total papers to run AI on (default: 500). "
                        "0 = process everything. Re-run to process more.")
    p.add_argument("--ai-batch-size", type=int, default=200,
                   help="Papers per AI subprocess call (default: 200). "
                        "Reduce to 50-100 if Ollama is slow.")

    # Visualization
    p.add_argument("--min-citations", type=int, default=0,
                   help="Min citations to include in visualization (default: 0)")
    p.add_argument("--frontend-dir", type=str,
                   default=str(SCRIPT_DIR.parent / "arxiv-3d-frontend" / "public"),
                   help="Directory to copy JSON files into for the frontend")

    # Step control
    p.add_argument("--skip-step", type=int, action="append", default=[],
                   help="Skip this step number entirely (repeatable). E.g. --skip-step 3 --skip-step 7")
    p.add_argument("--force-step", type=int, action="append", default=[],
                   help="Re-run this step even if checkpoint marks it done (repeatable).")
    p.add_argument("--only-step", type=int, default=None,
                   help="Run only this single step number.")
    p.add_argument("--reset-import", action="store_true",
                   help="Wipe and restart the papers table from scratch.")
    p.add_argument("--reset-citations", action="store_true",
                   help="Wipe and restart the citations table from scratch.")
    p.add_argument("--skip-mislabel", action="store_true", default=True,
                   help="Skip mislabel detection in step 5 (default: True)")

    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()
    db = args.db
    slug = args.topic.lower().replace(" ", "_")

    # Ensure data directory exists
    DATA_DIR.mkdir(exist_ok=True)

    # Output filenames scoped to topic (relative to SCRIPT_DIR / cwd)
    nodes_out = f"data/{slug}_nodes.json"
    edges_out = f"data/{slug}_edges.json"
    meta_out  = f"data/{slug}_metadata.json"

    # Load checkpoint
    cp = load_checkpoint(db)
    cp.setdefault("topic", args.topic)
    cp.setdefault("db", db)
    save_checkpoint(db, cp)

    forced  = set(args.force_step)
    skipped = set(args.skip_step)

    def should_run(step: int) -> bool:
        if args.only_step is not None:
            return step == args.only_step
        if step in skipped:
            return False
        if step in forced:
            return True
        if step in cp["steps_done"]:
            print(f"\n[checkpoint] Step {step} already done — skipping. "
                  f"Use --force-step {step} to re-run.")
            return False
        return True

    print(f"\n{'='*60}")
    print(f"  Pipeline: {args.topic}")
    print(f"  Database: {db}")
    print(f"  Checkpoint: {checkpoint_path(db).name}")
    print(f"  Steps done so far: {cp['steps_done']}")
    print(f"  Import batches done: {len(cp['import_batches_done'])}")
    print(f"  AI papers processed: {cp['ai_processed']}")
    print(f"{'='*60}")

    # ------------------------------------------------------------------
    # STEP 1 — Import papers (year-range batches)
    # ------------------------------------------------------------------
    if should_run(1):
        batches = make_year_batches(args.year_start, args.year_end, args.year_batch_size)
        done_keys = set(cp["import_batches_done"])

        # Handle --force-step 1 by clearing batch history for this topic
        if 1 in forced:
            print("[info] --force-step 1: clearing import batch history from checkpoint")
            cp["import_batches_done"] = []
            done_keys = set()
            save_checkpoint(db, cp)

        pending = [(f, t) for (f, t) in batches if batch_key(f, t) not in done_keys]
        print(f"\n[step 1] Import: {len(batches)} year-range batches total, "
              f"{len(done_keys)} already done, {len(pending)} to go.")

        for from_y, to_y in pending:
            bk = batch_key(from_y, to_y)
            cmd = [
                sys.executable, "import_openalex.py",
                "--topic-name", args.topic,
                "--db", db,
                "--email", args.email,
                "--from-year", str(from_y),
                "--to-year",   str(to_y),
            ]
            if args.api_key:
                cmd += ["--api-key", args.api_key]
            if args.papers_per_batch > 0:
                cmd += ["--sample", str(args.papers_per_batch)]
            if args.reset_import:
                cmd.append("--reset")
                args.reset_import = False  # only reset on first batch

            ok = run_cmd(cmd, f"1 — Import {from_y}–{to_y}", fatal=False)
            if ok:
                mark_import_batch_done(db, cp, bk)
                total = count_total_papers(db)
                print(f"[checkpoint] Batch {bk} done. Total papers in DB: {total}")
            else:
                print(f"[warn] Batch {bk} failed. Will retry next run.")
                print("Stopping here. Re-run to resume from this batch.")
                sys.exit(1)

        mark_step_done(db, cp, 1)
        print(f"\n[step 1] Import complete. Total papers: {count_total_papers(db)}")

    # ------------------------------------------------------------------
    # STEP 2 — Build citation edges
    # ------------------------------------------------------------------
    if should_run(2):
        cmd = [sys.executable, "rebuild_citations_openalex.py", "--db", db]
        if args.reset_citations:
            cmd.append("--reset")
        run_cmd(cmd, "2 — Rebuild citation edges")
        mark_step_done(db, cp, 2)

    # ------------------------------------------------------------------
    # STEP 3 — Fetch missing abstracts
    # ------------------------------------------------------------------
    if should_run(3):
        run_cmd(
            [sys.executable, "fetch_abstracts_s2_arxiv.py", "--db", db],
            "3 — Fetch missing abstracts (Semantic Scholar / arXiv)"
        )
        mark_step_done(db, cp, 3)

    # ------------------------------------------------------------------
    # STEP 4 — AI metadata (sampled, batched loop)
    # ------------------------------------------------------------------
    if should_run(4):
        target = args.ai_sample  # 0 = no limit
        batch  = args.ai_batch_size

        # On force, reset the counter so we can process more papers
        if 4 in forced:
            cp["ai_processed"] = 0
            save_checkpoint(db, cp)

        already_done = cp["ai_processed"]
        remaining_target = (target - already_done) if target > 0 else float("inf")

        unprocessed = count_unprocessed_ai(db)
        print(f"\n[step 4] AI metadata:")
        print(f"         Unprocessed papers in DB : {unprocessed}")
        print(f"         Already processed (this run): {already_done}")
        print(f"         Target (--ai-sample)     : {target if target > 0 else 'unlimited'}")
        print(f"         Batch size               : {batch}")

        if remaining_target <= 0:
            print(f"[checkpoint] Already reached AI sample target ({target}). "
                  f"Use --force-step 4 to process more, or increase --ai-sample.")
        elif unprocessed == 0:
            print("[info] No unprocessed papers found — skipping AI step.")
            mark_step_done(db, cp, 4)
        else:
            processed_this_run = 0
            while True:
                to_process = batch if target == 0 else min(batch, int(remaining_target) - processed_this_run)
                if to_process <= 0:
                    break

                unprocessed = count_unprocessed_ai(db)
                if unprocessed == 0:
                    print("[info] All papers now have AI metadata.")
                    break

                print(f"\n[step 4] Running AI on next {to_process} papers "
                      f"({processed_this_run + already_done} done so far, "
                      f"{unprocessed} remaining in DB)...")

                run_cmd(
                    [
                        sys.executable, "process_ai_metadata.py",
                        "--db", db,
                        "--only-unprocessed", "1",
                        "--limit", str(to_process),
                    ],
                    f"4 — AI metadata (batch of {to_process})"
                )

                processed_this_run += to_process
                cp["ai_processed"] = already_done + processed_this_run
                save_checkpoint(db, cp)

                if target > 0 and processed_this_run >= int(remaining_target):
                    print(f"[info] Reached AI sample target ({target} total). "
                          f"Re-run with --force-step 4 or increase --ai-sample for more.")
                    break

            mark_step_done(db, cp, 4)
            print(f"\n[step 4] AI done. Total processed: {cp['ai_processed']}")

    # ------------------------------------------------------------------
    # STEP 5 — Clean and standardize fields
    # ------------------------------------------------------------------
    if should_run(5):
        cmd = [
            sys.executable, "clean_and_categorize.py",
            "--db", db,
            "--field", args.topic,
        ]
        if args.skip_mislabel:
            cmd.append("--skip-mislabel")
        if args.ai_sample > 0:
            cmd += ["--limit", str(args.ai_sample)]
        run_cmd(cmd, "5 — Clean and standardize field classifications")
        mark_step_done(db, cp, 5)

    # ------------------------------------------------------------------
    # STEP 6 — Build frontend JSON
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
        if args.ai_sample > 0:
            cmd += ["--top-n", str(args.ai_sample)]
        if args.frontend_dir:
            cmd += ["--frontend-dir", args.frontend_dir]
        run_cmd(cmd, "6 — Build nodes/edges JSON for frontend")
        mark_step_done(db, cp, 6)

    # ------------------------------------------------------------------
    # STEP 7 — Rebuild universe view
    # ------------------------------------------------------------------
    if should_run(7):
        galaxies = find_galaxy_args()
        if not galaxies:
            print("[warn] No topic JSON files found — skipping universe build.")
        else:
            cmd = [
                sys.executable, "build_universe_json.py",
                "--email", args.email,
                "--output", "data/universe.json",
            ]
            if args.frontend_dir:
                cmd += ["--frontend-dir", args.frontend_dir]
            for g in galaxies:
                cmd += ["--galaxies", g]
            run_cmd(cmd, "7 — Build universe view")
        mark_step_done(db, cp, 7)

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    print(f"\n{'='*60}")
    print(f"  Pipeline complete: {args.topic}")
    print(f"  Papers in DB     : {count_total_papers(db)}")
    print(f"  AI processed     : {cp['ai_processed']}")
    print(f"  Steps done       : {sorted(cp['steps_done'])}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
