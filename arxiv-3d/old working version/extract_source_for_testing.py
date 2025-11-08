import feedparser
from openai import OpenAI
import json
import time
import requests
import re
import random
import shutil
import math
import ast

# Set up OpenAI client for Ollama
client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama"
)

# 1. Fetch arXiv papers
def fetch_arxiv_papers(category="physics.gen-ph", max_results=3):
    print(f"Fetching {max_results} papers from arXiv...")
    url = f"http://export.arxiv.org/api/query?search_query=cat:{category}&start=0&max_results={max_results}"
    feed = feedparser.parse(url)
    papers = []
    papers_meta = []
    for entry in feed.entries:
        categories = [tag['term'] for tag in entry.tags]
        primary_category = categories[0]
        secondary_categories = categories[1:]  # optional

        papers.append({
            "id": entry.id.split('/')[-1],
            "id_cat": entry.id.split('/')[-2],
            "title": entry.title,
            "abstract": entry.summary,
            "pdf_url": entry.links[1].href if len(entry.links) > 1 else None,
            "arxiv_url": entry.id,
            "authors": [author.name for author in entry.authors],
            "category_primary": primary_category,
            "categories_all": categories

        })
        papers_meta = [
            {k: v for k, v in paper.items() if k != "abstract"}
            for paper in papers
            ]
        #print(papers_meta)
    return papers

def fetch_arxiv_papers_by_id_list(arxiv_ids):
    """
    Fetches papers from arXiv given a list of arXiv IDs.
    Matches the structure of fetch_arxiv_papers().
    """
    print(f"Fetching {len(arxiv_ids)} papers from arXiv by ID")
    id_list = ",".join(arxiv_ids)
    url = f"http://export.arxiv.org/api/query?id_list={id_list}"
    feed = feedparser.parse(url)

    papers = []
    papers_meta = []

    for entry in feed.entries:
        categories = [tag['term'] for tag in entry.tags]
        primary_category = categories[0]
        secondary_categories = categories[1:]

        papers.append({
            "id": entry.id.split('/')[-1],
            "id_cat": entry.id.split('/')[-2],
            "title": entry.title,
            "abstract": entry.summary,
            "pdf_url": entry.links[1].href if len(entry.links) > 1 else None,
            "arxiv_url": entry.id,
            "authors": [author.name for author in entry.authors],
            "category_primary": primary_category,
            "categories_all": categories
        })

        papers_meta = [
            {k: v for k, v in paper.items() if k != "abstract"}
            for paper in papers
        ]
        print(papers_meta)

    return papers


# get the number of citations from semanticscholar
def clean_arxiv_id(raw_id, category=None):
    """
    Normalizes arXiv ID for Semantic Scholar API.
    - Strips version numbers (e.g., v1, v10)
    - Converts old-style IDs to `category/NNNNNNN`
    - Returns None if ID is invalid or can't be resolved
    """
    if not raw_id:
        return None

    raw_id = raw_id.strip()
    no_version = re.sub(r'v\d+$', '', raw_id)

    if '/' in no_version:
        return no_version  # already old-style (e.g., hep-th/9702026)

    if '.' in no_version:
        return no_version  # already clean new-style (e.g., 2403.12345)

    if category and re.match(r'^\d{7}$', no_version):
        return f"{category}/{no_version}"

    print(f"⚠️ Could not clean arXiv ID: {raw_id}")
    return None


def get_semantic_scholar_data(arxiv_id):
    """
    Returns (citationCount, list of cited arXiv IDs)
    """
    url = f"https://api.semanticscholar.org/graph/v1/paper/arXiv:{arxiv_id}?fields=paperId,citationCount,references.externalIds,references.paperId"

    try:
        response = requests.get(url)
        if response.status_code == 200:
            try:
                data = response.json()
                citation_count = data.get("citationCount", 0)
                source_paper_id = data.get("paperId")

                citees = []
                citees_paperid = []

                for ref in data.get("references", []):
                    external_ids = ref.get("externalIds")
                    paper_id = ref.get("paperId")
                    
                    if paper_id:
                        citees_paperid.append(paper_id)

                return citation_count, citees, citees_paperid, source_paper_id


            except Exception as parse_err:
                print(f"⚠️ Failed to parse Semantic Scholar data for {arxiv_id}: {parse_err}")
    except Exception as e:
        print(f"⚠️ Failed to get data from Semantic Scholar for {arxiv_id}: {e}")
    
    return 0, []


def main():
    papers = fetch_arxiv_papers(max_results=40)
    needed = 5
    seeds = []
    all_paper_ids = set()

    for paper in papers:
        arxiv_id_clean = clean_arxiv_id(paper['id'], paper['id_cat'])
        print("arxivID cleaned up =:", arxiv_id_clean)

        citations, _, citees_paperid, source_paper_id = get_semantic_scholar_data(arxiv_id_clean)

        if citations > 10 and source_paper_id:
            print(f"✅ {source_paper_id} | {citations} citations")
            seeds.append(source_paper_id)
            all_paper_ids.add(source_paper_id)
            all_paper_ids.update(citees_paperid)

        time.sleep(1)  # polite pause
        if len(seeds) >= needed:
            break

    all_paper_ids_list = list(all_paper_ids)
    print(f"\n🎯 Found {len(seeds)} seed papers.")
    print(f"📄 Total unique paperIds (seeds + citees): {len(all_paper_ids_list)}")
    print(f"🧱 Paper ID list: {all_paper_ids_list}")

    return all_paper_ids_list

if __name__ == "__main__":
    main()


