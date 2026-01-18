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
from typing import List, Dict, Any


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
            
            # Size based on node count (similar to galaxy node sizing)
            node_count = galaxy.get('nodeCount', 0)
            base_size = 10.0
            size = base_size + math.sqrt(node_count) * 0.3
            size = min(size, 60.0)  # Cap maximum size
            
            universe_node = {
                'id': galaxy['id'],
                'name': galaxy['name'],
                'type': 'galaxy',
                'nodeCount': node_count,
                'edgeCount': galaxy.get('edgeCount', 0),
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
        sorted_galaxies = sorted(galaxies, key=lambda g: g.get('nodeCount', 0), reverse=True)
        
        for i, galaxy in enumerate(sorted_galaxies):
            node_count = galaxy.get('nodeCount', 0)
            
            # Larger galaxies closer to center, smaller ones further out
            max_node_count = max([g.get('nodeCount', 0) for g in galaxies], default=1)
            distance_factor = 1.0 - (node_count / max_node_count) * 0.6  # 0.4 to 1.0
            
            # Angle for positioning (avoid overlap)
            angle = (i * 137.508 * math.pi / 180) % (2 * math.pi)  # Golden angle for even distribution
            
            radius = center_distance * (0.3 + distance_factor * 0.7)  # 30% to 100% of center_distance
            
            x = center_x + math.cos(angle) * radius
            y = center_y + math.sin(angle) * radius
            z = 0
            
            # Size based on node count
            base_size = 10.0
            size = base_size + math.sqrt(node_count) * 0.3
            size = min(size, 60.0)  # Cap maximum size
            
            universe_node = {
                'id': galaxy['id'],
                'name': galaxy['name'],
                'type': 'galaxy',
                'nodeCount': node_count,
                'edgeCount': galaxy.get('edgeCount', 0),
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
            
            # Size based on node count
            node_count = galaxy.get('nodeCount', 0)
            base_size = 10.0
            size = base_size + math.sqrt(node_count) * 0.3
            size = min(size, 60.0)  # Cap maximum size
            
            universe_node = {
                'id': galaxy['id'],
                'name': galaxy['name'],
                'type': 'galaxy',
                'nodeCount': node_count,
                'edgeCount': galaxy.get('edgeCount', 0),
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
    
    args = parser.parse_args()
    
    # Parse galaxy definitions
    galaxies_info = []
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
        
        galaxies_info.append({
            'id': galaxy_id,
            'name': galaxy_name,
            'nodeCount': galaxy_data['nodeCount'],
            'edgeCount': galaxy_data['edgeCount'],
            'nodesFile': os.path.basename(nodes_file),
            'edgesFile': os.path.basename(edges_file),
            'metadataFile': os.path.basename(metadata_file)
        })
        
        print(f"[info] Galaxy: {galaxy_name} ({galaxy_id}) - {galaxy_data['nodeCount']} nodes, {galaxy_data['edgeCount']} edges")
    
    if not galaxies_info:
        print("[error] No valid galaxies found")
        return
    
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
