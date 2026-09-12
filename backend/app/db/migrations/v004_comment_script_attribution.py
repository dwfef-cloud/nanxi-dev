"""
v004 · 评论回复的话术归因
==========================================
给 comment_tasks 补一列 reply_variant_id，记录这条评论实际用的是哪个话术变体。

背景：reply_script_id 列早就存在，但从来没有任何代码写入过它，导致
`_fire_comment_sent_tracking` 调用的 `record_script_usage` 因 script_id 为空而早退，
script_usage 表始终 0 行、变体 sent 始终 0，话术库的转化率面板与 R2 自动切换
拿不到任何数据。补上这一列后，脚本变体维度的归因才能闭环。

设计要求（同 v002）：
  - 带默认值，向后兼容
  - 不删除、不重命名、不修改任何现有字段
  - 幂等：列已存在时跳过
"""
from __future__ import annotations

import sqlite3

# (table, column, column_ddl)
_COLUMNS: list[tuple[str, str, str]] = [
    ("comment_tasks", "reply_variant_id", "TEXT NOT NULL DEFAULT ''"),
]


def run(conn: sqlite3.Connection) -> None:
    """幂等执行补列迁移"""
    def _has_column(table: str, col: str) -> bool:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(r[1] == col for r in rows)

    for table, col, ddl in _COLUMNS:
        if _has_column(table, col):
            continue
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
        except sqlite3.OperationalError as e:
            if "duplicate column name" in str(e).lower():
                continue
            raise
