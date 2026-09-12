"""
上手向导路由 · 5 步配置聚合提交
==================================
POST /api/onboarding/wizard   提交上手向导配置，保存到对应配置表
"""
from fastapi import APIRouter, Depends

from app.core.dependencies import get_onboarding_service
from app.schemas.onboarding import (
    OnboardingSkipRequest, OnboardingStatusResponse, ReadinessResponse,
    WizardPayload, WizardResponse,
)
from app.services.onboarding_service import OnboardingService

router = APIRouter(tags=["onboarding"])


@router.get("/onboarding/status", response_model=OnboardingStatusResponse)
def get_onboarding_status(
    service: OnboardingService = Depends(get_onboarding_service),
) -> dict:
    """查询上手向导状态：5 步各自完成度 + 整体状态"""
    return service.get_status()


@router.get("/onboarding/readiness", response_model=ReadinessResponse)
def get_onboarding_readiness(
    service: OnboardingService = Depends(get_onboarding_service),
) -> dict:
    """上线环境自检清单：逐项返回就绪状态与修复动作"""
    return service.get_readiness()


@router.post("/onboarding/skip")
def skip_onboarding(
    payload: OnboardingSkipRequest,
    service: OnboardingService = Depends(get_onboarding_service),
) -> dict:
    """跳过上手向导（需 confirmed=true）"""
    if not payload.confirmed:
        return {"ok": False, "message": "未确认跳过"}
    return service.skip()


@router.post("/onboarding/wizard", response_model=WizardResponse)
def submit_wizard(
    payload: WizardPayload,
    service: OnboardingService = Depends(get_onboarding_service),
) -> dict:
    """5 步上手向导聚合提交

    接收业务画像/产品知识库/目标客户/话术策略/微信设置的聚合对象，
    逐步骤保存到对应配置表（单例 upsert）。
    """
    return service.submit_wizard(payload)
