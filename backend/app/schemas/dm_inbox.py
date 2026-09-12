"""私信收件箱 Schema · 评论引流策略转化闭环

收件箱用于承接用户主动私信，支持查看会话、回复、标记加微转客户。
状态值：new（新会话未回复）/ replied（已回复）/ wechat_added（已加微）/ closed（已关闭）

P3-1: 统一 camelCase 输出，同时接受 snake_case/camelCase 输入。
前端 api-dm-inbox.js 的 _normalize() 会将 snake→camel，对 camelCase 输出幂等。
"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


# ═══════════════════════════════════════════════════════════
# 请求体
# ═══════════════════════════════════════════════════════════

class ReplyRequest(_Camel):
    """发送回复请求体"""
    content: str
    script_id: str | None = None


class MarkWechatRequest(_Camel):
    """标记加微转客户请求体"""
    wechat_id: str
    customer_name: str | None = None
    phone: str | None = None


class SimulateRequest(_Camel):
    """模拟接收私信（开发测试用）"""
    nickname: str
    content: str
    lead_id: str | None = None


# ═══════════════════════════════════════════════════════════
# 响应体
# ═══════════════════════════════════════════════════════════

class InboxMessageItem(_Camel):
    """收件箱消息项"""
    id: str
    direction: str          # in=用户发 / out=我们发
    sender: str             # ai / human / user / system
    content: str
    is_read: bool = False
    script_id: str | None = None
    created_at: datetime


class InboxConversationItem(_Camel):
    """收件箱会话列表项"""
    id: str
    lead_id: str | None = None
    customer_id: str | None = None
    nickname: str
    avatar_hue: int = 200
    last_message: str = ""
    last_message_at: datetime
    unread_count: int = 0
    status: str             # new / replied / wechat_added / closed


class InboxConversationDetail(_Camel):
    """收件箱会话详情"""
    id: str
    lead_id: str | None = None
    customer_id: str | None = None
    nickname: str
    avatar_hue: int = 200
    status: str
    messages: list[InboxMessageItem]


class MarkWechatResponse(_Camel):
    """标记加微响应"""
    ok: bool
    conversation_id: str
    customer_id: str
    lead_id: str | None = None


class SimulateResponse(_Camel):
    """模拟接收私信响应"""
    ok: bool
    conversation_id: str
    message_id: str
    lead_id: str
