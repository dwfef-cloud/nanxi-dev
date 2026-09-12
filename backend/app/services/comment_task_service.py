"""评论回复任务 Service · 评论引流策略核心

追踪每一条高意向评论的回复状态，以及回复后对方是否回访/主动私信。
主状态机：pending → locating → replying → replied / failed / cancelled
回复后行为追踪（兼容）：replied → user_replied / user_dm / ignored
（user_replied / user_dm 同时由 user_replied_comment / user_dm 布尔字段标记）
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from app.core.douyin_url import extract_comment_id, usable_video_url
from app.models.domain import CommentReplyTask, now_utc
from app.repositories.base import Repository
from app.schemas.comment_task import CommentTaskCreate, CommentTaskRead, CommentTaskUpdate
from app.services import _tracking

logger = logging.getLogger(__name__)


class CommentTaskService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo
        self._lead_service = None  # 可选注入，用于转化时联动 lead（见 set_lead_service）

    def set_lead_service(self, svc) -> None:
        """可选注入 LeadService：对方主动私信时自动调用 mark_wechat_added。"""
        self._lead_service = svc

    def list_tasks(self, status: str | None = None) -> list[CommentTaskRead]:
        tasks = self._repo.list_comment_tasks(status=status)
        return [self._to_read(t) for t in tasks]

    def get_task(self, task_id: str) -> CommentTaskRead:
        task = self._repo.get_comment_task(task_id)
        return self._to_read(task)

    def create_task(self, payload: CommentTaskCreate) -> CommentTaskRead:
        """创建评论回复任务（从高意向线索生成）

        video_url 兜底：任务不带地址（或是 /video/999 这类占位地址）时，
        回落到关联线索的来源视频。库里早期任务全是占位地址，靠这层兜底
        才能真的定位到评论区。
        """
        video_url = self._resolve_video_url(payload)
        comment_id = self._resolve_comment_id(payload)
        task = CommentReplyTask(
            lead_id=payload.lead_id,
            comment_content=payload.comment_content,
            video_title=payload.video_title,
            reply_content=payload.reply_content,
            account=payload.account,
            reply_script_id=payload.reply_script_id,
            # 精准获客（v002）：新字段透传，未传时走领域默认值
            video_url=video_url,
            comment_id=comment_id,
            priority=payload.priority,
            status="pending",
        )
        saved = self._repo.save_comment_task(task)
        return self._to_read(saved)

    def _resolve_comment_id(self, payload: CommentTaskCreate) -> str:
        """取评论 id：任务自带 → 关联线索的 comment_id / external_id 还原。

        回复检测靠这个 id 与采集回来的 parent_comment_id 配对。库里 106 条真实
        线索的 comment_id 列是空的，值留在 external_id（douyin-comment-<cid>）里，
        这里统一还原，否则该任务永远检测不到对方的回复。
        """
        cid = extract_comment_id(comment_id=payload.comment_id)
        if cid:
            return cid
        if not payload.lead_id:
            return ""
        try:
            lead = self._repo.get_lead(payload.lead_id)
        except KeyError:
            return ""
        resolved = extract_comment_id(
            external_id=getattr(lead, "external_id", "") or "",
            comment_id=getattr(lead, "comment_id", "") or "",
        )
        if resolved:
            logger.info(
                "建任务评论 id 兜底：从线索 %s 还原出 comment_id=%s",
                payload.lead_id, resolved,
            )
        else:
            logger.warning(
                "建任务后仍无评论 id（lead=%s）：该任务无法做回复检测，"
                "请确认线索是否来自评论采集",
                payload.lead_id,
            )
        return resolved

    def _resolve_video_url(self, payload: CommentTaskCreate) -> str:
        """取第一个可用的视频地址：任务自带 → 关联线索来源视频。"""
        video_url = (payload.video_url or "").strip()
        if usable_video_url(video_url):
            return video_url
        if not payload.lead_id:
            return video_url
        try:
            lead = self._repo.get_lead(payload.lead_id)
        except KeyError:
            return video_url
        lead_url = (lead.source_url or "").strip()
        if usable_video_url(lead_url):
            logger.info(
                "建任务地址兜底：任务地址 %r 不可用，改用线索 %s 的真实地址 %s",
                video_url, payload.lead_id, lead_url,
            )
            return lead_url
        logger.warning(
            "建任务后视频地址仍不可用：任务地址=%r 线索地址=%r（lead=%s），"
            "该任务无法定位评论区，请先补齐来源视频",
            video_url, lead_url, payload.lead_id,
        )
        return video_url or lead_url


    def update_task(self, task_id: str, payload: CommentTaskUpdate) -> CommentTaskRead:
        """更新任务状态（标记已回复/对方私信/对方追评）。

        状态联动：
        - status=replied → 自动设置 replied_at
        - status=user_dm → 自动设置 user_dm=True（转化成功 ★）
        - status=user_replied → 自动设置 user_replied_comment=True
        """
        task = self._repo.get_comment_task(task_id)

        if payload.status is not None:
            task.status = payload.status  # type: ignore[assignment]
            # 状态联动
            if payload.status == "replied" and task.replied_at is None:
                task.replied_at = datetime.now(timezone.utc)
            if payload.status == "user_dm":
                task.user_dm = True
            if payload.status == "user_replied":
                task.user_replied_comment = True

        if payload.reply_content is not None:
            task.reply_content = payload.reply_content
        if payload.reply_script_id is not None:
            task.reply_script_id = payload.reply_script_id
        if payload.reply_variant_id is not None:
            task.reply_variant_id = payload.reply_variant_id
        if payload.replied_at is not None:
            task.replied_at = payload.replied_at
        if payload.user_visited is not None:
            task.user_visited = payload.user_visited
        if payload.user_dm is not None:
            task.user_dm = payload.user_dm
        if payload.user_replied_comment is not None:
            task.user_replied_comment = payload.user_replied_comment

        task.updated_at = now_utc()
        saved = self._repo.save_comment_task(task)

        # 埋点：状态进入 replied（= 评论回复已发出）时记录
        if payload.status == "replied":
            self._fire_comment_sent_tracking(saved)

        # 埋点：用户追评/回复评论
        if payload.status == "user_replied":
            self._fire_comment_replied_tracking(saved)

        return self._to_read(saved)

    # ═══════════════════════════════════════════════════════
    # F3 · 回复执行流程（精确定位）
    # 说明：实际「打开视频 / 查找评论 / 点击回复 / 输入」由浏览器自动化模块完成，
    #       这里只负责状态机流转、入参校验与数据留痕。
    # ═══════════════════════════════════════════════════════

    def start_reply(self, task_id: str) -> CommentTaskRead:
        """开始回复：pending → locating（正在定位原评论）。

        这一步是异步浏览器自动化的入口：调用后任务进入 locating，
        由浏览器模块完成「打开 video_url → 按 comment_id 定位评论 → 确认未被删除」。
        定位完成后，模块可经 PATCH 推进到 replying，或直接调用 complete_reply。

        流程：
        1. 仅允许 status == 'pending' 的任务进入
        2. 标记 locating（正在定位原评论）
        3. 校验定位要素（video_url / comment_id）；缺失不阻断，但便于排错
        """
        task = self._repo.get_comment_task(task_id)
        if task.status != "pending":
            raise ValueError(
                f"任务状态为 {task.status}，仅 pending 可开始回复"
            )

        # 定位要素校验（模拟/预留）：真实浏览器自动化由其他模块执行。
        # 这里仅记录定位要素是否齐全，缺失时由调用方决定是否 fail_reply。
        if not task.video_url or not task.comment_id:
            task.reply_failure_reason = ""

        task.status = "locating"  # type: ignore[assignment]
        task.updated_at = now_utc()
        saved = self._repo.save_comment_task(task)
        return self._to_read(saved)

    def complete_reply(self, task_id: str, reply_content: str) -> CommentTaskRead:
        """完成回复：locating / replying → replied，记录回复内容与 replied_at。

        浏览器模块实际发出回复后调用；容忍 locating 与 replying 两个子态，
        以适配「定位成功后直接发出回复」与「先 PATCH 到 replying 再发出」两种时序。
        """
        task = self._repo.get_comment_task(task_id)
        if task.status not in ("locating", "replying"):
            raise ValueError(
                f"任务状态为 {task.status}，仅 locating/replying 可标记完成回复"
            )

        task.reply_content = reply_content
        task.status = "replied"  # type: ignore[assignment]
        task.replied_at = now_utc()
        task.reply_failure_reason = ""
        task.updated_at = now_utc()
        saved = self._repo.save_comment_task(task)

        # 回复已发出，复用 replied 埋点
        self._fire_comment_sent_tracking(saved)
        return self._to_read(saved)

    def fail_reply(self, task_id: str, reason: str) -> CommentTaskRead:
        """回复失败：任意可恢复态（locating/replying）→ failed，记录失败原因。"""
        task = self._repo.get_comment_task(task_id)
        if task.status not in ("pending", "locating", "replying"):
            raise ValueError(
                f"任务状态为 {task.status}，不可标记失败（仅 pending/locating/replying）"
            )
        task.status = "failed"  # type: ignore[assignment]
        task.reply_failure_reason = reason
        task.updated_at = now_utc()
        saved = self._repo.save_comment_task(task)

        try:
            _tracking.record_account_event(
                self._repo,
                account_id=task.account or "default",
                action="error",
                detail=f"comment_task_id={task.id} lead_id={task.lead_id} reason={reason}",
                success=False,
            )
        except Exception as e:
            logger.warning(
                "埋点失败 回复失败账号事件写入失败: task_id=%s lead_id=%s err=%s",
                task.id, task.lead_id, e, exc_info=True,
            )
        return self._to_read(saved)

    # ═══════════════════════════════════════════════════════
    # F4 · 转化追踪
    # ═══════════════════════════════════════════════════════

    def track_user_reply(
        self, task_id: str, replies: list[dict] | None = None,
    ) -> CommentTaskRead:
        """对方追评/回复评论。

        两种入口：
        1. 手动标记（API /tasks/{id}/track-reply，replies=None）：仅置
           user_replied_comment=True + status=user_replied，sub_replies 不变。
        2. reply_check 检测自动写入（replies=list[dict]）：把每条二级回复按
           comment_id 去重追加到 sub_replies（JSON 列表），刷新 user_reply_content /
           replier_name 为最新一条；首次有回复才打埋点。

        幂等：已存在同 comment_id 的子评论不重复追加；replies=None 且已标记过则
        直接返回，不重复埋点。不降级 user_dm（转化成功）终态。
        """
        task = self._repo.get_comment_task(task_id)
        items = replies if isinstance(replies, list) else []

        if not items:
            # 手动标记场景：仅置状态，不动 sub_replies
            if task.user_replied_comment:
                return self._to_read(task)
            task.user_replied_comment = True
            if task.status != "user_dm":
                task.status = "user_replied"  # type: ignore[assignment]
            task.updated_at = now_utc()
            saved = self._repo.save_comment_task(task)
            self._fire_comment_replied_tracking(saved)
            return self._to_read(saved)

        # 检测场景：解析现有 + 去重追加
        try:
            existing = json.loads(task.sub_replies or "[]")
        except Exception:
            existing = []
        if not isinstance(existing, list):
            existing = []
        existing_ids = {(r.get("comment_id") or "") for r in existing}
        was_empty = len(existing) == 0
        new_added: list[dict] = []
        for it in items:
            cid = (it.get("comment_id") or "").strip()
            content = (it.get("content") or "").strip()
            if not content:
                continue
            if cid and cid in existing_ids:
                continue  # 同一条子评论重复采集，去重
            rec = {
                "comment_id": cid,
                "nickname": (it.get("nickname") or "").strip(),
                "content": content,
                "replied_at": (it.get("replied_at") or ""),
                # v008：多级评论树——保留层级关系，供前端递归渲染
                "parent_id": (it.get("parent_id") or "").strip(),
                "level": int(it.get("level") or 1),
            }
            existing.append(rec)
            new_added.append(rec)

        if not new_added:
            return self._to_read(task)  # 无新增，幂等返回

        task.sub_replies = json.dumps(existing, ensure_ascii=False)
        # 刷新快捷字段：优先取「回复时间最新」的一条（贴近"最近回复"语义），
        # 时间缺失时退化为「层级最深」的一条（对话最深入），再则最后一条。
        def _ts(r):
            s = (r.get("replied_at") or "").strip()
            if not s:
                return ""
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
                try:
                    return datetime.strptime(s, fmt).strftime("%Y-%m-%d %H:%M:%S")
                except Exception:
                    continue
            return s  # 无法解析则按原始串比较
        latest = max(existing, key=lambda r: (_ts(r), int(r.get("level") or 0)))
        task.user_reply_content = latest.get("content", "")
        task.replier_name = latest.get("nickname", "")
        task.user_replied_comment = True
        if task.status != "user_dm":
            task.status = "user_replied"  # type: ignore[assignment]
        task.updated_at = now_utc()
        saved = self._repo.save_comment_task(task)
        if was_empty:
            self._fire_comment_replied_tracking(saved)  # 仅首次打埋点
        return self._to_read(saved)

    def track_user_dm(self, task_id: str) -> CommentTaskRead:
        """对方主动私信 → user_dm=True，并自动标记线索转化成功（lead → wechat_added）。

        lead 联动谨慎处理：优先调用注入的 LeadService.mark_wechat_added（含通知/话术回写）；
        未注入时退化为直接更新 lead 状态。任何异常都不影响主流程。
        """
        task = self._repo.get_comment_task(task_id)
        task.user_dm = True
        task.status = "user_dm"  # type: ignore[assignment]  # 兼容旧终态
        task.updated_at = now_utc()
        saved = self._repo.save_comment_task(task)

        # 线索转化联动（best-effort）
        try:
            if self._lead_service is not None:
                self._lead_service.mark_wechat_added(saved.lead_id, manual=False)
            else:
                lead = self._repo.get_lead(saved.lead_id)
                lead.status = "wechat_added"  # type: ignore[assignment]
                lead.wechat_added_at = now_utc()
                lead.updated_at = now_utc()
                self._repo.save_lead(lead)
        except Exception as e:
            logger.warning(
                "线索转化联动失败（对方主动私信→wechat_added）: task_id=%s lead_id=%s err=%s",
                saved.id, saved.lead_id, e, exc_info=True,
            )

        try:
            _tracking.log_lead_event(
                self._repo, saved.lead_id, "comment_dm_converted",
                f"task_id={saved.id} lead_id={saved.lead_id}",
            )
        except Exception as e:
            logger.warning(
                "埋点失败 comment_dm_converted 写入失败: task_id=%s lead_id=%s err=%s",
                saved.id, saved.lead_id, e, exc_info=True,
            )
        return self._to_read(saved)

    def list_followup_candidates(self, hours: int = 48) -> list[CommentTaskRead]:
        """可二次跟进候选：replied 且已超过 hours 小时仍无任何反应（未私信、未追评）。"""
        cutoff = now_utc() - timedelta(hours=hours)
        tasks = self._repo.list_comment_tasks(status="replied")
        result = []
        for t in tasks:
            if t.replied_at is None:
                continue
            if t.replied_at > cutoff:
                continue
            if t.user_dm or t.user_replied_comment:
                continue
            result.append(t)
        result.sort(key=lambda t: t.replied_at or now_utc())
        return [self._to_read(t) for t in result]

    # ═══════════════════════════════════════════════════════
    # 内部 · 埋点 helper（best-effort，失败不影响主流程）
    # ═══════════════════════════════════════════════════════

    def _fire_comment_sent_tracking(self, task: CommentReplyTask) -> None:
        """评论回复已发出：线索事件 + 话术使用留痕 + 账号操作留痕。"""
        try:
            _tracking.log_lead_event(
                self._repo, task.lead_id, "comment_sent",
                f"task_id={task.id} lead_id={task.lead_id} "
                f"script_id={task.reply_script_id or ''} account={task.account or ''}",
            )
            _tracking.record_script_usage(
                self._repo,
                script_id=task.reply_script_id,
                lead_id=task.lead_id,
                channel="comment",
                variant_id=task.reply_variant_id or None,
            )
            _tracking.record_account_event(
                self._repo,
                account_id=task.account or "default",
                action="comment_sent",
                detail=f"comment_task_id={task.id} lead_id={task.lead_id}",
                success=True,
            )
        except Exception as e:
            logger.warning(
                "埋点失败 评论已发出事件写入失败: task_id=%s lead_id=%s err=%s",
                task.id, task.lead_id, e, exc_info=True,
            )

    def _fire_comment_replied_tracking(self, task: CommentReplyTask) -> None:
        """对方追评/回复评论：线索事件。"""
        try:
            _tracking.log_lead_event(
                self._repo, task.lead_id, "comment_replied",
                f"task_id={task.id} lead_id={task.lead_id}",
            )
        except Exception as e:
            logger.warning(
                "埋点失败 comment_replied 事件写入失败: task_id=%s lead_id=%s err=%s",
                task.id, task.lead_id, e, exc_info=True,
            )

    # ═══════════════════════════════════════════════════════
    # 内部转换
    # ═══════════════════════════════════════════════════════

    @staticmethod
    def _to_read(task: CommentReplyTask) -> CommentTaskRead:
        # v008：多级回复统计（由 sub_replies 运行时派生，零额外存储）
        try:
            _subs = json.loads(task.sub_replies or "[]") or []
        except Exception:
            _subs = []
        if not isinstance(_subs, list):
            _subs = []
        reply_count = len(_subs)
        reply_people = len({r.get("nickname") for r in _subs if r.get("nickname")})
        reply_depth = max((int(r.get("level") or 0) for r in _subs), default=0)
        return CommentTaskRead(
            id=task.id,
            lead_id=task.lead_id,
            comment_content=task.comment_content,
            video_title=task.video_title,
            reply_content=task.reply_content,
            status=task.status,
            account=task.account,
            replied_at=task.replied_at,
            user_visited=task.user_visited,
            user_dm=task.user_dm,
            user_replied_comment=task.user_replied_comment,
            # v006：检测谁回复了我
            user_reply_content=task.user_reply_content,
            replier_name=task.replier_name,
            # v007：二级评论树（对方多条回复）
            sub_replies=task.sub_replies,
            # v008：多级回复统计（由 sub_replies 运行时派生）
            reply_count=reply_count,
            reply_people=reply_people,
            reply_depth=reply_depth,
            # 精准获客（v002）新字段
            video_url=task.video_url,
            comment_id=task.comment_id,
            reply_failure_reason=task.reply_failure_reason,
            priority=task.priority,
            # 话术归因（v004）
            reply_script_id=task.reply_script_id,
            reply_variant_id=task.reply_variant_id,
        )
