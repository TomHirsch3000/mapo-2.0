import subprocess
import sys
import os

def main():
    topic = "Classical mechanics"
    db = "papers_classical_mechanics_all.db"
    email = "tom.hirsch3000@gmail.com"

    for year in range(1900, 2027):
        print(f"========== Importing year {year} ==========")
        cmd = [
            sys.executable, "import_openalex.py",
            "--topic-name", topic,
            "--db", db,
            "--from-year", str(year),
            "--to-year", str(year),
            "--sample", "0",
            "--email", email
        ]
        if year == 1900:
            cmd.append("--reset")
        
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        try:
            subprocess.run(cmd, check=True, env=env)
        except subprocess.CalledProcessError as e:
            print(f"Error importing year {year}: {e}")
            # Continue to next year even if one fails

if __name__ == "__main__":
    main()
