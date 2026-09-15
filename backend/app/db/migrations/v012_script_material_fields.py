"""v012：补齐话术素材字段（5 个）

体检发现：4 张画像卡共 25 个字段，AI 生成话术只用了 16 个，且缺几类写话术最需要的素材
（自我介绍、服务流程、成功案例、优惠钩子、不接什么样的客户）。本次各补一列：

- business_profile.self_intro            自我介绍 / 账号人设（评论回复第一句报家门用）
- product_knowledge.service_process      服务流程与交付周期（客户最常问「多久能做完」）
- product_knowledge.case_studies         成功案例 / 客户见证（一行一条）
- audience_profile.excluded_customers    不接什么样的客户（业务语义层面的排除）
- wechat_settings.offer_hook             优惠 / 钩子（引导加微的具体理由）

全部为 TEXT NOT NULL DEFAULT ''，旧行自动填空串，不丢数据。
幂等：重复执行不报错。
"""
from __future__ import annotations

import sqlite3

# (表名, 列名, 列定义)
_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("business_profile", "self_intro", "TEXT NOT NULL DEFAULT ''"),
    ("product_knowledge", "service_process", "TEXT NOT NULL DEFAULT ''"),
    ("product_knowledge", "case_studies", "TEXT NOT NULL DEFAULT ''"),
    ("audience_profile", "excluded_customers", "TEXT NOT NULL DEFAULT ''"),
    ("wechat_settings", "offer_hook", "TEXT NOT NULL DEFAULT ''"),
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
    for table, column, ddl in _COLUMNS:
        if not _table_exists(cur, table):
            continue  # 表由 schema.sql 负责创建，这里只补列
        if column in _columns(cur, table):
            continue
        cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    conn.commit()
