import urllib.request
import json
import traceback

try:
    url = "https://api.openalex.org/concepts/C121332964"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read().decode('utf-8'))
    
    print(f"Name: {data.get('display_name')}")
    print("Related Concepts (level 1):")
    related = data.get('related_concepts', [])
    for r in related:
        if r.get('level') == 1:
            print(f" - {r.get('display_name')} ({r.get('id')})")
            
    print("\nTrying ancestor filter query:")
    url2 = "https://api.openalex.org/concepts?filter=level:1,ancestors.id:C121332964"
    req2 = urllib.request.Request(url2, headers={'User-Agent': 'Mozilla/5.0'})
    resp2 = urllib.request.urlopen(req2)
    data2 = json.loads(resp2.read().decode('utf-8'))
    print(f"Results with ancestors.id: {data2.get('meta', {}).get('count')}")
    
except Exception as e:
    print(f"Error: {e}")
    traceback.print_exc()
