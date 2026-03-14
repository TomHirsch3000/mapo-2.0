---
description: Clean, relabel, and categorize papers
---
// turbo-all

Run the following command to clean and categorize papers. Adjust `--db`, `--field`, and flags (`--limit`, `--skip-mislabel`, `--skip-standardize`) according to the user's request.

Default example:
```bash
cd arxiv-3d
python clean_and_categorize.py --db papers_astrophysics.db --field "Astrophysics" --skip-mislabel
```
