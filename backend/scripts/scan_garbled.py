"""Scan DB for ???? garbled data and check encoding"""
import sqlite3

conn = sqlite3.connect(r'D:\.data\lead_system.db')

# List all tables
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
print("Tables:", tables)
print()

# Scan each table for ???? in text columns
for table in tables:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    text_cols = [c[1] for c in cols if c[2] in ('TEXT', 'str', '')]
    for col in text_cols:
        try:
            rows = conn.execute(
                f"SELECT id, {col} FROM {table} WHERE {col} LIKE '%????%' LIMIT 10"
            ).fetchall()
            if rows:
                print(f"{table}.{col}: {len(rows)} rows (showing up to 10)")
                for r in rows:
                    print(f"  id={r[0][:16]}... val={r[1][:80] if r[1] else 'NULL'}")
        except Exception as e:
            pass

print()
# Check SQLite encoding
enc = conn.execute("PRAGMA encoding").fetchone()
print(f"SQLite encoding: {enc[0]}")

conn.close()
