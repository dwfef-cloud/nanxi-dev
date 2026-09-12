"""数据库版本化迁移包
=====================
按版本顺序执行 ALTER TABLE 补列迁移。每个迁移脚本对外暴露 run(conn)，
且自身必须幂等（重复执行不报错、不丢数据）。

新增迁移时：
  1. 新建 v00x_<name>.py，实现 run(conn)
  2. 在下方 _MIGRATIONS 列表末尾追加模块名
"""
from __future__ import annotations

import importlib
import sqlite3

# 按版本升序排列的迁移模块（只追加，不插中间）
_MIGRATIONS: list[str] = [
    "app.db.migrations.v002_precise_crawl",
    "app.db.migrations.v003_comment_insight",
    "app.db.migrations.v004_comment_script_attribution",
    "app.db.migrations.v005_sub_comment_reply_detect",
    "app.db.migrations.v006_reply_detail",
    "app.db.migrations.v007_reply_tree",
]


def run_all(conn: sqlite3.Connection) -> None:
    """依次执行全部迁移脚本（各脚本内部幂等）"""
    for mod_name in _MIGRATIONS:
        mod = importlib.import_module(mod_name)
        mod.run(conn)
