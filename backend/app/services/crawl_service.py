"""
采集服务 · CrawlService
========================
负责采集任务的 CRUD、启动/停止、以及采集结果入库为线索。

v002 精准获客改造：
- 初筛：无意义过滤 → 重复过滤 → 高意向识别 → 三级分流
- 精确定位：lead 记录 video_id / comment_id / comment_user_id / comment_time / matched_keywords
- 高意向（score>=60）自动创建 comment_task（P1，含 video_url + comment_id）
- 低意向（score<30）直接丢弃不入库
- MediaCrawler 改为调用已运行的本地 API（http://127.0.0.1:8090），不再 subprocess
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone

from app.integrations.mediacrawler_client import MediaCrawlerClient, MediaCrawlerUnavailable
from app.models.domain import CommentReplyTask, CrawlTask, Lead, now_utc
from app.repositories.base import Repository
from app.schemas.crawl import CrawlImportItem, CrawlImportRequest, CrawlTaskCreate
from app.schemas.lead import LeadCreate

logger = logging.getLogger(__name__)

HIGH_INTENT_KEYWORDS = [
    "多少钱", "价格", "报价", "怎么收费", "费用",
    "怎么做", "联系", "微信", "vx", "加微",
    "推荐", "求", "私", "咨询", "合作",
    "想买", "需要", "感兴趣", "了解一下", "详细",
]

BUSINESS_KEYWORDS = [
    "装修", "获客", "投放", "咨询", "合作",
    "翻新", "改造", "定制", "设计", "施工",
    "引流", "推广", "营销", "运营", "代运营",
]

# 无意义评论过滤：命中后整体被清空且剩余有效字符 <2 则丢弃
NOISE_PHRASES = ["哈哈", "666", "沙发", "顶", "路过", "不错", "可以"]
NOISE_EMOJIS = ["👍", "🔥", "😂", "👏", "💪", "😀", "😁", "🤣"]

# 三级分流阈值
HIGH_SCORE_THRESHOLD = 60
MID_SCORE_THRESHOLD = 30


class CrawlService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo
        # 旧 subprocess 句柄表保留以向后兼容；v002 起不再启动子进程，恒为空
        self._processes: dict = {}

    # ═══════════════════════════════════════════════════════════
    # CRUD
    # ═══════════════════════════════════════════════════════════

    def list_tasks(self, status: str | None = None) -> list[CrawlTask]:
        return self._repo.list_crawl_tasks(status=status)

    def get_task(self, task_id: str) -> CrawlTask:
        return self._repo.get_crawl_task(task_id)

    def create_task(self, payload: CrawlTaskCreate) -> CrawlTask:
        task = CrawlTask(
            name=payload.name or self._generate_task_name(payload),
            crawl_type=payload.crawl_type,
            keyword=payload.keyword,
            competitor_account=payload.competitor_account,
            video_url=payload.video_url,
            source=payload.source,
            intent_keywords=payload.intent_keywords,
            excluded_keywords=payload.excluded_keywords,
            max_comments=payload.max_comments,
            # 精准获客（v002）：新字段透传
            time_range=payload.time_range,
            max_videos=payload.max_videos,
            max_comments_per_video=payload.max_comments_per_video,
            sort_type=payload.sort_type,
            # reply_check（检测评论回复）隐含开启二级评论采集
            enable_sub_comments=(
                payload.enable_sub_comments or payload.crawl_type == "reply_check"
            ),
        )
        return self._repo.save_crawl_task(task)

    def delete_task(self, task_id: str) -> None:
        # P1-4: 先确认存在，不存在抛 KeyError → 路由转 404（而非静默 204）
        self._repo.get_crawl_task(task_id)
        self._stop_process(task_id)
        self._repo.delete_crawl_task(task_id)

    # P3-5: terminal states cannot be restarted (no reset/re-run)
    _TERMINAL_STATES = ("completed", "failed", "cancelled")

    def start_task(self, task_id: str) -> CrawlTask:
        task = self._repo.get_crawl_task(task_id)
        if task.status == "running":
            return task
        if task.status in self._TERMINAL_STATES:
            raise ValueError(
                f"crawl task already in terminal state ({task.status}); create a new task"
            )
        task.status = "running"
        task.error_message = ""
        task.started_at = now_utc()
        task.finished_at = None
        task.updated_at = now_utc()
        self._repo.save_crawl_task(task)
        self._launch_mediacrawler(task)
        return task

    def stop_task(self, task_id: str) -> CrawlTask:
        task = self._repo.get_crawl_task(task_id)
        self._stop_process(task_id)
        if task.status == "running":
            task.status = "completed"
            task.finished_at = now_utc()
            task.error_message = "已手动停止"
            task.updated_at = now_utc()
            self._repo.save_crawl_task(task)
        return task

    # ═══════════════════════════════════════════════════════════
    # 状态轮询（v002：改为查询 MediaCrawler API）
    # ═══════════════════════════════════════════════════════════

    def get_status(self, task_id: str) -> CrawlTask:
        task = self._repo.get_crawl_task(task_id)
        if task.status != "running":
            return task

        try:
            resp = MediaCrawlerClient().status()
        except MediaCrawlerUnavailable:
            # API 暂时不可达不把任务判死，留给下一次轮询
            return task
        except Exception:
            return task

        state = str(resp.get("status") or resp.get("state") or "").lower()
        if state in ("completed", "success", "done", "finished", "idle"):
            task.status = "completed"
            task.finished_at = now_utc()
            task.updated_at = now_utc()
            self._repo.save_crawl_task(task)
            # 采集完成后自动读取结果文件并导入
            self._auto_import_results(task)
        elif state in ("failed", "error"):
            task.status = "failed"
            task.error_message = str(
                resp.get("message") or resp.get("error") or "MediaCrawler 采集失败"
            )
            task.finished_at = now_utc()
            task.updated_at = now_utc()
            self._repo.save_crawl_task(task)
        # running / pending 等中间态：原样返回
        return task

    # ═══════════════════════════════════════════════════════════
    # 采集结果入库（任务 B + 任务 E）
    # ═══════════════════════════════════════════════════════════

    def import_comments(self, payload: CrawlImportRequest) -> dict:
        task_id = payload.task_id
        imported = 0
        skipped = 0
        lead_ids: list[str] = []
        auto_queued: list[str] = []   # 高意向自动入队的 comment_task id

        task: CrawlTask | None = None
        if task_id:
            try:
                task = self._repo.get_crawl_task(task_id)
            except KeyError:
                task = None

        intent_keywords = self._parse_keywords(
            task.intent_keywords if task else payload.keyword
        )
        excluded_keywords = self._parse_keywords(
            task.excluded_keywords if task else ""
        )
        seen_comment_ids: set[str] = set()
        video_filter_cache: dict[str, bool] = {}   # aweme_id → 是否通过视频级筛选
        # v008：全量评论建树（一级 + 所有子评论，每条带 comment_id/parent_comment_id）
        # 用于多级回复检测：以 comment_task.comment_id 为根展开全部后代（限 6 级）。
        all_nodes: dict[str, CrawlImportItem] = {}   # comment_id -> item
        all_tree: dict[str, list[str]] = {}          # parent_comment_id -> [子 comment_id]

        for item in payload.items:
            # 收集全量评论用于建树（不论后续是否入库，先入索引）
            _cid = (item.comment_id or "").strip()
            _pid = (item.parent_comment_id or "").strip()
            if _cid:
                all_nodes[_cid] = item
                if _pid and _pid != "0":
                    all_tree.setdefault(_pid, []).append(_cid)

            # ── 0. 非一级评论分流（v005 / v008）──
            # 子评论是"评论的评论"，既可能是我的回复，也可能是对方回我的话。
            # 它们不是新商机，入线索池会污染数据（我的话术含"微信/咨询"等词，
            # 会被高意向规则误判成客户），所以一律改走下方的多级回复检测通道。
            if _pid and _pid != "0":
                continue

            content = (item.content or "").strip()
            nickname = (item.nickname or "抖音用户").strip()
            comment_id = (item.comment_id or "").strip()
            aweme_id = (item.aweme_id or "").strip()

            # ── 1. 无意义过滤（直接丢弃，不入库） ──
            if self._is_noise(content):
                skipped += 1
                continue

            content_lower = content.lower()
            if any(kw in content_lower for kw in excluded_keywords):
                skipped += 1
                continue

            # ── 2. 重复过滤（同一批次 comment_id 去重） ──
            if comment_id and comment_id in seen_comment_ids:
                skipped += 1
                continue
            if comment_id:
                seen_comment_ids.add(comment_id)

            # ── 任务 E：视频级筛选（时间 / 热度 / 去重缓存） ──
            video_key = aweme_id or f"__anon_{comment_id or nickname}"
            video_passes = video_filter_cache.get(video_key)
            if video_passes is None:
                video_passes = self._video_passes_filters(item, task)
                video_filter_cache[video_key] = video_passes
            if not video_passes:
                skipped += 1
                continue

            external_id = f"douyin-comment-{comment_id}" if comment_id else ""
            source_url = item.source_url
            if not source_url and aweme_id:
                source_url = f"https://www.douyin.com/video/{aweme_id}"

            # ── 3. 高意向识别：评分 + 命中关键词 ──
            score = self._score_comment(content, nickname, intent_keywords)
            matched_list = self._collect_matched_keywords(content, nickname, intent_keywords)

            # ── 4. 三级分流 ──
            if score < MID_SCORE_THRESHOLD:
                # 低意向：直接丢弃，不入库
                skipped += 1
                continue

            intent_level = "A" if score >= 70 else "B" if score >= 40 else "C"
            intent_tag = "high" if score >= HIGH_SCORE_THRESHOLD else "mid"

            tags = ["mediacrawler", "douyin-comment"]
            if task_id:
                tags.append(f"crawl-{task_id}")
            if score >= HIGH_SCORE_THRESHOLD:
                tags.append("high_intent")

            lead_create = LeadCreate(
                nickname=nickname,
                source=payload.source,
                comment=content,
                video=item.video_title,
                source_url=source_url,
                source_keyword=payload.keyword or (task.keyword if task else ""),
                platform="douyin",
                external_id=external_id,
                tags=tags,
                note=content,
                account=None,
                # ── 5. 精确定位信息 ──
                video_id=aweme_id,
                comment_id=comment_id,
                comment_user_id=(item.user_id or "").strip(),
                comment_time=(item.create_time or "").strip(),
                matched_keywords=json.dumps(matched_list, ensure_ascii=False),
            )

            lead = self._create_or_get_lead(lead_create, score, intent_level, intent_tag)
            if lead is None:
                skipped += 1
                continue

            # external_id 命中已存在线索时不重复入队（lead 已处理过）
            lead_ids.append(lead.id)
            imported += 1

            # ── 6. 高意向自动创建 comment_task（P1） ──
            if score >= HIGH_SCORE_THRESHOLD:
                task_id_ = self._auto_enqueue_comment_task(lead, item, source_url)
                if task_id_:
                    auto_queued.append(task_id_)

        # ── 7. 回复检测（v008）：以 comment_task 为根，展开多级评论树识别「对方回复了我」 ──
        replied_tasks: list[str] = []
        replies: list[dict] = []
        if all_nodes:
            replied_tasks, replies = self._detect_user_replies(all_nodes, all_tree)

        if task_id and task is not None:
            task.collected_count = len(payload.items)
            task.imported_count = task.imported_count + imported
            task.updated_at = now_utc()
            self._repo.save_crawl_task(task)

        return {
            "imported": imported,
            "skipped": skipped,
            "task_id": task_id,
            "leads": lead_ids,
            "comment_tasks": auto_queued,
            "replied_tasks": replied_tasks,
            "replies": replies,
        }

    def _detect_user_replies(
        self,
        nodes: dict[str, CrawlImportItem],
        tree: dict[str, list[str]],
        max_depth: int = 6,
    ) -> tuple[list[str], list[dict]]:
        """以每条 comment_task 为根，展开其多级评论子树，识别「对方回复了我」。

        v008 升级：不再只匹配「直接挂在根下的二级」，而是用全量评论树
        （nodes/tree 由 import_comments 建好）对根做 BFS，收集**所有后代**
        （一级、二级、三级…最多 max_depth 层相对深度），所以别人在我评论下
        互聊、同人追评多条、六层深的对话线程都能完整拿到。

        判定依据：抖音评论的 parent_comment_id 指向被回复评论的 id。根就是
        comment_tasks.comment_id（我要跟进/回复的那条评论，可能是我主动发的一级
        帖，也可能是我切入别人热评下发的二级回复）。凡在根的子树里、且不是
        我自己发的（内容匹配 reply_content 排除），都算「对方回复」的一部分。

        多个人、多条追评：子树里多个节点全部保留（track_user_reply 内部按
        comment_id 去重，重复采集不叠加）。
        返回 (被标记 task id 列表, 回复明细)。
        """
        tasks = self._repo.list_comment_tasks()
        if not tasks:
            return [], []

        # 根(comment_id) → 关联 task 列表；同时收集我自己的回复话术用于排除
        roots: dict[str, list[CommentReplyTask]] = {}
        my_reply_texts: set[str] = set()
        for t in tasks:
            cid = (t.comment_id or "").strip()
            if cid and cid not in roots:
                roots[cid] = []
            if cid:
                roots[cid].append(t)
            text = (t.reply_content or "").strip()
            if text:
                my_reply_texts.add(text)

        if not roots:
            return [], []

        replied_ids: list[str] = []
        replies: list[dict] = []

        for root_cid, task_list in roots.items():
            if root_cid not in nodes:
                continue
            # BFS 展开子树（相对根深度，限 max_depth 层）
            descendants: list[tuple[str, int]] = []
            visited: set[str] = {root_cid}
            queue: list[tuple[str, int]] = [(root_cid, 0)]
            while queue:
                cur, depth = queue.pop(0)
                if depth >= max_depth:
                    continue
                for child in tree.get(cur, []):
                    if child in visited:
                        continue
                    visited.add(child)
                    descendants.append((child, depth + 1))
                    queue.append((child, depth + 1))

            if not descendants:
                continue

            # 收集后代（排除我自己的回复），带 parent_id + level
            sub_items: list[dict] = []
            for cid, lvl in descendants:
                it = nodes.get(cid)
                if it is None:
                    continue
                content = (it.content or "").strip()
                if not content:
                    continue
                if content in my_reply_texts:  # 我自己的话术被采回，忽略
                    continue
                sub_items.append({
                    "comment_id": cid,
                    "nickname": (it.nickname or "").strip(),
                    "content": content,
                    "replied_at": (it.create_time or "").strip(),
                    "parent_id": (it.parent_comment_id or "").strip(),
                    "level": lvl,  # 相对根深度：1=L2, 2=L3 … max_depth=L(1+max_depth)
                })

            if not sub_items:
                continue

            for t in task_list:
                try:
                    from app.services.comment_task_service import CommentTaskService

                    CommentTaskService(self._repo).track_user_reply(t.id, replies=sub_items)
                    if t.id not in replied_ids:
                        replied_ids.append(t.id)
                except Exception as e:  # best-effort：单个失败不影响整体导入
                    logger.warning(
                        "回写「对方回复了我」失败: task_id=%s err=%s", t.id, e, exc_info=True,
                    )
                replies.append({"taskId": t.id, "items": sub_items})

        if replied_ids:
            logger.info(
                "多级回复检测命中 %d 条：%s", len(replied_ids), ", ".join(replied_ids),
            )
        return replied_ids, replies

    def _create_or_get_lead(
        self, payload: LeadCreate, score: int, intent_level: str, intent_tag: str
    ) -> Lead | None:
        if payload.external_id:
            existing = self._repo.find_lead_by_external(payload.platform, payload.external_id)
            if existing is not None:
                return existing

        lead = Lead(
            nickname=payload.nickname,
            source=payload.source,
            comment=payload.comment,
            video=payload.video,
            source_url=payload.source_url,
            source_keyword=payload.source_keyword,
            platform=payload.platform,
            external_id=payload.external_id,
            tags=payload.tags,
            note=payload.note,
            score=score,
            intent_level=intent_level,
            intent=intent_tag,
            hue=hash(payload.nickname) % 360,
            # v002：入库线索统一 collected，高意向改由 comment_task 驱动跟进
            status="collected",
            # ── 精准获客（v002）：评论级溯源 ──
            video_id=payload.video_id,
            comment_id=payload.comment_id,
            comment_user_id=payload.comment_user_id,
            comment_time=payload.comment_time,
            matched_keywords=payload.matched_keywords,
        )
        return self._repo.save_lead(lead)

    # ═══════════════════════════════════════════════════════════
    # 高意向自动入队
    # ═══════════════════════════════════════════════════════════

    def _auto_enqueue_comment_task(
        self, lead: Lead, item: CrawlImportItem, source_url: str
    ) -> str | None:
        """高意向评论自动创建 P1 评论回复任务。

        直接走 repo.save_comment_task（CommentTaskService.create_task 不透传
        video_url/comment_id/priority，且不在本子任务范围内修改其核心逻辑）。
        """
        try:
            ctask = CommentReplyTask(
                lead_id=lead.id,
                comment_content=lead.comment,
                video_title=item.video_title,
                video_url=source_url,
                comment_id=(item.comment_id or "").strip(),
                priority="P1",
                status="pending",
            )
            saved = self._repo.save_comment_task(ctask)
            return saved.id
        except Exception:
            # best-effort：入队失败不阻断主流程
            return None

    # ═══════════════════════════════════════════════════════════
    # 初筛工具方法
    # ═══════════════════════════════════════════════════════════

    def _is_noise(self, content: str) -> bool:
        """无意义过滤：纯表情/纯符号/无意义短语。"""
        compact = re.sub(r"\s+", "", content or "")
        # 去除空白后长度 < 2
        if len(compact) < 2:
            return True
        # 去掉所有无意义短语与表情后，剩余有效字符（中文/字母/数字）<2 视为无意义
        candidate = compact
        for kw in NOISE_PHRASES:
            candidate = candidate.replace(kw, "")
        for emo in NOISE_EMOJIS:
            candidate = candidate.replace(emo, "")
        letters = re.sub(r"[^\w一-鿿]+", "", candidate, flags=re.UNICODE)
        return len(letters) < 2

    def _collect_matched_keywords(
        self, content: str, nickname: str, intent_keywords: list[str]
    ) -> list[str]:
        """收集 HIGH_INTENT_KEYWORDS + 自定义 intent_keywords 中命中的关键词（去重保序）。"""
        text = f"{content} {nickname}".lower()
        matched: list[str] = []
        seen: set[str] = set()
        for kw in list(HIGH_INTENT_KEYWORDS) + list(intent_keywords):
            if not kw:
                continue
            key = kw.lower()
            if key in text and key not in seen:
                seen.add(key)
                matched.append(kw)
        return matched

    def _score_comment(self, content: str, nickname: str, intent_keywords: list[str]) -> int:
        score = 0
        text = f"{content} {nickname}".lower()
        high_hits = sum(1 for kw in HIGH_INTENT_KEYWORDS if kw in text)
        score += min(high_hits * 15, 45)
        biz_hits = sum(1 for kw in BUSINESS_KEYWORDS if kw in text)
        score += min(biz_hits * 10, 30)
        custom_hits = sum(1 for kw in intent_keywords if kw and kw in text)
        score += min(custom_hits * 12, 25)
        if len(content) > 20:
            score += 5
        if len(content) > 50:
            score += 5
        return min(score, 100)

    # ═══════════════════════════════════════════════════════════
    # 任务 E：视频级筛选
    # ═══════════════════════════════════════════════════════════

    def _video_passes_filters(
        self, item: CrawlImportItem, task: CrawlTask | None
    ) -> bool:
        """时间 / 热度筛选。字段缺失时跳过该筛选（不报错、不丢弃）。"""
        # 时间筛选：视频发布时间在 time_range 天内
        if task is not None and task.time_range > 0 and item.publish_time:
            pub = self._parse_dt(item.publish_time)
            if pub is not None:
                cutoff = now_utc() - timedelta(days=task.time_range)
                if pub < cutoff:
                    return False
        # 热度筛选：有热度数据时要求 like>10 或 comment>5
        if item.like_count or item.comment_count:
            if item.like_count <= 10 and item.comment_count <= 5:
                return False
        return True

    @staticmethod
    def _parse_dt(value: str) -> datetime | None:
        """容忍解析 epoch(秒/毫秒) 或 ISO 时间字符串。"""
        if not value:
            return None
        try:
            num = float(value)
            if num > 1e12:
                num /= 1000.0
            return datetime.fromtimestamp(num, timezone.utc)
        except (ValueError, TypeError) as e:
            # 非 epoch 数值，降级走 ISO 字符串解析（预期内的正常分支）
            logger.debug("时间字段非 epoch 数值，降级为 ISO 解析: value=%r err=%s", value, e)
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None

    def _parse_keywords(self, raw: str) -> list[str]:
        if not raw:
            return []
        return [kw.strip().lower() for kw in raw.replace("，", ",").split(",") if kw.strip()]

    def _generate_task_name(self, payload: CrawlTaskCreate) -> str:
        parts = []
        if payload.keyword:
            parts.append(f"关键词:{payload.keyword}")
        if payload.competitor_account:
            parts.append(f"对标:{payload.competitor_account}")
        if payload.video_url:
            parts.append("指定视频")
        if not parts:
            parts.append("评论采集")
        return " · ".join(parts)

    # ═══════════════════════════════════════════════════════════
    # 任务 C：MediaCrawler API 对接（替代 subprocess）
    # ═══════════════════════════════════════════════════════════

    def _launch_mediacrawler(self, task: CrawlTask) -> None:
        """调用已运行的 MediaCrawler API 启动采集（不再 spawn 子进程）。"""
        try:
            # search/comment/profile → search 模式；competitor → creator 模式
            crawler_type = "creator" if task.crawl_type == "competitor" else "search"
            # 二级评论：reply_check 任务必须开（否则采不到别人的追评）
            wants_sub = task.enable_sub_comments or task.crawl_type == "reply_check"
            payload: dict = {
                "platform": "dy",
                "login_type": "qrcode",
                "crawler_type": crawler_type,
                "enable_comments": True,
                "enable_sub_comments": wants_sub,
                "max_notes_count": task.max_videos,
                "max_comments_count": task.max_comments_per_video,
                "sort_type": task.sort_type,
            }
            if task.crawl_type == "competitor" and task.competitor_account:
                payload["creator_ids"] = task.competitor_account
            elif task.keyword:
                payload["keywords"] = task.keyword
            elif task.video_url:
                payload["keywords"] = task.video_url

            MediaCrawlerClient().start(payload)
        except MediaCrawlerUnavailable as exc:
            task.status = "failed"
            task.error_message = (
                "MediaCrawler 未启动或未登录抖音。请先启动 MediaCrawler"
                "（http://127.0.0.1:8090）并扫码登录抖音。"
            )
            task.updated_at = now_utc()
            self._repo.save_crawl_task(task)
        except Exception as exc:
            task.status = "failed"
            task.error_message = f"MediaCrawler 启动失败: {exc}"
            task.updated_at = now_utc()
            self._repo.save_crawl_task(task)

    def _stop_process(self, task_id: str) -> None:
        """v002：调用 MediaCrawler API 停止采集；旧 subprocess 句柄清理（恒为空）。"""
        self._processes.pop(task_id, None)
        try:
            MediaCrawlerClient().stop()
        except Exception as e:
            logger.warning(
                "调用 MediaCrawler 停止采集失败: task_id=%s err=%s",
                task_id, e, exc_info=True,
            )

    # ═══════════════════════════════════════════════════════════
    # 采集完成后自动导入结果文件
    # ═══════════════════════════════════════════════════════════

    def _auto_import_results(self, task: CrawlTask) -> None:
        """读取 MediaCrawler 输出目录最新 JSON 结果，自动走 import_comments 入库。"""
        try:
            client = MediaCrawlerClient()
            data_dir = client.project_root / "data" / "douyin"
            if not data_dir.exists():
                return
            json_files = sorted(
                [p for p in data_dir.glob("*.json") if p.is_file()],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if not json_files:
                return

            items: list[CrawlImportItem] = []
            for path in json_files[:10]:   # 只取最新的若干个结果文件
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                records = data if isinstance(data, list) else [data]
                for rec in records:
                    if isinstance(rec, dict):
                        items.append(self._record_to_import_item(rec))

            if not items:
                return

            self.import_comments(
                CrawlImportRequest(
                    task_id=task.id,
                    source="competitor" if task.crawl_type == "competitor" else "own_comment",
                    keyword=task.keyword or task.competitor_account,
                    items=items,
                )
            )
        except Exception as e:
            # 自动导入为 best-effort，失败不影响任务状态
            logger.warning(
                "采集结果自动导入失败（best-effort，不影响任务状态）: task_id=%s err=%s",
                task.id, e, exc_info=True,
            )

    @staticmethod
    def _record_to_import_item(rec: dict) -> CrawlImportItem:
        """将 MediaCrawler 输出记录宽松映射为 CrawlImportItem（字段名兼容多种历史格式）。"""
        def _int(v) -> int:
            try:
                return int(v)
            except (TypeError, ValueError):
                return 0

        return CrawlImportItem(
            nickname=str(rec.get("nickname") or rec.get("nick_name") or ""),
            content=str(rec.get("content") or ""),
            comment_id=str(rec.get("comment_id") or rec.get("cid") or ""),
            aweme_id=str(rec.get("aweme_id") or rec.get("awemeId") or ""),
            video_title=str(rec.get("video_title") or rec.get("title") or rec.get("desc") or ""),
            source_url=str(rec.get("source_url") or ""),
            user_id=str(rec.get("user_id") or rec.get("user_id_str") or rec.get("uid") or ""),
            create_time=str(rec.get("create_time") or rec.get("ctime") or rec.get("createTime") or ""),
            publish_time=str(rec.get("publish_time") or rec.get("video_publish_time") or ""),
            like_count=_int(rec.get("like_count") or rec.get("digg_count") or rec.get("liked_count")),
            comment_count=_int(rec.get("comment_count") or rec.get("comments_count")),
            parent_comment_id=str(rec.get("parent_comment_id") or ""),
        )
