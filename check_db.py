
import sqlite3

try:
    conn = sqlite3.connect("arxiv-3d/papers.db")
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(papers)")
    columns = [row[1] for row in cursor.fetchall()]
    print("Columns in papers table:", columns)
    conn.close()
except Exception as e:
    print(e)
