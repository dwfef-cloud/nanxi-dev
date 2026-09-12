"""私信发送执行器 Service · P4-D
=================================
负责私信发送的编排：账号选择、频控、间隔、状态机回写、结果留痕。

- 单次发送：send_one
- 批量发送：send_batch（后台线程，不阻塞 HTTP）
- 配置管理：get_config / update_config（存 system_settings）
- 结果留痕：list_results / 写 dm_send_results

发送器实现由 integrations/dm_sender.py 提供（Mock / CDP）。
"""
from __future__ import annotations

import logging
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app.integrations.dm_sender import CDPDmSender, DmSender, MockDmSender, SendResult
from app.models.domain import Account, DmSendResult, Lead
from app.repositories.base import Repository
from app.services import _tracking

logger = logging.getLogger(__name__)

_CONFIG_CATEGORY = "dm_sender"
_THROTTLE_PAUSE_HOURS = 1
_MAX_RETRIES = 3  # P2-12: 失败最大重试次数
_RETRY_BACKOFF_BASE_MIN = 1  # 指数退避基数：2^n 分钟（1/2/4...）

_DEFAULT_CONTENT = "你好呀～看到你对我们的服务感兴趣，方便的话可以聊聊你的需求，我们给你出个方案。"


class DmSenderService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo
        self._lock = threading.Lock()
        self._sender: DmSender = MockDmSender()
        # P1-19: notification service (injected later)
        self._notification_service = None

        # 批量发送后台任务态
        self._batch_stop = threading.Event()
        self._batch_thread: threading.Thread | None = None
        self._batch_state: dict = {
            "task_id": None,
            "running": False,
            "total": 0,
            "done": 0,
            "success": 0,
            "failed": 0,
            "throttled": 0,
            "results": [],
        }
        # 被频控暂停的账号：account_id -> resume_at (datetime)
        self._paused_accounts: dict[str, datetime] = {}

        # 按当前配置初始化发送器
        self._sender = self._build_sender(self.get_config().get("mode", "mock"))

    # ═══════════════════════════════════════════════════════
    # 配置
    # ═══════════════════════════════════════════════════════

    @staticmethod
    def _build_sender(mode: str) -> DmSender:
        if mode == "cdp":
            return CDPDmSender()
        return MockDmSender()

    def set_notification_service(self, svc) -> None:
        """P1-19: inject NotificationService for failure/throttle alerts"""
        self._notification_service = svc

    def get_config(self) -> dict:
        # P3-8: daily_limit here is a SENDER-SIDE conservative cap (default 50).
        # It is intentionally DIFFERENT from per-account Account.daily_limit (default 80,
        # auto-reduced to 40 on R1 throttling). The two guards are complementary:
        #   Account.daily_limit = account own daily outreach quota (risk engine)
        #   dm_sender.daily_limit = sender-side soft cap when picking accounts
        # Both are tunable together: account model + dm_sender config.
        s = self._repo.get_system_settings(_CONFIG_CATEGORY)
        return {
            "mode": s.get("mode", "mock"),
            "min_interval": int(s.get("min_interval", "30")),
            "max_interval": int(s.get("max_interval", "60")),
            "daily_limit": int(s.get("daily_limit", "50")),
        }

    def update_config(
        self,
        mode: str | None = None,
        min_interval: int | None = None,
        max_interval: int | None = None,
        daily_limit: int | None = None,
    ) -> dict:
        cfg = self.get_config()
        if mode is not None:
            if mode not in ("mock", "cdp"):
                raise ValueError("mode 必须是 mock 或 cdp")
            cfg["mode"] = mode
        if min_interval is not None:
            cfg["min_interval"] = max(0, int(min_interval))
        if max_interval is not None:
            cfg["max_interval"] = max(0, int(max_interval))
        # P3-10: explicitly reject min_interval > max_interval (was silently normalized)
        if cfg["min_interval"] > cfg["max_interval"]:
            raise ValueError(
                "min_interval(%d) must be <= max_interval(%d)"
                % (cfg["min_interval"], cfg["max_interval"]),
            )
        if daily_limit is not None:
            cfg["daily_limit"] = max(1, int(daily_limit))

        self._repo.set_system_setting(_CONFIG_CATEGORY, "mode", cfg["mode"])
        self._repo.set_system_setting(_CONFIG_CATEGORY, "min_interval", str(cfg["min_interval"]))
        self._repo.set_system_setting(_CONFIG_CATEGORY, "max_interval", str(cfg["max_interval"]))
        self._repo.set_system_setting(_CONFIG_CATEGORY, "daily_limit", str(cfg["daily_limit"]))

        # 模式变化时重建发送器
        self._sender = self._build_sender(cfg["mode"])
        return cfg

    # ═══════════════════════════════════════════════════════
    # 单次发送
    # ═══════════════════════════════════════════════════════

    def send_one(self, lead_id: str, content: str | None = None, script_id: str | None = None) -> dict:
        """发送单条私信。lead 必须处于 pending_outreach。"""
        lead = self._repo.get_lead(lead_id)  # 不存在抛 KeyError
        if lead.status != "pending_outreach":
            raise ValueError(f"线索状态为 {lead.status}，仅 pending_outreach 可发送")

        account = self._get_available_account()
        if account is None:
            raise RuntimeError("无可用账号（健康分>60、未封禁、今日未达上限）")

        cfg = self.get_config()
        content = content or _DEFAULT_CONTENT

        # 调用发送器
        result: SendResult = self._sender.send_dm(
            account_id=account.id,
            user_id=lead.external_id or lead.id,
            content=content,
        )

        # 回写线索状态机
        self._apply_result_to_lead(lead, account, result)

        # 累加账号今日发送数
        self._repo.increment_account_send(account.id, success=(result.status == "success"))

        # 频控 → 暂停该账号 1 小时
        if result.status == "throttled":
            self._paused_accounts[account.id] = datetime.now(timezone.utc) + timedelta(hours=_THROTTLE_PAUSE_HOURS)

        # 结果留痕
        dm_result = DmSendResult(
            lead_id=lead.id,
            account_id=account.id,
            content=content,
            status=result.status,
            message=result.message,
            sender_mode=cfg["mode"],
        )
        # P2-12: retryable failures (failed/need_captcha) marked pending, exponential backoff
        if result.status in ("failed", "need_captcha"):
            dm_result.retry_status = "pending"
            dm_result.retry_count = 0
            dm_result.next_retry_at = datetime.now(timezone.utc) + timedelta(minutes=2 ** dm_result.retry_count)
        self._repo.create_dm_send_result(dm_result)

        # 埋点：私信发送（best-effort，不影响主流程）
        try:
            if result.status == "success":
                _tracking.log_lead_event(
                    self._repo, lead.id, "dm_sent",
                    f"account_id={account.id} status=success content={content[:40]}",
                )
                _tracking.record_script_usage(
                    self._repo, script_id=script_id, lead_id=lead.id, channel="dm",
                )
                _tracking.record_account_event(
                    self._repo, account_id=account.id, action="dm_sent",
                    detail=f"lead_id={lead.id}", success=True,
                )
            elif result.status == "throttled":
                _tracking.log_lead_event(
                    self._repo, lead.id, "dm_throttled",
                    f"account_id={account.id} msg={result.message}",
                )
                _tracking.record_account_event(
                    self._repo, account_id=account.id, action="throttled",
                    detail=f"lead_id={lead.id} msg={result.message}", success=False,
                )
            else:
                _tracking.log_lead_event(
                    self._repo, lead.id, "dm_failed",
                    f"account_id={account.id} status={result.status} msg={result.message}",
                )
                _tracking.record_account_event(
                    self._repo, account_id=account.id, action="error",
                    detail=f"lead_id={lead.id} status={result.status} msg={result.message}",
                    success=False,
                )
        except Exception as e:
            logger.warning(
                "埋点失败 私信发送结果留痕失败: lead_id=%s account_id=%s status=%s err=%s",
                lead.id, account.id, result.status, e, exc_info=True,
            )

        # P1-19: create notification on failure or throttle
        if self._notification_service is not None:
            lead_name = lead.nickname or lead.external_id or lead.id
            if result.status == "throttled":
                self._notification_service.create(
                    type="dm_throttled",
                    title=f"私信频控 · {account.nickname or account.name}",
                    content=f"线索 {lead_name} 发送被频控暂停1小时：{result.message}",
                    level="warning",
                    related_type="lead",
                    related_id=lead.id,
                )
            elif result.status in ("failed", "need_captcha", "account_banned"):
                self._notification_service.create(
                    type="dm_send_failed",
                    title=f"私信发送失败 · {account.nickname or account.name}",
                    content=f"线索 {lead_name} 发送失败（{result.status}）：{result.message}",
                    level="error",
                    related_type="lead",
                    related_id=lead.id,
                )

        return {
            "lead_id": lead.id,
            "status": result.status,
            "account_id": account.id,
            "message": result.message,
        }

    def _apply_result_to_lead(self, lead: Lead, account: Account, result: SendResult) -> None:
        lead.updated_at = datetime.now(timezone.utc)
        if result.status == "success":
            lead.status = "sent"
            lead.account = account.nickname or account.name
            lead.fail_note = None
            lead.throttled_note = None
        elif result.status == "throttled":
            lead.status = "throttled"
            lead.throttled_note = result.message
        else:
            # failed / need_captcha / account_banned
            lead.status = "send_failed"
            lead.fail_note = result.message
            if result.status == "account_banned":
                account.limit_status = "banned"
                account.last_ban_reason = result.message
                self._repo.save_account(account)
        self._repo.save_lead(lead)

    # ═══════════════════════════════════════════════════════
    # 批量发送（后台线程）
    # ═══════════════════════════════════════════════════════

    def send_batch(self, count: int = 10) -> dict:
        """启动批量发送后台线程，立即返回任务初始态。"""
        if self._batch_state["running"]:
            raise RuntimeError("已有批量发送任务正在运行")

        leads = self._repo.list_leads(status="pending_outreach")
        leads = leads[:count]
        if not leads:
            return {
                "task_id": None, "running": False, "total": 0, "done": 0,
                "success": 0, "failed": 0, "throttled": 0, "results": [],
                "message": "没有待发送（pending_outreach）的线索",
            }

        task_id = uuid4().hex
        self._batch_stop.clear()
        with self._lock:
            self._batch_state = {
                "task_id": task_id, "running": True, "total": len(leads),
                "done": 0, "success": 0, "failed": 0, "throttled": 0, "results": [],
            }

        self._batch_thread = threading.Thread(
            target=self._run_batch, args=[[l.id for l in leads]], daemon=True,
        )
        self._batch_thread.start()

        return self.get_batch_status()

    def _run_batch(self, lead_ids: list[str]) -> None:
        cfg = self.get_config()
        for lead_id in lead_ids:
            if self._batch_stop.is_set():
                break
            try:
                out = self.send_one(lead_id)
            except Exception as e:  # 单条失败不中断批量
                out = {"lead_id": lead_id, "status": "failed", "account_id": None, "message": str(e)}

            with self._lock:
                self._batch_state["done"] += 1
                self._batch_state["results"].append(out)
                st = out.get("status")
                if st == "success":
                    self._batch_state["success"] += 1
                elif st == "throttled":
                    self._batch_state["throttled"] += 1
                else:
                    self._batch_state["failed"] += 1

            # 随机间隔（重新读配置，允许运行中调整）
            if not self._batch_stop.is_set():
                cfg = self.get_config()
                lo, hi = cfg["min_interval"], cfg["max_interval"]
                wait = random.uniform(lo, max(lo, hi))
                # 分段 sleep 以便及时响应停止
                slept = 0.0
                while slept < wait and not self._batch_stop.is_set():
                    step = min(1.0, wait - slept)
                    time.sleep(step)
                    slept += step

        with self._lock:
            self._batch_state["running"] = False

    def stop_batch(self) -> dict:
        """请求停止批量发送（当前条发完后停）"""
        self._batch_stop.set()
        return self.get_batch_status()

    def get_batch_status(self) -> dict:
        with self._lock:
            return dict(self._batch_state)

    # ═══════════════════════════════════════════════════════
    # 结果列表 / 测试发送
    # ═══════════════════════════════════════════════════════

    def list_results(self, limit: int = 50) -> list[dict]:
        records = self._repo.list_dm_send_results(limit=limit)
        return [
            {
                "id": r.id,
                "lead_id": r.lead_id,
                "account_id": r.account_id,
                "content": r.content,
                "status": r.status,
                "message": r.message,
                "sender_mode": r.sender_mode,
                "created_at": r.created_at.isoformat(),
            }
            for r in records
        ]

    def test_send(self) -> dict:
        """用当前发送器发一条测试消息（不依赖真实 lead）"""
        cfg = self.get_config()
        result = self._sender.send_dm(account_id="__test__", user_id="__test_user__", content=_DEFAULT_CONTENT)
        self._repo.create_dm_send_result(DmSendResult(
            lead_id="__test__",
            account_id="__test__",
            content=_DEFAULT_CONTENT,
            status=result.status,
            message=result.message,
            sender_mode=cfg["mode"],
        ))
        return {"status": result.status, "message": result.message, "sender_mode": cfg["mode"]}


    # ═══════════════════════════════════════════════════════
    # P2-12：失败自动重试（指数退避，可由端点/scheduler 触发）
    # ═══════════════════════════════════════════════════════

    def retry_failed(self, max_attempt: int = 50) -> dict:
        """扫描到期的待重试失败记录并重发。

        - 仅处理 retry_status='pending' 且 next_retry_at<=now 的记录
        - 指数退避：第 n 次失败后等待 2^n 分钟
        - 成功 -> done；达到 _MAX_RETRIES 次仍失败 -> exhausted
        """
        now = datetime.now(timezone.utc)
        pending = self._repo.list_retryable_send_results(now.isoformat(), limit=max_attempt)
        retried: list[dict] = []
        for record in pending:
            lead_id = record.lead_id
            if lead_id == "__test__":
                record.retry_status = "done"
                self._repo.update_dm_send_result_retry(record)
                continue
            try:
                lead = self._repo.get_lead(lead_id)
            except KeyError:
                record.retry_status = "done"  # 线索已删除，不再重试
                self._repo.update_dm_send_result_retry(record)
                continue

            # 仅当线索仍处于 send_failed 才重发；状态已流转则结案
            if lead.status != "send_failed":
                record.retry_status = "done"
                self._repo.update_dm_send_result_retry(record)
                continue

            # 回到待发送态后复用 send_one（含账号选择/频控/留痕）
            lead.status = "pending_outreach"
            lead.updated_at = now
            self._repo.save_lead(lead)
            try:
                out = self.send_one(lead_id)
            except Exception as e:  # 无可用账号等：本轮跳过，等下次触发
                lead.status = "send_failed"
                self._repo.save_lead(lead)
                out = {"lead_id": lead_id, "status": "failed", "message": str(e)}

            record.retry_count += 1
            if out.get("status") == "success":
                record.retry_status = "done"
                record.next_retry_at = None
            elif record.retry_count >= _MAX_RETRIES:
                record.retry_status = "exhausted"
                record.next_retry_at = None
            else:
                record.retry_status = "pending"
                record.next_retry_at = now + timedelta(minutes=_RETRY_BACKOFF_BASE_MIN * (2 ** record.retry_count))
            self._repo.update_dm_send_result_retry(record)
            retried.append(out)

        return {
            "due": len(pending),
            "retried": len(retried),
            "results": retried,
        }

    # ═══════════════════════════════════════════════════════
    # 内部：账号选择 / 今日发送量
    # ═══════════════════════════════════════════════════════

    def _get_available_account(self) -> Account | None:
        """选可用账号：健康分>60、未封禁、未被频控暂停、今日未达上限。"""
        cfg = self.get_config()
        now = datetime.now(timezone.utc)
        candidates: list[Account] = []
        for acc in self._repo.list_accounts():
            if acc.health_score <= 60:
                continue
            if acc.limit_status in ("banned", "safe_mode"):
                continue
            # 频控暂停未结束
            resume_at = self._paused_accounts.get(acc.id)
            if resume_at and resume_at > now:
                continue
            # 今日发送量
            if self._get_today_sent_count(acc.id) >= cfg["daily_limit"]:
                continue
            candidates.append(acc)

        if not candidates:
            return None
        # 选健康分最高者
        candidates.sort(key=lambda a: a.health_score, reverse=True)
        return candidates[0]

    def _get_today_sent_count(self, account_id: str) -> int:
        today_prefix = now_date_str()
        records = self._repo.list_dm_send_results(limit=1000)
        return sum(
            1 for r in records
            if r.account_id == account_id and r.created_at.isoformat()[:10] == today_prefix
        )


def now_date_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()
