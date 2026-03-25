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


def _safe(row, col, default=""):
    """Safely get a column value from a Row, returning default if missing."""
    return row[col] if col in row.keys() else default


def format_node(row, node_type=None):
    """Format a DB row into a frontend-ready node dict."""
    yr = row['year'] if 'year' in row.keys() else None
    pub_date = _safe(row, 'publicationDate')
    if not yr and pub_date:
        try:
            yr = int(pub_date.split('-')[0])
        except Exception:
            yr = 2000

    cite_count = _safe(row, 'cited_by_count', 0) or _safe(row, 'citationCount', 0) or 0

    node = {
        "id": row['paperId'],
        "title": row['title'],
        "year": yr,
        "citationCount": cite_count,
        "primaryField": _safe(row, 'AI_primary_field') or _safe(row, 'primary_concept') or "Unassigned",
        "abstract": _safe(row, 'AI_summary') or _safe(row, 'abstract') or "No abstract available.",
        "authors": _safe(row, 'all_author_names') or _safe(row, 'first_author_name') or _safe(row, 'authors') or "Unknown",
        "institutions": _safe(row, 'all_institution_names') or "",
        "paperNature": _safe(row, 'paper_nature') or None,
        "iconCategory": _safe(row, 'icon_category') or None,
        "data": dict(row),
    }
    if node_type:
        node["nodeType"] = node_type
    return node


# ---------------------------------------------------------------------------
# /api/paper/<id>/details  -- single-paper neighbourhood
# ---------------------------------------------------------------------------

@app.route('/api/paper/<string:paper_id>/details', methods=['GET'])
def get_paper_details(paper_id):
    try:
        min_citations = int(request.args.get('min_citations', 100))
        max_papers = int(request.args.get('max_papers', 500))
    except ValueError:
        return jsonify({"error": "Invalid min_citations or max_papers parameter. Must be an integer."}), 400

    # Search across all databases for this paper
    for db_path in get_all_db_paths():
        conn = open_conn(db_path)
        try:
            # Check if this paper exists in this DB
            check = conn.execute("SELECT 1 FROM papers WHERE paperId = ?", (paper_id,)).fetchone()
            if not check:
                continue

            # 1. Get all connected edge pairs where the paper is source or target
            raw_edges = conn.execute(
                "SELECT source, target FROM citations WHERE source = ? OR target = ?",
                (paper_id, paper_id)
            ).fetchall()

            # Determine the unique set of paper IDs involved
            connected_ids = {paper_id}
            for row in raw_edges:
                connected_ids.add(row['source'])
                connected_ids.add(row['target'])

            if not connected_ids:
                return jsonify({"nodes": [], "edges": []})

            # 2. Query node details, filtering by min_citations
            # Always include the central paper regardless of citation count
            placeholders = ','.join(['?'] * len(connected_ids))
            params = list(connected_ids) + [min_citations, paper_id, max_papers]
            raw_nodes = conn.execute(
                f"SELECT * FROM papers WHERE paperId IN ({placeholders}) "
                f"AND (cited_by_count >= ? OR paperId = ?) LIMIT ?",
                params
            ).fetchall()

            # Re-verify valid node IDs after filter
            valid_node_ids = {row['paperId'] for row in raw_nodes}

            # 3. Filter edges to only include valid nodes on both ends
            valid_edges = []
            for row in raw_edges:
                if row['source'] in valid_node_ids and row['target'] in valid_node_ids:
                    valid_edges.append({
                        "source": row['source'],
                        "target": row['target'],
                        "importance": 1,
                    })

            # 4. Format nodes
            formatted_nodes = [format_node(row) for row in raw_nodes]

            return jsonify({
                "nodes": formatted_nodes,
                "edges": valid_edges,
            })

        except Exception as e:
            print(f"[error] DB {db_path}: {e}")
        finally:
            conn.close()

    return jsonify({"error": f"Paper {paper_id} not found in any database."}), 404


# ---------------------------------------------------------------------------
# /api/search  -- cross-database search with foundation/impact/evidence steps
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
    seen_node_ids = set()
    stats = {"core": 0, "foundation": 0, "impact": 0, "evidence": 0}

    for db_path in all_db_paths:
        conn = open_conn(db_path)

        try:
            # Check table exists
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
            if 'papers' not in tables:
                continue

            cols = column_names(conn)
            has_nature = 'paper_nature' in cols

            # ------------------------------------------------------------------
            # 1. Core papers -- match the search query
            # ------------------------------------------------------------------
            # Build WHERE clause based on available columns
            search_cols = ['title']
            for opt_col in ['AI_summary', 'abstract', 'AI_primary_field', 'summary']:
                if opt_col in cols:
                    search_cols.append(opt_col)
            where_parts = ' OR '.join(f'{c} LIKE ?' for c in search_cols)
            search_params = [search_term] * len(search_cols)

            cite_col = 'cited_by_count' if 'cited_by_count' in cols else 'citationCount'

            core_rows = conn.execute(
                f"SELECT * FROM papers WHERE ({where_parts}) "
                f"AND {cite_col} >= ? ORDER BY {cite_col} DESC LIMIT ?",
                search_params + [min_citations, max_papers]
            ).fetchall()

            if not core_rows:
                continue

            core_ids = {r['paperId'] for r in core_rows}
            core_id_list = list(core_ids)
            core_ph = ','.join(['?'] * len(core_id_list))

            # ------------------------------------------------------------------
            # 2. Foundation papers -- papers that core papers cite
            # ------------------------------------------------------------------
            foundation_edge_rows = conn.execute(
                f"SELECT source, target FROM citations WHERE source IN ({core_ph}) LIMIT 500",
                core_id_list
            ).fetchall()
            foundation_target_ids = {r['target'] for r in foundation_edge_rows} - core_ids

            # ------------------------------------------------------------------
            # 3. Impact papers -- papers that cite core papers
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
                    f"ORDER BY {cite_col} DESC LIMIT {limit}",
                    ids
                ).fetchall()

            foundation_rows = fetch_by_ids(foundation_target_ids, MAX_CONTEXT)
            impact_rows = fetch_by_ids(impact_source_ids, MAX_CONTEXT)

            valid_foundation_ids = {r['paperId'] for r in foundation_rows}
            valid_impact_ids = {r['paperId'] for r in impact_rows}

            # ------------------------------------------------------------------
            # 4. Evidence papers -- experimental papers connected to core
            # ------------------------------------------------------------------
            evidence_rows = []
            valid_evidence_ids = set()
            if has_nature:
                # Find experimental papers among foundation + impact
                context_ids = valid_foundation_ids | valid_impact_ids
                if context_ids:
                    ctx_list = list(context_ids)
                    ctx_ph = ','.join(['?'] * len(ctx_list))
                    evidence_rows = conn.execute(
                        f"SELECT * FROM papers WHERE paperId IN ({ctx_ph}) "
                        f"AND paper_nature = 'experimental' "
                        f"ORDER BY cited_by_count DESC LIMIT {MAX_CONTEXT}",
                        ctx_list
                    ).fetchall()
                    valid_evidence_ids = {r['paperId'] for r in evidence_rows}

            # ------------------------------------------------------------------
            # 5. Collect all valid node IDs for edge filtering
            # ------------------------------------------------------------------
            all_valid_ids = core_ids | valid_foundation_ids | valid_impact_ids | valid_evidence_ids

            # ------------------------------------------------------------------
            # 6. Format nodes (deduplicate across DBs)
            # ------------------------------------------------------------------
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
            # 7. Edges between valid nodes
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
                ev_ph = ','.join(['?'] * len(ev_and_core))
                for er in conn.execute(
                    f"SELECT source, target FROM citations "
                    f"WHERE source IN ({ev_ph}) AND target IN ({ev_ph}) LIMIT 500",
                    ev_and_core + ev_and_core
                ).fetchall():
                    add_edge(er['source'], er['target'], 'evidence')

            # ------------------------------------------------------------------
            # 8. Accumulate stats
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
    print(f"[info] DB directory: {DB_DIR}")
    print(f"[info] Databases found: {[topic_from_db_path(p) for p in get_all_db_paths()]}")
    app.run(host='0.0.0.0', port=port, debug=True)
