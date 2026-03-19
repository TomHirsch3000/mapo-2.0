#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
classify_icon_category.py — Assign experiment/observation sub-categories to papers
for icon mapping on the visual map.

Each experimental or phenomenological paper gets an 'icon_category' value
representing the type of experiment, detector, or physics analysis it describes.
This drives which icon image is shown on the paper's card in the frontend.

Categories are matched via keyword rules on title + abstract.
First matching rule wins (rules are ordered from most specific to most general).

Usage:
  python classify_icon_category.py                              # default DB
  python classify_icon_category.py --db papers_particle_physics_all.db
  python classify_icon_category.py --db papers_particle_physics_all.db --reclassify
"""

import argparse
import os
import re
import sqlite3
from typing import Optional, List, Tuple


# ---------------------------------------------------------------------------
# Category rules
# Each rule is (category_name, compiled_regex_pattern)
# First match wins — order from MOST SPECIFIC to MOST GENERAL
# ---------------------------------------------------------------------------

def _compile_rules(rule_defs: List[Tuple[str, str]]) -> List[Tuple[str, re.Pattern]]:
    """Compile (category, pattern_string) pairs into (category, compiled_regex)."""
    return [(cat, re.compile(pat, re.IGNORECASE)) for cat, pat in rule_defs]


# Rules are grouped by theme for readability, but flattened into a single
# priority-ordered list at the bottom.

# ── Specific Detectors & Experiments ──────────────────────────────────────

DETECTOR_RULES = [
    # LHC detectors
    ("atlas-detector",      r"\batlas\b.*\b(detector|experiment|collaboration|search|measurement)\b|\batlas collaboration\b"),
    ("cms-detector",        r"\bcms\b.*\b(detector|experiment|collaboration|search|measurement)\b|\bcms collaboration\b|\bcompact muon solenoid\b"),
    ("lhcb-detector",       r"\blhcb\b.*\b(detector|experiment|collaboration|measurement)\b|\blhcb collaboration\b"),
    ("alice-detector",      r"\balice\b.*\b(detector|experiment|collaboration|measurement)\b|\balice collaboration\b"),

    # Tevatron
    ("tevatron-cdf",        r"\b(cdf|cdf collaboration|cdf ii)\b"),
    ("tevatron-d0",         r"\b(d0 collaboration|d0 experiment|d\u00d8)\b|\bd0\b.*\b(detector|collaboration)\b"),
    ("tevatron",            r"\btevatron\b"),

    # HERA
    ("hera-h1",             r"\bh1\b.*\b(collaboration|detector|experiment|data)\b|\bh1 collaboration\b"),
    ("hera-zeus",           r"\bzeus\b.*\b(collaboration|detector|experiment|data)\b|\bzeus collaboration\b"),
    ("hera",                r"\bhera\b.*\b(collider|data|electron)\b"),

    # B-factories
    ("belle-experiment",    r"\bbelle\b.*\b(collaboration|experiment|detector|ii)\b|\bbelle collaboration\b|\bbelle ii\b"),
    ("babar-experiment",    r"\bbabar\b.*\b(collaboration|experiment|detector)\b|\bbabar collaboration\b"),
    ("kekb",                r"\bkekb\b|\bkek\b.*\b(b.factory|accelerator)\b"),

    # LEP experiments
    ("lep-delphi",          r"\bdelphi\b.*\b(collaboration|detector|experiment)\b"),
    ("lep-opal",            r"\bopal\b.*\b(collaboration|detector|experiment)\b"),
    ("lep-aleph",           r"\baleph\b.*\b(collaboration|detector|experiment)\b"),
    ("lep-l3",              r"\bl3\b.*\b(collaboration|detector|experiment)\b"),
    ("lep",                 r"\blep\b.*\b(collider|data|electron.positron)\b|\blarge electron.positron\b"),

    # Neutrino experiments
    ("super-kamiokande",    r"\bsuper.?kamiokande\b|\bsuper.?k\b|\bkamiokande\b"),
    ("miniboone",           r"\bminiboone\b|\bmini.?boone\b"),
    ("icecube",             r"\bicecube\b|\bice.?cube\b"),
    ("sno",                 r"\bsno\b.*\b(collaboration|detector|experiment)\b|\bsudbury neutrino\b"),
    ("t2k",                 r"\bt2k\b.*\b(experiment|collaboration)\b"),
    ("nova-neutrino",       r"\bnova\b.*\b(experiment|collaboration|detector)\b|\bno.?va\b.*neutrino"),
    ("dune",                r"\bdune\b.*\b(experiment|detector|collaboration)\b|\bdeep underground neutrino\b"),
    ("double-chooz",        r"\bdouble.?chooz\b"),
    ("daya-bay",            r"\bdaya.?bay\b"),
    ("borexino",            r"\bborexino\b"),
    ("antares",             r"\bantares\b.*\b(telescope|detector|neutrino)\b"),
    ("minos",               r"\bminos\b.*\b(experiment|collaboration|detector)\b"),

    # Heavy ion experiments
    ("rhic-star",           r"\bstar\b.*\b(collaboration|detector|experiment)\b.*\brhic\b|\bstar collaboration\b"),
    ("rhic-phenix",         r"\bphenix\b.*\b(collaboration|detector|experiment)\b"),
    ("rhic",                r"\brhic\b"),

    # Fixed target / other
    ("na62",                r"\bna62\b"),
    ("na48-na49",           r"\bna4[89]\b"),
    ("compass",             r"\bcompass\b.*\b(collaboration|experiment|detector)\b"),
    ("lhc-forward",         r"\blhcf\b|\btotem\b"),
    ("fermilab-fixed",      r"\bfermilab\b.*\b(fixed.target|test.beam)\b"),

    # Dark matter direct detection experiments
    ("xenon-dm",            r"\bxenon\b.*\b(collaboration|detector|experiment|1t|nt)\b|\bxenon1t\b|\bxenonnt\b"),
    ("lux-dm",              r"\blux\b.*\b(collaboration|detector|experiment|zeplin)\b|\blux.zeplin\b|\blz\b.*dark"),
    ("pandax-dm",           r"\bpandax\b"),
    ("cdms-dm",             r"\bcdms\b|\bsupercdms\b"),
    ("admx-axion",          r"\badmx\b"),

    # Gravitational wave detectors
    ("ligo-gw",             r"\bligo\b|\bvirgo\b.*\b(detector|collaboration)\b|\bgravitational.wave.*detect"),

    # Cosmic ray / astroparticle
    ("auger-cosmic",        r"\bauger\b.*\b(observatory|collaboration|cosmic)\b|\bpierre auger\b"),
    ("fermi-lat",           r"\bfermi.?lat\b|\bfermi\b.*\bgamma\b"),

    # Space telescopes (for cosmology/astrophysics papers in the DB)
    ("hubble-telescope",    r"\bhubble\b|\bhst\b.*\b(observation|image|survey)\b"),
    ("jwst-telescope",      r"\bjwst\b|\bjames webb\b"),
    ("planck-satellite",    r"\bplanck\b.*\b(satellite|collaboration|data|survey|cmb)\b"),
]

# ── Physics Topics (for papers not matched to specific experiments) ───────

TOPIC_RULES = [
    # Higgs physics
    ("higgs-discovery",     r"\bhiggs\b.*\b(discover|observation of|evidence for)\b"),
    ("higgs-properties",    r"\bhiggs\b.*\b(coupling|mass|width|decay|branching|self.coupling|production)\b"),
    ("higgs-search",        r"\bhiggs\b.*\b(search|hunt|exclusion|limit)\b"),
    ("higgs-boson",         r"\bhiggs boson\b|\bhiggs particle\b"),

    # Top quark
    ("top-quark",           r"\btop quark\b|\bttbar\b|\bt.?tbar\b|\btop.pair\b|\bsingle top\b|\btop.antitop\b"),

    # Electroweak
    ("w-boson",             r"\bw boson\b|\bw.?\+\b|\bw.?mass\b|\bw.?width\b"),
    ("z-boson",             r"\bz boson\b|\bz.?pole\b|\bz.?width\b|\bz.?decay\b"),
    ("electroweak-precision", r"\belectroweak\b.*\b(precision|correction|radiative|mixing)\b|\bweinberg angle\b|\bsin.*theta\b"),
    ("diboson",             r"\bdiboson\b|\bww\b.*\bproduction\b|\bwz\b.*\bproduction\b|\bzz\b.*\bproduction\b"),

    # QCD / Jets
    ("jet-production",      r"\bjet\b.*\b(production|cross.section|multiplicity|substructure)\b|\bdijet\b|\bmultijet\b"),
    ("jet-substructure",    r"\bjet substructure\b|\bjet grooming\b|\bjet mass\b|\bjet shape\b"),

    # Heavy quarks & exotic hadrons
    ("charmonium",          r"\bcharmonium\b|\bj/psi\b|\bj/\u03c8\b|\bpsi\(2s\)\b|\bchi_c\b|\bupsilon\b"),
    ("bottomonium",         r"\bbottomonium\b|\bupsilon\b|\b\u03a5\b|\bb.?bbar\b"),
    ("tetraquark",          r"\btetraquark\b|\bfour.quark\b|\bexotic hadron\b.*\btetra\b|\bz_c\b|\bz_b\b"),
    ("pentaquark",          r"\bpentaquark\b|\bfive.quark\b|\bp_c\b"),
    ("exotic-hadrons",      r"\bexotic\b.*\b(hadron|state|resonance|meson|baryon)\b|\bglueball\b|\bhybrid meson\b"),
    ("quarkonium",          r"\bquarkonium\b|\bheavy quarkonium\b"),

    # B physics
    ("b-meson-cp",          r"\bb meson\b.*\bcp\b|\bcp violation\b.*\bb\b|\bb.?decay\b.*\bcp\b"),
    ("b-meson-decay",       r"\bb meson\b|\bb.?decay\b|\bb.?hadron\b|\bb.?physics\b|\bb.?quark\b.*\bdecay\b"),
    ("charm-physics",       r"\bcharm\b.*\b(meson|baryon|decay|physics|quark)\b|\bd meson\b|\bd.?decay\b"),

    # Kaon physics
    ("kaon-physics",        r"\bkaon\b|\bk meson\b|\bk.?decay\b|\bk.?rare\b|\bk_l\b|\bk_s\b|\bk\+\b.*\bdecay\b"),

    # Pion & light meson physics
    ("pion-physics",        r"\bpion\b|\bpi meson\b|\bpi.?decay\b|\bchiral perturbation\b"),

    # Baryon physics
    ("baryon-spectroscopy", r"\bbaryon\b.*\b(spectroscopy|resonance|excited|spectrum)\b|\blambda_b\b|\bsigma_b\b|\bomega_b\b"),

    # Neutrino topics
    ("neutrino-oscillation", r"\bneutrino oscillat\b|\bneutrino mixing\b|\bpmns\b|\bneutrino mass\b.*\b(hierarchy|ordering)\b"),
    ("neutrino-cross-section", r"\bneutrino\b.*\b(cross.section|interaction|scattering)\b"),
    ("neutrino-mass",       r"\bneutrino mass\b|\bneutrinoless\b|\bdouble beta decay\b|\bmajoran\b"),
    ("sterile-neutrino",    r"\bsterile neutrino\b|\bheavy neutral lepton\b"),
    ("neutrino-astro",      r"\bneutrino\b.*\b(astrophys|solar|atmospheric|supernova|cosmic)\b"),

    # Dark matter
    ("dark-matter-direct",  r"\bdark matter\b.*\b(direct detection|nuclear recoil|scattering|wimp.nucleon)\b"),
    ("dark-matter-collider", r"\bdark matter\b.*\b(collider|lhc|mono.?jet|missing.*energy|invisible)\b"),
    ("dark-matter-indirect", r"\bdark matter\b.*\b(indirect|annihilat|gamma.ray|positron|antiproton)\b"),
    ("dark-matter-model",   r"\bdark matter\b.*\b(model|candidate|relic|wimp|neutralino)\b"),
    ("dark-matter",         r"\bdark matter\b|\bdark energy\b"),

    # SUSY
    ("susy-search",         r"\bsupersymmetr\b.*\b(search|exclusion|limit|signature)\b|\bsusy\b.*\b(search|exclusion|limit)\b"),
    ("susy-spectrum",       r"\bsupersymmetr\b.*\b(spectrum|mass|neutralino|chargino|squark|gluino|slepton)\b|\bsusy\b.*\b(mass|spectrum)\b"),
    ("susy",                r"\bsupersymmetr\b|\bsusy\b|\bsquark\b|\bgluino\b|\bslepton\b|\bneutralino\b|\bchargino\b"),

    # Axion
    ("axion-search",        r"\baxion\b.*\b(search|detect|experiment|limit)\b|\baxion.like\b"),
    ("axion",               r"\baxion\b|\balp\b.*\b(particle|photon|coupling)\b"),

    # Heavy ion / QGP
    ("quark-gluon-plasma",  r"\bquark.gluon plasma\b|\bqgp\b|\bdeconfinement\b|\bheavy.ion collision\b"),
    ("heavy-ion-flow",      r"\belliptic flow\b|\bcollective flow\b|\bazimuthal anisotropy\b|\bflow harmonic\b"),
    ("heavy-ion",           r"\bheavy.ion\b|\bheavy ion\b|\bnucleus.nucleus\b|\bpb.?pb\b|\bau.?au\b"),

    # QCD topics
    ("parton-distribution", r"\bparton distribution\b|\bpdf\b.*\b(fit|extraction|determination)\b|\bstructure function\b|\bdeep inelastic\b"),
    ("fragmentation",       r"\bfragmentation function\b|\bhadronization\b|\bjet fragmentation\b"),
    ("qcd-resummation",     r"\bresummation\b|\bsudakov\b|\bthreshold correction\b|\bsoft.gluon\b"),
    ("nlo-nnlo",            r"\bnlo\b|\bnnlo\b|\bnext.to.leading\b|\bfixed.order\b|\bhigher.order correction\b"),

    # Lattice QCD
    ("lattice-qcd",         r"\blattice qcd\b|\blattice calculation\b|\blattice simulation\b|\blattice gauge\b"),

    # Monte Carlo / event generation
    ("monte-carlo-sim",     r"\bmonte carlo\b|\bevent generat\b|\bpythia\b|\bherwig\b|\bsherpa\b|\bmadgraph\b|\bgeant4\b"),

    # Detector R&D
    ("detector-rd",         r"\bdetector\b.*\b(design|development|r&d|performance|upgrade|commissioning|prototype)\b|\bsilicon tracker\b|\bcalorimeter\b.*\b(design|performance)\b|\breadout\b.*\b(electronics|system)\b"),
    ("accelerator-rd",      r"\baccelerator\b.*\b(design|upgrade|performance|luminosity)\b|\bbeam optics\b|\bbeam dynamics\b"),

    # Cosmic ray
    ("cosmic-ray",          r"\bcosmic ray\b|\bextensive air shower\b|\bultra.high energy cosmic\b"),

    # CMB / cosmological observation
    ("cmb-observation",     r"\bcosmic microwave\b|\bcmb\b.*\b(anisotropy|polarization|power spectrum|observation)\b"),
    ("gravitational-wave",  r"\bgravitational wave\b|\bgravitational.wave\b|\bbinary merger\b|\bcompact binary\b"),

    # Precision measurements
    ("muon-g2",             r"\bmuon.*anomalous\b|\b(g-2|g.2)\b.*\bmuon\b|\bmuon.*magnetic moment\b"),
    ("edm-measurement",     r"\belectric dipole moment\b|\bedm\b.*\b(measurement|search|limit)\b"),
    ("alpha-qed",           r"\bfine.structure constant\b|\balpha.*qed\b|\bprecision qed\b"),

    # Rare decays & BSM searches
    ("rare-decay",          r"\brare decay\b|\bforbidden decay\b|\blepton.flavor violat\b|\bflavor.changing neutral\b|\bfcnc\b"),
    ("bsm-search",         r"\bbeyond.*standard model\b|\bnew physics\b.*\b(search|signal|evidence)\b|\bbsm\b.*\b(search|signal)\b"),
]

# ── Broad fallbacks (for remaining unmatched papers) ──────────────────────

FALLBACK_RULES = [
    ("collider-general",    r"\bcollider\b|\bproton.proton\b|\be\+e\-\b|\belectron.positron\b"),
    ("neutrino-general",    r"\bneutrino\b"),
    ("qcd-general",         r"\bqcd\b|\bquantum chromodynamics\b|\bstrong interaction\b|\bcolor charge\b"),
    ("electroweak-general", r"\belectroweak\b|\bweak interaction\b|\bweak decay\b"),
    ("hadron-general",      r"\bhadron\b|\bmeson\b|\bbaryon\b"),
    ("lepton-general",      r"\blepton\b|\bmuon\b|\btau.*lepton\b|\belectron.*positron\b"),
    ("nuclear-general",     r"\bnuclear\b.*\b(physics|structure|force|matter)\b"),
    ("cosmology-general",   r"\bcosmolog\b|\buniverse\b|\bbig bang\b|\binflation\b"),
    ("astroparticle",       r"\bastroparticle\b|\bcosmic\b|\bgamma.ray burst\b"),
]

# Combine all rules in priority order
ALL_RULES = _compile_rules(DETECTOR_RULES + TOPIC_RULES + FALLBACK_RULES)


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
    if "icon_category" not in cols:
        print("[info] Adding column 'icon_category' to papers")
        conn.execute("ALTER TABLE papers ADD COLUMN icon_category TEXT")
        conn.commit()


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

def classify_icon(title: Optional[str], abstract: Optional[str]) -> Optional[str]:
    """
    Match the paper's title + abstract against keyword rules.
    Returns the first matching category name, or None if no match.
    """
    combined = " ".join(filter(None, [title, abstract]))
    if not combined.strip():
        return None

    for category, pattern in ALL_RULES:
        if pattern.search(combined):
            return category

    return None


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------

def run(db_path: str, reclassify: bool = False):
    conn = open_db(db_path)
    ensure_columns(conn)

    # Only classify experimental and phenomenological papers
    if reclassify:
        rows = conn.execute(
            """SELECT paperId, title, abstract FROM papers
               WHERE paper_nature IN ('experimental', 'phenomenological')"""
        ).fetchall()
        print(f"[info] Classifying all {len(rows)} experimental/phenomenological papers")
    else:
        rows = conn.execute(
            """SELECT paperId, title, abstract FROM papers
               WHERE paper_nature IN ('experimental', 'phenomenological')
               AND (icon_category IS NULL OR icon_category = '')"""
        ).fetchall()
        print(f"[info] Classifying {len(rows)} unclassified experimental/phenomenological papers")

    if not rows:
        print("[info] Nothing to do.")
        conn.close()
        return

    BATCH_SIZE = 5000
    total_updates = 0
    updates = []

    for i, row in enumerate(rows):
        cat = classify_icon(row["title"], row["abstract"])
        updates.append((cat, row["paperId"]))

        if len(updates) >= BATCH_SIZE:
            conn.executemany(
                "UPDATE papers SET icon_category = ? WHERE paperId = ?",
                updates
            )
            conn.commit()
            total_updates += len(updates)
            print(f"  ... committed batch ({total_updates}/{len(rows)})")
            updates = []

    # Final batch
    if updates:
        conn.executemany(
            "UPDATE papers SET icon_category = ? WHERE paperId = ?",
            updates
        )
        conn.commit()
        total_updates += len(updates)

    # Print distribution
    print(f"\n[results] Classified {len(updates)} papers.")
    dist = conn.execute(
        """SELECT icon_category, COUNT(*) AS n FROM papers
           WHERE paper_nature IN ('experimental', 'phenomenological')
           GROUP BY icon_category ORDER BY n DESC"""
    ).fetchall()
    conn.close()

    assigned = 0
    unassigned = 0
    print("\n  Category distribution:")
    for r in dist:
        cat = r['icon_category'] or '(unmatched)'
        n = r['n']
        if r['icon_category']:
            assigned += n
        else:
            unassigned += n
        print(f"    {n:>7}  {cat}")

    total = assigned + unassigned
    print(f"\n  Assigned: {assigned}/{total} ({100*assigned/total:.1f}%)")
    print(f"  Unmatched: {unassigned}/{total} ({100*unassigned/total:.1f}%)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Classify papers into icon categories.")
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
