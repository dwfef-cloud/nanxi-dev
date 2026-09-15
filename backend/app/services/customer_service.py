"""客户与商机 · Service 层

依赖 Repository 接口，不感知具体实现。
阶段推进必须记录变更日志（谁、什么时间、从什么阶段到什么阶段）。
"""
import logging
from datetime import datetime, timezone

from app.models.domain import Customer, CustomerLog, FollowUp
from app.repositories.base import Repository
from app.schemas.customer import CustomerCreate
from app.services import _tracking

logger = logging.getLogger(__name__)

# 7 阶段标签（用于日志文案）。通用成交流程，不绑定行业。
STAGE_LABELS: dict[str, str] = {
    "added": "已加微",
    "discovery": "需求沟通",
    "proposal": "方案中",
    "quoted": "已报价",
    "negotiating": "谈判中",
    "won": "已成交",
    "lost": "已流失",
}

# P1-11: Stage transition guard - terminal states won't regress
# Valid forward transitions per stage
_STAGE_TRANSITIONS: dict[str, set[str]] = {
    "added": {"discovery", "proposal", "quoted", "negotiating", "won", "lost"},
    "discovery": {"proposal", "quoted", "negotiating", "won", "lost"},
    "proposal": {"quoted", "negotiating", "won", "lost"},
    "quoted": {"negotiating", "won", "lost"},
    "negotiating": {"won", "lost"},
    "won": set(),   # terminal
    "lost": set(),  # terminal
}

TERMINAL_STAGES = {"won", "lost"}

# P2-16：阶段推进后自动生成的 SOP 跟进模板（due=今天，进入今日跟进列表）
# 文案保持行业中立，不出现「量房/装修」等专属措辞
_STAGE_SOP: dict[str, tuple[str, str]] = {
    "added": ("首次跟进", "发送欢迎语，确认客户需求与预算"),
    "discovery": ("需求跟进", "确认需求细节，为出方案做准备"),
    "proposal": ("方案推进", "主动询问客户对方案的反馈"),
    "quoted": ("报价跟进", "回访报价，处理价格异议"),
    "negotiating": ("谈判", "推进成交谈判，敲定合同细节"),
}


def _now_str() -> str:
    return datetime.now(timezone.utc).strftime("%m-%d %H:%M")


class CustomerService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo
        self._notification_service = None  # P4-A 注入

    def set_notification_service(self, svc) -> None:
        """注入通知服务（P4-A），用于成交自动提醒"""
        self._notification_service = svc

    # ── 查询 ──

    def list_customers(
        self,
        stage: str | None = None,
        keyword: str | None = None,
    ) -> list[Customer]:
        customers = self._repo.list_customers(stage=stage)
        if keyword:
            needle = keyword.lower()
            customers = [
                c for c in customers
                if needle in c.name.lower()
                or (c.referrer and needle in c.referrer.lower())
            ]
        return customers

    def get_customer(self, customer_id: str) -> Customer:
        return self._repo.get_customer(customer_id)

    # ── 部分更新 ──

    def update_customer(self, customer_id: str, payload) -> Customer:
        customer = self._repo.get_customer(customer_id)
        if payload.name is not None:
            customer.name = payload.name
        if payload.est_value is not None:
            customer.est_value = payload.est_value
        if payload.next_action is not None:
            customer.next_action = payload.next_action
        if payload.next_at is not None:
            customer.next_at = payload.next_at
        customer.updated_at = datetime.now(timezone.utc)
        customer = self._repo.save_customer(customer)
        self._add_log(customer.id, "客户信息更新", "老板")
        return customer

    # ── 创建（含线索→客户转化） ──

    def create_customer(self, payload: CustomerCreate) -> Customer:
        customer = Customer(
            name=payload.name,
            source=payload.source,
            lead_id=payload.lead_id,
            est_value=payload.est_value,
            wechat_added_at=payload.wechat_added_at or datetime.now(timezone.utc),
            manual=payload.manual,
            referrer=payload.referrer,
            hue=payload.hue,
        )
        customer = self._repo.save_customer(customer)

        # 记录创建日志
        self._add_log(customer.id, "客户创建", "系统")

        # 线索→客户转化：关联 lead 后自动标记线索为已加微（若尚未标记）
        if payload.lead_id:
            try:
                lead = self._repo.get_lead(payload.lead_id)
                if lead.status != "wechat_added" and lead.status != "deal_won":
                    lead.status = "wechat_added"  # type: ignore[assignment]
                    lead.wechat_added_at = lead.wechat_added_at or datetime.now(timezone.utc)
                    lead.updated_at = datetime.now(timezone.utc)
                    self._repo.save_lead(lead)
                    self._add_log(customer.id, f"关联线索并标记已加微（线索ID: {payload.lead_id}）", "系统")
            except KeyError:
                self._add_log(customer.id, f"关联线索ID不存在: {payload.lead_id}", "系统")

        return customer

    # ── 阶段推进（记录变更日志） ──

    def advance_stage(self, customer_id: str, stage: str) -> Customer:
        customer = self._repo.get_customer(customer_id)
        old_stage = customer.stage
        # P1-11: Guard against terminal stage regression
        if old_stage in TERMINAL_STAGES:
            raise ValueError(f"Stage '{old_stage}' is terminal, cannot transition to '{stage}'")
        if stage not in _STAGE_TRANSITIONS.get(old_stage, set()):
            raise ValueError(f"Invalid transition: '{old_stage}' -> '{stage}'")
        customer.stage = stage  # type: ignore[assignment]
        customer.updated_at = datetime.now(timezone.utc)
        customer = self._repo.save_customer(customer)

        old_label = STAGE_LABELS.get(old_stage, old_stage)
        new_label = STAGE_LABELS.get(stage, stage)
        self._add_log(
            customer.id,
            f"阶段推进：{old_label} → {new_label}",
            "老板",
        )
        # P2-16：阶段推进后自动生成今日 SOP 跟进任务
        self._auto_sop_followup(customer, stage)
        return customer

    # ── 成交录入（≤3次点击） ──

    def record_deal(self, customer_id: str, amount: float) -> Customer:
        customer = self._repo.get_customer(customer_id)
        customer.deal_amount = amount
        customer.deal_at = datetime.now(timezone.utc)
        customer.stage = "won"  # type: ignore[assignment]
        customer.updated_at = datetime.now(timezone.utc)
        customer = self._repo.save_customer(customer)

        self._add_log(customer.id, f"成交录入：¥{amount:,.0f}", "老板")

        # 同步更新关联线索的成交状态
        if customer.lead_id:
            try:
                lead = self._repo.get_lead(customer.lead_id)
                lead.status = "deal_won"  # type: ignore[assignment]
                lead.deal_amount = amount
                lead.deal_at = datetime.now(timezone.utc)
                lead.updated_at = datetime.now(timezone.utc)
                self._repo.save_lead(lead)
            except KeyError as e:
                logger.warning(
                    "成交同步失败 关联线索不存在: customer_id=%s lead_id=%s err=%s",
                    customer.id, customer.lead_id, e, exc_info=True,
                )

        # 埋点：成交（best-effort）
        try:
            _tracking.log_lead_event(
                self._repo, customer.lead_id, "deal_won",
                f"customer_id={customer.id} amount={amount}",
                value=amount,
            )
            _tracking.mark_script_result(self._repo, customer.lead_id, "deal_won")
        except Exception as e:
            logger.warning(
                "埋点失败 成交 deal_won 写入失败: customer_id=%s lead_id=%s err=%s",
                customer.id, customer.lead_id, e, exc_info=True,
            )

        # P4-A：成交通知
        if self._notification_service:
            self._notification_service.create(
                type="deal_won",
                title=f"成交喜报 · {customer.name}",
                content=f"成交金额 ¥{amount:,.0f}，恭喜开单！",
                level="success",
                related_type="customer",
                related_id=customer.id,
            )

        return customer

    # ── 流失标记 ──

    def mark_lost(
        self,
        customer_id: str,
        reason: str | None = None,
        category: str = "other",
        note: str | None = None,
    ) -> Customer:
        customer = self._repo.get_customer(customer_id)
        # Task6：流失原因结构化。兼容旧调用：只传 reason 时归入 other，原文存备注。
        if category not in ("price", "competitor", "no_need", "timing", "contact_lost", "other"):
            category = "other"
        if note is None and reason:
            note = reason
        customer.stage = "lost"  # type: ignore[assignment]
        customer.lost_reason_category = category
        customer.lost_reason_note = note
        customer.lost_reason = note or category  # 兼容旧展示字段
        customer.lost_at = datetime.now(timezone.utc)
        customer.updated_at = datetime.now(timezone.utc)
        customer = self._repo.save_customer(customer)

        self._add_log(customer.id, f"标记流失：[{category}] {note or ''}", "老板")

        # 埋点：流失（best-effort）
        try:
            _tracking.log_lead_event(
                self._repo, customer.lead_id, "customer_lost",
                f"customer_id={customer.id} category={category} note={note or ''}",
            )
        except Exception as e:
            logger.warning(
                "埋点失败 流失 customer_lost 写入失败: customer_id=%s lead_id=%s err=%s",
                customer.id, customer.lead_id, e, exc_info=True,
            )
        return customer

    # ── 删除 ──

    def delete_customer(self, customer_id: str) -> None:
        """删除客户及其跟进日志""" 
        self._repo.delete_customer(customer_id)

    # ── P2-16：阶段推进自动生成 SOP 跟进 ──

    def _auto_sop_followup(self, customer: Customer, new_stage: str) -> None:
        """阶段推进后自动在「今日跟进」生成一条待办（幂等：同客户同阶段不重复建）。"""
        sop = _STAGE_SOP.get(new_stage)
        if not sop:
            return
        ftype, text = sop
        try:
            # 避免重复：若已有同客户、同阶段文本的未完成跟进则跳过
            existing = self._repo.list_followups(done=False)
            for fu in existing:
                if fu.customer_id == customer.id and fu.text == text and fu.done is False:
                    return
            fu = FollowUp(
                customer_id=customer.id,
                customer_name=customer.name,
                type=ftype,
                text=text,
                due="今天 18:00",
                overdue=False,
                done=False,
            )
            self._repo.save_followup(fu)
        except Exception as e:
            # SOP 自动生成失败不影响主流程
            logger.warning(
                "SOP 跟进自动生成失败: customer_id=%s new_stage=%s err=%s",
                customer.id, new_stage, e, exc_info=True,
            )

    # ── 跟进日志 ──

    def list_logs(self, customer_id: str) -> list[CustomerLog]:
        return self._repo.list_customer_logs(customer_id)

    # ── 内部工具 ──

    def _add_log(self, customer_id: str, text: str, by: str = "系统") -> CustomerLog:
        log = CustomerLog(
            customer_id=customer_id,
            text=text,
            time=_now_str(),
            by=by,
        )
        return self._repo.save_customer_log(log)
