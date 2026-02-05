
import urllib.request
import json
import urllib.parse

OPENALEX_BASE = "https://api.openalex.org"

def get(params):
    url = f"{OPENALEX_BASE}/concepts"
    qs = urllib.parse.urlencode(params)
    full = f"{url}?{qs}"
    print(f"Fetching: {full}")
    try:
        with urllib.request.urlopen(full) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = data.get('results', [])
            print(f"Count: {len(results)}")
            for r in results[:3]:
                print(f" - {r['display_name']} (Level {r['level']})")
                print(f"   Ancestors: {r.get('ancestors')}")
    except Exception as e:
        print(f"Error: {e}")

print("--- Fetch Level 1 Concepts ---")
get({"filter": "level:1", "per_page": 5})
