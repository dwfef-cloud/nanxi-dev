"""
v006 · 检测谁回复了我 · 详情落库
================================
配合「回复检测」闭环，把「对方回了什么、对方是谁」存进 comment_tasks，
待办互动的 user_replied 任务就能直接展示上下文并继续回复。

新增两列（带默认值，向后兼容）：
  - user_reply_content TEXT  对方追评/回复内容（reply_check 检测写入）
  - replier_name      TEXT  对方昵称（评论者展示用）

设计要求同前：带默认值、不删不改现有字段、幂等（列已存在跳过）。
"""
from __future__ import annotations

import sqlite3

_COLUMNS: list[tuple[str, str, str]] = [
    ("comment_tasks", "user_reply_content", "TEXT NOT NULL DEFAULT ''"),
    ("comment_tasks", "replier_name", "TEXT NOT NULL DEFAULT ''"),
]


def run(conn: sqlite3.Connection) -> None:
    """幂等执行：补两列"""

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
