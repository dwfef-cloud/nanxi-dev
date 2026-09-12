"""今日跟进 · API 路由

严格对照 api-contract.md 第三节 3.2。
三段式：overdue（逾期红色）/ today（今天待跟进）/ upcoming（明天及以后）。
"""
from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import get_followup_service
from app.schemas.followup import (
    FollowUpCreate, FollowUpDelay, FollowUpRead, FollowUpUpdate,
)
from app.services.followup_service import FollowUpService

router = APIRouter(prefix="/followups", tags=["followups"])


@router.get("", response_model=list[FollowUpRead])
def list_followups(
    date: str | None = None,
    service: FollowUpService = Depends(get_followup_service),
) -> list[FollowUpRead]:
    """跟进待办列表

    date: today（今天待跟进）/ overdue（逾期未完成，红色标记）/ upcoming（明天及以后）
    """
    return service.list_followups(date=date)


@router.post("", response_model=FollowUpRead)
def create_followup(
    payload: FollowUpCreate,
    service: FollowUpService = Depends(get_followup_service),
) -> FollowUpRead:
    """新建跟进待办"""
    return service.create_followup(payload)


@router.post("/{followup_id}/complete")
def complete_followup(
    followup_id: str,
    payload: dict | None = None,
    service: FollowUpService = Depends(get_followup_service),
) -> dict:
    """标记完成（记录完成时间和备注）"""
    note = (payload or {}).get("note")
    try:
        service.complete_followup(followup_id, note=note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Followup not found") from exc
    return {"ok": True}


@router.post("/{followup_id}/delay", response_model=FollowUpRead)
def delay_followup(
    followup_id: str,
    payload: FollowUpDelay,
    service: FollowUpService = Depends(get_followup_service),
) -> FollowUpRead:
    """延期跟进：向后推迟 days 天，或显式指定新的截止时间"""
    try:
        return service.delay_followup(followup_id, days=payload.days, due=payload.due)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Followup not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/{followup_id}", response_model=FollowUpRead)
def update_followup(
    followup_id: str,
    payload: FollowUpUpdate,
    service: FollowUpService = Depends(get_followup_service),
) -> FollowUpRead:
    """编辑跟进：修改内容/类型/截止时间/状态（均可选）"""
    try:
        return service.update_followup(followup_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Followup not found") from exc
