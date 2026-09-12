"""评论真实发送路由 · 把「确认回复」接到抖音

与 comments.py 同前缀，职责分离：
    comments.py           任务本身的增删改查、话术质检、脱敏、风险聚合
    comment_execution.py  真正驱动浏览器去抖音发评论（含浏览器/登录态管理）

安全边界（沿用并强化）：
    - 默认只预览，confirm=true 才发送，前端必须两步确认
    - 只做「回复某条评论」：没有定位依据（match / author）一律拒绝，不发顶层评论
    - 目标评论必须唯一命中；命中 0 条或多条都停手，绝不退化为「回复第一条」
    - 打字完成后还要核对「被回复的评论已进入回复状态」，否则不发
    - 同一（视频, 作者, 内容）只提交一次，重复会被发送记录拦截
    - 出现验证码一律停手，交人工处理，不自动重试、不绕过验证
"""
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import get_comment_task_service
from app.core.douyin_url import usable_video_url as _usable_video_url
from app.integrations.comment_executor import (
    CommentAgentError,
    DouyinCommentExecutor,
)
from app.schemas.comment_execution import (
    CommentAgentStatusResponse,
    CommentExecutionRequest,
    CommentExecutionResponse,
)
from app.schemas.comment_task import CommentTaskUpdate
from app.services.comment_task_service import CommentTaskService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/comments", tags=["comments"])
_executor = DouyinCommentExecutor()


def _fill_from_task(
    payload: CommentExecutionRequest,
    service: CommentTaskService,
) -> tuple[str, str, str]:
    """用任务/线索里的数据补齐定位要素，返回 (video_url, text, match)。

    视频地址按 payload → task → lead.source_url 逐级取**第一个有效的**：
    任务里的 video_url 可能是占位值（非空但打不开），只判空会让假地址一路走到底。
    """
    video_url = (payload.video_url or "").strip()
    text = (payload.text or "").strip()
    match = (payload.match or "").strip()

    if not payload.task_id:
        return video_url, text, match

    try:
        task = service.get_task(payload.task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Comment task not found") from exc

    if not _usable_video_url(video_url):
        video_url = (task.video_url or "").strip()
    if not _usable_video_url(video_url):
        try:
            lead = service._repo.get_lead(task.lead_id)
            video_url = (lead.source_url or "").strip()
        except KeyError:
            pass
    if not text:
        text = (task.reply_content or "").strip()
    if not match:
        # 昵称在库中已脱敏，只能用评论原文定位目标评论
        match = (task.comment_content or "").strip()
    return video_url, text, match


@router.post("/execute", response_model=CommentExecutionResponse, response_model_by_alias=True)
async def execute_comment(
    payload: CommentExecutionRequest,
    service: CommentTaskService = Depends(get_comment_task_service),
) -> CommentExecutionResponse:
    """预览（confirm=false）或真实发送（confirm=true）一条评论回复。

    预览只定位评论并把内容填入草稿；发送成功（accepted）才把任务标记为已回复，
    被平台拒绝则记为失败；结果未知一律不动状态，等人工核实，避免假数据。
    """
    video_url, text, match = _fill_from_task(payload, service)
    if not _usable_video_url(video_url):
        raise HTTPException(
            status_code=400,
            detail="来源视频地址无效：需要形如 https://www.douyin.com/video/<19位数字> 的真实地址。"
                   "当前任务里是占位地址（或为空），请到「评论获客」重新生成带真实视频地址的任务。"
                   + (f"当前值：{video_url}" if video_url else "当前为空。"),
        )
    if not text:
        raise HTTPException(status_code=400, detail="回复内容不能为空")
    if not (match or (payload.author or "").strip()):
        # 没有定位依据时会退化成「在视频下发一条顶层评论」——公开可见且回错了对象，
        # 本功能只做「回复某条评论」，所以这里直接拦掉。
        raise HTTPException(
            status_code=400,
            detail="缺少定位依据：本功能只做「回复某条评论」，不会发顶层评论。"
                   "请带上 taskId，或直接传入 match（评论原文）/ author（评论作者）",
        )

    reply_comment = True
    # 统一用 dict 合并后再构造响应：显式关键字 + **result 会因 status/author/match
    # 重名抛 TypeError，而 result 里的值才是执行的真实结果，优先级更高。
    fields = {"task_id": payload.task_id, "match": match}
    try:
        if payload.confirm:
            result = await _executor.execute(
                {
                    "video_url": video_url,
                    "text": text,
                    "author": (payload.author or "").strip(),
                    "match": match,
                    "reply_comment": reply_comment,
                    "max_scrolls": payload.max_scrolls,
                },
                timeout=120 if payload.current_page else 20,
            )
            _sync_task_status(
                payload.task_id, result, text, service,
                payload.script_id, payload.variant_id,
            )
            return CommentExecutionResponse(**{**fields, **result})

        preview = await _executor.prepare(
            video_url, text,
            (payload.author or "").strip(), match,
            payload.current_page, payload.max_scrolls,
        )
        return CommentExecutionResponse(**{**fields, "status": "preview", **preview})
    except CommentAgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _sync_task_status(
    task_id: str | None,
    result: dict,
    text: str,
    service: CommentTaskService,
    script_id: str | None = None,
    variant_id: str | None = None,
) -> None:
    """把发送结果回写到任务；回写失败不影响本次发送结论。

    script_id / variant_id 一并落库：它们会触发 comment_task_service 里已有的
    「评论已发出」埋点，进而写入 script_usage 并累加变体 sent，
    这是话术库转化率面板与 R2 自动切换唯一的数据来源。
    """
    if not task_id:
        return
    status = result.get("status")
    try:
        if status == "accepted":
            service.update_task(
                task_id,
                CommentTaskUpdate(
                    status="replied",
                    reply_content=text,
                    reply_script_id=script_id,
                    reply_variant_id=variant_id,
                ),
            )
        elif status == "rejected":
            service.fail_reply(task_id, f"平台拒绝：{result.get('message') or '未给出原因'}")
        else:
            # unknown：证据不足，保持原状态，交由人工核查后手工标记
            logger.warning(
                "评论发送结果未知，任务状态保持不变: task_id=%s message=%s",
                task_id, result.get("message"),
            )
    except Exception as exc:
        logger.warning(
            "评论发送结果回写任务状态失败（发送结论不受影响）: task_id=%s status=%s err=%s",
            task_id, status, exc, exc_info=True,
        )


def _status_response(info: dict, data: dict) -> CommentAgentStatusResponse:
    """合并「本机配置信息」与「浏览器探测结果」，只取契约内的字段。"""
    return CommentAgentStatusResponse(
        ok=bool(data.get("ok", True)),
        cdp_ready=bool(data.get("cdp_ready", False)),
        logged_in=data.get("logged_in"),
        port=int(data.get("port") or info.get("cdp_port") or 9222),
        page_count=int(data.get("page_count") or 0),
        douyin_pages=int(data.get("douyin_pages") or 0),
        profile_dir=data.get("profile_dir") or "",
        data_dir=data.get("data_dir") or info.get("data_dir") or "",
        interpreter=info.get("interpreter"),
        message=data.get("message") or info.get("error") or "",
    )


@router.get(
    "/agent/status",
    response_model=CommentAgentStatusResponse,
    response_model_by_alias=True,
)
async def agent_status() -> CommentAgentStatusResponse:
    """自动化浏览器状态：CDP 是否就绪、抖音是否已登录（只读探测）。"""
    info = _executor.describe()
    try:
        data = await _executor.browser_status()
    except CommentAgentError as exc:
        return _status_response(info, {"ok": False, "message": str(exc)})
    return _status_response(info, data)


@router.post(
    "/agent/browser/start",
    response_model=CommentAgentStatusResponse,
    response_model_by_alias=True,
)
async def agent_start_browser() -> CommentAgentStatusResponse:
    """拉起（或复用）常驻浏览器并打开抖音首页，供扫码登录。"""
    info = _executor.describe()
    try:
        data = await _executor.launch_browser()
    except CommentAgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _status_response(info, data)
