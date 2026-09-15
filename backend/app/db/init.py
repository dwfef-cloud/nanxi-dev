"""
数据库初始化模块
================
负责：
1. 确保 data/ 目录存在
2. 执行 schema.sql 建表
3. 初始化单例记录（runtime_state / 配置域）
4. 播种默认数据（compliance_rules / script_templates）
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app.models.domain import now_utc
from app.db.migrations import run_all
from app.db.migrations.v003_comment_insight import ensure_script_guard_rules

import os
from uuid import uuid4

# 项目根目录（app/ 的上一级）
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "lead_system.db"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def get_db_path() -> Path:
    """获取数据库文件路径，支持 DB_PATH 环境变量覆盖（C盘空间不足时放D盘）"""
    env_path = os.environ.get("DB_PATH")
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


def init_db(db_path: str | Path | None = None) -> Path:
    """初始化数据库：建目录、建表、播种默认数据

    Returns:
        数据库文件路径
    """
    if db_path is None:
        db_path = get_db_path()
    db_path = Path(db_path)

    # 1. 确保 data/ 目录存在
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # 2. 连接并执行 schema
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")

        schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
        conn.executescript(schema_sql)

        # 3.5 列迁移（为已存在的旧表补列，幂等）
        _migrate_columns(conn)

        # 3.6 版本化迁移（v002+，精准获客字段扩展，幂等）
        run_all(conn)

        # 4. 播种默认数据
        _seed_defaults(conn)

        conn.commit()
    finally:
        conn.close()

    return db_path


def _migrate_columns(conn: sqlite3.Connection) -> None:
    """为已存在的旧表补列（幂等，列已存在时跳过）"""
    def _has_column(table: str, col: str) -> bool:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(r[1] == col for r in rows)

    def _has_table(table: str) -> bool:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        return row is not None

    if not _has_column("messages", "is_read"):
        conn.execute("ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0")
    if not _has_column("messages", "script_id"):
        conn.execute("ALTER TABLE messages ADD COLUMN script_id TEXT")

    # ── 多账号调度模块迁移 ──
    if not _has_column("accounts", "weight"):
        conn.execute("ALTER TABLE accounts ADD COLUMN weight INTEGER NOT NULL DEFAULT 1")
    if not _has_column("accounts", "today_sent"):
        conn.execute("ALTER TABLE accounts ADD COLUMN today_sent INTEGER NOT NULL DEFAULT 0")
    if not _has_column("accounts", "today_success"):
        conn.execute("ALTER TABLE accounts ADD COLUMN today_success INTEGER NOT NULL DEFAULT 0")

    # scheduler_config 表（如不存在则创建）
    if not _has_table("scheduler_config"):
        conn.execute(
            """CREATE TABLE scheduler_config (
                id INTEGER PRIMARY KEY,
                strategy TEXT NOT NULL DEFAULT 'round_robin',
                health_threshold_warn INTEGER NOT NULL DEFAULT 60,
                health_threshold_critical INTEGER NOT NULL DEFAULT 30,
                max_concurrent INTEGER NOT NULL DEFAULT 3,
                updated_at TEXT NOT NULL
            )"""
        )

    # P2-12: dm_send_results retry columns
    for _col, _ddl in (
        ("retry_count", "INTEGER NOT NULL DEFAULT 0"),
        ("retry_status", "TEXT NOT NULL DEFAULT 'idle'"),
        ("next_retry_at", "TEXT"),
    ):
        if not _has_column("dm_send_results", _col):
            conn.execute(f"ALTER TABLE dm_send_results ADD COLUMN {_col} {_ddl}")

    # ── v003：话术质检规则表（与迁移共用同一份 schema/种子，避免两处不一致）──
    ensure_script_guard_rules(conn)

    # ── Task6：流失原因结构化（category + note），兼容已有自由文本数据 ──
    if not _has_column("leads", "lost_reason_category"):
        conn.execute("ALTER TABLE leads ADD COLUMN lost_reason_category TEXT NOT NULL DEFAULT 'other'")
    if not _has_column("leads", "lost_reason_note"):
        conn.execute("ALTER TABLE leads ADD COLUMN lost_reason_note TEXT")
    if not _has_column("customers", "lost_reason_category"):
        conn.execute("ALTER TABLE customers ADD COLUMN lost_reason_category TEXT")
    if not _has_column("customers", "lost_reason_note"):
        conn.execute("ALTER TABLE customers ADD COLUMN lost_reason_note TEXT")

    # 已有自由文本 lost_reason → category=other，原文存入 note（仅迁移一次）
    conn.execute(
        "UPDATE leads SET lost_reason_category='other', lost_reason_note=lost_reason "
        "WHERE (lost_reason IS NOT NULL AND lost_reason != '') "
        "AND (lost_reason_note IS NULL OR lost_reason_note = '')"
    )
    conn.execute(
        "UPDATE customers SET lost_reason_category='other', lost_reason_note=lost_reason "
        "WHERE (lost_reason IS NOT NULL AND lost_reason != '') "
        "AND (lost_reason_note IS NULL OR lost_reason_note = '')"
    )


def _seed_defaults(conn: sqlite3.Connection) -> None:
    """播种默认单例记录和基础数据（仅在不存在时插入）"""
    now = now_utc().isoformat()

    # ── runtime_state 单例 ──
    conn.execute(
        """INSERT OR IGNORE INTO runtime_state
           (id, safe_mode_active, safe_mode_reason, safe_mode_triggered_at,
            safe_mode_trigger_source, task_running, updated_at)
           VALUES ('default', 0, '', NULL, NULL, 1, ?)""",
        (now,),
    )

    # ── compliance_rules 默认 R1/R2/R3 ──
    default_rules = [
        ("R1", "单账号日频 ≥ 80 → 降速至 40", "standby", None, None),
        ("R2", "话术变体加微转化率 < 8%（样本≥30）→ 自动切换", "standby", None, None),
        ("R3", "黑名单日增 > 3% 或账号封禁 → 全量暂停", "standby", None, None),
    ]
    conn.executemany(
        """INSERT OR IGNORE INTO compliance_rules
           (rule_id, desc, status, hit_at, target)
           VALUES (?, ?, ?, ?, ?)""",
        default_rules,
    )

    # ── script_templates 默认模板包 ──
    default_templates = [
        ("装修", 8, "首次触达×3 / 报价跟进×2 / 加微引导×3", 1),
        ("教育", 0, "v2 规划中", 0),
        ("医疗口腔", 0, "v2 规划中", 0),
    ]
    conn.executemany(
        """INSERT OR IGNORE INTO script_templates
           (industry, count, desc, installed)
           VALUES (?, ?, ?, ?)""",
        default_templates,
    )

    # ── 配置域画像表（各一条 default 记录，首条即主记录 is_primary=1）──
    conn.execute(
        """INSERT OR IGNORE INTO business_profile
           (id, industry, service_area, conversion_goal, tone,
            is_primary, sort_order, created_at, updated_at)
           VALUES ('default', '', '', '添加微信', '专业、真诚', 1, 0, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT OR IGNORE INTO product_knowledge
           (id, product_name, description, selling_points,
            price_range, faq, forbidden_claims,
            is_primary, sort_order, created_at, updated_at)
           VALUES ('default', '', '', '', '', '', '', 1, 0, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT OR IGNORE INTO audience_profile
           (id, name, needs, pain_points,
            intent_keywords, excluded_keywords,
            is_primary, sort_order, created_at, updated_at)
           VALUES ('default', '', '', '', '', '', 1, 0, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT OR IGNORE INTO script_strategy
           (id, comment_script, private_message_script, wechat_script,
            objection_script, updated_at)
           VALUES ('default', '', '', '', '', ?)""",
        (now,),
    )
    conn.execute(
        """INSERT OR IGNORE INTO wechat_settings
           (id, wechat_id, guide_timing, guide_reason, compliance_note,
            is_primary, sort_order, created_at, updated_at)
           VALUES ('default', '', '客户明确表达兴趣后', '发送详细方案和案例', '', 1, 0, ?, ?)""",
        (now, now),
    )

    # ── 调度器配置单例 ──
    conn.execute(
        """INSERT OR IGNORE INTO scheduler_config
           (id, strategy, health_threshold_warn, health_threshold_critical,
            max_concurrent, updated_at)
           VALUES (1, 'round_robin', 60, 30, 3, ?)""",
        (now,),
    )

    # P2-5: seed scripts
    _seed_scripts(conn, now)


def _seed_scripts(conn: sqlite3.Connection, now: str) -> None:
    """P2-5: seed scripts covering the 5 contract categories.

    Categories: comment / private_message / wechat_guide / objection / nurture.
    Idempotent: checks by name, inserts missing scripts + missing variants.
    Each script has 2-3 variants for A/B testing.
    """
    # (name, category, is_main, intro, welcome_msg, [(variant_id, text, weight), ...])
    seeds = [
        (
            "评论区引流话术", "comment", 0,
            "回复高意向评论，引导用户主动私信", "",
            [
                ("A", "评论区看到您留言啦，这块我们做过不少类似案例，方便的话私信我，发您参考一下～", 40),
                ("B", "您好～您评论的这个问题我们正好擅长，已经做过很多同户型的案例，私信我发您看看？", 35),
                ("C", "感谢关注！关于您问的这块，我们有详细的方案和报价，私信发您一份参考～", 25),
            ],
        ),
        (
            "首次私信触达", "private_message", 1,
            "首条私信破冰，降低戒备", "",
            [
                ("A", "你好呀～看到你对我们的服务感兴趣，方便的话可以聊聊你的需求，我们给你出个方案。", 40),
                ("B", "嗨～注意到你在找装修方面的服务，我们专注这块好多年了，想了解下你家是新房还是老房翻新？", 35),
                ("C", "您好～看到您的留言，我们正好有针对类似需求的案例，方便简单说下您的情况吗？", 25),
            ],
        ),
        (
            "报价发送跟进", "private_message", 0,
            "发送报价后跟进，推动加微", "",
            [
                ("A", "方案和报价已经整理好了，文字发不太清楚，方便加个微信发您完整版？", 50),
                ("B", "之前给您发的报价不知道您看了没？有任何疑问随时问我，也可以加微信我给您语音解释下。", 50),
            ],
        ),
        (
            "加微引导话术", "wechat_guide", 0,
            "客户表达兴趣后引导加微信",
            "您好，我是负责对接的顾问，稍后把详细方案和案例发您～",
            [
                ("A", "文字里说不清细节，方便加个微信吗？我把户型方案和报价单发您看看，合适再聊。", 40),
                ("B", "我们这边资料比较多，微信发您更方便，可以吗？您微信号多少我加您。", 35),
                ("C", "方便留个微信吗？我把同小区的完工案例和实景图发您参考，不耽误您时间～", 25),
            ],
        ),
        (
            "异议处理话术", "objection", 0,
            "应对价格高、怕踩坑等异议", "",
            [
                ("A", "理解您的顾虑～我们按实际需求报价、没有隐形消费，也可以先约免费量房出方案，您对比下再决定。", 40),
                ("B", "价格这块确实要看具体需求，我们可以先免费上门量房出方案，您看完觉得合适再谈价格，没任何压力。", 35),
                ("C", "您说的贵我理解～我们用的材料和施工标准都是行业中上水平，也可以带您去看在建工地实地考察下。", 25),
            ],
        ),
        (
            "培育跟进话术", "nurture", 0,
            "长期未回复线索的轻量唤醒", "",
            [
                ("A", "最近不少老客户都在问今年的活动，想起您之前也关注过，有需要随时招呼我～", 50),
                ("B", "您好，打扰了～我们这周刚出了几套新的设计方案，觉得风格可能适合您，方便看看吗？", 50),
            ],
        ),
        (
            "成交临门话术", "nurture", 0,
            "意向客户促单", "",
            [
                ("A", "您考虑得怎么样了？最近这个月有个活动名额，签单可以送全屋保洁，需要的话我帮您留一个。", 50),
                ("B", "之前跟您聊的方案，如果确定的话我们这周可以排期开工，您看时间上方便吗？", 50),
            ],
        ),
    ]

    for name, category, is_main, intro, welcome, variants in seeds:
        # Check if this seed script already exists by name
        row = conn.execute("SELECT id FROM scripts WHERE name=?", (name,)).fetchone()
        if row is not None:
            sid = row[0]
        else:
            sid = uuid4().hex
            conn.execute(
                """INSERT INTO scripts
                   (id, name, industry, category, is_main, active, intro, welcome_msg, created_at, updated_at)
                   VALUES (?, ?, '装修', ?, ?, 1, ?, ?, ?, ?)""",
                (sid, name, category, is_main, intro, welcome, now, now),
            )

        # Insert variants that don't exist yet
        for vid, text, weight in variants:
            existing = conn.execute(
                "SELECT id FROM script_variants WHERE script_id=? AND variant_id=?",
                (sid, vid),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO script_variants
                       (id, script_id, variant_id, text, weight, status, created_at)
                       VALUES (?, ?, ?, ?, ?, 'active', ?)""",
                    (uuid4().hex, sid, vid, text, weight, now),
                )
