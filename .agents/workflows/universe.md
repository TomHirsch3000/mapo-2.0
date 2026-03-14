---
description: Build the universe view JSON
---
// turbo-all

Run the following command to build the universe JSON. Adjust `--galaxies`, `--output`, and `--frontend-dir` according to the user's request.

Default example:
```bash
cd arxiv-3d
python build_universe_json.py --galaxies ^
"1:Astrophysics:astrophysics_nodes.json:astrophysics_edges.json:astrophysics_metadata.json" ^
"2:Condensed Matter:condensed_matter_nodes.json:condensed_matter_edges.json:condensed_matter_metadata.json" ^
"3:Particle Physics:nodes.json:edges.json:metadata.json" ^
--output universe.json --frontend-dir ../arxiv-3d-frontend/public
```
