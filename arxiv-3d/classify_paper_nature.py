#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
classify_paper_nature.py — Keyword-based epistemological classification of papers.

Assigns each paper a 'paper_nature' value:
  experimental    — new measurements/observations, direct contact with reality
  theoretical     — new models, frameworks, derivations, no new data
  phenomenological — uses theory + real data to extract parameters/constraints
  review          — synthesis, overview, no new evidence or theory

Scoring is WEIGHTED:
  - HARD experimental keywords (collaboration names, specific detector terms): 3 pts each
  - SOFT experimental keywords (data language): 1 pt each
  - All other categories: 1 pt per keyword hit

A paper is only classified 'experimental' if its weighted experimental score >= 3
AND its experimental score > theoretical score.  This prevents theory papers that
mention "data" or "observed" from being falsely flagged as experimental.

Also stores 'paper_nature_score' (int) — the winning weighted score,
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
# Keyword lists — experimental split into HARD (3 pts) and SOFT (1 pt)
# All other categories score 1 pt per hit.
# ---------------------------------------------------------------------------

# HARD: specific enough that one hit almost certainly means "experimental paper"
EXPERIMENTAL_HARD = [
    # Named collaborations — very strong signal
    " cms ", "cms collaboration", "cms detector",
    " atlas ", "atlas collaboration", "atlas detector",
    " alice ", "alice collaboration",
    " lhcb ", "lhcb collaboration",
    "cdf collaboration", "d0 collaboration",
    "belle collaboration", "belle ii",
    "babar collaboration",
    "delphi collaboration", " opal ", "aleph collaboration",
    "na62", "na48", "na49",
    "star collaboration", "phenix collaboration",
    "brahms", "phobos collaboration",
    "pierre auger", "icecube collaboration", "antares collaboration",
    "planck collaboration", "wmap",
    "super-kamiokande", "kamland", "daya bay", "nova experiment",
    "t2k collaboration", "miniboone",
    # Specific hardware / detector components
    "drift chamber", "silicon tracker", "vertex detector",
    "time projection chamber", " tpc ", "electromagnetic calorimeter",
    "hadronic calorimeter", "muon spectrometer",
    "integrated luminosity", "inverse femtobarn", "inverse picobarn",
    # Definitive result language
    "we report the observation", "we report the discovery",
    "first observation of", "direct observation of",
    "evidence for the", "observation of the",
    "discovery of the",
]

# SOFT: useful signal but common enough to appear in theory papers too
EXPERIMENTAL_SOFT = [
    # Instrumentation (generic)
    "detector", "telescope", "accelerator", "collider", "spectrometer",
    "calorimeter", "apparatus", "luminosity", "beam dump",
    "fermilab", " lhc ",
    # Data & measurement language
    "data sample", "data set", "event selection", "event yield",
    "systematic uncertainty", "statistical uncertainty", "signal yield",
    "background estimation", "signal region", "control region",
    "calibration", "reconstruction efficiency", "trigger efficiency",
    "confidence level", "exclusion limit", "upper limit at",
    "cross section measurement", "branching fraction measurement",
    "invariant mass spectrum", "transverse momentum distribution",
    "collected data", "collected at",
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
    "operator product expansion",
    "dispersion relation", "unitarity cut",
    # Qualitative theory language
    "spontaneous symmetry breaking", "symmetry breaking mechanism",
    "goldstone boson", "higgs mechanism",
    "moduli space", "brane", "compactification",
    "holography", "holographic", "duality",
]

PHENOMENOLOGICAL_KEYWORDS = [
    "phenomenological", "phenomenology",
    "we fit", "global fit", "best fit", "fit to data",
    "we constrain", "we extract", "parameter extraction",
    "extraction of", "determination of",
    "parton distribution", "pdf fit", "parton shower",
    "form factor", "decay constant", "coupling constant extraction",
    "nlo calculation", "nnlo calculation", "qcd correction",
    "next-to-leading order", "next-to-next-to-leading",
    "fixed-order", "resummation", "jet cross section",
    "fragmentation function", "hadronic matrix element",
    "monte carlo", "event generator", "pythia", "herwig",
    "geant4", "sherpa", "madgraph",
    "lattice qcd", "lattice calculation", "lattice simulation",
    "sum rules", "qcd sum rules",
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

# Minimum weighted experimental score to be classified as experimental.
# A single collaboration name (3 pts) qualifies; pure soft-keyword papers need 3+ hits.
EXPERIMENTAL_THRESHOLD = 3

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
    """
    Return weighted scores per category.
    Experimental uses hard (3 pts) + soft (1 pt) keywords.
    All other categories score 1 pt per keyword hit.
    """
    exp_score = (
        sum(3 for kw in EXPERIMENTAL_HARD if kw in text) +
        sum(1 for kw in EXPERIMENTAL_SOFT if kw in text)
    )
    return {
        "experimental":     exp_score,
        "theoretical":      sum(1 for kw in THEORETICAL_KEYWORDS     if kw in text),
        "phenomenological": sum(1 for kw in PHENOMENOLOGICAL_KEYWORDS if kw in text),
        "review":           sum(1 for kw in REVIEW_KEYWORDS           if kw in text),
    }


def classify(title: Optional[str], abstract: Optional[str],
             concepts_json: Optional[str], work_type: Optional[str]) -> tuple:
    """
    Returns (nature: str, score: int).
    'nature' is one of: experimental, theoretical, phenomenological, review, unknown.
    'score' is the winning weighted score.
    """
    # Hard override: OpenAlex type = review, or title starts with "review of"
    title_lc = (title or "").lower().strip()
    if (work_type and "review" in work_type.lower()) or \
       title_lc.startswith("review of") or title_lc.startswith("a review of"):
        return "review", 99

    combined = " ".join(filter(None, [title, abstract, concepts_json])).lower()
    scores = score_text(combined)

    # Experimental requires a minimum threshold AND must beat theoretical score.
    # This prevents theory papers that mention "data" or "observed" from qualifying.
    if scores["experimental"] < EXPERIMENTAL_THRESHOLD or \
       scores["experimental"] <= scores["theoretical"]:
        scores["experimental"] = 0

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
