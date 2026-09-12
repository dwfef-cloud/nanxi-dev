"""
v007 · 二级评论树 · 多条回复落库
================================
配合「回复检测」闭环的升级：一条评论下可能有多人回复 / 同人多次回复，
需要把全部二级评论存下来（而非只留最新一条），待办互动才能按
「一级评论 → 二级评论」的层级展示完整对话上下文。

新增一列（带默认值，向后兼容）：
  - sub_replies  TEXT NOT NULL DEFAULT '[]'
    存 JSON 列表：[{comment_id, nickname, content, replied_at}]

设计要求同前：带默认值、不删不改现有字段、幂等（列已存在跳过）。
"""
from __future__ import annotations

import sqlite3

_COLUMNS: list[tuple[str, str, str]] = [
    ("comment_tasks", "sub_replies", "TEXT NOT NULL DEFAULT '[]'"),
]


def run(conn: sqlite3.Connection) -> None:
    """幂等执行：补 sub_replies 列"""

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
