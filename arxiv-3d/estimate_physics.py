import sqlite3
import os
import urllib.request
import urllib.parse
import json

DB_PATH = "papers_classical_mechanics_all.db"

def get_db_stats():
    if not os.path.exists(DB_PATH):
        return None
    sz = os.path.getsize(DB_PATH)
    try:
        conn = sqlite3.connect(DB_PATH)
        count = conn.execute("SELECT count(*) FROM papers").fetchone()[0]
        conn.close()
        if count == 0:
            return None
        return sz, count
    except Exception as e:
        print(f"DB Error: {e}")
        return None

def get_openalex_concept_works_count(concept_id):
    url = f"https://api.openalex.org/concepts/{concept_id}"
    req = urllib.request.Request(url, headers={'User-Agent': 'mailto:tom.hirsch3000@gmail.com'})
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read())
        return data.get('works_count', 0), data.get('display_name', '')

def get_physics_subfields():
    subfields = [
        "Classical mechanics",
        "Quantum mechanics",
        "Thermodynamics",
        "Electromagnetism",
        "Optics",
        "Particle physics",
        "Nuclear physics",
        "Astrophysics",
        "Condensed matter physics",
        "Biophysics",
        "Geophysics",
        "Fluid dynamics"
    ]
    results = []
    for name in subfields:
        url = f"https://api.openalex.org/concepts?filter=display_name.search:{urllib.parse.quote(name)},level:1&per_page=1"
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'mailto:tom.hirsch3000@gmail.com'})
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read())
                if data.get('results'):
                    res = data['results'][0]
                    # verify exact name match just in case
                    if res['display_name'].lower() == name.lower() or name.lower() in res['display_name'].lower():
                        results.append((res['id'].split('/')[-1], res['display_name'], res['works_count']))
        except Exception as e:
            print(f"Error fetching {name}: {e}")
    return results

def main():
    stats = get_db_stats()
    if stats:
        sz, count = stats
        bytes_per_paper = sz / count
        print(f"Current DB: {count:,} papers, {sz / 1024 / 1024:.2f} MB")
        print(f"Estimated size per paper: {bytes_per_paper:.2f} bytes ({bytes_per_paper / 1024:.2f} KB)")
    else:
        print("Could not get DB stats. Using fallback estimate of 4000 bytes/paper.")
        bytes_per_paper = 4000

    print("\nFetching data from OpenAlex...")
    phys_count, phys_name = get_openalex_concept_works_count("C121332964")
    
    print("\n" + "="*60)
    print(f"TOTAL FOR ALL OF PHYSICS ({phys_name.upper()})")
    print(f"Total Works on OpenAlex: {phys_count:,}")
    est_gb = phys_count * bytes_per_paper / (1024**3)
    print(f"Estimated total SQLite DB disk size: {est_gb:.2f} GB")
    print("="*60)

    print("\n--- Breakdown by Level 1 Topics ---")
    subfields = get_physics_subfields()
    subfields.sort(key=lambda x: x[2], reverse=True)
    for cid, name, count in subfields:
        num_gb = count * bytes_per_paper / (1024**3)
        print(f"{name.replace('mechanics', 'Mechanics'):<40} | {count:>12,} papers | {num_gb:>6.2f} GB")

if __name__ == "__main__":
    main()
