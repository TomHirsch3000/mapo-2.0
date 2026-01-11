
import sqlite3
import os

db_path = "arxiv-3d/papers_particle_physics_all.db"
if not os.path.exists(db_path):
    print(f"Error: {db_path} not found")
else:
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(papers)")
        columns = [row[1] for row in cursor.fetchall()]
        print(f"Columns in {db_path} papers table:", columns)
        conn.close()
    except Exception as e:
        print(e)
