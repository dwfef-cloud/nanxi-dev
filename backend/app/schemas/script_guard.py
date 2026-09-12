"""话术质检 Schema · 两层质检（敏感词 / 话术套路）契约对齐

注意：GuardCheckResponse 的 JSON 键与前端契约严格对齐（pass / block_count / hits …），
故不使用驼峰别名生成，仅对 Python 保留字 `pass` 显式声明 alias。
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


# ═══════════════════════════════════════════════════════
# 质检结果
# ═══════════════════════════════════════════════════════

class GuardCheckRequest(BaseModel):
    """POST /comments/guard-check 请求体"""
    content: str
    account: str | None = None


class GuardHit(BaseModel):
    """单条命中的质检项（layer=sensitive_word 时 rule_code 为 null）"""
    layer: Literal["sensitive_word", "script_pattern"]
    rule_code: str | None = None
    category: str
    severity: Literal["block", "warn"]
    matched: str
    advice: str | None = None


class GuardCheckResponse(BaseModel):
    """质检结果

    pass=False 表示存在 block 级命中，禁止直接发送。
    """

    model_config = ConfigDict(populate_by_name=True)

    passed: bool = Field(default=True, alias="pass")
    block_count: int = 0
    warn_count: int = 0
    hits: list[GuardHit] = Field(default_factory=list)
    sanitized: str = ""
    sensitive_check_available: bool = True
    sensitive_check_error: str | None = None
    notice: str = ""


# ═══════════════════════════════════════════════════════
# 规则 CRUD
# ═══════════════════════════════════════════════════════

class GuardRuleCreate(_Camel):
    """新建质检规则"""
    rule_code: str
    category: str
    pattern: str
    severity: Literal["block", "warn"] = "warn"
    advice: str | None = None
    source: str | None = None
    enabled: bool = True


class GuardRuleUpdate(_Camel):
    """局部更新/启停质检规则"""
    rule_code: str | None = None
    category: str | None = None
    pattern: str | None = None
    severity: Literal["block", "warn"] | None = None
    advice: str | None = None
    source: str | None = None
    enabled: bool | None = None


class GuardRuleRead(_Camel):
    """质检规则响应"""
    id: int
    rule_code: str = ""
    category: str = ""
    pattern: str = ""
    severity: str = "warn"
    advice: str | None = None
    source: str | None = None
    enabled: bool = True
    created_at: str | None = None
    updated_at: str | None = None
