
import urllib.request
import json
import urllib.parse

OPENALEX_BASE = "https://api.openalex.org"
PHYSICS_ID_1 = "C121332964" # Found via API search
PHYSICS_ID_2 = "C71924100"  # Example Medicine
PHYSICS_ID_3 = "C121332964" # Physics
PHYSICS_ID_ALT = "C185592682" # From web search? Wait, C185592682 might be something else?

def check_id(cid):
    print(f"\nChecking ID: {cid}")
    url = f"{OPENALEX_BASE}/concepts/{cid}"
    try:
        with urllib.request.urlopen(url) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Name: {data.get('display_name')}")
            print(f"Level: {data.get('level')}")
            print(f"Works: {data.get('works_count')}")
            
            # Try filter with this ID
            url2 = f"{OPENALEX_BASE}/concepts?filter=ancestors.id:{cid},level:1"
            print(f"Testing filter: {url2}")
            with urllib.request.urlopen(url2) as resp2:
                data2 = json.loads(resp2.read().decode("utf-8"))
                print(f"Children found: {data2.get('meta', {}).get('count')}")
    except Exception as e:
        print(f"Error: {e}")

check_id("C121332964") # What I have
check_id("C185592682") # What search suggested?
