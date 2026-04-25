


-------------------------------------------------
# open the backend systems
-------------------------------------------------
open ollama -- this is the ai environment

Open CMD

navigate to venv environment -- python environment 
cd C:\Users\TomHi\Documents\GitHub\mapo-2.0\arxiv-3d

start venv
.\venv\Scripts\activate 

open jupyter 
jupyter lab

-------------------------------------------------
# run python scripts
-------------------------------------------------

### Create universe view
- Run from arxiv-3d directory

```bash
python build_universe_json.py --galaxies ^
"1:Astrophysics:astrophysics_nodes.json:astrophysics_edges.json:astrophysics_metadata.json" ^
"2:Condensed Matter:condensed_matter_nodes.json:condensed_matter_edges.json:condensed_matter_metadata.json" ^
"3:Particle Physics:nodes.json:edges.json:metadata.json" ^
--output universe.json --frontend-dir ../arxiv-3d-frontend/public
```
 
### extract papers
Objective
Take a list of papers from a particular field from openalex, restrict the list by whatever parameters I want (e.g. top 2000 papers by citations, papers with over 100 citations, papers from a certain year range) and import them into the database. 

```bash
- import top 2000 papers from topic
    -   run for astrophysics
    - python import_openalex.py ^
    --topic-name "Astrophysics" ^
    --sample 2000 ^
    --db papers_astrophysics.db ^
    --email tom.hirsch3000@gmail.com
```
Import year by year
```bash
:: 1900–1950
python import_openalex.py ^
  --topic-name "particle physics" ^
  --db papers_particle_physics_all.db ^
  --from-year 1900 ^
  --to-year 1950 ^
  --sample 0 ^
  --email tom.hirsch3000@gmail.com ^
  --reset
```

### build citations edges

Objective 
Take the list of papers which have been selected to be included using the import_openalex.py script, these are all the papers present in the database. find all citiations and references for the papers but then only include citations from or references to other papers within the database. 

run for astrophysics
```bash
     -   python rebuild_citations_openalex.py --db papers_astrophysics.db
```
### Find rows missing abstracts from semantic scholar and arxiv
Objective
Take the list of papers which have been selected to be included using the import_openalex.py script, these are all the papers present in the database. Identify papers which are missing an abstract and try to fetch them from alternative sources such as semantic scholar and arxiv.

run for astrophysics
```bash
    - python fetch_abstracts_s2_arxiv.py --db papers_astrophysics.db
```
### generate AI metadata
Objective
Take the list of papers which have been selected to be included using the import_openalex.py script, these are all the papers present in the database. Use the llm to generate metadata for each paper, including a summary, keywords.

run for astrophysics
```bash
python process_ai_metadata.py --db papers_astrophysics.db
```

### Generate or extract pictures or icons 

Objective
 Each field of physics in the universe view will be represented by a hexagon known as a galaxy. This process should generate an icon or picture for each galaxy which will be contained within the hexagon. It should allow the user to intuitively understand what is contained within the hexagon. e.g. for classical mechanics it should show a picture of a pendulum or a ball on a string. 

### re label papers and exclude mislabeled
Objective
1. Take the list of papers which have been selected to be included using the import_openalex.py script, these are all the papers present in the database. Identify papers which are mislabeled.If it finds a paper which is not relevant to the field then it creats a flag 1 in a new column called mislabelled paper. 
2. take the list of physics fields from the AI field list column, I want to count the total number of instances of each field. Then I want it to create a subset of the fields listed with a limited number, I think 50 is the right number to try for now. then I want it to go through each row and find the closest matching field to one in the list of 50. It should do this first by reading all of that papers fields and finding the first match, if there are no matches then it should call the llm to read the abstract and try to assign it to one of the 50 fields. It should output this into the AI primary field column, even if that is already populated

run for astrophysics
```bash
python clean_and_categorize.py --db papers_astrophysics.db --field "Astrophysics" --skip-mislabel

Options
--limit <N>: Only process the first N papers (useful for testing).
--skip-mislabel: Skip the relevance check step.
--skip-standardize: Skip the field standardization step.
```

### Generate nodes.json + edges.json for the frontend
Objective
Take the list of papers which have been selected to be included using the import_openalex.py script, these are all the papers present in the database. Generate a nodes.json and edges.json file for the frontend.

run for astrophysics
```bash
  python build_frontend_json.py ^
  --db papers_astrophysics.db ^
  --output-nodes astrophysics_nodes.json ^
  --output-edges astrophysics_edges.json ^
  --output-metadata astrophysics_metadata.json ^
  --output-clusters astrophysics_clusters.json ^
  --min-citations 10 ^
  --frontend-dir ../arxiv-3d-frontend/public
```

run for particle physics (with experimental boost — guarantees top 500 experimental/phenomenological papers are included even if below the top-N citation threshold)
```bash
  python build_frontend_json.py ^
  --db papers_particle_physics_all.db ^
  --output-nodes particle_physics_nodes.json ^
  --output-edges particle_physics_edges.json ^
  --output-metadata particle_physics_metadata.json ^
  --output-clusters particle_physics_clusters.json ^
  --min-citations 10 ^
  --top-n 2000 ^
  --experimental-boost 500 ^
  --compute-clusters ^
  --frontend-dir ../arxiv-3d-frontend/public
```

**`--experimental-boost N`** flag: after selecting the main top-N papers, also queries the top N experimental/phenomenological papers (by citations) and merges them in, deduplicating by paperId. This ensures experimental papers are well-represented even if they fall below the general citation threshold. The output JSON also includes `paperNature` and `iconCategory` fields for each paper.

**Note**: After running, also ensure `universe.json` has the correct `nodesFile` path for particle physics (`particle_physics_nodes.json`, not `data/particle_physics_nodes.json`).

### Autocomplete search
The search bar supports type-ahead autocomplete. As the user types, it matches paper titles from all loaded galaxy JSON files client-side (no server call). Selecting a suggestion navigates directly to that paper's galaxy and field view. If the user types and presses Search without selecting a suggestion, the normal server-based topic search runs instead.

The autocomplete index is built at startup by fetching all galaxy `nodesFile` JSONs (the same files already served as static assets). With ~8400 papers across 4 galaxies, this is a fast, lightweight operation cached by the browser.