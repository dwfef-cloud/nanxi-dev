"""话术库 Schema · v1.0 契约对齐

响应字段使用 camelCase（与 api-contract.md 第二节一致）。
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


# ═══════════════════════════════════════════════════════════
# 话术变体
# ═══════════════════════════════════════════════════════════

class VariantCreate(_Camel):
    """新增变体请求"""
    variant_id: str = Field(description="变体标识，如 A/B/C")
    text: str
    weight: int = 50
    status: str = "active"  # active / switched_off / draft


class VariantUpdate(_Camel):
    """更新变体请求（权重/状态/文本）"""
    text: str | None = None
    weight: int | None = None
    status: str | None = None  # active / switched_off / draft


class VariantRead(_Camel):
    """变体响应 · id 字段映射 domain.variant_id（A/B/C）"""
    variant_id: str = Field(alias="id")
    text: str
    weight: int
    status: str
    sent: int = 0
    replied: int = 0
    wechat_added: int | None = None
    conv_rate: float | None = None
    sample_enough: bool = False


# ═══════════════════════════════════════════════════════════
# 话术
# ═══════════════════════════════════════════════════════════

class ScriptCreate(_Camel):
    """新建话术请求"""
    name: str
    industry: str = "通用"
    category: Literal["comment", "private_message", "wechat_guide", "objection", "nurture"] = "private_message"
    is_main: bool = False
    active: bool = True
    intro: str = ""
    welcome_msg: str = ""


class ScriptUpdate(_Camel):
    """更新话术（启用/禁用、改名、改分类）"""
    name: str | None = None
    category: Literal["comment", "private_message", "wechat_guide", "objection", "nurture"] | None = None
    active: bool | None = None


class ScriptRead(_Camel):
    """话术响应 · 含变体列表"""
    id: str
    name: str
    industry: str
    category: str
    is_main: bool
    active: bool
    intro: str
    welcome_msg: str
    variants: list[VariantRead] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════════
# 行业模板包
# ═══════════════════════════════════════════════════════════

class ScriptTemplateRead(_Camel):
    industry: str
    count: int
    desc: str
    installed: bool


# ═══════════════════════════════════════════════════════════
# 评论回复取内容 · 按权重挑选
# ═══════════════════════════════════════════════════════════

class CommentVariantPickRead(_Camel):
    """按权重挑出的一条评论回复内容。

    scriptId / variantId 要原样回传给 POST /api/comments/execute，
    发送成功后据此回写话术使用记录与变体发送数。
    """
    script_id: str
    script_name: str
    variant_id: str
    variant_label: str = Field("", description="变体标识，如 A/B/C")
    text: str
    weight: int = 0
