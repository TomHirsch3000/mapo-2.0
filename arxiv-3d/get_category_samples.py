import sqlite3, json

conn = sqlite3.connect('papers_particle_physics_all.db')
conn.row_factory = sqlite3.Row

cats = conn.execute(
    "SELECT icon_category, COUNT(*) as n FROM papers "
    "WHERE icon_category IS NOT NULL AND icon_category != '' "
    "AND paper_nature IN ('experimental', 'phenomenological') "
    "GROUP BY icon_category ORDER BY n DESC"
).fetchall()

results = {}
for cat_row in cats:
    cat = cat_row['icon_category']
    samples = conn.execute(
        "SELECT title FROM papers WHERE icon_category = ? AND abstract IS NOT NULL "
        "ORDER BY cited_by_count DESC LIMIT 3",
        (cat,)
    ).fetchall()
    results[cat] = {
        'count': cat_row['n'],
        'sample_titles': [s['title'] for s in samples]
    }

conn.close()
print(json.dumps(results, indent=2))
