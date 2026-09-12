"""
v003 · 评论洞察与话术质检 · 数据层扩展
==========================================
1. leads 表扩展 5 列：intent_category / sentiment / risk_level / insight_json / desensitized
   （复用已有 intent（high/mid/low）与 intent_level（A/B/C），不重复新增）
2. 新建 script_guard_rules 表并灌入内置质检规则

设计要求：
  - 幂等：列已存在时跳过；CREATE TABLE IF NOT EXISTS；规则按 rule_code INSERT OR IGNORE
  - 不删除、不重命名、不修改任何现有字段
  - schema 与种子数据只在本模块定义一次，init.py 复用 ensure_script_guard_rules()
"""
from __future__ import annotations

import sqlite3

# (table, column, column_ddl)
_COLUMNS: list[tuple[str, str, str]] = [
    # ── leads：评论洞察 AI 分级结果 ──
    ("leads", "intent_category", "TEXT"),
    ("leads", "sentiment", "TEXT"),
    ("leads", "risk_level", "TEXT"),
    ("leads", "insight_json", "TEXT"),
    ("leads", "desensitized", "INTEGER DEFAULT 0"),
]

# script_guard_rules 建表语句
_GUARD_RULES_DDL = """
CREATE TABLE IF NOT EXISTS script_guard_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code   TEXT UNIQUE NOT NULL,
  category    TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  severity    TEXT NOT NULL,
  advice      TEXT,
  source      TEXT DEFAULT 'skill-comment-reply',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT
)
"""

# 内置规则 (rule_code, category, pattern, severity, advice)
_GUARD_RULE_SEEDS: list[tuple[str, str, str, str, str]] = [
    ("D1", "话术套路", r"帮您反馈|这边反馈|反馈一下哦", "block", "空转话术，改为给出具体动作与时限"),
    ("D2", "话术套路", r"个人使用问题|使用不当|操作不当", "block", "甩锅客户，改为先认事实"),
    ("D3", "话术套路", r"可以申请退款|不满意可以退", "warn", "被动攻击，改为主动给方案"),
    ("D4", "话术套路", r"别的客户都没|别人都没问题|就您", "block", "否定客户，禁止使用"),
    ("D5", "话术套路", r"我们也不容易|请理解一下我们", "warn", "道德绑架，改为直接给补救"),
    ("D6", "话术套路", r"已私信您，注意查收", "warn", "未实际私信时属拖延话术"),
    ("D7", "话术套路", "（重复率检测，非正则）", "warn", "同账号24h内相同回复≥2次，属模板群发"),
    ("P1", "过度承诺", r"保证|一定|百分百|100%|绝对|永久", "warn", "承诺须能兑现，避免空头支票"),
    ("P2", "过度承诺", r"马上解决|立刻解决|今天必到", "warn", "改为给具体时限"),
    ("S1", "隐私泄露", r"\d{11}", "block", "疑似手机号，公屏禁止复述"),
    ("S2", "隐私泄露", r"订单号[:：]?\s*\w{6,}", "block", "订单号应引导私信提供"),
]


def ensure_script_guard_rules(conn: sqlite3.Connection) -> None:
    """建表 + 灌内置规则（幂等，可重复执行）"""
    conn.execute(_GUARD_RULES_DDL)
    conn.executemany(
        """INSERT OR IGNORE INTO script_guard_rules
           (rule_code, category, pattern, severity, advice, source)
           VALUES (?, ?, ?, ?, ?, 'skill-comment-reply')""",
        _GUARD_RULE_SEEDS,
    )


def run(conn: sqlite3.Connection) -> None:
    """幂等执行 v003 迁移"""
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

    ensure_script_guard_rules(conn)
