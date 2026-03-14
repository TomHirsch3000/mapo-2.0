---
description: Backend Processing Pipeline from requirements
---
This workflow executes the data extraction, processing, metadata generation, and frontend JSON building steps as defined in the `backend product state and requirements.md` file.

// turbo-all

### 1. Create universe view
```bash
cd arxiv-3d
python build_universe_json.py --galaxies ^
"1:Astrophysics:astrophysics_nodes.json:astrophysics_edges.json:astrophysics_metadata.json" ^
"2:Condensed Matter:condensed_matter_nodes.json:condensed_matter_edges.json:condensed_matter_metadata.json" ^
"3:Particle Physics:nodes.json:edges.json:metadata.json" ^
--output universe.json --frontend-dir ../arxiv-3d-frontend/public
```

### 2. Extract papers (Top 2000 for Astrophysics)
```bash
cd arxiv-3d
python import_openalex.py ^
    --topic-name "Astrophysics" ^
    --sample 2000 ^
    --db papers_astrophysics.db ^
    --email tom.hirsch3000@gmail.com
```

### 3. Extract papers (Year by year for Particle Physics)
```bash
cd arxiv-3d
python import_openalex.py ^
  --topic-name "particle physics" ^
  --db papers_particle_physics_all.db ^
  --from-year 1900 ^
  --to-year 1950 ^
  --sample 0 ^
  --email tom.hirsch3000@gmail.com ^
  --reset
```

### 4. Build citations edges (Astrophysics)
```bash
cd arxiv-3d
python rebuild_citations_openalex.py --db papers_astrophysics.db
```

### 5. Fetch missing abstracts
```bash
cd arxiv-3d
python fetch_abstracts_s2_arxiv.py --db papers_astrophysics.db
```

### 6. Generate AI metadata
```bash
cd arxiv-3d
python process_ai_metadata.py --db papers_astrophysics.db
```

### 7. Clean and categorize
```bash
cd arxiv-3d
python clean_and_categorize.py --db papers_astrophysics.db --field "Astrophysics" --skip-mislabel
```

### 8. Build frontend JSON
```bash
cd arxiv-3d
python build_frontend_json.py ^
  --db papers_astrophysics.db ^
  --output-nodes astrophysics_nodes.json ^
  --output-edges astrophysics_edges.json ^
  --output-metadata astrophysics_metadata.json ^
  --output-clusters astrophysics_clusters.json ^
  --min-citations 10 ^
  --frontend-dir ../arxiv-3d-frontend/public
```
