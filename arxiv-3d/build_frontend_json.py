#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
build_frontend_json_enhanced.py — Enhanced version with clustering and network metrics

New features:
- Computes betweenness centrality to find "bridge" papers
- Creates clusters of highly-connected papers
- Exports tiered JSON for progressive loading
- Calculates edge importance scores
"""

import argparse
import json
import math
import os
import shutil
import sqlite3
from typing import Dict, List, Any, Optional, Set, Tuple
from collections import defaultdict


# -------------------------
# DB helpers
# -------------------------

def open_db(path: str) -> sqlite3.Connection:
    abs_path = os.path.abspath(path)
    print("[info] Opening DB:", abs_path)
    conn = sqlite3.connect(abs_path)
    conn.row_factory = sqlite3.Row
    return conn


# -------------------------
# Network Analysis
# -------------------------

def compute_degree_centrality(edges: List[Dict], node_ids: Set[str]) -> Dict[str, int]:
    """Count total connections (in + out) for each node"""
    degree = defaultdict(int)
    for e in edges:
        if e['source'] in node_ids:
            degree[e['source']] += 1
        if e['target'] in node_ids:
            degree[e['target']] += 1
    return dict(degree)


def compute_betweenness_centrality_approx(
    edges: List[Dict], 
    node_ids: Set[str],
    sample_size: int = 100
) -> Dict[str, float]:
    """
    Approximate betweenness centrality using sampled shortest paths.
    High betweenness = paper bridges different research areas.
    """
    # Build adjacency
    adj = defaultdict(set)
    for e in edges:
        adj[e['source']].add(e['target'])
        adj[e['target']].add(e['source'])  # undirected for simplicity
    
    betweenness = defaultdict(float)
    nodes = list(node_ids)
    
    # Sample pairs for BFS
    import random
    random.seed(42)
    sample = min(sample_size, len(nodes))
    sampled_nodes = random.sample(nodes, sample)
    
    print(f"[info] Computing betweenness for {len(nodes)} nodes (sampling {sample} sources)...")
    
    for source in sampled_nodes:
        # BFS to find shortest paths
        queue = [(source, [source])]
        visited = {source}
        paths = defaultdict(list)
        
        while queue:
            node, path = queue.pop(0)
            
            for neighbor in adj[node]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    new_path = path + [neighbor]
                    paths[neighbor].append(new_path)
                    queue.append((neighbor, new_path))
        
        # Count how often each node appears in shortest paths
        for target, path_list in paths.items():
            if not path_list:
                continue
            for path in path_list:
                for node in path[1:-1]:  # exclude source and target
                    betweenness[node] += 1.0 / len(path_list)
    
    # Normalize
    n = len(nodes)
    if n > 2:
        norm = (n - 1) * (n - 2) / 2
        betweenness = {k: v / norm for k, v in betweenness.items()}
    
    return dict(betweenness)


def find_clusters(
    edges: List[Dict],
    node_ids: Set[str],
    min_cluster_size: int = 3,
    connection_threshold: int = 2
) -> Dict[str, int]:
    """
    Group nodes into clusters based on shared citations.
    Returns node_id -> cluster_id mapping.
    """
    # Build adjacency
    adj = defaultdict(set)
    for e in edges:
        adj[e['source']].add(e['target'])
        adj[e['target']].add(e['source'])
    
    # Simple connected components
    visited = set()
    clusters = {}
    cluster_id = 0
    
    def dfs(start, cid):
        stack = [start]
        while stack:
            node = stack.pop()
            if node in visited:
                continue
            visited.add(node)
            clusters[node] = cid
            for neighbor in adj[node]:
                if neighbor not in visited and len(adj[neighbor]) >= connection_threshold:
                    stack.append(neighbor)

    for node in node_ids:
        if node not in visited and len(adj[node]) >= connection_threshold:
            dfs(node, cluster_id)
            cluster_id += 1
    
    # Assign singletons to cluster -1
    for node in node_ids:
        if node not in clusters:
            clusters[node] = -1
    
    # Report
    cluster_sizes = defaultdict(int)
    for cid in clusters.values():
        cluster_sizes[cid] += 1
    
    print(f"[info] Found {cluster_id} clusters:")
    for cid, size in sorted(cluster_sizes.items()):
        if cid >= 0 and size >= min_cluster_size:
            print(f"  Cluster {cid}: {size} papers")
    
    return clusters


# -------------------------
# Sizing & edges
# -------------------------

def get_size_from_citations(citations: Optional[int],
                            base: float = 0.5,
                            max_size: float = 2.0) -> float:
    c = citations or 0
    if c <= 0:
        return base
    size = base + 0.5 * (c ** 0.4)
    return round(min(size, max_size), 2)


def detect_citation_columns(conn: sqlite3.Connection):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(citations)")]
    candidates = [
        ("source", "target"),
        ("citingPaperId", "citedPaperId"),
        ("citing", "cited"),
        ("from_id", "to_id"),
    ]
    for a, b in candidates:
        if a in cols and b in cols:
            return a, b
    return None


# -------------------------
# Y-axis mapping
# -------------------------

def _galaxy_field_for_band(row) -> Optional[str]:
    """
    Priority order for the galaxy (Y-axis grouping) field:
      1. oa_primary_subfield  (OpenAlex Topics hierarchy — most reliable)
      2. AI_primary_field     (LLM-assigned)
      3. primary_concept      (OpenAlex Concepts — legacy fallback)
    """
    keys = row.keys() if hasattr(row, "keys") else []
    if "oa_primary_subfield" in keys:
        v = row["oa_primary_subfield"]
        if v and str(v).strip():
            return str(v).strip()
    v = row["AI_primary_field"] if "AI_primary_field" in keys else None
    if v and str(v).strip():
        return str(v).strip()
    v = row["primary_concept"] if "primary_concept" in keys else None
    if v and str(v).strip():
        return str(v).strip()
    return None


def build_field_bands(conn: sqlite3.Connection) -> Dict[str, float]:
    """Stable mapping galaxy-field -> Y coordinate band.

    Uses oa_primary_subfield where available, falls back to AI_primary_field,
    then primary_concept.
    """
    db_cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}

    select_parts = []
    if "oa_primary_subfield" in db_cols:
        select_parts.append("oa_primary_subfield")
    select_parts.append("AI_primary_field")
    if "primary_concept" in db_cols:
        select_parts.append("primary_concept")

    rows = conn.execute(f"SELECT {', '.join(select_parts)} FROM papers").fetchall()

    seen: set = set()
    for r in rows:
        val = _galaxy_field_for_band(r)
        if val:
            seen.add(val)

    fields = sorted(seen)
    if not fields:
        print("[warn] No galaxy field values found; Y=0 for all nodes")
        return {}

    band_step = 3.0
    offset = -(len(fields) - 1) * band_step / 2.0
    mapping = {f: offset + i * band_step for i, f in enumerate(fields)}
    print(f"[info] Field bands: {len(mapping)} distinct galaxy-field values")
    return mapping


# -------------------------
# Tiered Selection
# -------------------------

def select_landmark_papers(
    nodes: List[Dict],
    edges: List[Dict],
    tier1_size: int = 500,
    min_citations: int = 50
) -> Tuple[List[Dict], Set[str]]:
    """
    Select Tier 1 "landmark" papers based on:
    - High citations
    - High betweenness (bridging papers)
    - Field diversity
    """
    node_ids = {n['id'] for n in nodes}
    
    # Filter minimum citations
    candidates = [n for n in nodes if n['citationCount'] >= min_citations]
    print(f"[info] {len(candidates)} papers with >={min_citations} citations")
    
    if len(candidates) <= tier1_size:
        return candidates, {n['id'] for n in candidates}
    
    # Compute centrality
    degree = compute_degree_centrality(edges, node_ids)
    betweenness = compute_betweenness_centrality_approx(edges, node_ids)
    
    # Score each paper
    for n in candidates:
        nid = n['id']
        cite_score = math.log1p(n['citationCount'])
        degree_score = math.log1p(degree.get(nid, 0))
        between_score = betweenness.get(nid, 0) * 100
        
        # Combined score
        n['landmark_score'] = cite_score + degree_score * 2 + between_score * 3
    
    # Sort and take top
    candidates.sort(key=lambda x: x['landmark_score'], reverse=True)
    selected = candidates[:tier1_size]
    
    print(f"[info] Selected {len(selected)} landmark papers")
    print(f"[info] Top paper: {selected[0]['title'][:60]}... (score: {selected[0]['landmark_score']:.1f})")
    
    return selected, {n['id'] for n in selected}


# -------------------------
# Build nodes
# -------------------------

def build_nodes(
    conn: sqlite3.Connection,
    min_citations: int = 0,
    top_n: int = 0,
    fields: Optional[List[str]] = None,
    keywords: Optional[List[str]] = None,
    authors: Optional[List[str]] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    paper_nature_filter: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Build node dicts for the frontend using the requested fields and filters."""

    print("[info] Building nodes…")

    # Detect which optional columns exist
    db_cols = {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}
    has_paper_nature   = "paper_nature"        in db_cols
    has_icon_category  = "icon_category"       in db_cols
    has_oa_subfield    = "oa_primary_subfield" in db_cols
    has_oa_topic       = "oa_primary_topic"    in db_cols
    has_primary_concept= "primary_concept"     in db_cols

    optional_cols = ""
    if has_paper_nature:
        optional_cols += ",\n            paper_nature"
    if has_icon_category:
        optional_cols += ",\n            icon_category"
    if has_oa_subfield:
        optional_cols += ",\n            oa_primary_subfield"
    if has_oa_topic:
        optional_cols += ",\n            oa_primary_topic"
    if has_primary_concept:
        optional_cols += ",\n            primary_concept"

    base_query = f"""
        SELECT
            paperId,
            title,
            abstract,
            AI_summary,
            AI_primary_field,
            cited_by_count,
            year,
            publicationDate,
            doi,
            journal_name,
            first_author_name,
            all_author_names,
            all_institution_names,
            work_type,
            language{optional_cols}
        FROM papers
    """

    conditions: List[str] = []
    params: List[Any] = []

    if min_citations and min_citations > 0:
        conditions.append("cited_by_count >= ?")
        params.append(min_citations)

    if year_from is not None:
        conditions.append("year >= ?")
        params.append(year_from)

    if year_to is not None:
        conditions.append("year <= ?")
        params.append(year_to)

    if fields:
        conditions.append(
            "(" + " OR ".join("AI_primary_field = ?" for _ in fields) + ")"
        )
        params.extend(fields)

    if keywords:
        for kw in keywords:
            conditions.append("(title LIKE ? OR AI_summary LIKE ?)")
            like = f"%{kw}%"
            params.extend([like, like])

    if authors:
        for a in authors:
            conditions.append("all_author_names LIKE ?")
            params.append(f"%{a}%")

    if paper_nature_filter and has_paper_nature:
        placeholders = ", ".join("?" for _ in paper_nature_filter)
        conditions.append(f"paper_nature IN ({placeholders})")
        params.extend(paper_nature_filter)

    q = base_query
    if conditions:
        q += " WHERE " + " AND ".join(f"({c})" for c in conditions)

    q += " ORDER BY cited_by_count DESC NULLS LAST"

    if top_n and top_n > 0:
        q += " LIMIT ?"
        params.append(top_n)

    print("[debug] Final node SQL:")
    print("   ", q.strip())
    print("[debug] Params:", params)

    rows = conn.execute(q, params).fetchall()
    print(f"[info] Rows fetched for nodes: {len(rows)}")

    field_bands = build_field_bands(conn)

    nodes: List[Dict[str, Any]] = []

    for r in rows:
        rkeys = r.keys()
        paperId              = r["paperId"]
        title                = r["title"]
        abstract             = r["abstract"]
        ai_summary           = r["AI_summary"]
        ai_primary_field     = r["AI_primary_field"]
        cited_by_count       = r["cited_by_count"]
        year                 = r["year"]
        publicationDate      = r["publicationDate"]
        doi                  = r["doi"]
        journal_name         = r["journal_name"]
        first_author_name    = r["first_author_name"]
        all_author_names     = r["all_author_names"]
        all_institution_names= r["all_institution_names"]
        work_type            = r["work_type"]
        language             = r["language"]
        paper_nature         = r["paper_nature"]  if "paper_nature"         in rkeys else None
        icon_category        = r["icon_category"] if "icon_category"        in rkeys else None
        oa_subfield          = r["oa_primary_subfield"] if "oa_primary_subfield" in rkeys else None
        oa_topic             = r["oa_primary_topic"]    if "oa_primary_topic"    in rkeys else None
        primary_concept      = r["primary_concept"]     if "primary_concept"     in rkeys else None

        # Galaxy field: OA subfield → AI primary field → primary_concept
        galaxy_field = (
            (oa_subfield      if oa_subfield      and str(oa_subfield).strip()      else None) or
            (ai_primary_field if ai_primary_field  and str(ai_primary_field).strip() else None) or
            (primary_concept  if primary_concept   and str(primary_concept).strip()  else None)
        )

        # Topic field: OA topic → AI primary field (as topic) → primary_concept
        topic_field = (
            (oa_topic         if oa_topic          and str(oa_topic).strip()         else None) or
            (ai_primary_field if ai_primary_field  and str(ai_primary_field).strip() else None) or
            (primary_concept  if primary_concept   and str(primary_concept).strip()  else None)
        )

        x = (year or 0) - 1950
        y = field_bands.get(galaxy_field, 0.0)
        z = math.log1p(cited_by_count or 0) * 10.0

        size = get_size_from_citations(cited_by_count)

        node = {
            "id": paperId,
            "paperId": paperId,
            "title": title,
            "abstract": abstract,
            "summary": ai_summary,
            "primaryField": galaxy_field,
            "topic": topic_field,
            "year": year,
            "publicationDate": publicationDate,
            "doi": doi,
            "journal": journal_name,
            "firstAuthor": first_author_name,
            "allAuthors": all_author_names,
            "institutions": all_institution_names,
            "workType": work_type,
            "paperNature": paper_nature,
            "iconCategory": icon_category,
            "language": language,
            "citationCount": cited_by_count,
            "url": f"https://openalex.org/{paperId}",
            "position": [x, y, z],
            "size": size,
        }

        nodes.append(node)

    print(f"[info] Nodes built: {len(nodes)}")
    return nodes


# -------------------------
# Build edges with importance scores
# -------------------------

def build_edges_enhanced(
    conn: sqlite3.Connection,
    nodes: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Build edges with importance scores based on:
    - Citation counts of source and target
    - Clustering (edges within clusters are less important for overview)
    """
    print("[info] Building enhanced edges…")

    pid_set = {n["paperId"] for n in nodes}
    node_map = {n["paperId"]: n for n in nodes}
    
    colpair = detect_citation_columns(conn)
    if not colpair:
        print("[warn] No suitable citation columns found on `citations` table.")
        return []

    src_col, dst_col = colpair
    print(f"[info] Using citation columns: {src_col} -> {dst_col}")

    edges: List[Dict[str, Any]] = []
    
    # Use cursor as iterator to avoid loading 12M+ rows into memory at once
    cur = conn.execute(f"SELECT {src_col}, {dst_col} FROM citations")

    total = 0
    kept = 0
    print("[info] processing citations stream...")
    
    for src, dst in cur:
        total += 1
        if total % 1000000 == 0:
            print(f"   ...processed {total} citation rows (kept {kept})...")

        if src in pid_set and dst in pid_set:
            src_node = node_map[src]
            dst_node = node_map[dst]
            
            # Importance score: higher for connections between highly-cited papers
            cite_score = math.log1p(src_node['citationCount']) + math.log1p(dst_node['citationCount'])
            
            edges.append({
                "source": src,
                "target": dst,
                "weight": 1.0,
                "importance": cite_score,
                "sourceField": src_node.get('primaryField'),
                "targetField": dst_node.get('primaryField'),
            })
            kept += 1

    print(f"[info] Edges built: kept {kept} of {total} citation rows")
    
    # Sort by importance
    edges.sort(key=lambda e: e['importance'], reverse=True)
    
    return edges


# -------------------------
# Save helpers
# -------------------------

def save_json(obj: Any, path: str, frontend_dir: Optional[str]):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    print("[info] Wrote:", path)

    if frontend_dir:
        os.makedirs(frontend_dir, exist_ok=True)
        dst = os.path.join(frontend_dir, os.path.basename(path))
        shutil.copy(path, dst)
        print("[info] Copied to:", dst)


# -------------------------
# CLI
# -------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Build enhanced nodes/edges JSON with clustering and network metrics"
    )
    parser.add_argument("--db", type=str, default="papers_particle_physics_all.db",
                        help="Path to SQLite DB")
    parser.add_argument("--frontend-dir", type=str, default=None,
                        help="Optional: directory to copy JSON files into")

    # Selection options
    parser.add_argument("--min-citations", type=int, default=0,
                        help="Minimum cited_by_count for a paper to be included")
    parser.add_argument("--top-n", type=int, default=0,
                        help="If >0, keep only the top N papers by citation count after filters")
    
    # Enhanced options
    parser.add_argument("--use-landmarks", action="store_true",
                        help="Use smart landmark selection instead of simple top-n")
    parser.add_argument("--landmark-count", type=int, default=500,
                        help="Number of landmark papers to select (default: 500)")
    parser.add_argument("--compute-clusters", action="store_true",
                        help="Compute and export cluster information")
    parser.add_argument("--cluster-threshold", type=int, default=2,
                        help="Minimum connections for clustering (default: 2)")
    parser.add_argument("--experimental-boost", type=int, default=0,
                        help="Also include top N experimental/phenomenological papers, merged with main set")

    # Filters
    parser.add_argument("--field", action="append", default=None,
                        help="Filter by AI_primary_field")
    parser.add_argument("--keyword", action="append", default=None,
                        help="Filter by keyword in title or AI_summary")
    parser.add_argument("--author", action="append", default=None,
                        help="Filter by author name")
    parser.add_argument("--year-from", type=int, default=None,
                        help="Minimum publication year (inclusive)")
    parser.add_argument("--year-to", type=int, default=None,
                        help="Maximum publication year (inclusive)")

    # Output filename options
    parser.add_argument("--output-nodes", type=str, default="data/particle_physics_nodes.json",
                        help="Output filename for nodes JSON (default: data/particle_physics_nodes.json)")
    parser.add_argument("--output-edges", type=str, default="data/particle_physics_edges.json",
                        help="Output filename for edges JSON (default: data/particle_physics_edges.json)")
    parser.add_argument("--output-metadata", type=str, default="data/particle_physics_metadata.json",
                        help="Output filename for metadata JSON (default: data/particle_physics_metadata.json)")
    parser.add_argument("--output-clusters", type=str, default="data/particle_physics_clusters.json",
                        help="Output filename for clusters JSON (default: data/particle_physics_clusters.json)")

    args = parser.parse_args()

    conn = open_db(args.db)

    # Build all nodes matching filters
    all_nodes = build_nodes(
        conn,
        min_citations=args.min_citations,
        top_n=args.top_n if not args.use_landmarks else 0,
        fields=args.field,
        keywords=args.keyword,
        authors=args.author,
        year_from=args.year_from,
        year_to=args.year_to,
    )
    
    # Experimental boost: merge in top N experimental/phenomenological papers
    if args.experimental_boost > 0:
        exp_nodes = build_nodes(
            conn,
            min_citations=args.min_citations,
            top_n=args.experimental_boost,
            fields=args.field,
            year_from=args.year_from,
            year_to=args.year_to,
            paper_nature_filter=['experimental', 'phenomenological'],
        )
        existing_ids = {n['id'] for n in all_nodes}
        new_exp = [n for n in exp_nodes if n['id'] not in existing_ids]
        all_nodes.extend(new_exp)
        print(f"[info] Experimental boost: added {len(new_exp)} new papers (from {len(exp_nodes)} exp/phenom)")

    # Build edges for all nodes
    all_edges = build_edges_enhanced(conn, all_nodes)
    
    # Landmark selection
    if args.use_landmarks:
        print("\n[info] Using landmark selection strategy...")
        landmark_nodes, landmark_ids = select_landmark_papers(
            all_nodes,
            all_edges,
            tier1_size=args.landmark_count,
            min_citations=args.min_citations or 10
        )
        
        # Filter edges to only those connecting landmarks
        landmark_edges = [
            e for e in all_edges 
            if e['source'] in landmark_ids and e['target'] in landmark_ids
        ]
        
        nodes = landmark_nodes
        edges = landmark_edges
    else:
        nodes = all_nodes
        edges = all_edges
    
    # Compute clusters if requested
    if args.compute_clusters:
        print("\n[info] Computing clusters...")
        node_ids = {n['id'] for n in nodes}
        clusters = find_clusters(
            edges,
            node_ids,
            connection_threshold=args.cluster_threshold
        )
        
        # Add cluster info to nodes
        for n in nodes:
            n['clusterId'] = clusters.get(n['id'], -1)
        
        # Export cluster summary
        cluster_summary = defaultdict(list)
        for n in nodes:
            cid = n.get('clusterId', -1)
            if cid >= 0:
                cluster_summary[cid].append({
                    'id': n['id'],
                    'title': n['title'],
                    'citations': n['citationCount']
                })
        
        save_json(
            dict(cluster_summary),
            args.output_clusters,
            args.frontend_dir
        )

    # Export main files
    save_json(nodes, args.output_nodes, args.frontend_dir)
    save_json(edges, args.output_edges, args.frontend_dir)
    
    # Export metadata
    metadata = {
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "usedLandmarks": args.use_landmarks,
        "hasClusters": args.compute_clusters,
        "filters": {
            "minCitations": args.min_citations,
            "topN": args.top_n,
            "fields": args.field,
            "yearRange": [args.year_from, args.year_to] if args.year_from or args.year_to else None,
        }
    }
    save_json(metadata, args.output_metadata, args.frontend_dir)

    conn.close()
    print("\n[info] Done! Your enhanced visualization data is ready.")
    print(f"[info] Nodes: {len(nodes)}, Edges: {len(edges)}")


if __name__ == "__main__":
    main()