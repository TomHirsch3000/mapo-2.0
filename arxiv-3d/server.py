import glob
import os
import sqlite3
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _find_db_dir():
    """
    Find the directory that contains papers_*.db files.
    Checks MAPO_DB_DIR env var first, then walks up from SCRIPT_DIR looking
    for an 'arxiv-3d' sibling that has .db files (handles git worktrees).
    """
    # Explicit override via env var
    env_dir = os.environ.get('MAPO_DB_DIR')
    if env_dir and glob.glob(os.path.join(env_dir, 'papers_*.db')):
        return env_dir

    # Check script's own directory first (normal case)
    if glob.glob(os.path.join(SCRIPT_DIR, 'papers_*.db')):
        return SCRIPT_DIR

    # Walk up looking for an arxiv-3d directory with .db files
    # (worktree case: script lives in .claude/worktrees/<name>/arxiv-3d/)
    candidate = SCRIPT_DIR
    for _ in range(8):
        candidate = os.path.dirname(candidate)
        sibling = os.path.join(candidate, 'arxiv-3d')
        if glob.glob(os.path.join(sibling, 'papers_*.db')):
            return sibling
        if glob.glob(os.path.join(candidate, 'papers_*.db')):
            return candidate

    return SCRIPT_DIR  # fallback


DB_DIR = _find_db_dir()


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_all_db_paths():
    """Return sorted list of all papers_*.db files in DB_DIR."""
    return sorted(glob.glob(os.path.join(DB_DIR, 'papers_*.db')))


def topic_from_db_path(db_path):
    """Derive human-readable topic name from DB filename.
    papers_particle_physics_all.db  ->  'Particle Physics'
    papers_astrophysics.db          ->  'Astrophysics'
    """
    name = os.path.basename(db_path).replace('papers_', '').replace('.db', '')
    if name.endswith('_all'):
        name = name[:-4]
    return name.replace('_', ' ').title()


def open_conn(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def column_names(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()}


# ---------------------------------------------------------------------------
# /api/paper/<id>/details  — single-paper neighbourhood
# ---------------------------------------------------------------------------

@app.route('/api/paper/<string:paper_id>/details', methods=['GET'])
def get_paper_details(paper_id):
    try:
        min_citations = int(request.args.get('min_citations', 100))
        max_papers = int(request.args.get('max_papers', 500))
    except ValueError:
        return jsonify({"error": "Invalid min_citations or max_papers parameter. Must be an integer."}), 400

    conn = get_db_connection()
    try:
        # 1. Get all connected edge pairs where the paper is source or target
        edges_query = """
            SELECT source, target 
            FROM citations 
            WHERE source = ? OR target = ?
        """
        raw_edges = conn.execute(edges_query, (paper_id, paper_id)).fetchall()
        
        # Determine the unique set of paper IDs involved (the central paper + all connected)
        connected_ids = set([paper_id])
        for row in raw_edges:
            connected_ids.add(row['source'])
            connected_ids.add(row['target'])
            
        if not connected_ids:
            return jsonify({"nodes": [], "edges": []})
            
        # 2. Query node details for the connected papers, filtering by min_citations
        # We always include the central selected paper regardless of its citation count
        placeholders = ','.join(['?'] * len(connected_ids))
        nodes_query = f"""
            SELECT * 
            FROM papers 
            WHERE paperId IN ({placeholders}) 
            AND (cited_by_count >= ? OR paperId = ?)
            LIMIT ?
        """
        
        params = list(connected_ids) + [min_citations, paper_id, max_papers]
        raw_nodes = conn.execute(nodes_query, params).fetchall()
        
        # Re-verify the set of valid node IDs after the filter and limit
        valid_node_ids = set([row['paperId'] for row in raw_nodes])
        
        # 3. Filter edges to only include those where both source and target are in the final valid nodes list
        valid_edges = []
        for row in raw_edges:
            if row['source'] in valid_node_ids and row['target'] in valid_node_ids:
                valid_edges.append({
                    "source": row['source'],
                    "target": row['target'],
                    "importance": 1 # Default importance
                })
                
        # 4. Format the nodes for the frontend
        formatted_nodes = []
        for row in raw_nodes:
            # Reconstruct the expected properties from the SQLite schema
            yr = row['year']
            if not yr and row['publicationDate']:
                try:
                    yr = int(row['publicationDate'].split('-')[0])
                except:
                    yr = 2000
                    
            node = {
                "id": row['paperId'],
                "title": row['title'],
                "year": yr,
                "citationCount": row['cited_by_count'] or 0,
                "primaryField": row['AI_primary_field'] or row['primary_concept'] or "Unassigned",
                "abstract": row['AI_summary'] or row['abstract'] or "No abstract available.",
                "authors": row['all_author_names'] or row['first_author_name'] or "Unknown",
                "institutions": row['all_institution_names'] or "",
                "paperNature": row['paper_nature'] if 'paper_nature' in row.keys() else None,

                # Maintain original DB row under data for any edge cases
                "data": dict(row)
            }
            formatted_nodes.append(node)
            
        return jsonify({
            "nodes": formatted_nodes,
            "edges": valid_edges
        })

        except Exception as e:
            conn.close()
            return jsonify({"error": str(e)}), 500
        finally:
            conn.close()

    return jsonify({"error": f"Paper {paper_id} not found in any database."}), 404


# ---------------------------------------------------------------------------
# /api/search  — cross-database search with experimental evidence step
# ---------------------------------------------------------------------------

@app.route('/api/search', methods=['GET'])
def search_topics():
    query = request.args.get('query', '').strip()
    if not query:
        return jsonify({"error": "Query parameter is required"}), 400

    try:
        min_citations = int(request.args.get('min_citations', 0))
        max_papers = int(request.args.get('max_papers', 50))
    except ValueError:
        return jsonify({"error": "Invalid parameters. Must be integers."}), 400

    all_db_paths = get_all_db_paths()
    if not all_db_paths:
        return jsonify({"error": "No databases found on the server."}), 500

    search_term = f'%{query}%'
    all_nodes = []
    all_edges = []
    seen_edges = set()
    seen_node_ids = set()   # deduplicate across DBs
    stats = {"core": 0, "foundation": 0, "impact": 0, "evidence": 0}

    for db_path in all_db_paths:
        topic = topic_from_db_path(db_path)
        conn = open_conn(db_path)

        try:
            cols = column_names(conn)
            has_nature = 'paper_nature' in cols

            # ------------------------------------------------------------------
            # 1. Core papers — match the search query
            # ------------------------------------------------------------------
            core_rows = conn.execute("""
                SELECT * FROM papers
                WHERE (title LIKE ? OR AI_summary LIKE ? OR abstract LIKE ? OR AI_primary_field LIKE ?)
                  AND cited_by_count >= ?
                ORDER BY cited_by_count DESC
                LIMIT ?
            """, (search_term, search_term, search_term, search_term,
                  min_citations, max_papers)).fetchall()

            if not core_rows:
                continue

            core_ids = {r['paperId'] for r in core_rows}
            core_id_list = list(core_ids)
            core_ph = ','.join(['?'] * len(core_id_list))

            # ------------------------------------------------------------------
            # 2. Foundation papers — papers that core papers cite
            # ------------------------------------------------------------------
            foundation_edge_rows = conn.execute(
                f"SELECT source, target FROM citations WHERE source IN ({core_ph}) LIMIT 500",
                core_id_list
            ).fetchall()
            foundation_target_ids = {r['target'] for r in foundation_edge_rows} - core_ids

            # ------------------------------------------------------------------
            # 3. Impact papers — papers that cite core papers
            # ------------------------------------------------------------------
            impact_edge_rows = conn.execute(
                f"SELECT source, target FROM citations WHERE target IN ({core_ph}) LIMIT 500",
                core_id_list
            ).fetchall()
            impact_source_ids = {r['source'] for r in impact_edge_rows} - core_ids

            MAX_CONTEXT = 30

            def fetch_by_ids(id_set, limit):
                if not id_set:
                    return []
                ids = list(id_set)
                ph = ','.join(['?'] * len(ids))
                return conn.execute(
                    f"SELECT * FROM papers WHERE paperId IN ({ph}) "
                    f"ORDER BY cited_by_count DESC LIMIT {limit}",
                    ids
                ).fetchall()

            foundation_rows = fetch_by_ids(foundation_target_ids, MAX_CONTEXT)
            impact_rows = fetch_by_ids(impact_source_ids, MAX_CONTEXT)

        valid_foundation_ids = set(r['paperId'] for r in foundation_rows)
        valid_impact_ids = set(r['paperId'] for r in impact_rows)

        # 5. Format nodes
        def format_node(row, node_type):
            yr = row['year']
            if not yr and row['publicationDate']:
                try:
                    yr = int(row['publicationDate'].split('-')[0])
                except Exception:
                    yr = 2000
            return {
                "id": row['paperId'],
                "title": row['title'],
                "year": yr,
                "citationCount": row['cited_by_count'] or 0,
                "primaryField": row['AI_primary_field'] or row['primary_concept'] or "Unassigned",
                "abstract": row['AI_summary'] or row['abstract'] or "No abstract available.",
                "authors": row['all_author_names'] or row['first_author_name'] or "Unknown",
                "institutions": row['all_institution_names'] or "",
                "paperNature": row['paper_nature'] if 'paper_nature' in row.keys() else None,
                "nodeType": node_type,
                "data": dict(row)
            }

            for row in core_rows:
                if row['paperId'] not in seen_node_ids:
                    all_nodes.append(format_node(row, 'core'))
                    seen_node_ids.add(row['paperId'])

            for row in foundation_rows:
                if row['paperId'] not in seen_node_ids:
                    all_nodes.append(format_node(row, 'foundation'))
                    seen_node_ids.add(row['paperId'])

            for row in impact_rows:
                if row['paperId'] not in seen_node_ids:
                    all_nodes.append(format_node(row, 'impact'))
                    seen_node_ids.add(row['paperId'])

            for row in evidence_rows:
                if row['paperId'] not in seen_node_ids:
                    all_nodes.append(format_node(row, 'evidence'))
                    seen_node_ids.add(row['paperId'])

            # ------------------------------------------------------------------
            # 6. Edges between valid nodes
            # ------------------------------------------------------------------
            def add_edge(source, target, edge_type):
                key = f"{source}|{target}"
                if key not in seen_edges and source in all_valid_ids and target in all_valid_ids:
                    seen_edges.add(key)
                    all_edges.append({
                        "source": source, "target": target,
                        "importance": 1, "edgeType": edge_type,
                    })

            for r in foundation_edge_rows:
                add_edge(r['source'], r['target'], 'foundation')
            for r in impact_edge_rows:
                add_edge(r['source'], r['target'], 'impact')

            # Edges connecting evidence nodes to the core
            if valid_evidence_ids:
                ev_and_core = core_id_list + list(valid_evidence_ids)
                ev_ph2 = ','.join(['?'] * len(ev_and_core))
                for er in conn.execute(
                    f"SELECT source, target FROM citations "
                    f"WHERE (source IN ({ev_ph2}) AND target IN ({ev_ph2})) LIMIT 500",
                    ev_and_core + ev_and_core
                ).fetchall():
                    add_edge(er['source'], er['target'], 'evidence')

            # ------------------------------------------------------------------
            # 7. Accumulate stats
            # ------------------------------------------------------------------
            stats["core"] += len(core_rows)
            stats["foundation"] += len(valid_foundation_ids)
            stats["impact"] += len(valid_impact_ids)
            stats["evidence"] += len(valid_evidence_ids)

        except Exception as e:
            print(f"[error] DB {db_path}: {e}")
        finally:
            conn.close()

    if not all_nodes:
        return jsonify({
            "nodes": [], "edges": [], "searchQuery": query,
            "stats": stats,
        })

    return jsonify({
        "nodes": all_nodes,
        "edges": all_edges,
        "searchQuery": query,
        "stats": stats,
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"[info] Starting server on port {port}")
    print(f"[info] Databases found: {[topic_from_db_path(p) for p in get_all_db_paths()]}")
    app.run(host='0.0.0.0', port=port, debug=True)
