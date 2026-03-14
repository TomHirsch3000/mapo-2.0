---
description: Build nodes, edges, metadata and cluster JSONs for the frontend
---
// turbo-all

Run the following command to build the frontend JSON files. Adjust `--db`, output paths, `--min-citations`, and `--frontend-dir` according to the user's request.

Default example:
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
