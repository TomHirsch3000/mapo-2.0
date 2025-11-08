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
        print(papers_meta)
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



# 2. Summarize using local model
def summarize_text(text):
    response = client.chat.completions.create(
        model="mistral",
        messages=[{
            "role": "user",
            "content": f"Summarize this scientific abstract:\n\n{text}"
        }]
    )
    return response.choices[0].message.content.strip()

def AI_category(text):
    response = client.chat.completions.create(
        model="mistral",
        messages=[{
            "role": "user",
            "content": f"provide a concise categorization for this scientific paper to help with grouping papers together into themes based on this abstract:\n\n{text}"
        }]
    )
    return response.choices[0].message.content.strip()

def AI_category_one(text):
    response = client.chat.completions.create(
        model="mistral",
        messages=[{
            "role": "user",
            "content": f"in a few key words pick the closest field of physics for this scientific paper based on this abstract, format the result as python list:\n\n{text}"
        }]
    )
    return response.choices[0].message.content.strip()


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
    url = f"https://api.semanticscholar.org/graph/v1/paper/arXiv:{arxiv_id}?fields=citationCount,references.externalIds"
    try:
        response = requests.get(url)
        if response.status_code == 200:
            try:
                data = response.json()
                citation_count = data.get("citationCount", 0)
                citees = []

                for ref in data.get("references", []):
                    external_ids = ref.get("externalIds") or {}
                    paper_id = ref.get("paperId")
                    
                    print("paperID =:", paper_id)
                    if "arxiv" in external_ids:
                        citees.append({"type": "arxiv", "id": external_ids["arxiv"]})
                    elif "DOI" in external_ids:
                        citees.append({"type": "doi", "id": external_ids["DOI"]})
                    elif paper_id:
                        citees.append({"type": "paperId", "id": paper_id})


                return citation_count, citees


            except Exception as parse_err:
                print(f"⚠️ Failed to parse Semantic Scholar data for {arxiv_id}: {parse_err}")
    except Exception as e:
        print(f"⚠️ Failed to get data from Semantic Scholar for {arxiv_id}: {e}")
    
    return 0, []


# position and size based on number of citations
def get_position_from_citations(citations, scale=100):
    """
    Highly cited papers are placed further from center.
    Low-citation papers stay close to center.
    """
    # Prevent log(0)
    citations = max(citations, 1)

    # Scale distance up with log(citations)
    distance = scale * math.log10(citations + 1)

    return [
        (random.random() - 0.5) * distance,
        (random.random() - 0.5) * distance,
        (random.random() - 0.5) * distance
    ]


def get_size_from_citations(citations, base=0.5, max_size=2.0):
    # Logarithmic growth: avoids huge jumps
    if citations <= 0:
        return base

    # Exponential growth (sublinear), add to base
    size = base + 0.5 * (citations ** 0.4)

    # Cap total size
    return round(min(size, max_size), 2)


# 3. Main logic
def main():
    #remove the sampling method and force a list of papers that we know have a citation for each other
 #   papers = fetch_arxiv_papers(max_results=4)
    papers = fetch_arxiv_papers_by_id_list([
    "2302.13971", "2207.05209", "2302.02096"
])
    nodes = []
    
    for paper in papers:
        print(f"Summarizing: {paper['title'][:60]}...")
        print("arXiv ID:", paper['id'], "  catagory", paper['category_primary'], "  ID catagory", paper['id_cat'])

        arxiv_id_clean = clean_arxiv_id(paper['id'], paper['id_cat'])
        print("arxivID cleaned up =:", arxiv_id_clean)

        citations, citees = get_semantic_scholar_data(arxiv_id_clean)

        print("citation number with ID cat =:", citations)

        #summary = summarize_text(paper['abstract'])
        #AI_category_word = AI_category(paper['abstract'])
        AI_category_list = AI_category_one(paper['abstract'])
        AI_field_list = ast.literal_eval(AI_category_list)
        AI_primary_field = AI_field_list[0]
        position = get_position_from_citations(citations)
        size = get_size_from_citations(citations)
        nodes.append({
            "id": paper['id'],
            "title": paper['title'],
            "citations": citations,
            #"summary": summary,
            #"AI_category": AI_category_word,
            "AI_field_list": AI_field_list,
            "AI_primary_field": AI_primary_field,
            "pdf_url": paper['pdf_url'],
            "arxiv_url": paper['arxiv_url'],
            "authors": paper['authors'],
            "citees": citees,
            "position": position,
            "category": paper['category_primary'],
            "categories_all": paper['categories_all'],
            "ID_category": paper['id_cat'],
            "size": size
        })
        time.sleep(1)  # polite pause between summaries

    with open("nodes.json", "w", encoding="utf-8") as f:
        json.dump(nodes, f, indent=2, ensure_ascii=False)
    print("\n✅ Done! Output saved to nodes.json")

    # Copy output to frontend
    destination = "../arxiv-3d-frontend/public/nodes.json"  # Adjust if needed
    try:
        shutil.copy("nodes.json", destination)
        print(f"📁 Copied nodes.json to frontend: {destination}")
    except Exception as e:
        print(f"❌ Failed to copy nodes.json: {e}")



    # Build citation edges
    edges = []
    arxiv_ids = set(node["id"] for node in nodes)

    for source in nodes:
        for target in source.get("citees", []):
            target_id = target["id"]
            if target["type"] == "arxiv" and target_id in arxiv_ids:
                edges.append({
                    "source": source["id"],
                    "target": target_id
                })

    # Save edges
    with open("edges.json", "w", encoding="utf-8") as f:
        json.dump(edges, f, indent=2)

    # copy to frontend
    try:
        shutil.copy("edges.json", "../arxiv-3d-frontend/public/edges.json")
        print("📁 Copied edges.json to frontend.")
    except Exception as e:
        print(f"❌ Failed to copy edges.json: {e}")





if __name__ == "__main__":
    main()
