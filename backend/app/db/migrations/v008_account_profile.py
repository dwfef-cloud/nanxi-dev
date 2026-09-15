"""
v008 · 账号专属登录目录
======================
多账号登录态隔离：一个抖音账号 = 一份独立 Chrome user-data-dir。扫码一次后
Cookie 常驻该目录，之后采集 / 评论免扫；切换账号 = 换目录。

新增一列（带默认值，向后兼容）：
  - profile_dir  TEXT NOT NULL DEFAULT ''
    空值 = 沿用默认共享目录 browser_data/cdp_dy_user_data_dir（兼容既有部署）；
    有值 = 账号专属目录名，由 app.core.douyin_profile 解析成完整路径。

注意：真实登录凭证仍在 Chrome 目录里，本列只记录"该账号用哪个目录"，
不存任何 cookie —— 账号绑定依旧只是业务台账，登录必须扫码。
"""
from __future__ import annotations

import sqlite3

_COLUMNS: list[tuple[str, str, str]] = [
    ("accounts", "profile_dir", "TEXT NOT NULL DEFAULT ''"),
]


def run(conn: sqlite3.Connection) -> None:
    """幂等执行：补 accounts.profile_dir 列"""

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
