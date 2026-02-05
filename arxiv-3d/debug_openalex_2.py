
import urllib.request
import json
import urllib.parse

OPENALEX_BASE = "https://api.openalex.org"
CONDENSED_MATTER_ID = "C26873012"

def get(params):
    url = f"{OPENALEX_BASE}/concepts"
    qs = urllib.parse.urlencode(params)
    full = f"{url}?{qs}"
    print(f"Fetching: {full}")
    try:
        with urllib.request.urlopen(full) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = data.get('results', [])
            if results:
                print(json.dumps(results[0], indent=2))
    except Exception as e:
        print(f"Error: {e}")

print("--- Check Condensed Matter ---")
get({"filter": f"openalex_id:{CONDENSED_MATTER_ID}"})
