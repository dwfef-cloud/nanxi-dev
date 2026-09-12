"""
SqliteRepository · SQLite 版数据访问实现
==========================================
生产环境持久化实现。完整实现 Repository 接口的 55 个抽象方法。

存储约定：
  - datetime  → ISO 字符串 (TEXT)
  - list[str] → JSON 字符串 (TEXT)
  - dict      → JSON 字符串 (TEXT)
  - bool      → INTEGER (0/1)
  - 所有写操作使用参数化查询防 SQL 注入
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.db.init import init_db
from app.models.domain import (
    Account, AccountEvent, AudienceProfile, BusinessProfile, CommentReplyTask,
    ComplianceEvent, ComplianceRule, Conversation, CrawlTask, Customer, CustomerLog,
    DmSendResult, FollowUp, Lead, LeadBehaviorEvent, Message, Notification, ProductKnowledge,
    RuntimeState, Script, ScriptStrategy, ScriptTemplate, ScriptUsage, ScriptVariant, Task,
    WeChatSettings,
)
from app.repositories.base import Repository


# ═══════════════════════════════════════════════════════════
# 序列化辅助函数
# ═══════════════════════════════════════════════════════════

def _dt_to_str(dt: datetime | None) -> str | None:
    """datetime → ISO 字符串"""
    if dt is None:
        return None
    return dt.isoformat()


def _str_to_dt(s: str | None) -> datetime | None:
    """ISO 字符串 → datetime"""
    if s is None or s == "":
        return None
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _to_json(obj: Any) -> str:
    """任意对象 → JSON 字符串"""
    return json.dumps(obj, ensure_ascii=False, default=str)


def _from_json(s: str | None, default: Any) -> Any:
    """JSON 字符串 → 对象，失败返回 default"""
    if s is None or s == "":
        return default
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return default


def _bool_to_int(b: bool) -> int:
    return 1 if b else 0


def _int_to_bool(v: int | None) -> bool:
    return bool(v) if v is not None else False


# ═══════════════════════════════════════════════════════════
# SqliteRepository
# ═══════════════════════════════════════════════════════════

class SqliteRepository(Repository):
    """SQLite 持久化 Repository 实现"""

    def __init__(self, db_path: str | Path | None = None) -> None:
        # 初始化数据库（建表 + 播种默认数据）
        self._db_path = init_db(db_path)
        # 单连接 + 线程锁（FastAPI 多线程安全）
        self._conn = sqlite3.connect(
            str(self._db_path),
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._lock = threading.Lock()
        # P3-14: ensure ad_spend table exists
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS ad_spend (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'douyin',
                amount REAL NOT NULL DEFAULT 0,
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )"""
        )
        self._conn.commit()

    # ── 底层执行辅助 ──

    def close(self) -> None:
        """安全关闭底层 sqlite 长连接（幂等，可重复调用）

        - 连接为 None / 已关闭时不抛异常
        - 关闭前尽力做一次 WAL checkpoint，减少 -wal 残留
        - 任何异常都被吞掉，避免影响进程退出流程
        """
        conn = getattr(self, "_conn", None)
        if conn is None:
            return
        try:
            lock = getattr(self, "_lock", None)
            if lock is not None:
                with lock:
                    self._close_conn(conn)
            else:
                self._close_conn(conn)
        except Exception:
            pass

    @staticmethod
    def _close_conn(conn: sqlite3.Connection) -> None:
        try:
            # WAL 模式下尽力 checkpoint，失败（如其他连接占用）不影响关闭
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.commit()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass

    def _execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        """执行写操作（带锁）"""
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        """执行查询（带锁）"""
        with self._lock:
            cur = self._conn.execute(sql, params)
            return cur.fetchall()

    def _query_one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        """执行单行查询"""
        rows = self._query(sql, params)
        return rows[0] if rows else None

    # ═══════════════════════════════════════════════════════
    # 获客域 · Lead
    # ═══════════════════════════════════════════════════════

    def _row_to_lead(self, row: sqlite3.Row) -> Lead:
        return Lead(
            id=row["id"],
            nickname=row["nickname"],
            source_url=row["source_url"],
            source_keyword=row["source_keyword"],
            platform=row["platform"],
            external_id=row["external_id"],
            source_task_id=row["source_task_id"],
            source=row["source"],
            comment=row["comment"],
            video=row["video"],
            video_id=row["video_id"],
            comment_id=row["comment_id"],
            comment_user_id=row["comment_user_id"],
            comment_time=row["comment_time"],
            matched_keywords=row["matched_keywords"],
            referral_note=row["referral_note"],
            score=row["score"],
            intent_level=row["intent_level"],
            intent=row["intent"],
            tags=_from_json(row["tags"], []),
            note=row["note"],
            customer_need=row["customer_need"],
            status=row["status"],
            account=row["account"],
            throttled_note=row["throttled_note"],
            fail_note=row["fail_note"],
            reject_reason=row["reject_reason"],
            wechat_added_at=_str_to_dt(row["wechat_added_at"]),
            manual=_int_to_bool(row["manual"]),
            deal_amount=row["deal_amount"],
            deal_at=_str_to_dt(row["deal_at"]),
            hue=row["hue"],
            region=row["region"],
            next_followup_at=_str_to_dt(row["next_followup_at"]),
            lost_reason=row["lost_reason"],
            lost_reason_category=row["lost_reason_category"] if "lost_reason_category" in row.keys() else "other",
            lost_reason_note=row["lost_reason_note"] if "lost_reason_note" in row.keys() else None,
            conversion_amount=row["conversion_amount"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_leads(
        self,
        status: str | None = None,
        source: str | None = None,
        keyword: str | None = None,
        min_score: int | None = None,
    ) -> list[Lead]:
        sql = "SELECT * FROM leads WHERE 1=1"
        params: list = []
        if status and status != "all":
            sql += " AND status = ?"
            params.append(status)
        if source:
            sql += " AND source = ?"
            params.append(source)
        if min_score is not None:
            sql += " AND score >= ?"
            params.append(min_score)
        sql += " ORDER BY created_at DESC"
        rows = self._query(sql, tuple(params))
        leads = [self._row_to_lead(r) for r in rows]
        # keyword 过滤在 Python 层做（tags 是 JSON，SQL LIKE 不可靠）
        if keyword:
            needle = keyword.lower()
            leads = [
                l for l in leads
                if needle in l.nickname.lower()
                or needle in l.comment.lower()
                or needle in (l.note or "").lower()
                or any(needle in t.lower() for t in l.tags)
            ]
        return leads

    def get_lead(self, lead_id: str) -> Lead:
        row = self._query_one("SELECT * FROM leads WHERE id = ?", (lead_id,))
        if row is None:
            raise KeyError(f"Lead not found: {lead_id}")
        return self._row_to_lead(row)

    def save_lead(self, lead: Lead) -> Lead:
        self._execute(
            """INSERT OR REPLACE INTO leads
               (id, nickname, source_url, source_keyword, platform, external_id,
                source_task_id, source, comment, video, video_id, comment_id,
                comment_user_id, comment_time, matched_keywords, referral_note, score,
                intent_level, intent, tags, note, customer_need, status, account,
                throttled_note, fail_note, reject_reason, wechat_added_at, manual,
                deal_amount, deal_at, hue, region, next_followup_at, lost_reason,
                lost_reason_category, lost_reason_note,
                conversion_amount, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                lead.id, lead.nickname, lead.source_url, lead.source_keyword,
                lead.platform, lead.external_id, lead.source_task_id, lead.source,
                lead.comment, lead.video, lead.video_id, lead.comment_id,
                lead.comment_user_id, lead.comment_time, lead.matched_keywords,
                lead.referral_note, lead.score,
                lead.intent_level, lead.intent, _to_json(lead.tags), lead.note,
                lead.customer_need, lead.status, lead.account, lead.throttled_note,
                lead.fail_note, lead.reject_reason, _dt_to_str(lead.wechat_added_at),
                _bool_to_int(lead.manual), lead.deal_amount, _dt_to_str(lead.deal_at),
                lead.hue, lead.region, _dt_to_str(lead.next_followup_at),
                lead.lost_reason, lead.lost_reason_category, lead.lost_reason_note,
                lead.conversion_amount,
                _dt_to_str(lead.created_at), _dt_to_str(lead.updated_at),
            ),
        )
        return lead

    def find_lead_by_external(self, platform: str, external_id: str) -> Lead | None:
        row = self._query_one(
            "SELECT * FROM leads WHERE platform = ? AND external_id = ? AND external_id != ''",
            (platform, external_id),
        )
        return self._row_to_lead(row) if row else None

    def delete_lead(self, lead_id: str) -> None:
        self._execute("DELETE FROM leads WHERE id = ?", (lead_id,))

    # ═══════════════════════════════════════════════════════
    # 获客域 · Account
    # ═══════════════════════════════════════════════════════

    def _row_to_account(self, row: sqlite3.Row) -> Account:
        return Account(
            id=row["id"],
            name=row["name"],
            nickname=row["nickname"],
            platform=row["platform"],
            avatar_hue=row["avatar_hue"],
            health_score=row["health_score"],
            factors=_from_json(row["factors"], {}),
            limit_status=row["limit_status"],
            status=row["status"],
            daily_outreach=row["daily_outreach"],
            daily_limit=row["daily_limit"],
            daily_send_count=row["daily_send_count"],
            risk_level=row["risk_level"],
            weight=row["weight"] if "weight" in row.keys() else 1,
            today_sent=row["today_sent"] if "today_sent" in row.keys() else 0,
            today_success=row["today_success"] if "today_success" in row.keys() else 0,
            last_ban_reason=row["last_ban_reason"],
            r1_note=row["r1_note"],
            r3_note=row["r3_note"],
            notes=row["notes"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_accounts(self) -> list[Account]:
        rows = self._query("SELECT * FROM accounts ORDER BY created_at")
        return [self._row_to_account(r) for r in rows]

    def get_account(self, account_id: str) -> Account:
        row = self._query_one("SELECT * FROM accounts WHERE id = ?", (account_id,))
        if row is None:
            raise KeyError(f"Account not found: {account_id}")
        return self._row_to_account(row)

    def save_account(self, account: Account) -> Account:
        self._execute(
            """INSERT OR REPLACE INTO accounts
               (id, name, nickname, platform, avatar_hue, health_score, factors,
                limit_status, status, daily_outreach, daily_limit, daily_send_count,
                risk_level, weight, today_sent, today_success, last_ban_reason, r1_note, r3_note, notes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                account.id, account.name, account.nickname, account.platform,
                account.avatar_hue, account.health_score, _to_json(account.factors),
                account.limit_status, account.status, account.daily_outreach,
                account.daily_limit, account.daily_send_count, account.risk_level,
                account.weight, account.today_sent, account.today_success,
                account.last_ban_reason, account.r1_note, account.r3_note,
                account.notes, _dt_to_str(account.created_at), _dt_to_str(account.updated_at),
            ),
        )
        return account

    # ═══════════════════════════════════════════════════════
    # 获客域 · Script / Variant / Template
    # ═══════════════════════════════════════════════════════

    def _row_to_script(self, row: sqlite3.Row) -> Script:
        return Script(
            id=row["id"],
            name=row["name"],
            industry=row["industry"],
            category=row["category"],
            is_main=_int_to_bool(row["is_main"]),
            active=_int_to_bool(row["active"]),
            intro=row["intro"],
            welcome_msg=row["welcome_msg"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_scripts(self, category: str | None = None, active: bool | None = None) -> list[Script]:
        sql = "SELECT * FROM scripts WHERE 1=1"
        params: list = []
        if category:
            sql += " AND category = ?"
            params.append(category)
        if active is not None:
            sql += " AND active = ?"
            params.append(_bool_to_int(active))
        sql += " ORDER BY created_at"
        rows = self._query(sql, tuple(params))
        return [self._row_to_script(r) for r in rows]

    def get_script(self, script_id: str) -> Script:
        row = self._query_one("SELECT * FROM scripts WHERE id = ?", (script_id,))
        if row is None:
            raise KeyError(f"Script not found: {script_id}")
        return self._row_to_script(row)

    def save_script(self, script: Script) -> Script:
        self._execute(
            """INSERT OR REPLACE INTO scripts
               (id, name, industry, category, is_main, active, intro, welcome_msg, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                script.id, script.name, script.industry, script.category,
                _bool_to_int(script.is_main), _bool_to_int(script.active),
                script.intro, script.welcome_msg,
                _dt_to_str(script.created_at), _dt_to_str(script.updated_at),
            ),
        )
        return script

    def _row_to_variant(self, row: sqlite3.Row) -> ScriptVariant:
        return ScriptVariant(
            id=row["id"],
            script_id=row["script_id"],
            variant_id=row["variant_id"],
            text=row["text"],
            weight=row["weight"],
            status=row["status"],
            sent=row["sent"],
            replied=row["replied"],
            wechat_added=row["wechat_added"],
            conv_rate=row["conv_rate"],
            sample_enough=_int_to_bool(row["sample_enough"]),
            r2_note=row["r2_note"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_variants(self, script_id: str) -> list[ScriptVariant]:
        rows = self._query(
            "SELECT * FROM script_variants WHERE script_id = ? ORDER BY variant_id",
            (script_id,),
        )
        return [self._row_to_variant(r) for r in rows]

    def save_variant(self, variant: ScriptVariant) -> ScriptVariant:
        self._execute(
            """INSERT OR REPLACE INTO script_variants
               (id, script_id, variant_id, text, weight, status, sent, replied,
                wechat_added, conv_rate, sample_enough, r2_note, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                variant.id, variant.script_id, variant.variant_id, variant.text,
                variant.weight, variant.status, variant.sent, variant.replied,
                variant.wechat_added, variant.conv_rate,
                _bool_to_int(variant.sample_enough), variant.r2_note,
                _dt_to_str(variant.created_at),
            ),
        )
        return variant

    def list_script_templates(self) -> list[ScriptTemplate]:
        rows = self._query("SELECT * FROM script_templates ORDER BY industry")
        return [
            ScriptTemplate(
                industry=r["industry"],
                count=r["count"],
                desc=r["desc"],
                installed=_int_to_bool(r["installed"]),
            )
            for r in rows
        ]

    # ═══════════════════════════════════════════════════════
    # 获客域 · CommentReplyTask
    # ═══════════════════════════════════════════════════════

    def _row_to_comment_task(self, row: sqlite3.Row) -> CommentReplyTask:
        return CommentReplyTask(
            id=row["id"],
            lead_id=row["lead_id"],
            comment_content=row["comment_content"],
            video_title=row["video_title"],
            video_url=row["video_url"],
            comment_id=row["comment_id"],
            reply_failure_reason=row["reply_failure_reason"],
            priority=row["priority"],
            reply_script_id=row["reply_script_id"],
            reply_variant_id=(
                row["reply_variant_id"] if "reply_variant_id" in row.keys() else ""
            ),
            reply_content=row["reply_content"],
            status=row["status"],
            account=row["account"],
            scheduled_at=_str_to_dt(row["scheduled_at"]),
            replied_at=_str_to_dt(row["replied_at"]),
            user_visited=_int_to_bool(row["user_visited"]),
            user_dm=_int_to_bool(row["user_dm"]),
            user_replied_comment=_int_to_bool(row["user_replied_comment"]),
            user_reply_content=row["user_reply_content"],
            replier_name=row["replier_name"],
            sub_replies=row["sub_replies"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_comment_tasks(self, status: str | None = None) -> list[CommentReplyTask]:
        if status:
            rows = self._query(
                "SELECT * FROM comment_tasks WHERE status = ? ORDER BY created_at DESC",
                (status,),
            )
        else:
            rows = self._query("SELECT * FROM comment_tasks ORDER BY created_at DESC")
        return [self._row_to_comment_task(r) for r in rows]

    def get_comment_task(self, task_id: str) -> CommentReplyTask:
        row = self._query_one("SELECT * FROM comment_tasks WHERE id = ?", (task_id,))
        if row is None:
            raise KeyError(f"CommentTask not found: {task_id}")
        return self._row_to_comment_task(row)

    def save_comment_task(self, task: CommentReplyTask) -> CommentReplyTask:
        self._execute(
            """INSERT OR REPLACE INTO comment_tasks
               (id, lead_id, comment_content, video_title, video_url, comment_id,
                reply_failure_reason, priority, reply_script_id, reply_variant_id,
                reply_content, status, account, scheduled_at, replied_at, user_visited,
                user_dm, user_replied_comment, user_reply_content, replier_name, sub_replies,
                created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                task.id, task.lead_id, task.comment_content, task.video_title,
                task.video_url, task.comment_id, task.reply_failure_reason, task.priority,
                task.reply_script_id, task.reply_variant_id,
                task.reply_content, task.status, task.account,
                _dt_to_str(task.scheduled_at), _dt_to_str(task.replied_at),
                _bool_to_int(task.user_visited), _bool_to_int(task.user_dm),
                _bool_to_int(task.user_replied_comment),
                task.user_reply_content, task.replier_name, task.sub_replies,
                _dt_to_str(task.created_at), _dt_to_str(task.updated_at),
            ),
        )
        return task

    # ═══════════════════════════════════════════════════════
    # 客户域 · Customer / Log
    # ═══════════════════════════════════════════════════════

    def _row_to_customer(self, row: sqlite3.Row) -> Customer:
        return Customer(
            id=row["id"],
            name=row["name"],
            source=row["source"],
            stage=row["stage"],
            lead_id=row["lead_id"],
            est_value=row["est_value"],
            deal_amount=row["deal_amount"],
            deal_at=_str_to_dt(row["deal_at"]),
            wechat_added_at=_str_to_dt(row["wechat_added_at"]),
            manual=_int_to_bool(row["manual"]),
            referrer=row["referrer"],
            next_action=row["next_action"],
            next_at=row["next_at"],
            lost_reason=row["lost_reason"],
            lost_reason_category=row["lost_reason_category"] if "lost_reason_category" in row.keys() else None,
            lost_reason_note=row["lost_reason_note"] if "lost_reason_note" in row.keys() else None,
            lost_at=_str_to_dt(row["lost_at"]),
            hue=row["hue"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_customers(self, stage: str | None = None) -> list[Customer]:
        if stage:
            rows = self._query(
                "SELECT * FROM customers WHERE stage = ? ORDER BY created_at DESC",
                (stage,),
            )
        else:
            rows = self._query("SELECT * FROM customers ORDER BY created_at DESC")
        return [self._row_to_customer(r) for r in rows]

    def get_customer(self, customer_id: str) -> Customer:
        row = self._query_one("SELECT * FROM customers WHERE id = ?", (customer_id,))
        if row is None:
            raise KeyError(f"Customer not found: {customer_id}")
        return self._row_to_customer(row)

    def save_customer(self, customer: Customer) -> Customer:
        self._execute(
            """INSERT OR REPLACE INTO customers
               (id, name, source, stage, lead_id, est_value, deal_amount, deal_at,
                wechat_added_at, manual, referrer, next_action, next_at, lost_reason,
                lost_reason_category, lost_reason_note,
                lost_at, hue, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                customer.id, customer.name, customer.source, customer.stage,
                customer.lead_id, customer.est_value, customer.deal_amount,
                _dt_to_str(customer.deal_at), _dt_to_str(customer.wechat_added_at),
                _bool_to_int(customer.manual), customer.referrer, customer.next_action,
                customer.next_at, customer.lost_reason,
                customer.lost_reason_category, customer.lost_reason_note,
                _dt_to_str(customer.lost_at),
                customer.hue, _dt_to_str(customer.created_at), _dt_to_str(customer.updated_at),
            ),
        )
        return customer

    def _row_to_customer_log(self, row: sqlite3.Row) -> CustomerLog:
        return CustomerLog(
            id=row["id"],
            customer_id=row["customer_id"],
            text=row["text"],
            time=row["time"],
            by=row["by"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_customer_logs(self, customer_id: str) -> list[CustomerLog]:
        rows = self._query(
            "SELECT * FROM customer_logs WHERE customer_id = ? ORDER BY created_at",
            (customer_id,),
        )
        return [self._row_to_customer_log(r) for r in rows]

    def save_customer_log(self, log: CustomerLog) -> CustomerLog:
        self._execute(
            """INSERT OR REPLACE INTO customer_logs
               (id, customer_id, text, time, by, created_at)
               VALUES (?,?,?,?,?,?)""",
            (
                log.id, log.customer_id, log.text, log.time, log.by,
                _dt_to_str(log.created_at),
            ),
        )
        return log

    def delete_customer(self, customer_id: str) -> None:
        row = self._query_one("SELECT id FROM customers WHERE id = ?", (customer_id,))
        if row is None:
            raise KeyError(f"Customer not found: {customer_id}")
        self._execute("DELETE FROM customer_logs WHERE customer_id = ?", (customer_id,))
        self._execute("DELETE FROM customers WHERE id = ?", (customer_id,))

    # ═══════════════════════════════════════════════════════
    # 客户域 · FollowUp
    # ═══════════════════════════════════════════════════════

    def _row_to_followup(self, row: sqlite3.Row) -> FollowUp:
        return FollowUp(
            id=row["id"],
            customer_id=row["customer_id"],
            customer_name=row["customer_name"],
            type=row["type"],
            text=row["text"],
            due=row["due"],
            overdue=_int_to_bool(row["overdue"]),
            done=_int_to_bool(row["done"]),
            lead_id=row["lead_id"],
            event_type=row["event_type"],
            content=row["content"],
            scheduled_at=_str_to_dt(row["scheduled_at"]),
            result=row["result"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_followups(self, date: str | None = None, done: bool | None = None) -> list[FollowUp]:
        sql = "SELECT * FROM followups WHERE 1=1"
        params: list = []
        if date == "overdue":
            sql += " AND overdue = 1 AND done = 0"
        elif date == "today":
            sql += " AND overdue = 0 AND done = 0 AND due LIKE ?"
            params.append("%今天%")
        elif date == "upcoming":
            sql += " AND done = 0 AND due NOT LIKE ? AND overdue = 0"
            params.append("%今天%")
        if done is not None:
            sql += " AND done = ?"
            params.append(_bool_to_int(done))
        sql += " ORDER BY created_at DESC"
        rows = self._query(sql, tuple(params))
        return [self._row_to_followup(r) for r in rows]

    def get_followup(self, followup_id: str) -> FollowUp:
        row = self._query_one("SELECT * FROM followups WHERE id = ?", (followup_id,))
        if row is None:
            raise KeyError(f"FollowUp not found: {followup_id}")
        return self._row_to_followup(row)

    def save_followup(self, followup: FollowUp) -> FollowUp:
        self._execute(
            """INSERT OR REPLACE INTO followups
               (id, customer_id, customer_name, type, text, due, overdue, done,
                lead_id, event_type, content, scheduled_at, result, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                followup.id, followup.customer_id, followup.customer_name,
                followup.type, followup.text, followup.due,
                _bool_to_int(followup.overdue), _bool_to_int(followup.done),
                followup.lead_id, followup.event_type, followup.content,
                _dt_to_str(followup.scheduled_at), followup.result,
                _dt_to_str(followup.created_at),
            ),
        )
        return followup

    # ═══════════════════════════════════════════════════════
    # 消息域 · Conversation / Message
    # ═══════════════════════════════════════════════════════

    def _row_to_conversation(self, row: sqlite3.Row) -> Conversation:
        return Conversation(
            id=row["id"],
            lead_id=row["lead_id"],
            account_name=row["account_name"],
            status=row["status"],
            last_message_at=_str_to_dt(row["last_message_at"]) or datetime.now(timezone.utc),
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_conversations(self) -> list[Conversation]:
        rows = self._query("SELECT * FROM conversations ORDER BY last_message_at DESC")
        return [self._row_to_conversation(r) for r in rows]

    def get_conversation(self, conversation_id: str) -> Conversation:
        row = self._query_one("SELECT * FROM conversations WHERE id = ?", (conversation_id,))
        if row is None:
            raise KeyError(f"Conversation not found: {conversation_id}")
        return self._row_to_conversation(row)

    def save_conversation(self, conversation: Conversation) -> Conversation:
        self._execute(
            """INSERT OR REPLACE INTO conversations
               (id, lead_id, account_name, status, last_message_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (
                conversation.id, conversation.lead_id, conversation.account_name,
                conversation.status, _dt_to_str(conversation.last_message_at),
                _dt_to_str(conversation.created_at), _dt_to_str(conversation.updated_at),
            ),
        )
        return conversation

    def _row_to_message(self, row: sqlite3.Row) -> Message:
        return Message(
            id=row["id"],
            conversation_id=row["conversation_id"],
            sender=row["sender"],
            content=row["content"],
            is_ai_generated=_int_to_bool(row["is_ai_generated"]),
            direction=row["direction"],
            variant=row["variant"],
            is_read=_int_to_bool(row["is_read"]) if "is_read" in row.keys() else False,
            script_id=row["script_id"] if "script_id" in row.keys() else None,
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_messages(self, conversation_id: str | None = None) -> list[Message]:
        if conversation_id:
            rows = self._query(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at",
                (conversation_id,),
            )
        else:
            rows = self._query("SELECT * FROM messages ORDER BY created_at")
        return [self._row_to_message(r) for r in rows]

    def save_message(self, message: Message) -> Message:
        self._execute(
            """INSERT OR REPLACE INTO messages
               (id, conversation_id, sender, content, is_ai_generated, direction, variant, is_read, script_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                message.id, message.conversation_id, message.sender, message.content,
                _bool_to_int(message.is_ai_generated), message.direction, message.variant,
                _bool_to_int(message.is_read), message.script_id,
                _dt_to_str(message.created_at),
            ),
        )
        return message

    # ═══════════════════════════════════════════════════════
    # 合规域 · Event / Rule / Runtime
    # ═══════════════════════════════════════════════════════

    def _row_to_compliance_event(self, row: sqlite3.Row) -> ComplianceEvent:
        return ComplianceEvent(
            id=row["id"],
            type=row["type"],
            level=row["level"],
            text=row["text"],
            time=row["time"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_compliance_events(self, limit: int | None = None) -> list[ComplianceEvent]:
        sql = "SELECT * FROM compliance_events ORDER BY created_at DESC"
        if limit:
            sql += f" LIMIT {int(limit)}"
        rows = self._query(sql)
        return [self._row_to_compliance_event(r) for r in rows]

    def save_compliance_event(self, event: ComplianceEvent) -> ComplianceEvent:
        self._execute(
            """INSERT OR REPLACE INTO compliance_events
               (id, type, level, text, time, created_at)
               VALUES (?,?,?,?,?,?)""",
            (
                event.id, event.type, event.level, event.text, event.time,
                _dt_to_str(event.created_at),
            ),
        )
        return event

    def _row_to_compliance_rule(self, row: sqlite3.Row) -> ComplianceRule:
        return ComplianceRule(
            rule_id=row["rule_id"],
            desc=row["desc"],
            status=row["status"],
            hit_at=row["hit_at"],
            target=row["target"],
        )

    def list_compliance_rules(self) -> list[ComplianceRule]:
        rows = self._query("SELECT * FROM compliance_rules ORDER BY rule_id")
        return [self._row_to_compliance_rule(r) for r in rows]

    def save_compliance_rule(self, rule: ComplianceRule) -> ComplianceRule:
        self._execute(
            """INSERT OR REPLACE INTO compliance_rules
               (rule_id, desc, status, hit_at, target)
               VALUES (?,?,?,?,?)""",
            (rule.rule_id, rule.desc, rule.status, rule.hit_at, rule.target),
        )
        return rule

    def get_runtime(self) -> RuntimeState:
        row = self._query_one("SELECT * FROM runtime_state WHERE id = 'default'")
        if row is None:
            return RuntimeState()
        return RuntimeState(
            id=row["id"],
            safe_mode_active=_int_to_bool(row["safe_mode_active"]),
            safe_mode_reason=row["safe_mode_reason"],
            safe_mode_triggered_at=row["safe_mode_triggered_at"],
            safe_mode_trigger_source=row["safe_mode_trigger_source"],
            task_running=_int_to_bool(row["task_running"]),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def save_runtime(self, state: RuntimeState) -> RuntimeState:
        self._execute(
            """INSERT OR REPLACE INTO runtime_state
               (id, safe_mode_active, safe_mode_reason, safe_mode_triggered_at,
                safe_mode_trigger_source, task_running, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (
                state.id, _bool_to_int(state.safe_mode_active), state.safe_mode_reason,
                state.safe_mode_triggered_at, state.safe_mode_trigger_source,
                _bool_to_int(state.task_running), _dt_to_str(state.updated_at),
            ),
        )
        return state

    # ═══════════════════════════════════════════════════════
    # 任务域 · Task / Behavior
    # ═══════════════════════════════════════════════════════

    def _row_to_task(self, row: sqlite3.Row) -> Task:
        return Task(
            id=row["id"],
            task_type=row["task_type"],
            payload=_from_json(row["payload"], {}),
            status=row["status"],
            error_message=row["error_message"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_tasks(self) -> list[Task]:
        rows = self._query("SELECT * FROM tasks ORDER BY created_at DESC")
        return [self._row_to_task(r) for r in rows]

    def get_task(self, task_id: str) -> Task:
        row = self._query_one("SELECT * FROM tasks WHERE id = ?", (task_id,))
        if row is None:
            raise KeyError(f"Task not found: {task_id}")
        return self._row_to_task(row)

    def save_task(self, task: Task) -> Task:
        self._execute(
            """INSERT OR REPLACE INTO tasks
               (id, task_type, payload, status, error_message, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (
                task.id, task.task_type, _to_json(task.payload), task.status,
                task.error_message, _dt_to_str(task.created_at), _dt_to_str(task.updated_at),
            ),
        )
        return task

    def _row_to_behavior_event(self, row: sqlite3.Row) -> LeadBehaviorEvent:
        return LeadBehaviorEvent(
            id=row["id"],
            lead_id=row["lead_id"],
            event_type=row["event_type"],
            content=row["content"],
            value=row["value"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_behavior_events(self, lead_id: str | None = None) -> list[LeadBehaviorEvent]:
        if lead_id:
            rows = self._query(
                "SELECT * FROM behavior_events WHERE lead_id = ? ORDER BY created_at",
                (lead_id,),
            )
        else:
            rows = self._query("SELECT * FROM behavior_events ORDER BY created_at")
        return [self._row_to_behavior_event(r) for r in rows]

    def save_behavior_event(self, event: LeadBehaviorEvent) -> LeadBehaviorEvent:
        self._execute(
            """INSERT OR REPLACE INTO behavior_events
               (id, lead_id, event_type, content, value, created_at)
               VALUES (?,?,?,?,?,?)""",
            (
                event.id, event.lead_id, event.event_type, event.content,
                event.value, _dt_to_str(event.created_at),
            ),
        )
        return event

    # ═══════════════════════════════════════════════════════
    # 采集域 · CrawlTask
    # ═══════════════════════════════════════════════════════

    def _row_to_crawl_task(self, row: sqlite3.Row) -> CrawlTask:
        return CrawlTask(
            id=row["id"],
            name=row["name"],
            crawl_type=row["crawl_type"],
            keyword=row["keyword"],
            competitor_account=row["competitor_account"],
            video_url=row["video_url"],
            source=row["source"],
            intent_keywords=row["intent_keywords"],
            excluded_keywords=row["excluded_keywords"],
            max_comments=row["max_comments"],
            time_range=row["time_range"],
            max_videos=row["max_videos"],
            max_comments_per_video=row["max_comments_per_video"],
            sort_type=row["sort_type"],
            enable_sub_comments=(
                bool(row["enable_sub_comments"])
                if "enable_sub_comments" in row.keys()
                else False
            ),
            status=row["status"],
            collected_count=row["collected_count"],
            imported_count=row["imported_count"],
            error_message=row["error_message"],
            started_at=_str_to_dt(row["started_at"]),
            finished_at=_str_to_dt(row["finished_at"]),
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def list_crawl_tasks(self, status: str | None = None) -> list[CrawlTask]:
        if status:
            rows = self._query(
                "SELECT * FROM crawl_tasks WHERE status = ? ORDER BY created_at DESC",
                (status,),
            )
        else:
            rows = self._query("SELECT * FROM crawl_tasks ORDER BY created_at DESC")
        return [self._row_to_crawl_task(r) for r in rows]

    def get_crawl_task(self, task_id: str) -> CrawlTask:
        row = self._query_one("SELECT * FROM crawl_tasks WHERE id = ?", (task_id,))
        if row is None:
            raise KeyError(f"CrawlTask not found: {task_id}")
        return self._row_to_crawl_task(row)

    def save_crawl_task(self, task: CrawlTask) -> CrawlTask:
        self._execute(
            """INSERT OR REPLACE INTO crawl_tasks
               (id, name, crawl_type, keyword, competitor_account, video_url,
                source, intent_keywords, excluded_keywords, max_comments,
                time_range, max_videos, max_comments_per_video, sort_type,
                status, collected_count, imported_count, error_message,
                started_at, finished_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                task.id, task.name, task.crawl_type, task.keyword,
                task.competitor_account, task.video_url, task.source,
                task.intent_keywords, task.excluded_keywords, task.max_comments,
                task.time_range, task.max_videos, task.max_comments_per_video,
                task.sort_type, task.status, task.collected_count, task.imported_count,
                task.error_message, _dt_to_str(task.started_at),
                _dt_to_str(task.finished_at), _dt_to_str(task.created_at),
                _dt_to_str(task.updated_at),
            ),
        )
        return task

    def delete_crawl_task(self, task_id: str) -> None:
        self._execute("DELETE FROM crawl_tasks WHERE id = ?", (task_id,))

    # ═══════════════════════════════════════════════════════
    # 配置域 · 单例
    # ═══════════════════════════════════════════════════════

    def get_business_profile(self) -> BusinessProfile:
        row = self._query_one("SELECT * FROM business_profile WHERE id = 'default'")
        if row is None:
            return BusinessProfile()
        return BusinessProfile(
            id=row["id"],
            industry=row["industry"],
            product=row["product"],
            service_area=row["service_area"],
            target_customer=row["target_customer"],
            price_range=row["price_range"],
            conversion_goal=row["conversion_goal"],
            tone=row["tone"],
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def save_business_profile(self, profile: BusinessProfile) -> BusinessProfile:
        self._execute(
            """INSERT OR REPLACE INTO business_profile
               (id, industry, product, service_area, target_customer,
                price_range, conversion_goal, tone, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                profile.id, profile.industry, profile.product, profile.service_area,
                profile.target_customer, profile.price_range, profile.conversion_goal,
                profile.tone, _dt_to_str(profile.updated_at),
            ),
        )
        return profile

    def get_product_knowledge(self) -> ProductKnowledge:
        row = self._query_one("SELECT * FROM product_knowledge WHERE id = 'default'")
        if row is None:
            return ProductKnowledge()
        return ProductKnowledge(
            id=row["id"],
            product_name=row["product_name"],
            description=row["description"],
            selling_points=row["selling_points"],
            target_customers=row["target_customers"],
            price_range=row["price_range"],
            faq=row["faq"],
            forbidden_claims=row["forbidden_claims"],
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def save_product_knowledge(self, value: ProductKnowledge) -> ProductKnowledge:
        self._execute(
            """INSERT OR REPLACE INTO product_knowledge
               (id, product_name, description, selling_points, target_customers,
                price_range, faq, forbidden_claims, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                value.id, value.product_name, value.description, value.selling_points,
                value.target_customers, value.price_range, value.faq,
                value.forbidden_claims, _dt_to_str(value.updated_at),
            ),
        )
        return value

    def get_audience_profile(self) -> AudienceProfile:
        row = self._query_one("SELECT * FROM audience_profile WHERE id = 'default'")
        if row is None:
            return AudienceProfile()
        return AudienceProfile(
            id=row["id"],
            name=row["name"],
            industry=row["industry"],
            region=row["region"],
            needs=row["needs"],
            pain_points=row["pain_points"],
            intent_keywords=row["intent_keywords"],
            excluded_keywords=row["excluded_keywords"],
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def save_audience_profile(self, value: AudienceProfile) -> AudienceProfile:
        self._execute(
            """INSERT OR REPLACE INTO audience_profile
               (id, name, industry, region, needs, pain_points,
                intent_keywords, excluded_keywords, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                value.id, value.name, value.industry, value.region, value.needs,
                value.pain_points, value.intent_keywords, value.excluded_keywords,
                _dt_to_str(value.updated_at),
            ),
        )
        return value

    def get_script_strategy(self) -> ScriptStrategy:
        row = self._query_one("SELECT * FROM script_strategy WHERE id = 'default'")
        if row is None:
            return ScriptStrategy()
        return ScriptStrategy(
            id=row["id"],
            comment_script=row["comment_script"],
            private_message_script=row["private_message_script"],
            wechat_script=row["wechat_script"],
            objection_script=row["objection_script"],
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def save_script_strategy(self, value: ScriptStrategy) -> ScriptStrategy:
        self._execute(
            """INSERT OR REPLACE INTO script_strategy
               (id, comment_script, private_message_script, wechat_script,
                objection_script, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (
                value.id, value.comment_script, value.private_message_script,
                value.wechat_script, value.objection_script, _dt_to_str(value.updated_at),
            ),
        )
        return value

    def get_wechat_settings(self) -> WeChatSettings:
        row = self._query_one("SELECT * FROM wechat_settings WHERE id = 'default'")
        if row is None:
            return WeChatSettings()
        return WeChatSettings(
            id=row["id"],
            wechat_id=row["wechat_id"],
            guide_timing=row["guide_timing"],
            guide_reason=row["guide_reason"],
            compliance_note=row["compliance_note"],
            updated_at=_str_to_dt(row["updated_at"]) or datetime.now(timezone.utc),
        )

    def save_wechat_settings(self, value: WeChatSettings) -> WeChatSettings:
        self._execute(
            """INSERT OR REPLACE INTO wechat_settings
               (id, wechat_id, guide_timing, guide_reason, compliance_note, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (
                value.id, value.wechat_id, value.guide_timing, value.guide_reason,
                value.compliance_note, _dt_to_str(value.updated_at),
            ),
        )
        return value

    # ═══════════════════════════════════════════════════════
    # 聚合查询
    # ═══════════════════════════════════════════════════════

    # =================================================================
    # 系统配置中心 · key-value
    # =================================================================

    def get_system_settings(self, category: str) -> dict[str, str]:
        rows = self._query(
            "SELECT key, value FROM system_settings WHERE category = ?",
            (category,),
        )
        return {r["key"]: r["value"] for r in rows if r["value"] is not None}

    def set_system_setting(self, category: str, key: str, value: str) -> None:
        sql = """INSERT INTO system_settings (category, key, value, updated_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(category, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"""
        self._execute(sql, (category, key, value))

    def get_all_system_settings(self) -> dict[str, dict[str, str]]:
        rows = self._query("SELECT category, key, value FROM system_settings")
        result: dict[str, dict[str, str]] = {}
        for r in rows:
            if r["value"] is None:
                continue
            cat = r["category"]
            if cat not in result:
                result[cat] = {}
            result[cat][r["key"]] = r["value"]
        return result

    def summary(self) -> dict[str, int]:
        counts = {}
        for table in ["leads", "tasks", "followups", "conversations",
                       "messages", "accounts", "customers", "scripts"]:
            row = self._query_one(f"SELECT COUNT(*) AS cnt FROM {table}")
            counts[table] = row["cnt"] if row else 0
        return {
            "leads": counts["leads"],
            "tasks": counts["tasks"],
            "followups": counts["followups"],
            "conversations": counts["conversations"],
            "messages": counts["messages"],
            "accounts": counts["accounts"],
            "customers": counts["customers"],
            "scripts": counts["scripts"],
        }

    def funnel_stats(self, window_days: int = 30) -> dict:
        from datetime import timedelta as _td
        ws = (datetime.now(timezone.utc) - _td(days=window_days)).isoformat()
        tr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE created_at >= ?", (ws,))
        t = tr["cnt"] if tr else 0
        orr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE created_at >= ? AND status IN ('sent','replied','wechat_added','deal_won')", (ws,))
        o = orr["cnt"] if orr else 0
        rr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE created_at >= ? AND status IN ('replied','wechat_added','deal_won')", (ws,))
        r_ = rr["cnt"] if rr else 0
        wr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE created_at >= ? AND status IN ('wechat_added','deal_won')", (ws,))
        w = wr["cnt"] if wr else 0
        dr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE created_at >= ? AND status = 'deal_won'", (ws,))
        d = dr["cnt"] if dr else 0
        da = self._query_one("SELECT COALESCE(SUM(deal_amount),0) AS total, COUNT(*) AS cnt FROM leads WHERE created_at >= ? AND status = 'deal_won' AND deal_amount > 0", (ws,))
        av = (da["total"] / da["cnt"]) if da and da["cnt"] else 0
        # P3-14: read ad spend within window
        spend_row = self._query_one(
            "SELECT COALESCE(SUM(amount),0) AS total FROM ad_spend WHERE date >= ?", (ws[:10],)
        )
        total_spend = spend_row["total"] if spend_row else 0
        spend_connected = total_spend > 0
        return {
            "window": f"近 {window_days} 天",
            "stages": [
                {"key": "exposure", "label": "评论区曝光", "value": 0},
                {"key": "collected", "label": "线索入库", "value": t},
                {"key": "outreach", "label": "私信触达", "value": o},
                {"key": "replied", "label": "私信回复", "value": r_},
                {"key": "wechat", "label": "加企微 ★", "value": w},
                {"key": "deal", "label": "成交", "value": d},
            ],
            "cost": {"totalSpend": total_spend, "perLead": (round(total_spend / t, 2) if t else 0), "perWechatAdd": (round(total_spend / w, 2) if w else 0), "perDeal": (round(total_spend / d, 2) if d else 0), "avgDealAmount": av}, "spendConnected": spend_connected,
            "wechatTrend": [],
        }

    def attribution_stats(self, window_days: int = 30) -> dict:
        from datetime import timedelta as _td
        ws = (datetime.now(timezone.utc) - _td(days=window_days)).isoformat()
        bs = []
        for sk in ["own_comment", "competitor", "inbound_dm", "fan_dm", "lead_card", "referral"]:
            lr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE source = ? AND created_at >= ?", (sk, ws))
            lc = lr["cnt"] if lr else 0
            wr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE source = ? AND created_at >= ? AND status IN ('wechat_added','deal_won')", (sk, ws))
            wc = wr["cnt"] if wr else 0
            dr = self._query_one("SELECT COUNT(*) AS cnt FROM leads WHERE source = ? AND created_at >= ? AND status = 'deal_won'", (sk, ws))
            dc = dr["cnt"] if dr else 0
            bs.append({"source": sk, "label": sk, "leads": lc, "wechat": wc, "deal": dc, "pilot": sk in ("lead_card", "referral")})
        return {"window": f"近 {window_days} 天", "bySource": bs, "topVideos": []}

    def compliance_summary(self) -> dict:
        rejected_row = self._query_one(
            "SELECT COUNT(*) AS cnt FROM leads WHERE status = 'rejected'"
        )
        rejected = rejected_row["cnt"] if rejected_row else 0

        audit_row = self._query_one("SELECT COUNT(*) AS cnt FROM compliance_events")
        audit = audit_row["cnt"] if audit_row else 0

        return {
            "summary": {
                "unsubscribe7d": 0,
                "blacklistTotal": rejected,
                "blacklistDelta7d": 0,
                "complaints7d": 0,
                "auditEvents": audit,
            },
            "rules": self.list_compliance_rules(),
            "audit": self.list_compliance_events(limit=20),
        }

    # ═══════════════════════════════════════════════════════
    # 调度域 · SchedulerConfig / 发送计数
    # ═══════════════════════════════════════════════════════

    def get_scheduler_config(self) -> dict:
        row = self._query_one("SELECT * FROM scheduler_config WHERE id = 1")
        if row is None:
            return {}
        return {
            "strategy": row["strategy"],
            "health_threshold_warn": row["health_threshold_warn"],
            "health_threshold_critical": row["health_threshold_critical"],
            "max_concurrent": row["max_concurrent"],
        }

    def save_scheduler_config(self, data: dict) -> dict:
        from app.models.domain import now_utc
        now = now_utc().isoformat()
        existing = self.get_scheduler_config()
        merged = {**existing, **data}
        self._execute(
            """INSERT OR REPLACE INTO scheduler_config
               (id, strategy, health_threshold_warn, health_threshold_critical,
                max_concurrent, updated_at)
               VALUES (1, ?, ?, ?, ?, ?)""",
            (
                merged.get("strategy", "round_robin"),
                merged.get("health_threshold_warn", 60),
                merged.get("health_threshold_critical", 30),
                merged.get("max_concurrent", 3),
                now,
            ),
        )
        return self.get_scheduler_config()

    def increment_account_send(self, account_id: str, success: bool) -> None:
        if success:
            self._execute(
                "UPDATE accounts SET today_sent = today_sent + 1, today_success = today_success + 1 WHERE id = ?",
                (account_id,),
            )
        else:
            self._execute(
                "UPDATE accounts SET today_sent = today_sent + 1 WHERE id = ?",
                (account_id,),
            )


    # ═══════════════════════════════════════════════════════
    # 通知域 · Notification（P4-A）
    # ═══════════════════════════════════════════════════════

    def _row_to_notification(self, row: sqlite3.Row) -> Notification:
        return Notification(
            id=row["id"],
            type=row["type"],
            title=row["title"],
            content=row["content"],
            level=row["level"],
            read=_int_to_bool(row["read"]),
            related_type=row["related_type"],
            related_id=row["related_id"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def list_notifications(self, unread_only: bool = False, limit: int = 50, offset: int = 0) -> list[Notification]:
        sql = "SELECT * FROM notifications WHERE 1=1"
        params: list = []
        if unread_only:
            sql += " AND read = 0"
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])
        rows = self._query(sql, tuple(params))
        return [self._row_to_notification(r) for r in rows]

    def get_unread_count(self) -> int:
        row = self._query_one("SELECT COUNT(*) AS cnt FROM notifications WHERE read = 0")
        return row["cnt"] if row else 0

    def mark_notification_read(self, notification_id: str) -> bool:
        cur = self._execute("UPDATE notifications SET read = 1 WHERE id = ?", (notification_id,))
        return cur.rowcount > 0

    def mark_all_read(self) -> None:
        self._execute("UPDATE notifications SET read = 1 WHERE read = 0")

    def create_notification(self, notification: Notification) -> Notification:
        self._execute(
            """INSERT OR REPLACE INTO notifications
               (id, type, title, content, level, read, related_type, related_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                notification.id, notification.type, notification.title, notification.content,
                notification.level, _bool_to_int(notification.read),
                notification.related_type, notification.related_id,
                _dt_to_str(notification.created_at),
            ),
        )
        return notification

    # ═══════════════════════════════════════════════════════
    # 私信发送执行域 · DmSendResult（P4-D）
    # ═══════════════════════════════════════════════════════

    def _row_to_dm_send_result(self, row: sqlite3.Row) -> DmSendResult:
        keys = row.keys()
        return DmSendResult(
            id=row["id"],
            lead_id=row["lead_id"],
            account_id=row["account_id"],
            content=row["content"],
            status=row["status"],
            message=row["message"] or "",
            sender_mode=row["sender_mode"],
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
            retry_count=row["retry_count"] if "retry_count" in keys else 0,
            retry_status=row["retry_status"] if "retry_status" in keys else "idle",
            next_retry_at=(
                _str_to_dt(row["next_retry_at"])
                if "next_retry_at" in keys and row["next_retry_at"] else None
            ),
        )

    def create_dm_send_result(self, result: DmSendResult) -> DmSendResult:
        self._execute(
            """INSERT INTO dm_send_results
               (id, lead_id, account_id, content, status, message, sender_mode,
                retry_count, retry_status, next_retry_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                result.id, result.lead_id, result.account_id, result.content,
                result.status, result.message, result.sender_mode,
                result.retry_count, result.retry_status, _dt_to_str(result.next_retry_at),
                _dt_to_str(result.created_at),
            ),
        )
        return result

    def list_dm_send_results(self, limit: int = 50) -> list[DmSendResult]:
        rows = self._query(
            "SELECT * FROM dm_send_results ORDER BY created_at DESC LIMIT ?",
            (int(limit),),
        )
        return [self._row_to_dm_send_result(r) for r in rows]

    def list_retryable_send_results(self, now_iso: str, limit: int = 50) -> list[DmSendResult]:
        """P2-12: 取出到期可重试的失败记录（retry_status=pending 且 next_retry_at<=now）"""
        rows = self._query(
            """SELECT * FROM dm_send_results
               WHERE retry_status = 'pending'
                 AND next_retry_at IS NOT NULL
                 AND next_retry_at <= ?
               ORDER BY created_at ASC LIMIT ?""",
            (now_iso, int(limit)),
        )
        return [self._row_to_dm_send_result(r) for r in rows]

    def update_dm_send_result_retry(self, result: DmSendResult) -> None:
        """P2-12: 回写单条发送记录的重试状态"""
        self._execute(
            """UPDATE dm_send_results
               SET retry_count = ?, retry_status = ?, next_retry_at = ?
               WHERE id = ?""",
            (result.retry_count, result.retry_status,
             _dt_to_str(result.next_retry_at), result.id),
        )

    # ═══════════════════════════════════════════════════════
    # 话术使用归因域 · ScriptUsage（埋点补全 Task4）
    # ═══════════════════════════════════════════════════════

    def _row_to_script_usage(self, row: sqlite3.Row) -> ScriptUsage:
        return ScriptUsage(
            id=row["id"],
            script_id=row["script_id"],
            variant_id=row["variant_id"],
            lead_id=row["lead_id"],
            channel=row["channel"],
            result=row["result"],
            used_at=_str_to_dt(row["used_at"]) or datetime.now(timezone.utc),
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def save_script_usage(self, usage: ScriptUsage) -> ScriptUsage:
        self._execute(
            """INSERT OR REPLACE INTO script_usage
               (id, script_id, variant_id, lead_id, channel, result, used_at, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                usage.id, usage.script_id, usage.variant_id, usage.lead_id,
                usage.channel, usage.result,
                _dt_to_str(usage.used_at), _dt_to_str(usage.created_at),
            ),
        )
        return usage

    def update_script_usage_result(self, lead_id: str, result: str) -> None:
        """回写该 lead_id 所有未结束 script_usage 行的 result（已结束的不覆盖）"""
        self._execute(
            "UPDATE script_usage SET result = ? WHERE lead_id = ? AND (result IS NULL OR result = '')",
            (result, lead_id),
        )

    def list_script_usages(self, lead_id: str | None = None) -> list[ScriptUsage]:
        if lead_id:
            rows = self._query(
                "SELECT * FROM script_usage WHERE lead_id = ? ORDER BY used_at",
                (lead_id,),
            )
        else:
            rows = self._query("SELECT * FROM script_usage ORDER BY used_at")
        return [self._row_to_script_usage(r) for r in rows]

    # ═══════════════════════════════════════════════════════
    # 账号操作审计域 · AccountEvent（埋点补全 Task5）
    # ═══════════════════════════════════════════════════════

    def _row_to_account_event(self, row: sqlite3.Row) -> AccountEvent:
        return AccountEvent(
            id=row["id"],
            account_id=row["account_id"],
            action=row["action"],
            detail=row["detail"],
            success=_int_to_bool(row["success"]),
            created_at=_str_to_dt(row["created_at"]) or datetime.now(timezone.utc),
        )

    def save_account_event(self, event: AccountEvent) -> AccountEvent:
        self._execute(
            """INSERT OR REPLACE INTO account_events
               (id, account_id, action, detail, success, created_at)
               VALUES (?,?,?,?,?,?)""",
            (
                event.id, event.account_id, event.action, event.detail,
                _bool_to_int(event.success), _dt_to_str(event.created_at),
            ),
        )
        return event

    def list_account_events(self, limit: int = 50) -> list[AccountEvent]:
        rows = self._query(
            "SELECT * FROM account_events ORDER BY created_at DESC LIMIT ?",
            (int(limit),),
        )
        return [self._row_to_account_event(r) for r in rows]

    # ═══════════════════════════════════════════════════════
    # 评论洞察与话术质检域（v003）
    # ═══════════════════════════════════════════════════════

    def list_guard_rules(self, enabled_only: bool = True) -> list[dict]:
        sql = "SELECT * FROM script_guard_rules"
        if enabled_only:
            sql += " WHERE enabled = 1"
        sql += " ORDER BY id"
        return [dict(r) for r in self._query(sql)]

    def get_guard_rule(self, rule_id: int) -> dict | None:
        row = self._query_one("SELECT * FROM script_guard_rules WHERE id = ?", (int(rule_id),))
        return dict(row) if row is not None else None

    def create_guard_rule(self, payload: dict) -> dict:
        from app.models.domain import now_utc
        cur = self._execute(
            """INSERT INTO script_guard_rules
               (rule_code, category, pattern, severity, advice, source, enabled, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                payload.get("rule_code", ""),
                payload.get("category", ""),
                payload.get("pattern", ""),
                payload.get("severity", "warn"),
                payload.get("advice"),
                payload.get("source", "skill-comment-reply"),
                _bool_to_int(bool(payload.get("enabled", 1))),
                now_utc().isoformat(),
            ),
        )
        return self.get_guard_rule(int(cur.lastrowid)) or dict(payload)

    def update_guard_rule(self, rule_id: int, payload: dict) -> dict | None:
        from app.models.domain import now_utc
        if self.get_guard_rule(rule_id) is None:
            return None
        # 白名单列名 → 只拼接固定字段，值一律参数化
        fields: list[str] = []
        params: list = []
        for col in ("rule_code", "category", "pattern", "severity", "advice", "source", "enabled"):
            if col not in payload:
                continue
            fields.append(f"{col} = ?")
            params.append(_bool_to_int(bool(payload[col])) if col == "enabled" else payload[col])
        if not fields:
            return self.get_guard_rule(rule_id)
        fields.append("updated_at = ?")
        params.append(now_utc().isoformat())
        params.append(int(rule_id))
        self._execute(
            f"UPDATE script_guard_rules SET {', '.join(fields)} WHERE id = ?",
            tuple(params),
        )
        return self.get_guard_rule(rule_id)

    def find_duplicate_replies(
        self, reply_content: str, account: str | None, hours: int = 24
    ) -> int:
        """D7：同账号近 N 小时内 reply_content 完全相同的条数"""
        from datetime import timedelta
        since = (datetime.now(timezone.utc) - timedelta(hours=int(hours))).isoformat()
        sql = "SELECT COUNT(*) AS cnt FROM comment_tasks WHERE reply_content = ? AND created_at >= ?"
        params: list = [reply_content, since]
        if account is None:
            sql += " AND account IS NULL"
        else:
            sql += " AND account = ?"
            params.append(account)
        row = self._query_one(sql, tuple(params))
        return int(row["cnt"]) if row is not None else 0

    def update_lead_insight(self, lead_id: str, insight: dict) -> bool:
        """回写 AI 分级结果；未提供的字段保持原值（intent/intent_level 为 NOT NULL）"""
        if self._query_one("SELECT id FROM leads WHERE id = ?", (lead_id,)) is None:
            return False
        self._execute(
            """UPDATE leads
               SET intent_category = COALESCE(?, intent_category),
                   intent          = COALESCE(?, intent),
                   intent_level    = COALESCE(?, intent_level),
                   sentiment       = COALESCE(?, sentiment),
                   risk_level      = COALESCE(?, risk_level),
                   insight_json    = ?,
                   updated_at      = ?
               WHERE id = ?""",
            (
                insight.get("intent_category"),
                insight.get("intent"),
                insight.get("intent_level"),
                insight.get("sentiment"),
                insight.get("risk_level"),
                _to_json(insight),
                datetime.now(timezone.utc).isoformat(),
                lead_id,
            ),
        )
        return True

    # ═══════════════════════════════════════════════════════
    # 数据脱敏与风险聚合域（P2）
    # ═══════════════════════════════════════════════════════

    def list_leads_for_risk(
        self, start_date: str | None = None, end_date: str | None = None
    ) -> list[dict]:
        """风险聚合用：取有 comment 的线索，按日期区间（含首尾）过滤"""
        sql = (
            "SELECT id, nickname, comment, sentiment, risk_level, created_at "
            "FROM leads WHERE comment IS NOT NULL AND TRIM(comment) != ''"
        )
        params: list = []
        if start_date:
            sql += " AND SUBSTR(created_at, 1, 10) >= ?"
            params.append(str(start_date))
        if end_date:
            sql += " AND SUBSTR(created_at, 1, 10) <= ?"
            params.append(str(end_date))
        sql += " ORDER BY created_at DESC"
        return [dict(r) for r in self._query(sql, tuple(params))]

    def list_leads_for_desensitize(self, limit: int = 200) -> list[dict]:
        """存量脱敏用：仅取未脱敏线索（幂等，可重复执行）"""
        rows = self._query(
            """SELECT id, nickname, comment, referral_note
               FROM leads
               WHERE COALESCE(desensitized, 0) = 0
               ORDER BY created_at DESC
               LIMIT ?""",
            (int(limit),),
        )
        return [dict(r) for r in rows]

    def update_lead_desensitize(self, lead_id: str, fields: dict) -> bool:
        """回写脱敏结果：仅白名单列参与拼接，值一律参数化"""
        if not fields or lead_id is None:
            return False
        sets: list[str] = []
        params: list = []
        for col in ("nickname", "comment", "referral_note"):
            if col not in fields:
                continue
            sets.append(f"{col} = ?")
            params.append(fields[col])
        if not sets:
            return False
        sets.append("desensitized = 1")
        sets.append("updated_at = ?")
        params.append(datetime.now(timezone.utc).isoformat())
        params.append(lead_id)
        self._execute(f"UPDATE leads SET {', '.join(sets)} WHERE id = ?", tuple(params))
        return True

