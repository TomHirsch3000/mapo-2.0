# stage3_report.py
import json, sqlite3, os

DB_PATH = os.getenv("DB_PATH", "papers.db")

def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM papers WHERE abstract IS NULL OR abstract=''")
    remaining = cur.fetchone()[0]

    cur.execute("""SELECT paperId, title FROM papers
                   WHERE abstract IS NULL OR abstract=''
                   ORDER BY paperId LIMIT 10""")
    samples = [{"paperId": r[0], "title": r[1]} for r in cur.fetchall()]
    conn.close()

    stage1 = json.load(open("stage1_report.json")) if os.path.exists("stage1_report.json") else {}
    stage2 = json.load(open("stage2_report.json")) if os.path.exists("stage2_report.json") else {}

    report = {
        "stage1": stage1,
        "stage2": stage2,
        "remaining_without_abstract": remaining,
        "sample_missing": samples
    }
    json.dump(report, open("stage3_summary.json","w",encoding="utf-8"), indent=2)
    print("[stage3] wrote stage3_summary.json")

if __name__ == "__main__":
    main()
