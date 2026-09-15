"""评论回复任务 Schema · 评论引流策略核心 · v1.0 契约对齐"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


class CommentTaskCreate(_Camel):
    """创建评论回复任务（从高意向线索生成）

    v009：video_id / comment_author / comment_time 可显式传入；留空时服务层
    自动从关联线索补齐（评论人昵称、评论时间、视频 ID、视频标题、视频链接）。
    """
    lead_id: str
    comment_content: str = ""
    video_title: str = ""
    reply_content: str = ""
    account: str | None = None
    reply_script_id: str | None = None
    # 精准获客（v002）
    video_url: str = ""
    comment_id: str = ""
    # v009：完整上下文
    video_id: str = ""
    comment_author: str = ""
    comment_time: str = ""
    priority: Literal["P0", "P1", "P2", "P3"] = "P2"


class CommentTaskPushRequest(_Camel):
    """批量推送线索到「待办互动 → 评论回复」（POST /comments/tasks/push）

    评论候选池只是候选池，这里把选中的线索批量建成回复任务。
    幂等：同一 lead 已有未结束任务（pending/locating/replying/replied/user_replied）
    时跳过，不重复建。
    """
    lead_ids: list[str] = Field(default_factory=list)
    account: str | None = None          # 留空 = 当前激活账号
    priority: Literal["P0", "P1", "P2", "P3"] | None = None  # 留空 = 按线索意向等级推导
    reply_content: str = ""             # 已在候选池写好话术时一并带过去
    reply_script_id: str | None = None


class CommentTaskPushItem(_Camel):
    """单条推送结果"""
    lead_id: str
    status: str = "created"             # created / skipped
    task_id: str = ""
    reason: str = ""
    comment_author: str = ""
    video_title: str = ""


class CommentTaskPushResponse(_Camel):
    """批量推送结果"""
    created: int = 0
    skipped: int = 0
    task_ids: list[str] = Field(default_factory=list)
    items: list[CommentTaskPushItem] = Field(default_factory=list)


class CommentTaskUpdate(_Camel):
    """更新任务状态（标记已回复/对方私信/对方追评）

    状态值兼容：pending/locating/replying/replied/failed/cancelled/
    user_replied/user_dm/ignored
    """
    status: Literal[
        "pending", "locating", "replying", "replied",
        "failed", "cancelled", "user_replied", "user_dm", "ignored",
    ] | None = None
    reply_content: str | None = None
    # 实际使用的评论话术 ID / 变体 ID —— 发送成功时回写，供话术效果归因
    reply_script_id: str | None = None
    reply_variant_id: str | None = None
    replied_at: datetime | None = None
    user_visited: bool | None = None
    user_dm: bool | None = None
    user_replied_comment: bool | None = None
    # v006：检测谁回复了我
    user_reply_content: str | None = None
    replier_name: str | None = None
    # v007：二级评论树（JSON 列表字符串）
    sub_replies: str | None = None
    # 精准获客（v002）
    reply_failure_reason: str | None = None
    priority: Literal["P0", "P1", "P2", "P3"] | None = None


class ReplyCompleteRequest(_Camel):
    """完成评论回复请求（POST /tasks/{id}/complete）"""
    reply_content: str


class ReplyFailRequest(_Camel):
    """回复失败请求（POST /tasks/{id}/fail）

    reason 建议取值：评论已删除 / 视频已下架 / 评论定位失败 / 账号被限流 / 网络异常
    """
    reason: str


class CommentTaskRead(_Camel):
    """评论回复任务响应"""
    id: str
    lead_id: str
    comment_content: str
    video_title: str
    # v009：评论人 / 评论时间 / 视频 ID
    comment_author: str = ""
    comment_time: str = ""
    video_id: str = ""
    reply_content: str
    status: str
    account: str | None = None
    replied_at: datetime | None = None
    user_visited: bool = False
    user_dm: bool = False
    user_replied_comment: bool = False
    # v006：检测谁回复了我
    user_reply_content: str = ""
    replier_name: str = ""
    # v007：二级评论树（JSON 列表字符串）
    sub_replies: str = "[]"
    # v008：多级回复统计（由 sub_replies 运行时派生）
    reply_count: int = 0        # 对方回复总条数（sub_replies 长度）
    reply_people: int = 0       # 参与回复的去重人数
    reply_depth: int = 0        # 最深层级（max level，0=无回复）
    # 精准获客（v002）
    video_url: str = ""
    comment_id: str = ""
    reply_failure_reason: str = ""
    priority: str = "P2"
    # 话术归因（v004）
    reply_script_id: str | None = None
    reply_variant_id: str = ""
    # 创建时间：评论时间为空时，前端按它兜底排序（列表默认评论时间倒序）
    created_at: datetime | None = None
