"""Add missing retry columns to dm_send_results (after restore from old backup)"""
import sqlite3

conn = sqlite3.connect(r"D:\.data\lead_system.db")

for sql in [
    "ALTER TABLE dm_send_results ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE dm_send_results ADD COLUMN retry_status TEXT NOT NULL DEFAULT 'idle'",
    "ALTER TABLE dm_send_results ADD COLUMN next_retry_at TEXT",
]:
    try:
        conn.execute(sql)
        print(f"OK: {sql[:60]}")
    except sqlite3.OperationalError as e:
        print(f"SKIP: {e}")

conn.commit()
rows = conn.execute("PRAGMA table_info(dm_send_results)").fetchall()
print("\nFinal schema:")
for r in rows:
    print(f"  {r}")
conn.close()
