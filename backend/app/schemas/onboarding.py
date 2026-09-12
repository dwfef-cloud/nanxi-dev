"""
上手向导 Schema · 5 步配置聚合
"""
from pydantic import BaseModel, model_validator

from app.schemas.business import BusinessProfileUpdate
from app.schemas.workbench import (
    AudienceProfileUpdate, ProductKnowledgeUpdate,
    ScriptStrategyUpdate, WeChatSettingsUpdate,
)


class WizardPayload(BaseModel):
    """5 步上手向导聚合配置对象

    每一步对应一个配置表单，均为可选（用户可能只完成部分步骤），
    但至少必须提交一步，空 body 返回 422。
    """
    business: BusinessProfileUpdate | None = None    # 第1步：业务画像
    product: ProductKnowledgeUpdate | None = None     # 第2步：产品知识库
    audience: AudienceProfileUpdate | None = None     # 第3步：目标客户
    scripts: ScriptStrategyUpdate | None = None       # 第4步：话术策略
    wechat: WeChatSettingsUpdate | None = None        # 第5步：微信转化设置

    @model_validator(mode="after")
    def _require_at_least_one_step(self):
        if not any([self.business, self.product, self.audience, self.scripts, self.wechat]):
            raise ValueError("上手向导至少需要提交一步配置")
        return self


class WizardResponse(BaseModel):
    ok: bool
    saved: list[str]
    message: str = ""


class OnboardingStepState(BaseModel):
    """单个上手步骤的完成状态"""
    done: bool
    label: str = ""


class OnboardingStatusResponse(BaseModel):
    """上手状态查询响应"""
    status: str            # pending / in_progress / completed / skipped
    skipped: bool = False
    done_count: int = 0
    total: int = 5
    steps: dict[str, bool] = {}


class OnboardingSkipRequest(BaseModel):
    """跳过上手向导请求体（必填确认）"""
    confirmed: bool


class ReadinessItem(BaseModel):
    """环境自检单项"""
    key: str
    label: str
    ok: bool
    detail: str = ""
    action: dict | None = None
    link: str | None = None


class ReadinessResponse(BaseModel):
    """环境自检清单响应"""
    ok: bool
    checkedAt: str
    blocking: list[str] = []
    items: list[ReadinessItem] = []
