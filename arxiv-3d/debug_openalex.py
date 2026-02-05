
import urllib.request
import json
import urllib.parse

OPENALEX_BASE = "https://api.openalex.org"
PHYSICS_ID = "C121332964"

def get(params):
    url = f"{OPENALEX_BASE}/concepts"
    qs = urllib.parse.urlencode(params)
    full = f"{url}?{qs}"
    print(f"Fetching: {full}")
    try:
        with urllib.request.urlopen(full) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Count: {data.get('meta', {}).get('count')}")
            for r in data.get('results', [])[:3]:
                print(f" - {r['display_name']} (Level {r['level']})")
    except Exception as e:
        print(f"Error: {e}")

print("--- Test 1: Ancestors only ---")
get({"filter": f"ancestors.id:{PHYSICS_ID}"})

print("\n--- Test 2: Ancestors + Level 1 ---")
get({"filter": f"ancestors.id:{PHYSICS_ID},level:1"})

print("\n--- Test 3: Check Physics ID directly ---")
get({"filter": f"openalex_id:{PHYSICS_ID}"})
