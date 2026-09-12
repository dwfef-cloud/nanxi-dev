"""
v002 · 精准获客系统改造 · 基础字段扩展
==========================================
给 crawl_tasks / leads / comment_tasks 三张表新增字段。

设计要求：
  - 所有新增字段带默认值，向后兼容（旧代码不传新字段也能正常工作）
  - 不删除、不重命名、不修改任何现有字段
  - 幂等：列已存在时跳过；ALTER TABLE 触发 duplicate column 时忽略
"""
from __future__ import annotations

import sqlite3

# (table, column, column_ddl)
_COLUMNS: list[tuple[str, str, str]] = [
    # ── crawl_tasks：精准采集参数 ──
    ("crawl_tasks", "time_range", "INTEGER NOT NULL DEFAULT 7"),
    ("crawl_tasks", "max_videos", "INTEGER NOT NULL DEFAULT 20"),
    ("crawl_tasks", "max_comments_per_video", "INTEGER NOT NULL DEFAULT 50"),
    ("crawl_tasks", "sort_type", "TEXT NOT NULL DEFAULT 'latest'"),
    # ── leads：评论级溯源 ──
    ("leads", "video_id", "TEXT NOT NULL DEFAULT ''"),
    ("leads", "comment_id", "TEXT NOT NULL DEFAULT ''"),
    ("leads", "comment_user_id", "TEXT NOT NULL DEFAULT ''"),
    ("leads", "comment_time", "TEXT NOT NULL DEFAULT ''"),
    ("leads", "matched_keywords", "TEXT NOT NULL DEFAULT '[]'"),
    # ── comment_tasks：回复任务扩展 ──
    ("comment_tasks", "video_url", "TEXT NOT NULL DEFAULT ''"),
    ("comment_tasks", "comment_id", "TEXT NOT NULL DEFAULT ''"),
    ("comment_tasks", "reply_failure_reason", "TEXT NOT NULL DEFAULT ''"),
    ("comment_tasks", "priority", "TEXT NOT NULL DEFAULT 'P2'"),
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
            # 并发/重复执行场景下的兜底幂等
            if "duplicate column name" in str(e).lower():
                continue
            raise
