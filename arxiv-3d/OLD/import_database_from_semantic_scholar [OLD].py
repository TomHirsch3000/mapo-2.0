import json
import sqlite3
import gzip

DB_FILE = "physics_graph.db"  # same database file
DATA_FILE = "semantic-scholar-physics.jsonl.gz"  # path to your dataset

# Connect to existing DB
conn = sqlite3.connect(DB_FILE)
cur = conn.cursor()

# Create new tables
cur.execute("""
CREATE TABLE IF NOT EXISTS physics_papers (
    paper_id TEXT PRIMARY KEY,
    title TEXT,
    year INTEGER,
    arxiv_id TEXT,
    doi TEXT,
    fields TEXT
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS physics_citations (
    source_id TEXT,
    target_id TEXT,
    FOREIGN KEY(source_id) REFERENCES physics_papers(paper_id),
    FOREIGN KEY(target_id) REFERENCES physics_papers(paper_id)
)
""")

# Insert logic
def insert_paper_and_citations(paper):
    pid = paper.get("paperId")
    title = paper.get("title")
    year = paper.get("year")
    arxiv_id = paper.get("arxivId")
    doi = paper.get("doi")
    fields = ",".join(paper.get("fieldsOfStudy", []))

    cur.execute("""
    INSERT OR IGNORE INTO physics_papers (paper_id, title, year, arxiv_id, doi, fields)
    VALUES (?, ?, ?, ?, ?, ?)""",
    (pid, title, year, arxiv_id, doi, fields))

    for ref in paper.get("references", []):
        if isinstance(ref, str):
            target_id = ref
        else:
            target_id = ref.get("paperId")
        if target_id:
            cur.execute("""
            INSERT INTO physics_citations (source_id, target_id)
            VALUES (?, ?)""", (pid, target_id))

# Load the dataset line-by-line
with gzip.open(DATA_FILE, 'rt', encoding='utf-8') as f:
    for i, line in enumerate(f):
        try:
            paper = json.loads(line)
            insert_paper_and_citations(paper)
        except Exception as e:
            print(f"Skipping line {i}: {e}")
        if i % 10000 == 0:
            print(f"Processed {i} lines...")
            conn.commit()

conn.commit()
conn.close()
print("✅ Loaded into physics_papers and physics_citations.")
