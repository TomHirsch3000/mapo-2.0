import feedparser
from openai import OpenAI
import json
import time
from datetime import datetime
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
        }],
        temperature=0,      # Deterministic
        #top_k=1,            # Only most likely token
        top_p=0             # Disable nucleus sampling
    )
    return response.choices[0].message.content.strip()

    

def get_semantic_scholar_paper(paper_id, max_retries=5, base_delay=10, api_key=None):
    """
    Fetch metadata, references, and citations for a given Semantic Scholar paperId.
    Handles rate limits (429) with exponential backoff and random jitter.
    """

    import math

    base_url = "https://api.semanticscholar.org/graph/v1"
    field_params = "fields=title,abstract,citationCount,authors.name,fieldsOfStudy,year,publicationDate,references.paperId"
    metadata_url = f"{base_url}/paper/{paper_id}?{field_params}"
    citations_url = f"{base_url}/paper/{paper_id}/citations?fields=citingPaper.paperId"

    headers = {
        "User-Agent": "arxiv-3d-reader/0.1"
    }
    if api_key:
        headers["x-api-key"] = api_key

    def safe_get(url, desc):
        for attempt in range(max_retries):
            try:
                resp = requests.get(url, headers=headers)
                if resp.status_code == 429:
                    backoff = base_delay * (2 ** attempt) + random.uniform(0, 3)
                    print(f"⚠️ 429 Too Many Requests while fetching {desc}. Sleeping {backoff:.1f}s...")
                    time.sleep(backoff)
                    continue
                resp.raise_for_status()
                if not resp.content:
                    raise ValueError(f"{desc} response was empty")
                return resp.json()
            except Exception as e:
                print(f"⚠️ Error fetching {desc}, attempt {attempt + 1}/{max_retries}: {e}")
                time.sleep(base_delay)
        print(f"❌ Giving up on {desc} after {max_retries} retries.")
        return None

    # Fetch metadata
    data = safe_get(metadata_url, "metadata")
    if not data:
        return None, [], []

    metadata = {
        "paperId": paper_id,
        "title": data.get("title", ""),
        "abstract": data.get("abstract", ""),
        "citationCount": data.get("citationCount", 0),
        "authors": [a.get("name", "") for a in data.get("authors") or []],
        "fieldsOfStudy": data.get("fieldsOfStudy", []),
        "year": data.get("year"),
        "publicationDate": data.get("publicationDate")
    }

    # Defensive programming in case references is None
    references_raw = data.get("references") or []
    references = [ref["paperId"] for ref in references_raw if isinstance(ref, dict) and ref.get("paperId")]

    # Sleep politely
    time.sleep(base_delay + random.uniform(0, 2))

    # Fetch citations
    citation_data = safe_get(citations_url, "citations")
    citations = []
    if citation_data:
        for c in citation_data.get("data", []):
            citing = c.get("citingPaper")
            if citing and citing.get("paperId"):
                citations.append(citing["paperId"])

    return metadata, references, citations



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
    papers =     ['d20793b5044b7bab20e5b1a791c7ca1672b4073e', 'd9d9d2beffdc5dbd9b23e875321355e9c3f6530f', '0b3557d343dfb2ba86c2819c9e4844fe73637ae4']

    nodes = []
    
    for paper in papers:
 
        metadata, references, citations = get_semantic_scholar_paper(paper)
        if not metadata:
            print(f"⚠️ Outer error, Skipping {paper} — failed to fetch metadata.")
            continue  # skip this iteration if metadata is missing

        print(f"Summarizing: {metadata['title'][:60]}...")

        print("citation number =:", metadata['citationCount'])

        #summary = summarize_text(paper['abstract'])
        #AI_category_word = AI_category(paper['abstract'])
        AI_category_list = AI_category_one(metadata['abstract'])
        try:
            AI_field_list = ast.literal_eval(AI_category_list)
            AI_primary_field = AI_field_list[0]
        except Exception as e:
            print(f"⚠️ Failed to parse AI_category_list: {AI_category_list}")
            AI_field_list = ["Unknown"]
            AI_primary_field = "Unknown"

        # date_str = metadata["publicationDate"] or f"{metadata['year']}-01-01"
        # try:
        #     date = datetime.strptime(date_str, "%Y-%m-%d")
        # except:
        #     date = datetime.strptime("2000-01-01", "%Y-%m-%d")
        # x = time.mktime(date.timetuple()) / 1e9

        x = (metadata["year"] - 1950) * 10  # 10 units per year
        y = hash(AI_primary_field) % 50 - 25  # map field to y
        z = math.log1p(metadata['citationCount']) * 10  # map citations to z
        position = [x, y, z]

        #position = get_position_from_citations(metadata['citationCount'])
        size = get_size_from_citations(metadata['citationCount'])

        nodes.append({
            "id": metadata['paperId'],
            "title": metadata['title'],
            "citationCount": metadata['citationCount'],  # total number of incoming citations
            "AI_field_list": AI_field_list,
            "AI_primary_field": AI_primary_field,
            "url": f"https://www.semanticscholar.org/paper/{paper}",
            "authors": metadata['authors'],
            "fieldsOfStudy": metadata['fieldsOfStudy'],
            "references": references,        # outgoing links (what this paper cites)
            "citedBy": citations,            # incoming links (who cites this paper)
            "year": metadata["year"],
            "publicationDate": metadata["publicationDate"],
            "position": position,
            "size": size
        })

        time.sleep(5)  # polite pause between summaries

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
    paper_ids = set(node["id"] for node in nodes)

    for target in nodes:
        citing_ids = target.get("citedBy", [])
        total_sources = len(citing_ids)

        for idx, source_id in enumerate(citing_ids):
            if source_id in paper_ids:
                weight = 1.0 - (idx / total_sources) if total_sources else 1.0
                weight = round(max(weight, 0.1), 3)
                edges.append({
                    "source": source_id,
                    "target": target["id"],
                    "weight": weight
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
