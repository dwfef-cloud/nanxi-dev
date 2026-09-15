"""P2（v010）：scripts 表增加 source / generated_from / variables 字段

支撑「业务画像 → 话术库」贯通：
- source          ：话术来源 manual / generated / imported / legacy
- generated_from  ：基于画像生成时的画像快照（JSON 字符串），用于变更检测
- variables       ：话术用到的变量列表（JSON 字符串），便于来源追溯

幂等：重复执行不报错、不丢数据。
"""
from __future__ import annotations

import sqlite3


def run(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    existing = {r[1] for r in cur.execute("PRAGMA table_info(scripts)").fetchall()}
    if "source" not in existing:
        cur.execute("ALTER TABLE scripts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    if "generated_from" not in existing:
        cur.execute("ALTER TABLE scripts ADD COLUMN generated_from TEXT NOT NULL DEFAULT ''")
    if "variables" not in existing:
        cur.execute("ALTER TABLE scripts ADD COLUMN variables TEXT NOT NULL DEFAULT ''")
    conn.commit()
