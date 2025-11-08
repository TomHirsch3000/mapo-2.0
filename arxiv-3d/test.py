import sqlite3, json

with open("nodes.json", encoding="utf-8") as f:
    nodes = json.load(f)
pid_set = {n["id"] for n in nodes}

conn = sqlite3.connect("papers_particle_physics.db")
c = conn.cursor()

# Pick one known ID
test_id = "W1551729708"
print("Is in nodes.json?", test_id in pid_set)

rows = c.execute("SELECT source, target FROM citations WHERE source=? OR target=?", (test_id, test_id)).fetchall()
print("Citations involving", test_id, ":", rows)

for src, dst in rows:
    print("src==node?", src in pid_set, "dst==node?", dst in pid_set, "pair=", (src, dst))
