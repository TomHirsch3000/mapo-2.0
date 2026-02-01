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
    meta_count = data.get("meta", {}).get("count")
    if meta_count:
        total_works = meta_count
            
    return {
        "totalWorksCount": total_works,
        "firstPublicationYear": min_year,
        "worksByDecade": works_by_decade,
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
                # New metadata
                'totalWorksCount': galaxy.get('totalWorksCount', 0),
                'firstPublicationYear': galaxy.get('firstPublicationYear'),
                'worksByDecade': galaxy.get('worksByDecade', []),
                
                'nodesFile': galaxy.get('nodesFile', f"{galaxy['id']}_nodes.json"),
                'edgesFile': galaxy.get('edgesFile', f"{galaxy['id']}_edges.json"),
                'metadataFile': galaxy.get('metadataFile', f"{galaxy['id']}_metadata.json"),
                'position': [x, y, z],
                'size': round(size, 2),
                'angle': round(math.degrees(angle), 2)
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
                'totalWorksCount': galaxy.get('totalWorksCount', 0),
                'firstPublicationYear': galaxy.get('firstPublicationYear'),
                'worksByDecade': galaxy.get('worksByDecade', []),
                'nodesFile': galaxy.get('nodesFile', f"{galaxy['id']}_nodes.json"),
                'edgesFile': galaxy.get('edgesFile', f"{galaxy['id']}_edges.json"),
                'metadataFile': galaxy.get('metadataFile', f"{galaxy['id']}_metadata.json"),
                'position': [x, y, z],
                'size': round(size, 2),
                'angle': round(math.degrees(angle), 2)
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
                'firstPublicationYear': galaxy.get('firstPublicationYear'),
                'worksByDecade': galaxy.get('worksByDecade', []),
                'nodesFile': galaxy.get('nodesFile', f"{galaxy['id']}_nodes.json"),
                'edgesFile': galaxy.get('edgesFile', f"{galaxy['id']}_edges.json"),
                'metadataFile': galaxy.get('metadataFile', f"{galaxy['id']}_metadata.json"),
                'position': [x, y, z],
                'size': round(size, 2),
                'angle': round(math.degrees(angle), 2)
            }
            
            universe_nodes.append(universe_node)
    
    return universe_nodes


def main():
    parser = argparse.ArgumentParser(
        description="Generate universe.json from galaxy JSON files"
    )
    parser.add_argument("--galaxies", nargs='+', required=True,
                        help="Galaxy definitions as: id:name:nodes_file:edges_file:metadata_file")
    parser.add_argument("--output", type=str, default="universe.json",
                        help="Output filename (default: universe.json)")
    parser.add_argument("--frontend-dir", type=str, default=None,
                        help="Optional: directory to copy JSON file into")
    parser.add_argument("--center-distance", type=float, default=300.0,
                        help="Base distance from center for galaxy positioning (default: 300.0)")
    parser.add_argument("--layout", type=str, default="spiral", choices=["spiral", "cluster", "circle"],
                        help="Layout type: 'spiral' (knowledge evolution), 'cluster' (constellation), or 'circle' (default: spiral)")
    parser.add_argument("--email", type=str, default=None,
                        help="Email for OpenAlex API (polite pool)")
    
    args = parser.parse_args()
    
    # Parse galaxy definitions
    galaxies_info = []
    print(f"[info] Parsing {len(args.galaxies)} galaxies...")
    
    for galaxy_def in args.galaxies:
        parts = galaxy_def.split(':')
        if len(parts) < 3:
            print(f"[error] Invalid galaxy definition: {galaxy_def}")
            print("[error] Expected format: id:name:nodes_file[:edges_file][:metadata_file]")
            continue
        
        galaxy_id = parts[0]
        galaxy_name = parts[1]
        nodes_file = parts[2]
        edges_file = parts[3] if len(parts) > 3 else f"{galaxy_id}_edges.json"
        metadata_file = parts[4] if len(parts) > 4 else f"{galaxy_id}_metadata.json"
        
        # Load galaxy data to get node count
        if not os.path.exists(nodes_file):
            print(f"[warn] Nodes file not found: {nodes_file}, assuming 0 nodes")
            galaxy_data = {'nodeCount': 0, 'edgeCount': 0, 'metadata': {}}
        else:
            galaxy_data = load_galaxy_data(nodes_file, metadata_file)
            
        # Fetch OpenAlex metrics
        print(f"[info] Fetching OpenAlex metrics for '{galaxy_name}'...")
        oa_metrics = get_openalex_metrics(galaxy_name, args.email)
        
        info = {
            'id': galaxy_id,
            'name': galaxy_name,
            'nodeCount': galaxy_data['nodeCount'],
            'edgeCount': galaxy_data['edgeCount'],
            'nodesFile': os.path.basename(nodes_file),
            'edgesFile': os.path.basename(edges_file),
            'metadataFile': os.path.basename(metadata_file)
        }
        
        if oa_metrics:
            info.update(oa_metrics)
            print(f"      -> Works: {oa_metrics.get('totalWorksCount',0)}, First Year: {oa_metrics.get('firstPublicationYear')}")
        else:
            print(f"      -> No OpenAlex data found")
            
        galaxies_info.append(info)

    if not galaxies_info:
        print("[error] No valid galaxies found")
        return
    
    # Sort galaxies by firstPublicationYear for spiral layout (Time line view)
    # If using spiral layout, sorting by time makes the spiral a timeline.
    if args.layout == "spiral":
        # Sort keys: has_year (bool), year (int). Put those without year at end (or beginning?)
        # Let's put oldest first.
        # Put items with year=None at the end (using 9999 as sentinel)
        galaxies_info.sort(key=lambda x: (x.get('firstPublicationYear') is None, x.get('firstPublicationYear') or 9999))
        
        print("[info] Sorted galaxies by first publication year for spiral layout")

    # Generate universe nodes
    universe_nodes = generate_universe_nodes(galaxies_info, args.center_distance, args.layout)
    
    # Create universe JSON structure
    universe_data = {
        'nodes': universe_nodes,
        'metadata': {
            'galaxyCount': len(universe_nodes),
            'totalNodes': sum(g['nodeCount'] for g in galaxies_info),
            'totalEdges': sum(g['edgeCount'] for g in galaxies_info)
        }
    }
    
    # Save universe.json
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(universe_data, f, indent=2, ensure_ascii=False)
    
    print(f"[info] Wrote: {args.output}")
    
    # Copy to frontend if requested
    if args.frontend_dir:
        os.makedirs(args.frontend_dir, exist_ok=True)
        dst = os.path.join(args.frontend_dir, os.path.basename(args.output))
        import shutil
        shutil.copy(args.output, dst)
        print(f"[info] Copied to: {dst}")
    
    print(f"\n[info] Done! Generated universe with {len(universe_nodes)} galaxies.")

if __name__ == "__main__":
    main()
