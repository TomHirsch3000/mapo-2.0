#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
source_category_images.py — Download real images for icon categories from
CERN CDS, NASA Image Library, and Wikimedia Commons.

Downloads candidate images for each icon_category and logs provenance to
image_sources.json for future reference and re-runs.

Usage:
  python source_category_images.py                    # download all
  python source_category_images.py --category atlas-detector  # single category
  python source_category_images.py --gallery          # generate HTML gallery only
  python source_category_images.py --select atlas-detector 2  # select candidate #2
"""

import argparse
import json
import os
import re
import time
from datetime import date
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, urljoin

import requests
from PIL import Image

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
ICONS_DIR = SCRIPT_DIR.parent / "arxiv-3d-frontend" / "public" / "icons" / "categories"
SOURCES_FILE = SCRIPT_DIR / "image_sources.json"
GALLERY_FILE = SCRIPT_DIR / "image_gallery.html"

ICONS_DIR.mkdir(parents=True, exist_ok=True)

# Max candidates to download per category
MAX_CANDIDATES = 5
# Target image size (will resize to this for consistency)
TARGET_SIZE = (512, 512)

# ---------------------------------------------------------------------------
# Category → (api_source, search_query) mapping
# api_source is one of: "cern", "nasa", "wiki"
# ---------------------------------------------------------------------------

CATEGORY_SOURCES = {
    # ── LHC Detectors ─────────────────────────────────────────────────────
    "atlas-detector":       ("cern", "ATLAS detector"),
    "cms-detector":         ("cern", "CMS detector"),
    "lhcb-detector":        ("cern", "LHCb detector"),
    "alice-detector":       ("cern", "ALICE detector"),
    "lhc-forward":          ("cern", "LHC forward TOTEM"),

    # ── Tevatron ──────────────────────────────────────────────────────────
    "tevatron":             ("cern", "Tevatron accelerator Fermilab"),
    "tevatron-cdf":         ("cern", "CDF detector Tevatron"),
    "tevatron-d0":          ("cern", "D0 detector Tevatron"),

    # ── HERA ──────────────────────────────────────────────────────────────
    "hera":                 ("wiki", "HERA particle accelerator DESY"),
    "hera-h1":              ("wiki", "H1 detector HERA"),
    "hera-zeus":            ("wiki", "ZEUS detector HERA"),

    # ── B-Factories ───────────────────────────────────────────────────────
    "belle-experiment":     ("wiki", "Belle experiment KEK"),
    "babar-experiment":     ("wiki", "BaBar detector SLAC"),
    "kekb":                 ("wiki", "KEKB accelerator KEK"),

    # ── LEP ───────────────────────────────────────────────────────────────
    "lep":                  ("cern", "LEP collider tunnel"),
    "lep-delphi":           ("cern", "DELPHI detector LEP"),
    "lep-opal":             ("cern", "OPAL detector LEP"),
    "lep-aleph":            ("cern", "ALEPH detector LEP"),
    "lep-l3":               ("cern", "L3 detector LEP"),

    # ── Neutrino Experiments ──────────────────────────────────────────────
    "super-kamiokande":     ("wiki", "Super-Kamiokande"),
    "miniboone":            ("wiki", "MiniBooNE detector Fermilab"),
    "icecube":              ("wiki", "IceCube Neutrino Observatory"),
    "sno":                  ("wiki", "Sudbury Neutrino Observatory"),
    "t2k":                  ("wiki", "T2K experiment Japan"),
    "nova-neutrino":        ("wiki", "NOvA detector Fermilab"),
    "dune":                 ("wiki", "DUNE experiment neutrino"),
    "double-chooz":         ("wiki", "Double Chooz reactor neutrino"),
    "daya-bay":             ("wiki", "Daya Bay reactor neutrino experiment"),
    "borexino":             ("wiki", "Borexino detector Gran Sasso"),
    "antares":              ("wiki", "ANTARES neutrino telescope"),
    "minos":                ("wiki", "MINOS detector Fermilab"),

    # ── Heavy Ion / RHIC ──────────────────────────────────────────────────
    "rhic":                 ("wiki", "RHIC Brookhaven accelerator"),
    "rhic-star":            ("wiki", "STAR detector RHIC"),
    "rhic-phenix":          ("wiki", "PHENIX detector RHIC"),
    "heavy-ion":            ("cern", "heavy ion collision ALICE"),
    "heavy-ion-flow":       ("cern", "elliptic flow heavy ion"),
    "quark-gluon-plasma":   ("cern", "quark gluon plasma"),

    # ── Fixed Target / Other ──────────────────────────────────────────────
    "na62":                 ("cern", "NA62 experiment"),
    "na48-na49":            ("cern", "NA48 experiment"),
    "compass":              ("cern", "COMPASS experiment"),
    "fermilab-fixed":       ("wiki", "Fermilab accelerator complex"),

    # ── Dark Matter Experiments ───────────────────────────────────────────
    "xenon-dm":             ("wiki", "XENON dark matter detector"),
    "lux-dm":               ("wiki", "LUX-ZEPLIN dark matter"),
    "pandax-dm":            ("wiki", "PandaX dark matter experiment"),
    "cdms-dm":              ("wiki", "CDMS dark matter detector"),
    "admx-axion":           ("wiki", "ADMX axion experiment"),
    "dark-matter":          ("wiki", "dark matter galaxy rotation curve"),
    "dark-matter-direct":   ("wiki", "dark matter direct detection underground"),
    "dark-matter-indirect": ("wiki", "dark matter indirect detection gamma ray"),
    "dark-matter-collider": ("cern", "dark matter search CMS"),
    "dark-matter-model":    ("wiki", "dark matter WIMP diagram"),

    # ── Gravitational Waves / Cosmic ──────────────────────────────────────
    "ligo-gw":              ("nasa", "LIGO gravitational wave"),
    "gravitational-wave":   ("nasa", "gravitational wave merger"),
    "auger-cosmic":         ("wiki", "Pierre Auger Observatory cosmic ray"),
    "cosmic-ray":           ("wiki", "cosmic ray air shower"),
    "fermi-lat":            ("nasa", "Fermi gamma ray telescope"),

    # ── Space Telescopes / Cosmology ──────────────────────────────────────
    "hubble-telescope":     ("nasa", "Hubble Space Telescope deep field"),
    "jwst-telescope":       ("nasa", "James Webb Space Telescope galaxy"),
    "planck-satellite":     ("nasa", "Planck cosmic microwave background"),
    "cmb-observation":      ("nasa", "cosmic microwave background map"),
    "cosmology-general":    ("nasa", "universe cosmic web"),
    "astroparticle":        ("nasa", "astroparticle cosmic ray"),

    # ── Higgs Physics ─────────────────────────────────────────────────────
    "higgs-boson":          ("cern", "Higgs boson event display"),
    "higgs-discovery":      ("cern", "Higgs boson discovery 2012"),
    "higgs-properties":     ("cern", "Higgs boson decay channel"),
    "higgs-search":         ("cern", "Higgs boson search exclusion"),

    # ── Electroweak ───────────────────────────────────────────────────────
    "top-quark":            ("cern", "top quark event display"),
    "w-boson":              ("cern", "W boson event display"),
    "z-boson":              ("cern", "Z boson event display"),
    "electroweak-precision":("cern", "electroweak precision measurement"),
    "electroweak-general":  ("wiki", "electroweak interaction diagram"),
    "diboson":              ("cern", "diboson production event"),

    # ── QCD / Jets ────────────────────────────────────────────────────────
    "jet-production":       ("cern", "jet event display proton collision"),
    "jet-substructure":     ("cern", "jet substructure event display"),
    "qcd-general":          ("wiki", "quantum chromodynamics Feynman diagram"),
    "qcd-resummation":      ("wiki", "QCD resummation soft gluon"),
    "parton-distribution":  ("wiki", "parton distribution function plot"),
    "fragmentation":        ("wiki", "hadronization fragmentation diagram"),
    "nlo-nnlo":             ("wiki", "next-to-leading order Feynman diagram"),
    "lattice-qcd":          ("wiki", "lattice QCD simulation gauge field"),
    "monte-carlo-sim":      ("wiki", "Monte Carlo event generator particle physics"),

    # ── Heavy Quarks & Exotic Hadrons ─────────────────────────────────────
    "charmonium":           ("wiki", "charmonium J/psi spectrum"),
    "bottomonium":          ("wiki", "bottomonium upsilon spectrum"),
    "quarkonium":           ("wiki", "quarkonium spectroscopy"),
    "tetraquark":           ("wiki", "tetraquark exotic hadron"),
    "pentaquark":           ("wiki", "pentaquark LHCb"),
    "exotic-hadrons":       ("wiki", "exotic hadron spectroscopy"),
    "charm-physics":        ("wiki", "charm quark D meson"),

    # ── B/Kaon/Pion Physics ───────────────────────────────────────────────
    "b-meson-decay":        ("wiki", "B meson decay diagram"),
    "b-meson-cp":           ("wiki", "CP violation B meson"),
    "kaon-physics":         ("wiki", "kaon decay particle physics"),
    "pion-physics":         ("wiki", "pion particle physics"),

    # ── Baryon / Hadron / Lepton ──────────────────────────────────────────
    "baryon-spectroscopy":  ("wiki", "baryon spectroscopy resonance"),
    "hadron-general":       ("wiki", "hadron quark model"),
    "lepton-general":       ("wiki", "lepton particle physics"),
    "nuclear-general":      ("wiki", "nuclear physics structure"),

    # ── Neutrino Topics ───────────────────────────────────────────────────
    "neutrino-general":     ("wiki", "neutrino particle physics"),
    "neutrino-oscillation": ("wiki", "neutrino oscillation diagram"),
    "neutrino-cross-section":("wiki", "neutrino cross section measurement"),
    "neutrino-mass":        ("wiki", "neutrino mass hierarchy diagram"),
    "neutrino-astro":       ("wiki", "neutrino astronomy solar"),
    "sterile-neutrino":     ("wiki", "sterile neutrino diagram"),

    # ── SUSY ──────────────────────────────────────────────────────────────
    "susy":                 ("wiki", "supersymmetry particle spectrum"),
    "susy-search":          ("cern", "supersymmetry search CMS ATLAS"),
    "susy-spectrum":        ("wiki", "supersymmetry mass spectrum MSSM"),

    # ── BSM / Rare ────────────────────────────────────────────────────────
    "bsm-search":           ("cern", "beyond standard model search"),
    "rare-decay":           ("wiki", "rare decay flavor changing neutral current"),
    "axion":                ("wiki", "axion particle physics"),
    "axion-search":         ("wiki", "axion search experiment helioscope"),

    # ── Precision Measurements ────────────────────────────────────────────
    "muon-g2":              ("wiki", "muon g-2 experiment Fermilab"),
    "edm-measurement":      ("wiki", "electric dipole moment measurement"),
    "alpha-qed":            ("wiki", "fine structure constant QED"),

    # ── Detector / Accelerator R&D ────────────────────────────────────────
    "detector-rd":          ("cern", "particle detector development silicon"),
    "accelerator-rd":       ("cern", "accelerator technology CERN"),

    # ── Collider General ──────────────────────────────────────────────────
    "collider-general":     ("cern", "proton proton collision event display"),
}

# Verify all DB categories are mapped
_ALL_DB_CATEGORIES = [
    "atlas-detector", "pion-physics", "qcd-general", "cms-detector",
    "lattice-qcd", "higgs-properties", "hadron-general", "lhcb-detector",
    "collider-general", "parton-distribution", "tevatron-cdf", "monte-carlo-sim",
    "alice-detector", "belle-experiment", "nlo-nnlo", "tevatron", "charmonium",
    "jet-production", "rhic", "kaon-physics", "super-kamiokande", "charm-physics",
    "heavy-ion", "top-quark", "lepton-general", "quark-gluon-plasma",
    "neutrino-general", "neutrino-cross-section", "tevatron-d0", "qcd-resummation",
    "babar-experiment", "detector-rd", "neutrino-mass", "higgs-boson", "miniboone",
    "dark-matter", "tetraquark", "exotic-hadrons", "electroweak-precision",
    "icecube", "susy", "neutrino-oscillation", "electroweak-general",
    "b-meson-decay", "hera", "na48-na49", "baryon-spectroscopy", "na62",
    "dark-matter-model", "bsm-search", "fragmentation", "accelerator-rd",
    "rhic-star", "hera-h1", "quarkonium", "neutrino-astro", "dark-matter-direct",
    "dark-matter-collider", "w-boson", "nuclear-general", "lep", "xenon-dm",
    "hera-zeus", "z-boson", "pentaquark", "higgs-discovery", "planck-satellite",
    "rhic-phenix", "hubble-telescope", "b-meson-cp", "bottomonium", "lep-opal",
    "auger-cosmic", "muon-g2", "daya-bay", "axion", "compass", "dune",
    "lhc-forward", "rare-decay", "ligo-gw", "axion-search", "cosmic-ray",
    "nova-neutrino", "higgs-search", "lep-delphi", "dark-matter-indirect",
    "fermi-lat", "cosmology-general", "diboson", "t2k", "heavy-ion-flow",
    "lep-aleph", "sterile-neutrino", "lep-l3", "astroparticle", "minos",
    "fermilab-fixed", "kekb", "cdms-dm", "cmb-observation", "susy-spectrum",
    "antares", "borexino", "edm-measurement", "double-chooz", "jet-substructure",
    "sno", "susy-search", "lux-dm", "alpha-qed", "gravitational-wave",
    "pandax-dm", "admx-axion", "jwst-telescope",
]
_unmapped = [c for c in _ALL_DB_CATEGORIES if c not in CATEGORY_SOURCES]
if _unmapped:
    print(f"[WARNING] {len(_unmapped)} categories not mapped: {_unmapped}")


# ---------------------------------------------------------------------------
# API Fetchers — each returns list of dicts:
#   [{"url": image_url, "title": description, "source_url": page_url, "license": str}]
# ---------------------------------------------------------------------------

def fetch_cern(query: str, limit: int = MAX_CANDIDATES) -> list:
    """Search CERN CDS for photos matching query.
    Falls back to Wikimedia Commons if CERN API fails."""
    results = []
    try:
        # Try the CERN CDS JSON API
        url = "https://cds.cern.ch/search"
        params = {
            "p": query,
            "of": "recjson",
            "rg": limit * 3,
        }
        headers = {"User-Agent": "MapoProject/1.0 (tom.hirsch3000@gmail.com)"}
        resp = requests.get(url, params=params, timeout=30, headers=headers)

        if resp.status_code == 403:
            # CERN API blocked, fall back to Wikimedia
            print(f"    [info] CERN API returned 403, falling back to Wikimedia...")
            return fetch_wikimedia(query + " CERN", limit)

        resp.raise_for_status()
        records = resp.json()

        for rec in records[:limit * 3]:
            if len(results) >= limit:
                break
            rec_id = rec.get("recid")
            if not rec_id:
                continue

            title = ""
            if isinstance(rec.get("title"), dict):
                title = rec["title"].get("title", "")
            elif isinstance(rec.get("title"), list) and rec["title"]:
                title = rec["title"][0].get("title", "") if isinstance(rec["title"][0], dict) else str(rec["title"][0])
            elif isinstance(rec.get("title"), str):
                title = rec["title"]

            # Look for image URLs in various record fields
            image_url = None
            for field_name in ["url", "files", "FFT"]:
                field = rec.get(field_name, [])
                if not isinstance(field, list):
                    field = [field]
                for item in field:
                    if isinstance(item, dict):
                        u = item.get("url", "") or item.get("u", "")
                        if u and any(u.lower().endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".gif"]):
                            image_url = u
                            break
                if image_url:
                    break

            if not image_url:
                continue  # Skip records without downloadable images

            if not image_url.startswith("http"):
                image_url = f"https://cds.cern.ch{image_url}"

            results.append({
                "url": image_url,
                "title": title or f"CERN record {rec_id}",
                "source_url": f"https://cds.cern.ch/record/{rec_id}",
                "license": "CERN-copyright / CC-BY-SA-4.0",
            })

    except Exception as e:
        print(f"    [error] CERN API: {e}")
        # Fall back to Wikimedia
        print(f"    [info] Falling back to Wikimedia...")
        return fetch_wikimedia(query + " CERN", limit)

    if not results:
        # No image results from CERN, fall back to Wikimedia
        print(f"    [info] No CERN image results, falling back to Wikimedia...")
        return fetch_wikimedia(query + " CERN", limit)

    return results[:limit]


def fetch_nasa(query: str, limit: int = MAX_CANDIDATES) -> list:
    """Search NASA Image and Video Library."""
    results = []
    try:
        url = "https://images-api.nasa.gov/search"
        params = {"q": query, "media_type": "image"}
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        items = data.get("collection", {}).get("items", [])
        for item in items[:limit]:
            item_data = item.get("data", [{}])[0]
            nasa_id = item_data.get("nasa_id", "")
            title = item_data.get("title", "")
            desc = item_data.get("description", "")

            # Get image URL from links — use preview (thumb) directly
            links = item.get("links", [])
            image_url = None
            for link in links:
                if link.get("rel") == "preview" and link.get("render") == "image":
                    image_url = link.get("href", "")
                    break
            if not image_url:
                for link in links:
                    href = link.get("href", "")
                    if href and any(href.lower().endswith(e) for e in [".jpg", ".jpeg", ".png"]):
                        image_url = href
                        break

            results.append({
                "url": image_url,
                "title": title,
                "source_url": f"https://images.nasa.gov/details/{nasa_id}",
                "license": "NASA / Public Domain",
            })

    except Exception as e:
        print(f"    [error] NASA API: {e}")

    return results[:limit]


def fetch_wikimedia(query: str, limit: int = MAX_CANDIDATES) -> list:
    """Search Wikimedia Commons for freely-licensed images."""
    results = []
    try:
        # Step 1: Search for files
        url = "https://commons.wikimedia.org/w/api.php"
        params = {
            "action": "query",
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": "6",  # File namespace
            "gsrlimit": str(limit * 2),
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": "512",
            "format": "json",
        }
        resp = requests.get(url, params=params, timeout=30,
                           headers={"User-Agent": "MapoProject/1.0 (tom.hirsch3000@gmail.com)"})
        resp.raise_for_status()
        data = resp.json()

        pages = data.get("query", {}).get("pages", {})
        if not pages:
            return results

        for page_id, page in pages.items():
            if len(results) >= limit:
                break
            if page_id == "-1":
                continue
            ii = page.get("imageinfo", [{}])[0]
            image_url = ii.get("thumburl") or ii.get("url")
            desc_url = ii.get("descriptionurl", "")

            # Only include actual image files (check case-insensitively)
            if image_url:
                license_info = "Wikimedia Commons"
                extmeta = ii.get("extmetadata", {})
                if "LicenseShortName" in extmeta:
                    license_info = extmeta["LicenseShortName"].get("value", license_info)

                results.append({
                    "url": image_url,
                    "title": page.get("title", "").replace("File:", ""),
                    "source_url": desc_url,
                    "license": license_info,
                })

    except Exception as e:
        print(f"    [error] Wikimedia API: {e}")

    return results[:limit]


FETCHERS = {
    "cern": fetch_cern,
    "nasa": fetch_nasa,
    "wiki": fetch_wikimedia,
}


# ---------------------------------------------------------------------------
# Image download & resize
# ---------------------------------------------------------------------------

def download_and_save(url: str, save_path: Path) -> bool:
    """Download image from URL, resize to TARGET_SIZE, save as JPEG."""
    try:
        resp = requests.get(url, timeout=30, stream=True,
                           headers={"User-Agent": "MapoProject/1.0 (tom.hirsch3000@gmail.com)"})
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "")
        if "html" in content_type.lower():
            # Got an HTML page instead of an image
            return False

        img = Image.open(BytesIO(resp.content))
        img = img.convert("RGB")
        img = img.resize(TARGET_SIZE, Image.LANCZOS)
        img.save(str(save_path), "JPEG", quality=85)
        return True
    except Exception as e:
        print(f"    [error] Download failed for {url}: {e}")
        return False


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def load_sources() -> dict:
    """Load existing image_sources.json or return empty dict."""
    if SOURCES_FILE.exists():
        with open(SOURCES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_sources(sources: dict):
    """Save image_sources.json."""
    with open(SOURCES_FILE, "w", encoding="utf-8") as f:
        json.dump(sources, f, indent=2, ensure_ascii=False)


def fetch_category(category: str, sources: dict):
    """Fetch candidate images for a single category."""
    if category not in CATEGORY_SOURCES:
        print(f"  [skip] {category} — no source mapping defined")
        return

    api, query = CATEGORY_SOURCES[category]
    fetcher = FETCHERS[api]

    print(f"  [{api}] {category}: searching '{query}'...")
    results = fetcher(query)

    if not results:
        print(f"    [warn] No results for {category}")
        return

    candidates = []
    for i, result in enumerate(results):
        if not result["url"]:
            continue
        filename = f"{category}_candidate_{i}.jpg"
        save_path = ICONS_DIR / filename

        print(f"    Downloading candidate {i}: {result['title'][:60]}...")
        if download_and_save(result["url"], save_path):
            candidates.append({
                "filename": filename,
                "source_url": result["source_url"],
                "title": result["title"],
                "license": result["license"],
                "original_url": result["url"],
            })
        time.sleep(0.5)  # Be polite to APIs

    sources[category] = {
        "api": api,
        "query": query,
        "candidates": candidates,
        "selected": None,
        "fetched_date": str(date.today()),
    }

    print(f"    -> {len(candidates)} candidates downloaded")


def generate_gallery(sources: dict):
    """Generate an HTML gallery page for reviewing candidates."""
    html = ["""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Icon Category Gallery</title>
<style>
  body { font-family: sans-serif; background: #1a1a2e; color: #eee; margin: 20px; }
  h1 { color: #e94560; }
  .category { margin: 20px 0; padding: 15px; background: #16213e; border-radius: 8px; }
  .category h2 { margin: 0 0 5px; color: #0f3460; font-size: 16px; color: #e94560; }
  .category .meta { font-size: 12px; color: #888; margin-bottom: 10px; }
  .candidates { display: flex; gap: 10px; flex-wrap: wrap; }
  .candidate { text-align: center; cursor: pointer; border: 3px solid transparent; border-radius: 8px; padding: 5px; }
  .candidate:hover { border-color: #e94560; }
  .candidate.selected { border-color: #0f3460; background: #0a1929; }
  .candidate img { width: 150px; height: 150px; object-fit: cover; border-radius: 4px; }
  .candidate .label { font-size: 11px; color: #aaa; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .no-candidates { color: #e94560; font-style: italic; }
</style></head><body>
<h1>Icon Category Image Gallery</h1>
<p>Click a candidate to select it. Total categories: """ + str(len(sources)) + """</p>
"""]

    for cat, data in sorted(sources.items()):
        selected = data.get("selected", "")
        html.append(f'<div class="category" id="{cat}">')
        html.append(f'  <h2>{cat}</h2>')
        html.append(f'  <div class="meta">API: {data["api"]} | Query: "{data["query"]}" | Fetched: {data.get("fetched_date", "?")}</div>')

        candidates = data.get("candidates", [])
        if not candidates:
            html.append('  <div class="no-candidates">No candidates downloaded</div>')
        else:
            html.append('  <div class="candidates">')
            for c in candidates:
                sel_class = " selected" if c["filename"] == selected else ""
                img_path = f"../arxiv-3d-frontend/public/icons/categories/{c['filename']}"
                html.append(f'    <div class="candidate{sel_class}" onclick="alert(\'Select: {c["filename"]}\')">')
                html.append(f'      <img src="{img_path}" alt="{c["title"]}">')
                html.append(f'      <div class="label">{c["title"][:40]}</div>')
                html.append(f'      <div class="label">{c["license"]}</div>')
                html.append(f'    </div>')
            html.append('  </div>')

        html.append('</div>')

    html.append("</body></html>")

    with open(GALLERY_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(html))
    print(f"\n[info] Gallery saved to {GALLERY_FILE}")


def select_candidate(category: str, candidate_index: int, sources: dict):
    """Select a candidate image and copy it as the final icon."""
    if category not in sources:
        print(f"[error] Category '{category}' not found in image_sources.json")
        return

    candidates = sources[category].get("candidates", [])
    if candidate_index >= len(candidates):
        print(f"[error] Candidate index {candidate_index} out of range (max {len(candidates) - 1})")
        return

    candidate = candidates[candidate_index]
    src = ICONS_DIR / candidate["filename"]
    dst = ICONS_DIR / f"{category}.jpg"

    if not src.exists():
        print(f"[error] Source file not found: {src}")
        return

    # Copy the candidate as the final selected image
    import shutil
    shutil.copy2(str(src), str(dst))

    sources[category]["selected"] = f"{category}.jpg"
    save_sources(sources)
    print(f"[done] Selected candidate {candidate_index} for {category} → {dst.name}")


def run(categories: list = None, gallery_only: bool = False):
    sources = load_sources()

    if gallery_only:
        generate_gallery(sources)
        return

    targets = categories or list(CATEGORY_SOURCES.keys())
    total = len(targets)

    for i, cat in enumerate(targets, 1):
        # Skip if already fetched (unless explicitly re-requesting)
        if cat in sources and sources[cat].get("candidates") and categories is None:
            print(f"[{i}/{total}] {cat} — already fetched, skipping (use --category to re-fetch)")
            continue

        print(f"[{i}/{total}] Fetching {cat}...")
        fetch_category(cat, sources)
        save_sources(sources)  # Save after each category for resume support
        time.sleep(1)  # Rate limiting between categories

    generate_gallery(sources)
    print(f"\n[done] Fetched images for {total} categories.")
    print(f"  Sources log: {SOURCES_FILE}")
    print(f"  Gallery: {GALLERY_FILE}")
    print(f"\nNext steps:")
    print(f"  1. Open {GALLERY_FILE} in a browser to review candidates")
    print(f"  2. Run: python source_category_images.py --select <category> <index>")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Source real images for icon categories.")
    parser.add_argument("--category", type=str, help="Fetch/re-fetch a single category")
    parser.add_argument("--gallery", action="store_true", help="Generate gallery HTML only (no downloads)")
    parser.add_argument("--select", nargs=2, metavar=("CATEGORY", "INDEX"),
                        help="Select candidate N for a category")
    args = parser.parse_args()

    if args.select:
        sources = load_sources()
        select_candidate(args.select[0], int(args.select[1]), sources)
    elif args.category:
        run(categories=[args.category])
    else:
        run(gallery_only=args.gallery)
