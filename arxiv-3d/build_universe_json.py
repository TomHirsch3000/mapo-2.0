#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
build_universe_json.py — Generate universe.json from galaxy JSON files

Creates a universe view where each galaxy is represented as a node.
Galaxies are positioned around a central focal point.
"""

import argparse
import json
import math
import os
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

OPENALEX_BASE = "https://api.openalex.org"
CONCEPTS_URL = f"{OPENALEX_BASE}/concepts"

def safe_get_json(url: str, params: Dict[str, Any] = None,
                  max_retries: int = 3, base_sleep: float = 1.0) -> Dict[str, Any]:
    """Safely get JSON from a URL with retries."""
    if params:
        qs = urllib.parse.urlencode(params, doseq=True, safe=":,")
        full = f"{url}?{qs}"
    else:
        full = url
        
    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(full, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"[warn] HTTP {e.code} -> retry in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
            # For 404 or other errors, return empty dict or None? 
            # Better to log and return None so we can handle it.
            print(f"[warn] HTTP {e.code} on {full}")
            return {}
        except Exception as e:
            if attempt < max_retries:
                sleep_s = base_sleep * attempt
                print(f"[warn] Error '{e}' -> retry in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
            print(f"[error] Failed to fetch {full}: {e}")
            return {}
    return {}

def get_openalex_metrics(topic_name: str, email: str) -> Dict[str, Any]:
    """
    Get OpenAlex metrics for a topic/field.
    Returns dict with: totalWorksCount, firstPublicationYear, worksByYear (list)
    """
    if not email:
        email = "pool@example.com" # Fallback if not provided
        
    # 1. Resolve topic name to Concept ID
    params = {
        "filter": f"display_name.search:{topic_name}",
        "sort": "relevance_score:desc",
        "per_page": 1,
        "mailto": email,
    }
    
    data = safe_get_json(CONCEPTS_URL, params)
    results = data.get("results", [])
    
    if not results:
        # Try direct search if filter didn't work
        params = {
            "search": topic_name,
            "sort": "relevance_score:desc",
            "per_page": 1,
            "mailto": email,
        }
        data = safe_get_json(CONCEPTS_URL, params)
        results = data.get("results", [])

    if not results:
        print(f"[warn] No OpenAlex concept found for '{topic_name}'")
        return {}

    concept_summary = results[0]
    concept_id_url = concept_summary.get("id") # e.g. https://openalex.org/C123
    if not concept_id_url:
        return {}
        
    concept_id = concept_id_url.split("/")[-1]
    
    # 2. Get metrics via group_by=publication_year
    # This gives us the full history histogram and total count effectively
    works_url = f"{OPENALEX_BASE}/works"
    params = {
        "filter": f"concepts.id:{concept_id}",
        "group_by": "publication_year",
        "mailto": email,
    }
    
    print(f"[info] Fetching history for {topic_name} ({concept_id})...")
    data = safe_get_json(works_url, params)
    
    group_by = data.get("group_by", [])
    
    # Process histogram
    # group_by is list of {key: "YEAR", count: N}
    # Aggregate into decades
    decades_map = {}
    
    total_works = 0
    min_year = None
    
    for entry in group_by:
        try:
            year = int(entry.get("key"))
            count = int(entry.get("count"))
            
            # Decade aggregation
            decade = (year // 10) * 10
            decades_map[decade] = decades_map.get(decade, 0) + count
            
            total_works += count
            
            if min_year is None or year < min_year:
                min_year = year
        except (ValueError, TypeError):
            continue
            
    # Sort by decade
    sorted_decades = sorted(decades_map.items())
    works_by_decade = [{"decade": d, "works_count": c} for d, c in sorted_decades]
    
    # Use total from meta if available, otherwise sum of years
    meta_total = data.get("meta", {}).get("count")
    if meta_total:
        total_works = meta_total

    # --- Decadal Projection (2020s) ---
    current_year = int(time.strftime("%Y"))
    current_decade = (current_year // 10) * 10
    
    if current_decade == 2020:
        # Check if we have data for 2020s
        for entry in works_by_decade:
            if entry["decade"] == 2020:
                # Naive projection: 
                # Years elapsed (inclusive of current year partial? OpenAlex updates fast)
                # Let's say we are in 2026 (based on user context prompt! "2026-02-05")
                # Wait, context says 2026. If year is 2026, we have 2020, 21, 22, 23, 24, 25 full. 2026 partial.
                # So ~6.1 years?
                # Simple math: 10 / (current_year - 2020 + 0.2)
                elapsed = max(1, current_year - 2020 + 0.2)
                factor = 10.0 / elapsed
                
                # Apply projection (conservative)
                projected_val = int(entry["works_count"] * factor * 0.95)
                entry["works_count_projected"] = projected_val
                entry["is_projected"] = True
                entry["original_count"] = entry["works_count"] 
                # Update main count for visual consistency (area chart will use this)
                entry["works_count"] = projected_val
                break

    # --- Fetch Rich Metadata (First & Most Cited) ---
    
    # 1. First Paper
    first_params = {
        "filter": f"concepts.id:{concept_id}",
        "sort": "publication_date:asc",
        # "per_page": 1, # Actually openalex default is 25, 1 is fine
        "per_page": 1,
        "mailto": email
    }
    first_data = safe_get_json(works_url, first_params)
    first_results = first_data.get("results", [])
    first_paper = None
    if first_results:
        w = first_results[0]
        first_paper = {
            "title": w.get("title") or "Untitled",
            "year": w.get("publication_year"),
            "id": w.get("id")
        }
        # Refine min_year if found earlier
        if first_paper["year"] and (min_year is None or first_paper["year"] < min_year):
            min_year = first_paper["year"]

    # 2. Most Cited Paper
    cited_params = {
        "filter": f"concepts.id:{concept_id}",
        "sort": "cited_by_count:desc",
        "per_page": 1,
        "mailto": email
    }
    cited_data = safe_get_json(works_url, cited_params)
    cited_results = cited_data.get("results", [])
    most_cited_paper = None
    if cited_results:
        w = cited_results[0]
        most_cited_paper = {
            "title": w.get("title") or "Untitled",
            "year": w.get("publication_year"),
            "citations": w.get("cited_by_count"),
            "id": w.get("id")
        }

    return {
        "totalWorksCount": total_works,
        "firstPublicationYear": min_year,
        "worksByDecade": works_by_decade,
        "oldestWork": first_paper,
        "mostCitedWork": most_cited_paper,
        "openAlexId": concept_id
    }


def load_galaxy_data(nodes_path: str, metadata_path: str = None) -> Dict[str, Any]:
    """Load galaxy nodes and metadata, return count and metadata."""
    with open(nodes_path, 'r', encoding='utf-8') as f:
        nodes = json.load(f)
    
    node_count = len(nodes) if isinstance(nodes, list) else 0
    
    metadata = {}
    if metadata_path and os.path.exists(metadata_path):
        with open(metadata_path, 'r', encoding='utf-8') as f:
            metadata = json.load(f)
    
    return {
        'nodeCount': node_count,
        'edgeCount': metadata.get('edgeCount', 0) if metadata else 0,
        'metadata': metadata
    }


def generate_universe_nodes(
    galaxies: List[Dict[str, Any]],
    center_distance: float = 300.0,
    layout: str = "spiral"
) -> List[Dict[str, Any]]:
    """
    Generate universe nodes (galaxies) positioned in a meaningful shape.
    
    Args:
        galaxies: List of galaxy info dicts with keys: id, name, nodeCount, nodesFile, edgesFile, metadataFile
        center_distance: Base distance from center for positioning (default: 300.0, closer)
        layout: Layout type - "spiral" (knowledge evolution) or "cluster" (constellation)
    """
    universe_nodes = []
    
    # Calculate global max works for sizing if available
    max_total_works = 0
    for g in galaxies:
        w = g.get('totalWorksCount', 0) or 0
        if w > max_total_works:
            max_total_works = w
            
    if layout == "spiral":
        # Spiral layout: represents growth and evolution of knowledge
        # Uses logarithmic spiral where each galaxy is at different radius
        spiral_tightness = 0.3  # How tight the spiral is (higher = tighter)
        angle_step = (2 * math.pi) / max(len(galaxies), 1)  # Angle between galaxies
        
        for i, galaxy in enumerate(galaxies):
            # Logarithmic spiral: r = a * e^(b*θ)
            # Start closer to center, spiral outward
            angle = i * angle_step * 2  # Multiply by 2 for more rotations
            base_radius = 80  # Minimum distance from center
            radius = base_radius + (center_distance - base_radius) * (i / max(len(galaxies) - 1, 1)) * (1 + spiral_tightness * math.sin(angle * 2))
            
            x = math.cos(angle) * radius
            y = math.sin(angle) * radius
            z = 0  # Keep at same Z level
            
            # Size based on TOTAL works count if available, else local node count
            total_works = galaxy.get('totalWorksCount', 0)
            if total_works and max_total_works > 0:
                # Log scale for size because works count varies wildly (millions vs thousands)
                # min size 20, max size 120
                # log10(1) = 0, log10(100M) = 8
                
                # Avoid log(0)
                val = math.log10(total_works + 1)
                max_val = math.log10(max_total_works + 1)
                
                # Normalize 0..1
                ratio = val / max_val if max_val > 0 else 0
                size = 20.0 + ratio * 100.0
            else:
                # Fallback to local node count
                node_count = galaxy.get('nodeCount', 0)
                base_size = 10.0
                size = base_size + math.sqrt(node_count) * 0.3
                size = min(size, 60.0)  # Cap maximum size
            
            universe_node = {
                'id': galaxy['id'],
                'name': galaxy['name'],
                'type': 'galaxy',
                'nodeCount': galaxy.get('nodeCount', 0),
                'edgeCount': galaxy.get('edgeCount', 0),
                'hasPapers': galaxy.get('hasPapers', True),
                # New metadata
                'totalWorksCount': galaxy.get('totalWorksCount', 0),
                'firstPublicationYear': galaxy.get('firstPublicationYear'),
                'worksByDecade': galaxy.get('worksByDecade', []),
                'oldestWork': galaxy.get('oldestWork'),
                'mostCitedWork': galaxy.get('mostCitedWork'),
                
                'nodesFile': galaxy.get('nodesFile', f"{galaxy['id']}_nodes.json"),
                'edgesFile': galaxy.get('edgesFile', f"{galaxy['id']}_edges.json"),
                'metadataFile': galaxy.get('metadataFile', f"{galaxy['id']}_metadata.json"),
                'position': [x, y, z],
                'size': round(size, 2),
                'angle': round(math.degrees(angle), 2),
                'timeline_y': galaxy.get('timeline_y', 0)
            }
            
            universe_nodes.append(universe_node)
    
    elif layout == "cluster":
        # Cluster/constellation layout: galaxies arranged in an organic cluster
        # Positions based on their size (larger = more central)
        center_x, center_y = 0, 0
        
        # Sort by size to place larger galaxies more centrally
        # Use totalWorksCount if available for sorting order
        sorted_galaxies = sorted(galaxies, key=lambda g: g.get('totalWorksCount', g.get('nodeCount', 0)), reverse=True)
        
        for i, galaxy in enumerate(sorted_galaxies):
            # Size calculation
            total_works = galaxy.get('totalWorksCount', 0)
            if total_works and max_total_works > 0:
                val = math.log10(total_works + 1)
                max_val = math.log10(max_total_works + 1)
                ratio = val / max_val if max_val > 0 else 0
                size = 20.0 + ratio * 100.0
            else:
                node_count = galaxy.get('nodeCount', 0)
                base_size = 10.0
                size = base_size + math.sqrt(node_count) * 0.3
                size = min(size, 60.0)
            
            # Larger galaxies closer to center, smaller ones further out
            # We use index in sorted list for distance
            distance_factor = i / max(len(galaxies), 1) # 0 to nearly 1
            
            # Angle for positioning (avoid overlap)
            angle = (i * 137.508 * math.pi / 180) % (2 * math.pi)  # Golden angle for even distribution
            
            radius = center_distance * (0.3 + distance_factor * 0.7)  # 30% to 100% of center_distance
            
            x = center_x + math.cos(angle) * radius
            y = center_y + math.sin(angle) * radius
            z = 0
            
            universe_node = {
                'id': galaxy['id'],
                'name': galaxy['name'],
                'type': 'galaxy',
                'nodeCount': galaxy.get('nodeCount', 0),
                'edgeCount': galaxy.get('edgeCount', 0),
                'hasPapers': galaxy.get('hasPapers', True),
                'totalWorksCount': galaxy.get('totalWorksCount', 0),
                'firstPublicationYear': galaxy.get('firstPublicationYear'),
                'worksByDecade': galaxy.get('worksByDecade', []),
                'oldestWork': galaxy.get('oldestWork'),
                'mostCitedWork': galaxy.get('mostCitedWork'),
                'nodesFile': galaxy.get('nodesFile', f"{galaxy['id']}_nodes.json"),
                'edgesFile': galaxy.get('edgesFile', f"{galaxy['id']}_edges.json"),
                'metadataFile': galaxy.get('metadataFile', f"{galaxy['id']}_metadata.json"),
                'position': [x, y, z],
                'size': round(size, 2),
                'angle': round(math.degrees(angle), 2),
                'timeline_y': galaxy.get('timeline_y', 0)
            }
            
            universe_nodes.append(universe_node)
    
    else:
        # Fallback to circular arrangement (closer together)
        angle_step = (2 * math.pi) / len(galaxies) if len(galaxies) > 0 else 0
        
        for i, galaxy in enumerate(galaxies):
            angle = i * angle_step
            x = math.cos(angle) * center_distance
            y = math.sin(angle) * center_distance
            z = 0
            
            # Size calc
            total_works = galaxy.get('totalWorksCount', 0)
            if total_works and max_total_works > 0:
                val = math.log10(total_works + 1)
                max_val = math.log10(max_total_works + 1)
                ratio = val / max_val if max_val > 0 else 0
                size = 20.0 + ratio * 100.0
            else:
                node_count = galaxy.get('nodeCount', 0)
                base_size = 10.0
                size = base_size + math.sqrt(node_count) * 0.3
                size = min(size, 60.0)

            universe_node = {
                'id': galaxy['id'],
                'name': galaxy['name'],
                'type': 'galaxy',
                'nodeCount': galaxy.get('nodeCount', 0),
                'edgeCount': galaxy.get('edgeCount', 0),
                'totalWorksCount': galaxy.get('totalWorksCount', 0),
                'totalCitations': galaxy.get('totalCitations', 0), # New field
                'firstPublicationYear': galaxy.get('firstPublicationYear'),
                'worksByDecade': galaxy.get('worksByDecade', []),
                'nodesFile': galaxy.get('nodesFile', f"{galaxy['id']}_nodes.json"),
                'edgesFile': galaxy.get('edgesFile', f"{galaxy['id']}_edges.json"),
                'metadataFile': galaxy.get('metadataFile', f"{galaxy['id']}_metadata.json"),
                'position': [x, y, z],
                'size': round(size, 2),
                'angle': round(math.degrees(angle), 2),
                'timeline_y': galaxy.get('timeline_y', 0)
            }
            
            universe_nodes.append(universe_node)
    
    return universe_nodes


    return universe_nodes

PHYSICS_CONCEPT_ID = "C121332964"

# Hardcoded list since API filtering by ancestor seems unreliable
PHYSICS_SUBFIELDS_NAMES = [
    "Quantum mechanics",
    "Astrophysics",
    "Condensed matter physics",
    "Particle physics",
    "Nuclear physics",
    "Atomic physics", 
    "Optical physics", # Optics
    "Classical mechanics",
    "Thermodynamics",
    "Acoustics",
    "Biophysics",
    "Geophysics",
    "Statistical mechanics",
    "Fluid dynamics",
    "Plasma physics",
    "Computational physics",
    "Theoretical physics"
]

def fetch_physics_subfields(email: str) -> List[Dict[str, Any]]:
    """Fetch specific Level 1 physics concepts by name."""
    subfields = []
    
    print(f"[info] Fetching {len(PHYSICS_SUBFIELDS_NAMES)} physics subfields individually...")
    
    for name in PHYSICS_SUBFIELDS_NAMES:
        # Search for exact name match at level 1
        url = f"{OPENALEX_BASE}/concepts"
        params = {
            "filter": f"display_name.search:{name},level:1",
            "per_page": 1,
            "mailto": email
        }
        
        try:
            data = safe_get_json(url, params)
            results = data.get("results", [])
            
            if results:
                r = results[0]
                # Basic validation: check if name is close match?
                # OpenAlex search is fuzzy, but usually top result is good for specific terms
                print(f"  [+] Found: {r['display_name']} ({r['id']})")
                subfields.append({
                    "id": r.get("id", "").split("/")[-1],
                    "display_name": r.get("display_name"),
                    "description": r.get("description"),
                    "works_count": r.get("works_count", 0),
                    "cited_by_count": r.get("cited_by_count", 0) # Capture citations
                })
            else:
                print(f"  [-] Not found: {name}")
                
            time.sleep(0.1) # Polite delay
        except Exception as e:
            print(f"  [!] Error fetching {name}: {e}")
            
    print(f"[info] Found {len(subfields)} valid physics subfields.")
    return subfields

def main():
    parser = argparse.ArgumentParser(description="Generate universe.json from galaxy data")
    parser.add_argument("--galaxies", nargs="+", help="Galaxy definitions in format id:name:nodesFile:edgesFile:metadataFile", default=[])
    parser.add_argument("--output", default="data/universe.json", help="Output JSON file path")
    parser.add_argument("--frontend-dir", help="Path to frontend public dir to copy universe.json to")
    parser.add_argument("--layout", default="spiral", choices=["spiral", "cluster", "circle"], help="Layout algorithm")
    parser.add_argument("--email", help="Email for OpenAlex API (polite pool)")
    
    args = parser.parse_args()
    
    # 1. Parse User Galaxies (available locally)
    user_galaxies_map = {}
    if args.galaxies:
        for g_str in args.galaxies:
            parts = g_str.split(":")
            if len(parts) >= 2:
                try:
                    g_id = parts[0]
                    name = parts[1]
                    nodes_file = parts[2] if len(parts) > 2 else f"{g_id}_nodes.json"
                    edges_file = parts[3] if len(parts) > 3 else f"{g_id}_edges.json"
                    meta_file = parts[4] if len(parts) > 4 else f"{g_id}_metadata.json"
                    
                    # Load local data if available
                    node_count = 0
                    edge_count = 0
                    if os.path.exists(nodes_file):
                        load_res = load_galaxy_data(nodes_file, meta_file)
                        node_count = load_res['nodeCount']
                        edge_count = load_res['edgeCount']
                    
                    user_galaxies_map[name.lower()] = {
                        "id": g_id,
                        "name": name,
                        "nodesFile": nodes_file,
                        "edgesFile": edges_file,
                        "metadataFile": meta_file,
                        "nodeCount": node_count,
                        "edgeCount": edge_count,
                        "hasPapers": True
                    }
                except Exception as e:
                    print(f"[warn] Failed to parse galaxy '{g_str}': {e}")

    # 2. Fetch All Physics Subfields
    all_subfields = fetch_physics_subfields(args.email)
    
    final_galaxies = []
    
    # 3. Merge and Fetch Metrics
    for sub in all_subfields:
        name = sub["display_name"]
        normalized_name = name.lower()
        
        galaxy_info = {}
        
        # Check if user provided this galaxy (match by name)
        # We try strict match or partial match logic
        found_key = None
        if normalized_name in user_galaxies_map:
            found_key = normalized_name
        else:
            # Fuzzy match: check if user provided name is a substring of OA name or vice versa
            # e.g. "Condensed Matter" (user) in "Condensed matter physics" (OA) -> Match
            for key in user_galaxies_map.keys():
                if key in normalized_name or normalized_name in key:
                    found_key = key
                    break
        
        if found_key:
            print(f"[info] Processing user galaxy: {name} (matched '{found_key}')...")
            galaxy_info = user_galaxies_map[found_key]
            # Update name to match OpenAlex official name if desired, or keep user name?
            # Let's keep User name but ensure ID is correct? 
            # Actually, we want the official OA ID.
            galaxy_info["openAlexId"] = sub["id"] 
            # Ensure proper ID usage. If user provided an ID, it might be arbitrary "2".
            # The universe nodes usually use `id`. We should probably switch to OA ID if we can,
            # BUT the frontend loads files based on the ID in universe.json.
            # The user provided files like `condensed_matter_nodes.json`. 
            # If we change the ID to `C...`, the frontend might look for `C..._nodes.json`?
            # universe.json stores `nodesFile`. Frontend uses that.
            # So `id` can be anything unique. 
            # HOWEVER, universe views often use ID for coloring or keys.
            
            # Let's KEEP the user's ID for user galaxies to ensure file loading works if it relies on ID naming conventions not explicitly in nodesFile property (though nodesFile property is explicit).
            # The issue is `hasPapers` is in `galaxy_info`.
            galaxy_info["hasPapers"] = True
            # Also set citations if we matched from sub
            if "cited_by_count" in sub:
                 galaxy_info["totalCitations"] = sub["cited_by_count"]
        else:
            print(f"[info] Processing stub galaxy: {name}...")
            # Create stub
            galaxy_info = {
                "id": sub["id"], # Use OpenAlex ID as ID for stubs
                "name": name,
                # Set nodeCount to 0 for stubs, size comes from totalWorksCount
                "nodeCount": 0,
                "edgeCount": 0,
                "hasPapers": False,
                "totalCitations": sub.get("cited_by_count", 0)
            }
            
        # Metrics (Universal)
        print(f"[info] Fetching history for {name} ({sub['id']})...")
        metrics = get_openalex_metrics(name, args.email)
        
        if metrics:
            print(f"      -> Works: {metrics.get('totalWorksCount')}, First Year: {metrics.get('firstPublicationYear')}")
            galaxy_info.update(metrics)
            
        final_galaxies.append(galaxy_info)
        
    print(f"[info] Sorted galaxies by first publication year for spiral layout")
    final_galaxies.sort(key=lambda x: x.get("firstPublicationYear") or 2000)

    # --- Pre-calculate Absolute Timeline Y-Coordinates (Dynamic Spacing) ---
    print(f"[info] Calculating dynamic timeline positions...")
    
    # 1. Find Global Max (single decade count) for scaling
    global_max_works_single_decade = 0
    for g in final_galaxies:
        decade_counts = [w.get("works_count", 0) for w in g.get("worksByDecade", [])]
        local_max = max(decade_counts) if decade_counts else 0
        if local_max > global_max_works_single_decade:
            global_max_works_single_decade = local_max
    
    global_max_works_single_decade = max(global_max_works_single_decade, 1) # Avoid div by zero

    # Layout Constraints (Must match Frontend App.js logic ideally, or Frontend matches this)
    # Frontend: BASE_HEIGHT = 200, MAX_DATA_HEIGHT = 400
    NODE_BASE_HEIGHT = 40 # Reduced to minimal (label space) to allow proportional scaling
    TARGET_MAX_DATA_HEIGHT = 300 # Increased range to emphasize "bigger nodes get more space"
    GAP = 10 # Reduced from 50 to 10 per user request ("bring them even closer")

    current_y_cursor = 0
    # timelines are centered on their Y. So we track the "bottom" of the previous node.
    
    # We want the whole stack centered around 0.
    # First pass: calculate total height
    calculated_positions = []
    total_stack_height = 0
    
    for i, g in enumerate(final_galaxies):
        decade_counts = [w.get("works_count", 0) for w in g.get("worksByDecade", [])]
        local_max = max(decade_counts) if decade_counts else 0
        
        # Calculate Height
        ratio = local_max / global_max_works_single_decade
        
        # Manual Boost for specific fields per user request
        g_name = g.get('name', '').lower()
        if 'quantum mechanics' in g_name or 'acoustics' in g_name:
             # Boost moderately (User requested "less space" after 3.0 was too much)
             ratio = ratio * 1.5
             # Clamp to 1.0 logic? Or allow to exceed? 
             # Let's allow it to be large but maybe cap ratio at 1.5 of max to avoid blowing up screen
             ratio = max(ratio, 0.4) # Ensure it has at least 40% height even if data is small

        data_height = ratio * TARGET_MAX_DATA_HEIGHT
        total_node_height = NODE_BASE_HEIGHT + data_height
        
        calculated_positions.append({
            "height": total_node_height,
            "galaxy": g
        })
        
        if i > 0:
            total_stack_height += GAP
        total_stack_height += total_node_height

    # Second pass: Assign Y
    start_y = -total_stack_height / 2
    current_y = start_y

    for item in calculated_positions:
        h = item["height"]
        # Center of this node is current_y + h/2
        center_y = current_y + (h / 2)
        item["galaxy"]["timeline_y"] = center_y
        
        # Advance cursor
        current_y += h + GAP

    # 4. Generate Universe Nodes
    universe_nodes = generate_universe_nodes(final_galaxies, layout=args.layout)
    
    output_data = {
        "nodes": universe_nodes,
        "metadata": {
            "galaxyCount": len(universe_nodes),
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S")
        }
    }
    
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2)
        
    print(f"[info] Wrote: {args.output}")
    
    # Auto-detect frontend dir if not provided
    frontend_dir = args.frontend_dir
    if not frontend_dir:
        # Assume standard repo structure: ../arxiv-3d-frontend/public
        potential_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "arxiv-3d-frontend", "public")
        if os.path.exists(potential_path):
            frontend_dir = potential_path
            print(f"[info] Auto-detected frontend dir: {frontend_dir}")

    if frontend_dir and os.path.exists(frontend_dir):
        import shutil
        dest = os.path.join(frontend_dir, "universe.json")
        try:
            shutil.copy2(args.output, dest)
            print(f"[info] Copied to: {dest}")
        except Exception as e:
            print(f"[warn] Failed to copy to frontend: {e}")
        
    print(f"\n[info] Done! Generated universe with {len(universe_nodes)} galaxies.")

if __name__ == "__main__":
    main()
