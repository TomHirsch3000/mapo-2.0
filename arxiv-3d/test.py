# show_schema.py
import sqlite3, os

path = "papers_particle_physics.db"
print("Opening:", os.path.abspath(path))

conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row

print("\nColumns:")
for cid, name, ctype, *_ in conn.execute("PRAGMA table_info(papers)"):
    print(cid, name, ctype)

conn.close()