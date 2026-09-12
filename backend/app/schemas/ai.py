from typing import Literal

from pydantic import BaseModel, Field


# ═══════════════════════════════════════════════════════════
# 现有：设置 / 业务画像分析 / 草稿（保留兼容）
# ═══════════════════════════════════════════════════════════

class DraftRequest(BaseModel):
    lead_nickname: str
    source_keyword: str
    user_note: str = ""


class DraftResponse(BaseModel):
    drafts: list[str]


class ProfileAnalysisRequest(BaseModel):
    product: str
    industry: str = ""
    region: str = ""
    target_customer: str = ""
    selling_points: str = ""


class ProfileAnalysisResponse(BaseModel):
    needs: list[str]
    pain_points: list[str]
    search_keywords: list[str]
    intent_keywords: list[str]
    excluded_keywords: list[str]
    customer_language: list[str] = []


class AISettingsUpdate(BaseModel):
    # P2-8: provider must be one of the supported values; invalid → 422 at request validation
    provider: Literal["doubao", "dashscope"] | None = None
    api_key: str | None = None
    model: str | None = None


class AISettingsRead(BaseModel):
    provider: str
    configured: bool
    masked_key: str
    model: str


# ═══════════════════════════════════════════════════════════
# 新增：线索画像分析 POST /api/ai/analyze
# ═══════════════════════════════════════════════════════════

class AnalyzeRequest(BaseModel):
    nickname: str = ""
    comment: str = ""
    video_title: str = ""
    source_keyword: str = ""


class AnalyzeResponse(BaseModel):
    intent_level: Literal["A", "B", "C"] = "C"
    customer_need: str = ""
    tags: list[str] = Field(default_factory=list)
    recommended_script_category: Literal[
        "comment", "private_message", "wechat_guide", "objection", "nurture"
    ] = "private_message"
    follow_up_suggestion: str = ""
    raw_reasoning: str = ""


# ═══════════════════════════════════════════════════════════
# 新增：智能草稿 POST /api/ai/draft
# ═══════════════════════════════════════════════════════════

DraftStyle = Literal["formal", "casual", "short"]


class SmartDraftRequest(BaseModel):
    lead_id: str
    script_category: Literal[
        "comment", "private_message", "wechat_guide", "objection", "nurture"
    ] = "private_message"
    user_comment: str = ""
    style: DraftStyle = "casual"


class SmartDraftResponse(BaseModel):
    draft: str
    style: DraftStyle
    lead_nickname: str = ""


# ═══════════════════════════════════════════════════════════
# 新增：评论回复建议 POST /api/ai/comment-suggestion
# ═══════════════════════════════════════════════════════════

CommentScenario = Literal["auto", "praise", "inquiry", "complaint", "objection"]
CommentIndustry = Literal[
    "ecommerce", "knowledge", "local", "saas", "media", "home_decoration", "other"
]


class CommentSuggestionRequest(BaseModel):
    comment: str
    video_title: str = ""
    source_keyword: str = ""
    # 新增（可选，默认值保证老调用不受影响）
    scenario: CommentScenario = "auto"
    industry: CommentIndustry = "other"


class CommentSuggestionItem(BaseModel):
    type: Literal["hook", "value", "question", "empathy", "solution", "private"]
    label: str
    content: str


class CommentSuggestionResponse(BaseModel):
    suggestions: list[CommentSuggestionItem]


# ═══════════════════════════════════════════════════════════
# 新增：评论语义四维分级 POST /api/ai/comment-insight
# ═══════════════════════════════════════════════════════════

class CommentInsightRequest(BaseModel):
    comment: str
    video_title: str = ""
    source_keyword: str = ""


class CommentInsightResponse(BaseModel):
    category: Literal["inquiry", "solution", "pain", "identity", "other"] = "other"
    intent_level: Literal["A", "B", "C"] = "C"
    sentiment: Literal["positive", "neutral", "negative"] = "neutral"
    reply_type: Literal["inquiry", "praise", "complaint", "objection", "other"] = "other"
    reason: str = ""
    # 映射到 leads 表的字段，便于回写
    lead_intent: Literal["high", "mid", "low"] = "low"
    lead_intent_level: Literal["A", "B", "C"] = "C"


class CommentInsightItem(BaseModel):
    lead_id: str
    comment: str = ""
    video_title: str = ""
    source_keyword: str = ""


class CommentInsightBatchRequest(BaseModel):
    items: list[CommentInsightItem] = Field(default_factory=list)


class CommentInsightBatchResult(BaseModel):
    lead_id: str
    success: bool = False
    insight: CommentInsightResponse | None = None
    error: str = ""


class CommentInsightBatchResponse(BaseModel):
    results: list[CommentInsightBatchResult] = Field(default_factory=list)
    updated: int = 0
    failed: int = 0
    truncated: bool = False
