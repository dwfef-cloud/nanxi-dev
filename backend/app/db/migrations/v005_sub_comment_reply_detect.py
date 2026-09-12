"""
v005 · 二级评论采集开关 + 线索评论 id 回填
==========================================
两个目的：

1. crawl_tasks 补 `enable_sub_comments` 列 —— MediaCrawler 的二级评论采集开关。
   打开后，采集会把「我回复过的评论」下面的追评一起抓回来。这解决了
   「有人回复我时只能全量重采」的痛点：只要盯住我发过评论的那几个视频采子评论，
   就能看到谁回了我，不必按关键词搜全网。

2. 回填 leads.comment_id —— 库里 106 条真实线索的 comment_id 列为空，但导入时
   评论 id 被拼进了 external_id（`douyin-comment-<cid>`）。没有这个 id，
   「对方的回复挂在哪条评论下」就无从匹配，回复检测链路断在起点。

设计要求（同 v002/v004）：
  - 带默认值，向后兼容
  - 不删除、不重命名、不修改任何现有字段
  - 幂等：列已存在时跳过；comment_id 已有值时不动
"""
from __future__ import annotations

import sqlite3

# (table, column, column_ddl)
_COLUMNS: list[tuple[str, str, str]] = [
    ("crawl_tasks", "enable_sub_comments", "INTEGER NOT NULL DEFAULT 0"),
]

# 导入时使用的 external_id 前缀（见 CrawlService.import_comments）
_EXTERNAL_ID_PREFIX = "douyin-comment-"


def run(conn: sqlite3.Connection) -> None:
    """幂等执行：补列 + 回填评论 id"""

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

    _backfill_comment_ids(conn)


def _backfill_comment_ids(conn: sqlite3.Connection) -> None:
    """从 external_id 还原 leads.comment_id（只补空值，不覆盖已有值）。"""
    try:
        rows = conn.execute(
            "SELECT id, external_id FROM leads "
            "WHERE (comment_id IS NULL OR comment_id = '') "
            "AND external_id LIKE ?",
            (_EXTERNAL_ID_PREFIX + "%",),
        ).fetchall()
    except sqlite3.OperationalError:
        return

    updates: list[tuple[str, str]] = []
    for lead_id, external_id in rows:
        cid = str(external_id or "")[len(_EXTERNAL_ID_PREFIX):].strip()
        if cid:
            updates.append((cid, lead_id))

    if updates:
        conn.executemany("UPDATE leads SET comment_id = ? WHERE id = ?", updates)
