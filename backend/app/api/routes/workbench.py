from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.dependencies import (
    get_account_service,
    get_comment_task_service,
    get_customer_service,
    get_dm_service,
    get_followup_service,
    get_lead_service,
    get_notification_service,
    get_repository,
    get_workbench_service,
)
from app.models.domain import AudienceProfile, ProductKnowledge, ScriptStrategy, WeChatSettings
from app.schemas.analytics import WorkbenchResponse
from app.schemas.workbench import (
    AudienceProfileRead, AudienceProfileUpdate, ProductKnowledgeRead,
    ProductKnowledgeUpdate, ScriptStrategyRead, ScriptStrategyUpdate,
    WeChatSettingsRead, WeChatSettingsUpdate,
)
from app.services.workbench_service import WorkbenchService

router = APIRouter(prefix="/workbench", tags=["workbench"])


def stamp(payload: BaseModel) -> dict:
    return {**payload.model_dump(), "updated_at": datetime.now(timezone.utc)}


# ═══════════════════════════════════════════════════════════
# 工作台聚合（今日总览 + 预警 + 活动）
# ═══════════════════════════════════════════════════════════

@router.get("", response_model=WorkbenchResponse)
def get_workbench(
    service: WorkbenchService = Depends(get_workbench_service),
) -> dict:
    """今日运营总览（北极星导向）+ 预警 + 最近活动"""
    return service.get_workbench()


# ═══════════════════════════════════════════════════════════
# P3-12: 侧边栏导航角标汇总（单次请求获取所有角标数字）
# ═══════════════════════════════════════════════════════════

class BadgesResponse(BaseModel):
    """侧边栏角标汇总"""
    leads: int               # 线索总数
    dmQueue: int             # 待处理私信队列（pending_outreach + send_failed）
    accountsWarn: int        # 健康分<40 的账号数
    customers: int           # 活跃客户数（非 won/lost）
    followups: int           # 未完成跟进数
    unreadNotifications: int # 未读通知数
    replies: int             # 有人回复了我的评论、待继续回复（comment_tasks.status='user_replied'）


@router.get("/badges", response_model=BadgesResponse)
def get_badges(
    lead_svc=Depends(get_lead_service),
    dm_svc=Depends(get_dm_service),
    acc_svc=Depends(get_account_service),
    cust_svc=Depends(get_customer_service),
    fu_svc=Depends(get_followup_service),
    notif_svc=Depends(get_notification_service),
    ct_svc=Depends(get_comment_task_service),
) -> BadgesResponse:
    """P3-12: 侧边栏角标动态数据，替代前端硬编码 20/9/7"""
    leads = len(lead_svc.list_leads())
    queue = dm_svc.list_queue()
    dm_count = sum(1 for q in queue if q.status in ("pending_outreach", "send_failed"))
    accs = acc_svc.list_accounts()
    acc_warn = sum(1 for a in accs if a.health_score < 40)
    custs = cust_svc.list_customers()
    cust_active = sum(1 for c in custs if c.stage not in ("won", "lost"))
    fups = fu_svc.list_followups()
    fu_pending = sum(1 for f in fups if not f.done)
    unread = notif_svc.unread_count()
    # 有人回复我的评论、待继续回复（二级评论检测命中 → status='user_replied'）
    reply_tasks = ct_svc.list_tasks(status="user_replied")
    replies = len(reply_tasks)
    return BadgesResponse(
        leads=leads,
        dmQueue=dm_count,
        accountsWarn=acc_warn,
        customers=cust_active,
        followups=fu_pending,
        unreadNotifications=unread,
        replies=replies,
    )


# ═══════════════════════════════════════════════════════════
# 工作台配置（已有，保留）
# ═══════════════════════════════════════════════════════════

@router.get("/product", response_model=ProductKnowledgeRead)
def get_product(repo=Depends(get_repository)):
    return repo.get_product_knowledge()


@router.put("/product", response_model=ProductKnowledgeRead)
def update_product(payload: ProductKnowledgeUpdate, repo=Depends(get_repository)):
    return repo.save_product_knowledge(ProductKnowledge(**stamp(payload)))


@router.get("/audience", response_model=AudienceProfileRead)
def get_audience(repo=Depends(get_repository)):
    return repo.get_audience_profile()


@router.put("/audience", response_model=AudienceProfileRead)
def update_audience(payload: AudienceProfileUpdate, repo=Depends(get_repository)):
    return repo.save_audience_profile(AudienceProfile(**stamp(payload)))


@router.get("/scripts", response_model=ScriptStrategyRead)
def get_scripts(repo=Depends(get_repository)):
    return repo.get_script_strategy()


@router.put("/scripts", response_model=ScriptStrategyRead)
def update_scripts(payload: ScriptStrategyUpdate, repo=Depends(get_repository)):
    return repo.save_script_strategy(ScriptStrategy(**stamp(payload)))


@router.get("/wechat", response_model=WeChatSettingsRead)
def get_wechat(repo=Depends(get_repository)):
    return repo.get_wechat_settings()


@router.put("/wechat", response_model=WeChatSettingsRead)
def update_wechat(payload: WeChatSettingsUpdate, repo=Depends(get_repository)):
    return repo.save_wechat_settings(WeChatSettings(**stamp(payload)))
