"""埋点公共助手 · 所有写库埋点统一在此包裹 try-except

设计原则（与 lead_service._log_event 一致）：
  - 埋点失败绝不能影响主流程；任何异常都被吞掉
  - 所有函数接收一个 Repository 实例（不关心具体实现）
  - 延迟 import 领域模型，避免循环依赖
"""
from __future__ import annotations

import logging

from app.repositories.base import Repository

logger = logging.getLogger(__name__)


def log_lead_event(
    repo: Repository,
    lead_id: str | None,
    event_type: str,
    content: str = "",
    value: float = 0,
) -> None:
    """写一条线索行为事件到 behavior_events。lead_id 为空则跳过。"""
    if not lead_id:
        return
    try:
        from app.models.domain import LeadBehaviorEvent
        repo.save_behavior_event(LeadBehaviorEvent(
            lead_id=lead_id,
            event_type=event_type,
            content=content,
            value=value,
        ))
    except Exception as e:
        logger.warning(
            "埋点失败 log_lead_event: lead_id=%s event_type=%s err=%s",
            lead_id, event_type, e, exc_info=True,
        )


def _apply_r2_for_scripts(repo: Repository, script_ids: set[str]) -> None:
    """结果回写后跑一次 R2 自动停用（样本够但加微转化率低的变体）。

    延迟 import：script_service 与本模块同在 services 包，顶层 import 会绕回依赖。
    失败只记日志 —— 统计与自动停用属于增强，不能拖垮发送主流程。
    """
    ids = {s for s in script_ids if s}
    if not ids:
        return
    try:
        from app.services.script_service import ScriptService

        service = ScriptService(repo)
        for script_id in ids:
            service.apply_r2(script_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("埋点失败 R2 自动停用: scripts=%s err=%s", ids, e, exc_info=True)


def record_script_usage(
    repo: Repository,
    *,
    script_id: str | None,
    lead_id: str | None,
    channel: str,
    variant_id: str | None = None,
) -> None:
    """发评论/发私信带了 script_id 时，插一行 script_usage，并累加变体发送数。

    变体计数是话术库「转化率 / 权重」面板唯一的数据来源，所以放在这里与
    usage 留痕同一处写入，保证两条路径（自动发送、手动标记已回复）行为一致。
    """
    if not script_id or not lead_id:
        return
    try:
        from app.models.domain import ScriptUsage
        repo.save_script_usage(ScriptUsage(
            script_id=script_id,
            variant_id=variant_id,
            lead_id=lead_id,
            channel=channel,
        ))
    except Exception as e:
        logger.warning(
            "埋点失败 record_script_usage: script_id=%s lead_id=%s channel=%s err=%s",
            script_id, lead_id, channel, e, exc_info=True,
        )
        return

    if not variant_id:
        return
    try:
        for variant in repo.list_variants(script_id):
            if variant.variant_id == variant_id:
                variant.sent += 1
                repo.save_variant(variant)
                break
    except Exception as e:
        logger.warning(
            "埋点失败 变体发送数累加: script_id=%s variant_id=%s err=%s",
            script_id, variant_id, e, exc_info=True,
        )

    # 发送数变了，样本量可能刚跨过阈值 → 跑一次 R2 判断
    _apply_r2_for_scripts(repo, {script_id})


def mark_script_result(repo: Repository, lead_id: str | None, result: str) -> None:
    """线索加微 / 客户成交时，回写关联该 lead_id 的 script_usage.result。

    回写后立刻重算相关话术的变体统计并执行 R2 自动停用 —— 这是「加微转化率」
    真正变化的时刻，也是 R2 唯一有意义的触发点。
    """
    if not lead_id:
        return
    try:
        repo.update_script_usage_result(lead_id, result)
    except Exception as e:
        logger.warning(
            "埋点失败 mark_script_result: lead_id=%s result=%s err=%s",
            lead_id, result, e, exc_info=True,
        )
        return

    try:
        usages = repo.list_script_usages(lead_id=lead_id)
    except Exception:
        usages = []
    _apply_r2_for_scripts(repo, {u.script_id for u in usages})


def record_account_event(
    repo: Repository,
    *,
    account_id: str | None,
    action: str,
    detail: str | None = None,
    success: bool = True,
) -> None:
    """账号操作留痕：login / comment_sent / dm_sent / throttled / error。"""
    try:
        from app.models.domain import AccountEvent
        repo.save_account_event(AccountEvent(
            account_id=account_id or "unknown",
            action=action,
            detail=detail,
            success=success,
        ))
    except Exception as e:
        logger.warning(
            "埋点失败 record_account_event: account_id=%s action=%s err=%s",
            account_id, action, e, exc_info=True,
        )
