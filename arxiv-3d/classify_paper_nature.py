#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
classify_paper_nature.py — Keyword-based epistemological classification of papers.

Assigns each paper a 'paper_nature' value:
  experimental    — new measurements/observations, direct contact with reality
  theoretical     — new models, frameworks, derivations, no new data
  phenomenological — uses theory + real data to extract parameters/constraints
  review          — synthesis, overview, no new evidence or theory

Also stores 'paper_nature_score' (int) — the winning keyword hit count,
useful for inspecting borderline cases.

Usage:
  python classify_paper_nature.py                              # uses default DB
  python classify_paper_nature.py --db papers_particle_physics_all.db
  python classify_paper_nature.py --db papers_astrophysics.db --reclassify
"""

import argparse
import os
import sqlite3
from typing import Optional


# ---------------------------------------------------------------------------
# Keyword lists
# Each entry is matched as a lowercase substring of the combined text field.
# Collaboration names are padded with spaces to avoid false partial matches.
# ---------------------------------------------------------------------------

EXPERIMENTAL_KEYWORDS = [
    # Instrumentation
    "detector", "telescope", "accelerator", "collider", "spectrometer",
    "calorimeter", "apparatus", "luminosity", "beam dump",
    "drift chamber", "silicon tracker", "vertex detector", "muon chamber",
    # Major collaborations (space-padded to avoid e.g. "atlas" in "catalyst")
    " cms ", " atlas ", " alice ", " lhcb ", " lhc ",
    "fermilab", "belle ", " babar", "delphi", " opal ", " aleph ",
    "cdf collaboration", "d0 collaboration", "na62", "na48", "compass",
    "brahms", "phobos", "star collaboration", "phenix",
    "auger", "icecube", "antares",
    # Data & measurement language
    "measurement of", "we measure", "we report", "we present",
    "measured value", "we observed", "we detect", "we search for",
    "data sample", "data set", "event selection", "event yield",
    "systematic uncertainty", "statistical uncertainty", "signal yield",
    "background estimation", "signal region", "control region",
    "calibration", "reconstruction efficiency", "trigger", "readout",
    # Statistical / result language
    "confidence level", "exclusion limit", "upper limit",
    "cross section measurement", "branching fraction measurement",
    "invariant mass", "transverse momentum distribution",
    "collected data", "integrated luminosity",
]

THEORETICAL_KEYWORDS = [
    # Language of derivation / proposal
    "we propose", "we derive", "we calculate", "we show that",
    "we demonstrate that", "we prove", "we conjecture", "we argue that",
    "it is shown that", "it can be shown",
    # Frameworks and formalisms
    "effective field theory", "lagrangian", "hamiltonian",
    "path integral", "partition function",
    "perturbation theory", "renormalization group",
    "string theory", "m-theory", "superstring",
    "supersymmetry", "supergravity", "susy breaking",
    "conformal field theory", "topological field theory",
    "gauge theory", "chern-simons", "ads/cft",
    # Mathematical tools
    "feynman diagram", "feynman rules", "one-loop", "two-loop",
    "anomalous dimension", "beta function", "running coupling",
    "fixed point", "conjecture", "theorem", "proof",
    "ansatz", "variational principle", "ward identity",
    "operator product expansion", "ope",
    "dispersion relation", "unitarity cut",
    # Qualitative theory language
    "spontaneous symmetry breaking", "symmetry breaking mechanism",
    "goldstone boson", "higgs mechanism",
    "moduli space", "brane", "compactification",
    "holography", "holographic", "duality",
]

PHENOMENOLOGICAL_KEYWORDS = [
    # Explicit label
    "phenomenological", "phenomenology",
    # Fitting and extraction
    "we fit", "global fit", "best fit", "fit to data",
    "we constrain", "we extract", "parameter extraction",
    "extraction of", "determination of",
    "parton distribution", "pdf fit", "parton shower",
    "form factor", "decay constant", "coupling constant extraction",
    # QCD / precision calculations applied to data
    "nlo calculation", "nnlo calculation", "qcd correction",
    "next-to-leading order", "next-to-next-to-leading",
    "fixed-order", "resummation", "jet cross section",
    "fragmentation function", "hadronic matrix element",
    # Simulation / event generation applied to data
    "monte carlo", "event generator", "pythia", "herwig",
    "geant4", "sherpa", "madgraph",
    # Lattice (sits between theory and experiment)
    "lattice qcd", "lattice calculation", "lattice simulation",
    "sum rules", "qcd sum rules",
    # Re-analysis / updated constraints
    "updated analysis", "re-analysis", "reanalysis",
    "we update", "updated constraints", "global analysis",
]

REVIEW_KEYWORDS = [
    "review of", "review article", "we review", "this review",
    "status of", "recent progress", "recent developments",
    "survey of", "overview of", "a brief overview",
    "introduction to", "lecture notes", "lectures on",
    "progress in", "compilation of", "comprehensive review",
    "historical overview", "pedagogical",
    "proceedings of", "conference proceedings",
]

# Tie-breaking priority (earlier = wins when scores equal)
PRIORITY = ["review", "experimental", "phenomenological", "theoretical"]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def open_db(path: str) -> sqlite3.Connection:
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Database not found at {abs_path}")
    print(f"[info] Opening DB at {abs_path}")
    conn = sqlite3.connect(abs_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_columns(conn: sqlite3.Connection):
    cursor = conn.execute("PRAGMA table_info(papers)")
    cols = {r[1] for r in cursor.fetchall()}
    if "paper_nature" not in cols:
        print("[info] Adding column 'paper_nature' to papers")
        conn.execute("ALTER TABLE papers ADD COLUMN paper_nature TEXT")
    if "paper_nature_score" not in cols:
        print("[info] Adding column 'paper_nature_score' to papers")
        conn.execute("ALTER TABLE papers ADD COLUMN paper_nature_score INTEGER DEFAULT 0")
    conn.commit()


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

def score_text(text: str) -> dict:
    """Return keyword hit counts per category for the given (lowercased) text."""
    return {
        "experimental":    sum(1 for kw in EXPERIMENTAL_KEYWORDS    if kw in text),
        "theoretical":     sum(1 for kw in THEORETICAL_KEYWORDS     if kw in text),
        "phenomenological":sum(1 for kw in PHENOMENOLOGICAL_KEYWORDS if kw in text),
        "review":          sum(1 for kw in REVIEW_KEYWORDS           if kw in text),
    }


def classify(title: Optional[str], abstract: Optional[str],
             concepts_json: Optional[str], work_type: Optional[str]) -> tuple:
    """
    Returns (nature: str, score: int).
    'nature' is one of: experimental, theoretical, phenomenological, review, unknown.
    'score' is the winning keyword count.
    """
    # Hard override: OpenAlex marks it as a review article
    if work_type and "review" in work_type.lower():
        return "review", 99

    combined = " ".join(filter(None, [title, abstract, concepts_json])).lower()
    scores = score_text(combined)

    best_score = max(scores.values())
    if best_score == 0:
        return "unknown", 0

    # Resolve ties using PRIORITY order
    for category in PRIORITY:
        if scores[category] == best_score:
            return category, best_score

    return "unknown", 0  # unreachable


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------

def run(db_path: str, reclassify: bool = False):
    conn = open_db(db_path)
    ensure_columns(conn)

    if reclassify:
        rows = conn.execute(
            "SELECT paperId, title, abstract, concepts_json, work_type FROM papers"
        ).fetchall()
        print(f"[info] Reclassifying all {len(rows)} papers")
    else:
        rows = conn.execute(
            """SELECT paperId, title, abstract, concepts_json, work_type
               FROM papers
               WHERE paper_nature IS NULL OR paper_nature = ''"""
        ).fetchall()
        print(f"[info] Classifying {len(rows)} unclassified papers")

    if not rows:
        print("[info] Nothing to do.")
        conn.close()
        return

    updates = []
    for row in rows:
        nature, score = classify(
            row["title"], row["abstract"],
            row["concepts_json"], row["work_type"]
        )
        updates.append((nature, score, row["paperId"]))

    conn.executemany(
        "UPDATE papers SET paper_nature = ?, paper_nature_score = ? WHERE paperId = ?",
        updates
    )
    conn.commit()
    conn.close()

    # Print distribution
    conn2 = open_db(db_path)
    dist = conn2.execute(
        "SELECT paper_nature, COUNT(*) AS n FROM papers GROUP BY paper_nature ORDER BY n DESC"
    ).fetchall()
    conn2.close()

    print("\n[results] Classification distribution:")
    for r in dist:
        print(f"  {r['paper_nature'] or 'NULL':20s}  {r['n']}")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Classify papers by epistemological nature.")
    parser.add_argument(
        "--db", default="papers_particle_physics_all.db",
        help="Path to SQLite database (default: papers_particle_physics_all.db)"
    )
    parser.add_argument(
        "--reclassify", action="store_true",
        help="Re-run classification even for already-classified papers"
    )
    args = parser.parse_args()
    run(args.db, reclassify=args.reclassify)
