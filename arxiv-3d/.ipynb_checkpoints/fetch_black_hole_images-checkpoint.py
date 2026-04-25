#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_black_hole_images.py — Source, verify, and download canonical images
for each black hole narrative chapter.

Strategy (two layers):
  1. Curated manifest — known images per chapter with their Wikimedia Commons
     filename or a manual-download note. These are the definitive visuals you
     want. The script verifies they exist and downloads them.
  2. Wikimedia Commons search — for each chapter, runs a keyword search to
     surface additional candidates you can eyeball in the notebook.

Output:
  images/                   — downloaded image files
  image_manifest.json       — per-chapter image metadata, paths, credits

Usage:
  python fetch_black_hole_images.py
  python fetch_black_hole_images.py --images-dir my_images --search-extras
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from typing import Dict, Any, List, Optional

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"
WIKIMEDIA_THUMB = "https://commons.wikimedia.org/wiki/Special:FilePath/{filename}?width={width}"


# ---------------------------------------------------------------------------
# Curated image manifest
# ---------------------------------------------------------------------------
# Each entry has:
#   chapter_id    — matches fetch_black_holes.py chapter IDs
#   label         — short display label
#   source        — "wikimedia" | "manual"
#   filename      — Wikimedia Commons File: name (if source=="wikimedia")
#   manual_url    — landing page to visit for manual download (if source=="manual")
#   manual_file   — suggested local filename for manual downloads
#   credit        — attribution string to display
#   caption       — one-sentence display caption
#
# All Wikimedia filenames are the exact title after "File:" on Commons.
# ---------------------------------------------------------------------------
CURATED_IMAGES = [
    # -----------------------------------------------------------------------
    # precursor_stellar_theory
    # -----------------------------------------------------------------------
    {
        "chapter_id": "precursor_stellar_theory",
        "label": "Hertzsprung-Russell diagram",
        "source": "wikimedia",
        "filename": "HRDiagram.png",
        "credit": "Richard Powell / CC BY-SA 2.5",
        "caption": "The HR diagram showing stellar evolution paths — the context in which Chandrasekhar realised some stars could not stop collapsing.",
    },
    {
        "chapter_id": "precursor_stellar_theory",
        "label": "White dwarf comparison",
        "source": "wikimedia",
        "filename": "Sirius_A_and_B_Hubble_photo.jpg",
        "credit": "NASA, ESA / Public domain",
        "caption": "Sirius A and its white dwarf companion B — the type of object Chandrasekhar was calculating the mass limit for.",
    },

    # -----------------------------------------------------------------------
    # precursor_redshift
    # -----------------------------------------------------------------------
    {
        "chapter_id": "precursor_redshift",
        "label": "Pound-Rebka experiment",
        "source": "wikimedia",
        "filename": "Gravitational_red-shifting2.png",
        "credit": "Wikimedia Commons / CC BY-SA 3.0",
        "caption": "Diagram of the Pound-Rebka experiment (1959) — the first laboratory confirmation that gravity stretches light towards longer wavelengths.",
    },
    {
        "chapter_id": "precursor_redshift",
        "label": "Gravitational redshift spectrum",
        "source": "wikimedia",
        "filename": "Redshift.svg",
        "credit": "Georg Wiora / CC BY-SA 2.5",
        "caption": "Spectral lines shifted to longer wavelengths by a gravitational field — the observational signature that hinted at extreme gravity near compact objects.",
    },

    # -----------------------------------------------------------------------
    # precursor_quasars
    # -----------------------------------------------------------------------
    {
        "chapter_id": "precursor_quasars",
        "label": "3C 273 optical image",
        "source": "wikimedia",
        "filename": "3C273_quasar.jpg",
        "credit": "ESA/Hubble & NASA / Public domain",
        "caption": "3C 273, the first quasar to have its redshift measured (z=0.158, 1963) — a star-like point outshining entire galaxies.",
    },
    {
        "chapter_id": "precursor_quasars",
        "label": "Quasar jet (M87)",
        "source": "wikimedia",
        "filename": "M87_jet.jpg",
        "credit": "NASA and The Hubble Heritage Team (STScI/AURA) / Public domain",
        "caption": "The relativistic jet of M87, imaged by Hubble — visible evidence of the enormous energy output powered by a supermassive black hole.",
    },

    # -----------------------------------------------------------------------
    # precursor_xray_sky
    # -----------------------------------------------------------------------
    {
        "chapter_id": "precursor_xray_sky",
        "label": "Uhuru satellite",
        "source": "wikimedia",
        "filename": "Uhuru_satellite.jpg",
        "credit": "NASA / Public domain",
        "caption": "The Uhuru satellite (1970) — the first dedicated X-ray astronomy mission, which catalogued 339 X-ray sources including Cygnus X-1.",
    },
    {
        "chapter_id": "precursor_xray_sky",
        "label": "ROSAT all-sky X-ray map",
        "source": "wikimedia",
        "filename": "ROSAT_X-ray_map.gif",
        "credit": "Max Planck Institute for Extraterrestrial Physics / Public domain",
        "caption": "The entire X-ray sky as seen by ROSAT — the bright point sources that demanded compact-object explanations.",
    },

    # -----------------------------------------------------------------------
    # theory_foundation
    # -----------------------------------------------------------------------
    {
        "chapter_id": "theory_foundation",
        "label": "Penrose diagram of a black hole",
        "source": "wikimedia",
        "filename": "Penrose_diagram_of_black_hole.svg",
        "credit": "Wikimedia Commons / CC BY-SA 3.0",
        "caption": "A Penrose-Carter conformal diagram showing the causal structure of a black hole — once inside the event horizon, all future paths lead to the singularity.",
    },
    {
        "chapter_id": "theory_foundation",
        "label": "Schwarzschild geometry embedding",
        "source": "wikimedia",
        "filename": "Spacetime_curvature.png",
        "credit": "NASA / Public domain",
        "caption": "A spatial embedding diagram of the Schwarzschild geometry — the curved 'funnel' that represents spacetime near a non-rotating black hole.",
    },

    # -----------------------------------------------------------------------
    # theory_hawking
    # -----------------------------------------------------------------------
    {
        "chapter_id": "theory_hawking",
        "label": "Hawking radiation diagram",
        "source": "wikimedia",
        "filename": "Hawkingradiation.svg",
        "credit": "Wikimedia Commons / CC BY-SA 3.0",
        "caption": "Particle-antiparticle pairs created near the event horizon — one falls in, one escapes, causing the black hole to slowly evaporate.",
    },
    {
        "chapter_id": "theory_hawking",
        "label": "Stephen Hawking",
        "source": "wikimedia",
        "filename": "Stephen_Hawking.StarChild.jpg",
        "credit": "NASA / Public domain",
        "caption": "Stephen Hawking, whose 1974 paper predicting black hole thermal radiation was one of the most surprising results in theoretical physics.",
    },

    # -----------------------------------------------------------------------
    # evidence_cygnus_x1
    # -----------------------------------------------------------------------
    {
        "chapter_id": "evidence_cygnus_x1",
        "label": "Cygnus X-1 Chandra X-ray image",
        "source": "wikimedia",
        "filename": "Cygnus_X-1.png",
        "credit": "NASA/CXC/M.Weiss / Public domain",
        "caption": "Cygnus X-1 imaged in X-rays by Chandra — the first strong black hole candidate, established through its mass exceeding any possible neutron star.",
    },
    {
        "chapter_id": "evidence_cygnus_x1",
        "label": "Cygnus X-1 system diagram",
        "source": "wikimedia",
        "filename": "Cygnus_X-1_diagram.jpg",
        "credit": "NASA/CXC/M.Weiss / Public domain",
        "caption": "Artist's diagram of the Cygnus X-1 binary system — matter stripped from the blue supergiant HDE 226868 spirals into the black hole, emitting X-rays.",
    },

    # -----------------------------------------------------------------------
    # evidence_sgr_a
    # -----------------------------------------------------------------------
    {
        "chapter_id": "evidence_sgr_a",
        "label": "S2 stellar orbit around Sgr A*",
        "source": "wikimedia",
        "filename": "Galactic_centre_orbits.svg",
        "credit": "Wikimedia Commons / CC BY-SA 4.0",
        "caption": "Orbits of stars near Sagittarius A* mapped over 20 years — the tight ellipses require a four-million solar mass object in a region smaller than our solar system.",
    },
    {
        "chapter_id": "evidence_sgr_a",
        "label": "EHT image of Sgr A*",
        "source": "manual",
        "manual_url": "https://eventhorizontelescope.org/press-release-april-12-2022-astronomers-reveal-first-image-black-hole-heart-our-galaxy",
        "manual_file": "sgr_a_eht_2022.jpg",
        "credit": "EHT Collaboration / CC BY 4.0",
        "caption": "The first direct image of Sgr A*, the black hole at the centre of the Milky Way, released by the Event Horizon Telescope in 2022.",
    },

    # -----------------------------------------------------------------------
    # evidence_agn_accretion
    # -----------------------------------------------------------------------
    {
        "chapter_id": "evidence_agn_accretion",
        "label": "M87 jet (wide field)",
        "source": "wikimedia",
        "filename": "Messier_87_Hubble_WikiSky.jpg",
        "credit": "NASA, ESA, and the Hubble Heritage Team / Public domain",
        "caption": "Galaxy M87 with its famous jet — the visible output of a 6.5-billion solar mass black hole whose shadow was later imaged directly.",
    },
    {
        "chapter_id": "evidence_agn_accretion",
        "label": "Accretion disk artist impression",
        "source": "wikimedia",
        "filename": "Black_hole_accretion_disk.jpg",
        "credit": "NASA/JPL-Caltech / Public domain",
        "caption": "Artist's impression of an accretion disk — matter spiralling into a black hole heats up and emits X-rays, powering AGN across the universe.",
    },

    # -----------------------------------------------------------------------
    # evidence_gravitational_waves
    # -----------------------------------------------------------------------
    {
        "chapter_id": "evidence_gravitational_waves",
        "label": "GW150914 detection waveform",
        "source": "wikimedia",
        "filename": "LIGO_measurement_of_gravitational_waves.svg",
        "credit": "Caltech/MIT/LIGO Lab / CC BY 3.0",
        "caption": "The gravitational wave signal GW150914 detected simultaneously at LIGO Hanford and Livingston on 14 September 2015 — the chirp of two black holes merging.",
    },
    {
        "chapter_id": "evidence_gravitational_waves",
        "label": "LIGO aerial photograph",
        "source": "wikimedia",
        "filename": "LIGO_Hanford_aerial_05.jpg",
        "credit": "Caltech/MIT/LIGO Lab / CC BY-SA 3.0",
        "caption": "LIGO Hanford — one of the two L-shaped interferometers whose 4 km arms can detect a length change 10,000 times smaller than a proton.",
    },

    # -----------------------------------------------------------------------
    # evidence_eht
    # -----------------------------------------------------------------------
    {
        "chapter_id": "evidence_eht",
        "label": "M87* first image",
        "source": "wikimedia",
        "filename": "Black_hole_-_Messier_87_crop_max_res.jpg",
        "credit": "EHT Collaboration / CC BY 4.0",
        "caption": "The first direct image of a black hole shadow — M87*, released 10 April 2019. The bright ring is photons bent around a 6.5-billion solar mass object.",
    },
    {
        "chapter_id": "evidence_eht",
        "label": "Event Horizon Telescope array map",
        "source": "wikimedia",
        "filename": "EHT_2017_Locations.png",
        "credit": "EHT Collaboration / CC BY 4.0",
        "caption": "The eight observatories that formed the Earth-spanning EHT array in 2017 — together they constitute a virtual dish the diameter of Earth.",
    },
]


# ---------------------------------------------------------------------------
# Wikimedia Commons API helpers
# ---------------------------------------------------------------------------
def wm_api(params: Dict[str, Any]) -> Dict[str, Any]:
    params.setdefault("format", "json")
    qs = urllib.parse.urlencode(params, doseq=True)
    url = f"{WIKIMEDIA_API}?{qs}"
    for attempt in range(1, 5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mapo-image-fetcher/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 4:
                time.sleep(2 * attempt)
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < 4:
                time.sleep(2 * attempt)
                continue
            raise
    return {}


def resolve_wikimedia_url(filename: str, width: int = 1200) -> Optional[str]:
    """Return a direct image URL for a Wikimedia Commons filename."""
    data = wm_api({
        "action": "query",
        "titles": f"File:{filename}",
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "iiurlwidth": width,
    })
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        ii = (page.get("imageinfo") or [{}])[0]
        return ii.get("thumburl") or ii.get("url")
    return None


def search_wikimedia(query: str, limit: int = 5) -> List[Dict]:
    """Search Wikimedia Commons for images matching a query."""
    data = wm_api({
        "action": "query",
        "list": "search",
        "srsearch": f"{query} filetype:bitmap|drawing",
        "srnamespace": 6,
        "srlimit": limit,
        "srprop": "snippet|titlesnippet",
    })
    results = []
    for item in (data.get("query") or {}).get("search") or []:
        title = item.get("title", "")
        filename = title.replace("File:", "").strip()
        results.append({
            "filename": filename,
            "snippet": item.get("snippet", "").replace('<span class="searchmatch">', "").replace("</span>", ""),
        })
    return results


def download_file(url: str, dest: Path) -> bool:
    """Download url to dest. Returns True on success."""
    if dest.exists():
        print(f"    already exists: {dest.name}", flush=True)
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mapo-image-fetcher/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        dest.write_bytes(data)
        print(f"    downloaded: {dest.name} ({len(data)//1024} KB)", flush=True)
        return True
    except Exception as e:
        print(f"    [error] could not download {url}: {e}", flush=True)
        return False


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------
def process_curated(images_dir: Path) -> List[Dict]:
    """Resolve and download all curated images. Returns enriched manifest entries."""
    manifest = []

    for entry in CURATED_IMAGES:
        result = dict(entry)
        result["local_path"] = None
        result["resolved_url"] = None

        if entry["source"] == "wikimedia":
            filename = entry["filename"]
            print(f"  [{entry['chapter_id']}] {entry['label']}", flush=True)

            url = resolve_wikimedia_url(filename)
            if not url:
                print(f"    [warn] could not resolve {filename} on Wikimedia", flush=True)
                result["status"] = "unresolved"
            else:
                result["resolved_url"] = url
                ext = Path(filename).suffix or ".jpg"
                safe_name = filename.replace(" ", "_")
                dest = images_dir / safe_name
                ok = download_file(url, dest)
                result["local_path"] = str(dest) if ok else None
                result["status"] = "ok" if ok else "download_failed"

        elif entry["source"] == "manual":
            print(f"  [{entry['chapter_id']}] {entry['label']} — MANUAL DOWNLOAD REQUIRED", flush=True)
            print(f"    Visit: {entry['manual_url']}", flush=True)
            print(f"    Save as: images/{entry['manual_file']}", flush=True)
            dest = images_dir / entry["manual_file"]
            result["local_path"] = str(dest) if dest.exists() else None
            result["status"] = "present" if dest.exists() else "manual_required"

        time.sleep(0.3)
        manifest.append(result)

    return manifest


def run_extra_searches(images_dir: Path) -> Dict[str, List[Dict]]:
    """
    Run Wikimedia searches for each chapter to surface candidates beyond the
    curated set. Returns a dict keyed by chapter_id.
    """
    CHAPTER_SEARCHES = {
        "precursor_stellar_theory": "neutron star stellar collapse astronomy",
        "precursor_redshift": "gravitational redshift spectrum observation",
        "precursor_quasars": "quasar optical spectrum redshift",
        "precursor_xray_sky": "X-ray astronomy satellite telescope",
        "theory_foundation": "black hole event horizon diagram",
        "theory_hawking": "Hawking radiation quantum black hole",
        "evidence_cygnus_x1": "Cygnus X-1 X-ray binary",
        "evidence_sgr_a": "galactic centre infrared stars orbit",
        "evidence_agn_accretion": "active galaxy nucleus accretion disk jet",
        "evidence_gravitational_waves": "gravitational wave LIGO interferometer",
        "evidence_eht": "Event Horizon Telescope M87 shadow",
    }

    extras: Dict[str, List[Dict]] = {}
    for chapter_id, query in CHAPTER_SEARCHES.items():
        print(f"  searching: {chapter_id} ({query!r})", flush=True)
        results = search_wikimedia(query, limit=8)
        for r in results:
            url = resolve_wikimedia_url(r["filename"], width=800)
            r["thumb_url"] = url
        extras[chapter_id] = results
        time.sleep(0.4)

    return extras


def build_output(manifest: List[Dict], extras: Dict[str, List[Dict]], chapters_order: List[str]) -> Dict:
    by_chapter: Dict[str, List[Dict]] = {}
    for entry in manifest:
        cid = entry["chapter_id"]
        by_chapter.setdefault(cid, []).append(entry)

    output = {"chapters": []}
    for cid in chapters_order:
        output["chapters"].append({
            "chapter_id": cid,
            "curated_images": by_chapter.get(cid, []),
            "search_candidates": extras.get(cid, []),
        })
    return output


def print_summary(manifest: List[Dict]):
    ok = sum(1 for e in manifest if e.get("status") == "ok")
    manual = sum(1 for e in manifest if e.get("status") == "manual_required")
    present = sum(1 for e in manifest if e.get("status") == "present")
    failed = sum(1 for e in manifest if e.get("status") in ("unresolved", "download_failed"))

    print(f"\n{'='*60}")
    print(f"  Curated images: {len(manifest)} total")
    print(f"    Downloaded:       {ok}")
    print(f"    Already present:  {present}")
    print(f"    Manual required:  {manual}")
    print(f"    Failed/missing:   {failed}")
    print(f"{'='*60}")

    if manual > 0:
        print("\n  Images requiring manual download:")
        for e in manifest:
            if e.get("status") == "manual_required":
                print(f"    [{e['chapter_id']}] {e['label']}")
                print(f"      → {e.get('manual_url')}")
                print(f"      save as: images/{e.get('manual_file')}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Source and download images for black hole narrative chapters.")
    p.add_argument("--images-dir", default="images", help="Directory to save images (default: images/)")
    p.add_argument("--json-out", default="image_manifest.json", help="Output manifest path")
    p.add_argument("--search-extras", action="store_true",
                   help="Also run Wikimedia searches for extra candidates per chapter")
    p.add_argument("--dry-run", action="store_true",
                   help="Resolve URLs and print plan without downloading")
    args = p.parse_args()

    images_dir = Path(args.images_dir)
    if not args.dry_run:
        images_dir.mkdir(exist_ok=True)

    CHAPTER_ORDER = [e["id"] for e in [
        {"id": "precursor_stellar_theory"},
        {"id": "precursor_redshift"},
        {"id": "precursor_quasars"},
        {"id": "precursor_xray_sky"},
        {"id": "theory_foundation"},
        {"id": "theory_hawking"},
        {"id": "evidence_cygnus_x1"},
        {"id": "evidence_sgr_a"},
        {"id": "evidence_agn_accretion"},
        {"id": "evidence_gravitational_waves"},
        {"id": "evidence_eht"},
    ]]

    print("\n=== Curated images ===", flush=True)
    if args.dry_run:
        for entry in CURATED_IMAGES:
            src = entry.get("filename") or entry.get("manual_file")
            print(f"  [{entry['chapter_id']}] {entry['label']} — {src}")
        manifest = []
    else:
        manifest = process_curated(images_dir)
        print_summary(manifest)

    extras: Dict[str, List[Dict]] = {}
    if args.search_extras and not args.dry_run:
        print("\n=== Wikimedia search candidates ===", flush=True)
        extras = run_extra_searches(images_dir)

    output = build_output(manifest, extras, CHAPTER_ORDER)
    with open(args.json_out, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n[export] image_manifest.json written with {len(manifest)} curated entries")


if __name__ == "__main__":
    main()
