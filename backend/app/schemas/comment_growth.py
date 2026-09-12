"""数据脱敏 + 风险聚合 Schema（P2）
====================================
对外 JSON 契约与前端/调用方严格对齐：
  - replacements 里的键为 `from`（Python 保留字），用 alias 显式声明
  - 其余字段用 camelCase 别名生成（与项目其它 schema 一致）
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
# 脱敏
# ═══════════════════════════════════════════════════════

class DesensitizeRequest(BaseModel):
    """POST /comments/desensitize 请求体"""
    text: str


class ReplacementRead(BaseModel):
    """单条替换映射（from 为 Python 保留字，需 by_alias 序列化）"""
    model_config = ConfigDict(populate_by_name=True)

    type: str
    from_value: str = Field(alias="from")
    to: str


class DesensitizeResponse(BaseModel):
    """脱敏结果"""
    original: str
    desensitized: str
    replacements: list[ReplacementRead] = Field(default_factory=list)
    count: int = 0


class DesensitizeBatchRequest(BaseModel):
    """POST /comments/desensitize/batch 请求体"""
    limit: int = 200
    dry_run: bool = True


class BatchChangeRead(BaseModel):
    """单字段前后对比"""
    field: str
    count: int
    before: str
    after: str


class BatchSampleRead(BaseModel):
    """单条 lead 的脱敏样例"""
    lead_id: str | None = None
    changes: list[BatchChangeRead] = Field(default_factory=list)


class DesensitizeBatchResponse(BaseModel):
    """存量清洗结果（dry_run=true 时只返回样例，不落库）"""
    scanned: int = 0
    changed: int = 0
    dry_run: bool = True
    samples: list[BatchSampleRead] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════
# 风险聚合
# ═══════════════════════════════════════════════════════

class RiskClusterRead(BaseModel):
    topic: str
    count: int
    sample_comments: list[str] = Field(default_factory=list)
    samples_desensitized: bool = True


class RiskItemRead(BaseModel):
    lead_id: str | None = None
    comment: str = ""
    reason: str = ""


class RiskSummaryResponse(BaseModel):
    level: Literal["none", "L1", "L2", "L3"]
    negative_count: int = 0
    clusters: list[RiskClusterRead] = Field(default_factory=list)
    l1_items: list[RiskItemRead] = Field(default_factory=list)
    advice: str = ""
    notice: str = ""
    official_escalation_required: bool = False
