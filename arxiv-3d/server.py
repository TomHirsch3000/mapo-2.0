import os
import sqlite3
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
# Enable CORS for all routes, allowing the React app to communicate with the API
CORS(app)

DB_PATH = os.path.join(os.path.dirname(__file__), 'papers_particle_physics_all.db')

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

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
                "iconCategory": row['icon_category'] if 'icon_category' in row.keys() else None,

                # Maintain original DB row under data for any edge cases
                "data": dict(row)
            }
            formatted_nodes.append(node)
            
        return jsonify({
            "nodes": formatted_nodes,
            "edges": valid_edges
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()

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

    conn = get_db_connection()
    try:
        search_term = f'%{query}%'

        # 1. Find core papers matching the search query
        core_rows = conn.execute("""
            SELECT * FROM papers
            WHERE (title LIKE ? OR AI_summary LIKE ? OR abstract LIKE ? OR AI_primary_field LIKE ?)
            AND cited_by_count >= ?
            ORDER BY cited_by_count DESC
            LIMIT ?
        """, (search_term, search_term, search_term, search_term, min_citations, max_papers)).fetchall()

        if not core_rows:
            return jsonify({
                "nodes": [], "edges": [], "searchQuery": query,
                "stats": {"core": 0, "foundation": 0, "impact": 0}
            })

        core_ids = set(row['paperId'] for row in core_rows)
        core_ph = ','.join(['?'] * len(core_ids))
        core_id_list = list(core_ids)

        # 2. Foundation papers: papers that core papers cite (the evidence chain — why we believe it)
        foundation_edge_rows = conn.execute(
            f"SELECT source, target FROM citations WHERE source IN ({core_ph}) LIMIT 500",
            core_id_list
        ).fetchall()
        foundation_target_ids = set(r['target'] for r in foundation_edge_rows) - core_ids

        # 3. Impact papers: papers that cite core papers (where this led)
        impact_edge_rows = conn.execute(
            f"SELECT source, target FROM citations WHERE target IN ({core_ph}) LIMIT 500",
            core_id_list
        ).fetchall()
        impact_source_ids = set(r['source'] for r in impact_edge_rows) - core_ids

        # 4. Fetch context node details (top by citation count)
        MAX_CONTEXT = 30

        def fetch_context_nodes(id_set, limit):
            if not id_set:
                return []
            ids = list(id_set)
            ph = ','.join(['?'] * len(ids))
            return conn.execute(
                f"SELECT * FROM papers WHERE paperId IN ({ph}) ORDER BY cited_by_count DESC LIMIT {limit}",
                ids
            ).fetchall()

        foundation_rows = fetch_context_nodes(foundation_target_ids, MAX_CONTEXT)
        impact_rows = fetch_context_nodes(impact_source_ids, MAX_CONTEXT)

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
                "iconCategory": row['icon_category'] if 'icon_category' in row.keys() else None,
                "nodeType": node_type,
                "data": dict(row)
            }

        formatted_nodes = (
            [format_node(r, 'core') for r in core_rows] +
            [format_node(r, 'foundation') for r in foundation_rows] +
            [format_node(r, 'impact') for r in impact_rows]
        )

        # 6. Build edges between valid nodes
        all_valid_ids = core_ids | valid_foundation_ids | valid_impact_ids
        seen_edges = set()
        edges_out = []

        def add_edge(source, target, edge_type):
            key = f"{source}|{target}"
            if key not in seen_edges and source in all_valid_ids and target in all_valid_ids:
                seen_edges.add(key)
                edges_out.append({"source": source, "target": target, "importance": 1, "edgeType": edge_type})

        for row in foundation_edge_rows:
            add_edge(row['source'], row['target'], 'foundation')
        for row in impact_edge_rows:
            add_edge(row['source'], row['target'], 'impact')

        return jsonify({
            "nodes": formatted_nodes,
            "edges": edges_out,
            "searchQuery": query,
            "stats": {
                "core": len(core_rows),
                "foundation": len(valid_foundation_ids),
                "impact": len(valid_impact_ids)
            }
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


if __name__ == '__main__':
    # Use environment variables for port to support Render deployment seamlessly
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
