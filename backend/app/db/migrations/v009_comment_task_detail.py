"""
v009 · 评论任务补全「人 / 视频 / 时间」三要素
==============================================
评论候选池只是候选池，真正回复在「待办互动 → 评论回复」。推送过去的任务必须自带
完整上下文，到了回复页才不用回头查线索。原表只有 comment_content / video_title /
video_url / comment_id，缺三样：

  - comment_author  TEXT 评论人昵称（对方是谁）
  - comment_time    TEXT 评论时间（原始时间戳或 ISO 串，原样保存）
  - video_id        TEXT 视频 ID（标题缺失时按 ID 定位/展示）

三列均带默认值，向后兼容；旧任务三列为空，由服务层从关联线索回填。
"""
from __future__ import annotations

import sqlite3

_COLUMNS: list[tuple[str, str, str]] = [
    ("comment_tasks", "comment_author", "TEXT NOT NULL DEFAULT ''"),
    ("comment_tasks", "comment_time", "TEXT NOT NULL DEFAULT ''"),
    ("comment_tasks", "video_id", "TEXT NOT NULL DEFAULT ''"),
]


def run(conn: sqlite3.Connection) -> None:
    """幂等执行：补 comment_tasks 三列"""

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
