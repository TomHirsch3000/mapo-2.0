import sqlite3
import argparse
import os

def clean_database(db_path):
    print(f"Opening {db_path}...")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # 1. Title Case Standardization
    # Consolidate things like "High energy physics" and "high energy physics" into "High Energy Physics"
    print("Standardizing field name casing...")
    
    # We will fetch all distinct AI_primary_field values, then update them to be Title Case
    cursor.execute("SELECT DISTINCT AI_primary_field FROM papers WHERE AI_primary_field IS NOT NULL")
    fields = cursor.fetchall()
    
    updates = 0
    for (field,) in fields:
        if not field: continue
        
        # Step 1: Base title case (e.g., "High energy physics" -> "High Energy Physics")
        target = field.title()
        
        # Step 2: Specific overrides to consolidate near-matches or fix acronym casing
        lower_field = field.lower()
        if lower_field in ["high energy physics", "high-energy physics"]:
            target = "High Energy Physics"
        elif lower_field in ["particle physics", "elementary particle physics"]:
            target = "Particle Physics"
        elif "qcd" in lower_field or "quantum chromodynamics" in lower_field:
            target = "Quantum Chromodynamics"
        elif "string" in lower_field:
            target = "String Theory"
            
        if field != target:
            cursor.execute("UPDATE papers SET AI_primary_field = ? WHERE AI_primary_field = ?", (target, field))
            updates += cursor.rowcount
            
    print(f"Standardized casing for {updates} papers.")

    # 2. Heuristics for "Unassigned" or "Unknown" based on title/abstract keywords
    print("Classifying 'Unassigned' papers using fast keyword matching...")
    
    cursor.execute("SELECT paperId, title, abstract FROM papers WHERE AI_primary_field = 'Unassigned' OR AI_primary_field IS NULL OR AI_primary_field = 'Unknown'")
    unassigned = cursor.fetchall()
    
    keyword_mapping = {
        "String Theory": ["string theory", "superstring", "m-theory", "brane"],
        "Quantum Chromodynamics": ["qcd", "chromodynamics", "quark-gluon", "gluon"],
        "Quantum Electrodynamics": ["qed", "electrodynamics", "dirac equation"],
        "Standard Model": ["standard model", "higgs", "electroweak", "w boson", "z boson"],
        "Neutrino Physics": ["neutrino", "majorana", "solar neutrino", "sterile neutrino"],
        "Lattice Gauge Theory": ["lattice qcd", "lattice gauge"],
        "Supersymmetry": ["supersymmetry", "susy", "neutralino", "chargino"],
        "Dark Matter / Energy": ["dark matter", "dark energy", "wimp", "axion"],
        "Cosmology": ["cosmology", "inflation", "cmb", "cosmic microwave"],
        "Heavy Ion Physics": ["heavy ion", "alice experiment", "quark-gluon plasma"],
        "Particle Physics": ["particle physics", "collider", "lhc", "cern", "fermilab", "tev"]
    }
    
    reassigned = 0
    for paper_id, title, abstract in unassigned:
        text = ((title or "") + " " + (abstract or "")).lower()
        if not text.strip():
            continue
            
        assigned_field = None
        for field, keywords in keyword_mapping.items():
            if assigned_field: break
            for kw in keywords:
                if kw in text:
                    assigned_field = field
                    break
                    
        if assigned_field:
            cursor.execute("UPDATE papers SET AI_primary_field = ? WHERE paperId = ?", (assigned_field, paper_id))
            reassigned += 1
            
    print(f"Heuristically reassigned {reassigned} 'Unassigned' papers.")
    
    # 3. Consolidate small categories (< 5 papers) into broader ones or 'Other' to declutter the graph
    print("Consolidating tiny subfields...")
    cursor.execute("SELECT AI_primary_field, COUNT(*) as c FROM papers GROUP BY AI_primary_field HAVING c < 5")
    tiny_fields = cursor.fetchall()
    
    tiny_updates = 0
    for field, count in tiny_fields:
        if field in ["Unassigned", "Unknown", "Other"]: continue
        
        # We could map them to "Other" or "Particle Physics"
        cursor.execute("UPDATE papers SET AI_primary_field = 'Minor Particle Subfields' WHERE AI_primary_field = ?", (field,))
        tiny_updates += cursor.rowcount
        
    print(f"Consolidated {len(tiny_fields)} tiny fields ({tiny_updates} papers total) into 'Minor Particle Subfields'.")

    conn.commit()
    conn.close()
    print("Database cleanup complete.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    clean_database(args.db)
