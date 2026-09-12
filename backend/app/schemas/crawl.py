"""
采集任务 · Pydantic Schemas
=============================
与 CrawlTask 领域模型对齐，用于 API 请求/响应校验。
"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class CrawlTaskCreate(BaseModel):
    """创建采集任务"""
    name: str = Field(default="", max_length=200)
    crawl_type: Literal["comment", "search", "profile", "competitor", "reply_check"] = "comment"
    keyword: str = ""
    competitor_account: str = ""
    video_url: str = ""
    source: Literal["own_comment", "competitor"] = "own_comment"
    intent_keywords: str = ""
    excluded_keywords: str = ""
    max_comments: int = Field(default=100, ge=1, le=10000)
    # 精准获客（v002）
    time_range: int = Field(default=7, ge=1, le=365)
    max_videos: int = Field(default=20, ge=1, le=500)
    max_comments_per_video: int = Field(default=50, ge=1, le=2000)
    sort_type: Literal["latest", "most_liked", "most_commented"] = "latest"
    # 二级评论（子评论）：回复检测必需。crawl_type=reply_check 时强制开启
    enable_sub_comments: bool = False


class CrawlTaskRead(BaseModel):
    """采集任务详情"""
    id: str
    name: str
    crawl_type: str
    keyword: str
    competitor_account: str
    video_url: str
    source: str
    intent_keywords: str
    excluded_keywords: str
    max_comments: int
    # 精准获客（v002）
    time_range: int = 7
    max_videos: int = 20
    max_comments_per_video: int = 50
    sort_type: str = "latest"
    enable_sub_comments: bool = False       # 子评论采集（回复检测必需）
    status: str
    collected_count: int
    imported_count: int
    error_message: str
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CrawlTaskStatus(BaseModel):
    """采集任务状态响应"""
    id: str
    status: str
    collected_count: int
    imported_count: int
    max_comments: int
    max_videos: int = 20
    error_message: str
    started_at: datetime | None
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class CrawlImportItem(BaseModel):
    """单条采集评论数据（MediaCrawler 输出格式）"""
    nickname: str = ""
    content: str = ""                          # 评论内容
    comment_id: str = ""                       # 评论唯一ID（去重用）
    aweme_id: str = ""                         # 视频ID
    video_title: str = ""                      # 视频标题
    source_url: str = ""                       # 来源URL
    user_id: str = ""                          # 用户ID
    create_time: str = ""                      # 评论时间
    # ── 精准获客（v002）：视频级筛选字段（可选，缺失时跳过对应筛选） ──
    publish_time: str = ""                     # 视频发布时间（epoch 或 ISO）
    like_count: int = 0                        # 视频点赞数
    comment_count: int = 0                     # 视频评论数
    # reply_check（检测回复）必需：父评论ID。主评论为 "0"，子评论指向所回复的那条评论
    parent_comment_id: str = ""


class CrawlImportRequest(BaseModel):
    """采集结果批量入库请求"""
    task_id: str = ""
    source: Literal["own_comment", "competitor"] = "own_comment"
    keyword: str = ""
    items: list[CrawlImportItem] = Field(default_factory=list)


class CrawlImportResponse(BaseModel):
    """采集结果入库响应"""
    imported: int
    skipped: int
    task_id: str
    leads: list[str] = Field(default_factory=list)  # 新入库的 lead id 列表
    comment_tasks: list[str] = Field(default_factory=list)  # 高意向自动入队的 comment_task id 列表
    replied_tasks: list[str] = Field(default_factory=list)  # 本次检测到「对方回复了我」的 comment_task id
    replies: list[dict] = Field(default_factory=list)       # 回复明细（taskId / nickname / content）
