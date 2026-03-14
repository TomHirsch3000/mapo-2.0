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

if __name__ == '__main__':
    # Use environment variables for port to support Render deployment seamlessly
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
