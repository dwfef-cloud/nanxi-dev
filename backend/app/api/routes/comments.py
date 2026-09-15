"""评论回复任务路由 · 评论引流策略核心

GET/POST/PATCH /api/comments/tasks
回复执行流程：POST /tasks/{id}/start → /complete | /fail
转化追踪：POST /tasks/{id}/track-reply | /track-dm
二次跟进：GET /followup-candidates
"""
from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import (
    get_comment_task_service,
    get_desensitize_service,
    get_risk_service,
    get_script_guard_service,
)
from app.schemas.comment_growth import (
    DesensitizeBatchRequest,
    DesensitizeBatchResponse,
    DesensitizeRequest,
    DesensitizeResponse,
    RiskSummaryResponse,
)
from app.schemas.comment_task import (
    CommentTaskCreate,
    CommentTaskPushRequest,
    CommentTaskPushResponse,
    CommentTaskRead,
    CommentTaskUpdate,
    ReplyCompleteRequest,
    ReplyFailRequest,
)
from app.schemas.script_guard import (
    GuardCheckRequest,
    GuardCheckResponse,
    GuardRuleCreate,
    GuardRuleRead,
    GuardRuleUpdate,
)
from app.services.comment_task_service import CommentTaskService
from app.services.desensitize_service import DesensitizeService
from app.services.risk_service import RiskService
from app.services.script_guard_service import ScriptGuardService

router = APIRouter(prefix="/comments", tags=["comments"])


@router.get("/tasks", response_model=list[CommentTaskRead], response_model_by_alias=True)
def list_tasks(
    status: str | None = None,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> list[CommentTaskRead]:
    """评论回复任务列表。

    主状态机：pending / locating / replying / replied / failed / cancelled
    兼容终态：user_replied / user_dm / ignored
    """
    return service.list_tasks(status=status)


@router.post("/tasks/push", response_model=CommentTaskPushResponse, response_model_by_alias=True)
def push_leads_to_tasks(
    payload: CommentTaskPushRequest,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskPushResponse:
    """批量把「评论候选池」里的线索推送到「待办互动 → 评论回复」。

    评论候选池只做筛选与分级，不直接回复；在这里选中线索推送后，
    任务带着「评论人 / 视频名称 / 视频链接 / 评论内容 / 负责账号」落到待办互动，
    到那边才写话术并发送。同一线索已有未闭环任务时自动跳过。
    """
    if not payload.lead_ids:
        raise HTTPException(status_code=400, detail="lead_ids 不能为空")
    return service.push_leads_to_tasks(payload)


@router.get("/tasks/{task_id}", response_model=CommentTaskRead, response_model_by_alias=True)
def get_task(
    task_id: str,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """P3-6: 单条评论任务详情（含关联线索/回复结果）"""
    try:
        return service.get_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc


@router.post("/tasks", response_model=CommentTaskRead, response_model_by_alias=True)
def create_task(
    payload: CommentTaskCreate,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """创建评论回复任务（从高意向线索生成）"""
    return service.create_task(payload)


@router.patch("/tasks/{task_id}", response_model=CommentTaskRead, response_model_by_alias=True)
def update_task(
    task_id: str,
    payload: CommentTaskUpdate,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """更新任务状态（标记已回复/对方私信/对方追评）"""
    try:
        return service.update_task(task_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: str,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> dict:
    """删除一条评论回复任务"""
    try:
        service.delete_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc
    return {"ok": True, "task_id": task_id}


# ═══════════════════════════════════════════════════════
# F3 · 回复执行流程（精确定位）
# ═══════════════════════════════════════════════════════

@router.post("/tasks/{task_id}/start", response_model=CommentTaskRead, response_model_by_alias=True)
def start_reply(
    task_id: str,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """开始回复：pending → locating → replying（浏览器自动化模块实际执行定位/输入）"""
    try:
        return service.start_reply(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/complete", response_model=CommentTaskRead, response_model_by_alias=True)
def complete_reply(
    task_id: str,
    payload: ReplyCompleteRequest,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """完成回复：replying → replied，记录实际回复内容"""
    try:
        return service.complete_reply(task_id, payload.reply_content)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/fail", response_model=CommentTaskRead, response_model_by_alias=True)
def fail_reply(
    task_id: str,
    payload: ReplyFailRequest,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """回复失败：pending/locating/replying → failed，记录失败原因"""
    try:
        return service.fail_reply(task_id, payload.reason)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


# ═══════════════════════════════════════════════════════
# F4 · 转化追踪
# ═══════════════════════════════════════════════════════

@router.post("/tasks/{task_id}/track-reply", response_model=CommentTaskRead, response_model_by_alias=True)
def track_user_reply(
    task_id: str,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """标记对方追评/回复评论"""
    try:
        return service.track_user_reply(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc


@router.post("/tasks/{task_id}/track-dm", response_model=CommentTaskRead, response_model_by_alias=True)
def track_user_dm(
    task_id: str,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentTaskRead:
    """标记对方主动私信（转化成功），自动联动 lead → wechat_added"""
    try:
        return service.track_user_dm(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc


@router.get("/followup-candidates", response_model=list[CommentTaskRead], response_model_by_alias=True)
def list_followup_candidates(
    hours: int = 48,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> list[CommentTaskRead]:
    """可二次跟进候选：replied 超过 hours 小时仍无任何反应的任务"""
    return service.list_followup_candidates(hours=hours)


# ═══════════════════════════════════════════════════════
# 话术质检（两层：敏感词 / 话术套路）
# ═══════════════════════════════════════════════════════

@router.post("/guard-check", response_model=GuardCheckResponse, response_model_by_alias=True)
def guard_check(
    payload: GuardCheckRequest,
    service: ScriptGuardService = Depends(get_script_guard_service),
) -> GuardCheckResponse:
    """发送前话术质检：第一层通用敏感词 + 第二层话术套路。

    pass=False（存在 block 级命中）时不应直接发送。
    """
    return service.check(payload.content, payload.account)


@router.get("/guard-rules", response_model=list[GuardRuleRead], response_model_by_alias=True)
def list_guard_rules(
    enabled_only: bool = True,
    service: ScriptGuardService = Depends(get_script_guard_service),
) -> list[GuardRuleRead]:
    """质检规则列表（enabled_only=false 时含已停用规则）"""
    return service.list_rules(enabled_only=enabled_only)


@router.post("/guard-rules", response_model=GuardRuleRead, response_model_by_alias=True)
def create_guard_rule(
    payload: GuardRuleCreate,
    service: ScriptGuardService = Depends(get_script_guard_service),
) -> GuardRuleRead:
    """新建质检规则（severity: block=禁止发送 / warn=仅提示）"""
    return service.create_rule(payload)


@router.patch("/guard-rules/{rule_id}", response_model=GuardRuleRead, response_model_by_alias=True)
def update_guard_rule(
    rule_id: int,
    payload: GuardRuleUpdate,
    service: ScriptGuardService = Depends(get_script_guard_service),
) -> GuardRuleRead:
    """修改/启停质检规则"""
    updated = service.update_rule(rule_id, payload)
    if updated is None:
        raise HTTPException(status_code=404, detail="Guard rule not found")
    return updated


# ═══════════════════════════════════════════════════════
# P2 · 数据脱敏
# ═══════════════════════════════════════════════════════

@router.post("/desensitize", response_model=DesensitizeResponse)
def desensitize_text(
    payload: DesensitizeRequest,
    service: DesensitizeService = Depends(get_desensitize_service),
) -> DesensitizeResponse:
    """单段文本脱敏：手机号→【电话A】/ 微信号→【微信A】/ 人名→【用户A】。

    同名实体在同一段文本内保持同一编号。
    """
    return service.desensitize(payload.text)


@router.post(
    "/desensitize/batch",
    response_model=DesensitizeBatchResponse,
    response_model_by_alias=True,
)
def desensitize_batch(
    payload: DesensitizeBatchRequest,
    service: DesensitizeService = Depends(get_desensitize_service),
) -> DesensitizeBatchResponse:
    """存量清洗：扫描 leads 的 nickname/comment/referral_note。

    dry_run=true（默认）只返回将改动的样例，不落库；确认后再传 false 执行。
    """
    return service.batch_clean(limit=payload.limit, dry_run=payload.dry_run)


# ═══════════════════════════════════════════════════════
# P2 · 风险聚合（危机升级 L1/L2/L3）
# ═══════════════════════════════════════════════════════

@router.get(
    "/risk-summary",
    response_model=RiskSummaryResponse,
    response_model_by_alias=True,
)
def risk_summary(
    start_date: str | None = None,
    end_date: str | None = None,
    service: RiskService = Depends(get_risk_service),
) -> RiskSummaryResponse:
    """按日期区间聚合负面评论并定级。

    L1 逐条处理 / L2 同类≥3条集中投诉 / L3 出现传播迹象需官方与法务介入。
    """
    return service.summarize(start_date=start_date, end_date=end_date)
