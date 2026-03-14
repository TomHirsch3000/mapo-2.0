---
description: Import papers from OpenAlex
---
// turbo-all

Run the following command to import papers for a topic. Adjust `--topic-name`, `--sample`, `--db`, `--email`, `--from-year`, `--to-year` according to the user's request.

Default example (Top 2000 astrophysics):
```bash
cd arxiv-3d
python import_openalex.py ^
    --topic-name "Astrophysics" ^
    --sample 2000 ^
    --db papers_astrophysics.db ^
    --email tom.hirsch3000@gmail.com
```

Default example (Year by year particle physics):
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
