"""v011：4 张画像表支持「多条记录 + 可指定主记录」

背景：business_profile / product_knowledge / audience_profile / wechat_settings
原本是单例表（id='default'），保存即覆盖。改为多条后：
- 每次保存形成一条独立记录，互不覆盖；
- 其中一条标记 is_primary=1 作为「主记录」，话术变量、AI 生成、以及旧的
  get_xxx() 单数接口都取这条，保证既有逻辑零改动。

新增列：
- is_primary  INTEGER  是否主记录（0/1），旧数据回填为 1
- sort_order   INTEGER  列表排序（越小越靠前）
- created_at   TEXT     创建时间，旧数据回填 updated_at

幂等：重复执行不报错、不丢数据。
"""
from __future__ import annotations

import sqlite3

# 需要支持多条记录的画像表
_TABLES = (
    "business_profile",
    "product_knowledge",
    "audience_profile",
    "wechat_settings",
)


def _columns(cur: sqlite3.Cursor, table: str) -> set[str]:
    return {r[1] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}


def _table_exists(cur: sqlite3.Cursor, table: str) -> bool:
    row = cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def run(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    for table in _TABLES:
        if not _table_exists(cur, table):
            continue  # 表由 schema.sql 负责创建，这里只补列

        have = _columns(cur, table)
        if "is_primary" not in have:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0")
        if "sort_order" not in have:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        if "created_at" not in have:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")

        # 回填创建时间（旧行只有 updated_at）
        cur.execute(f"UPDATE {table} SET created_at = updated_at WHERE created_at = ''")

        # 保证至少有一条主记录：没有主记录时把最新那条设为主
        primary_count = cur.execute(
            f"SELECT COUNT(*) FROM {table} WHERE is_primary = 1"
        ).fetchone()[0]
        if primary_count == 0:
            cur.execute(
                f"""UPDATE {table} SET is_primary = 1
                    WHERE id = (SELECT id FROM {table} ORDER BY updated_at DESC LIMIT 1)"""
            )

    conn.commit()
