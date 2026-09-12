# -*- coding: utf-8 -*-
"""P2-16: auto-generate followup SOP on customer stage advance."""
import io, os

ROOT = r"D:\nanxi-dev\backend"

def patch(relpath, old, new, count=1):
    p = os.path.join(ROOT, relpath)
    s = io.open(p, encoding="utf-8").read()
    found = s.count(old)
    assert found == count, f"{relpath}: expected {count}, got {found}: {old[:70]!r}"
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
    print("OK", relpath)

# import FollowUp
patch(
    r"app\services\customer_service.py",
    "from app.models.domain import Customer, CustomerLog\n",
    "from app.models.domain import Customer, CustomerLog, FollowUp\n",
)

# SOP text per target stage (due "今天" so it lands in the today list)
patch(
    r"app\services\customer_service.py",
    'TERMINAL_STAGES = {"won", "lost"}\n',
    '''TERMINAL_STAGES = {"won", "lost"}

# P2-16：阶段推进后自动生成的 SOP 跟进模板（due=今天，进入今日跟进列表）
_STAGE_SOP: dict[str, tuple[str, str]] = {
    "added": ("首次跟进", "发送欢迎语并确认装修需求与预算"),
    "measured": ("方案推进", "跟进量房结果，约方案初稿沟通"),
    "proposal": ("方案推进", "主动询问客户对方案的反馈"),
    "quoted": ("报价跟进", "回访报价，处理价格异议"),
    "negotiating": ("谈判", "推进成交谈判，敲定合同细节"),
}
''',
)

# hook into advance_stage after log
patch(
    r"app\services\customer_service.py",
    '''        old_label = STAGE_LABELS.get(old_stage, old_stage)
        new_label = STAGE_LABELS.get(stage, stage)
        self._add_log(
            customer.id,
            f"阶段推进：{old_label} → {new_label}",
            "老板",
        )
        return customer''',
    '''        old_label = STAGE_LABELS.get(old_stage, old_stage)
        new_label = STAGE_LABELS.get(stage, stage)
        self._add_log(
            customer.id,
            f"阶段推进：{old_label} → {new_label}",
            "老板",
        )
        # P2-16：阶段推进后自动生成今日 SOP 跟进任务
        self._auto_sop_followup(customer, stage)
        return customer''',
)

# add helper method before list_logs
patch(
    r"app\services\customer_service.py",
    '''    # ── 跟进日志 ──

    def list_logs(self, customer_id: str) -> list[CustomerLog]:''',
    '''    # ── P2-16：阶段推进自动生成 SOP 跟进 ──

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
        except Exception:
            # SOP 自动生成失败不影响主流程
            pass

    # ── 跟进日志 ──

    def list_logs(self, customer_id: str) -> list[CustomerLog]:''',
)

print("P2-16 backend DONE")
