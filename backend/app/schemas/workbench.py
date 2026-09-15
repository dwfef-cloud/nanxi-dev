from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    """统一 camelCase 别名：前端 camelCase 对象可直接透传，响应也返回 camelCase。"""
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


class ProductKnowledgeUpdate(_Camel):
    product_name: str = ""
    description: str = ""
    selling_points: str = ""
    target_customers: str = ""
    price_range: str = ""
    faq: str = ""
    forbidden_claims: str = ""
    service_process: str = ""
    case_studies: str = ""


class ProductKnowledgeRead(ProductKnowledgeUpdate):
    id: str
    updated_at: datetime
    is_primary: bool = True
    sort_order: int = 0
    created_at: datetime | None = None


class AudienceProfileUpdate(_Camel):
    name: str = ""
    industry: str = ""
    region: str = ""
    needs: str = ""
    pain_points: str = ""
    intent_keywords: str = ""
    excluded_keywords: str = ""
    excluded_customers: str = ""


class AudienceProfileRead(AudienceProfileUpdate):
    id: str
    updated_at: datetime
    is_primary: bool = True
    sort_order: int = 0
    created_at: datetime | None = None


class ScriptStrategyUpdate(_Camel):
    comment_script: str = ""
    private_message_script: str = ""
    wechat_script: str = ""
    objection_script: str = ""


class ScriptStrategyRead(ScriptStrategyUpdate):
    id: str
    updated_at: datetime


class WeChatSettingsUpdate(_Camel):
    wechat_id: str = ""
    guide_timing: str = "客户明确表达兴趣后"
    guide_reason: str = "发送详细方案和案例"
    compliance_note: str = ""
    offer_hook: str = ""


class WeChatSettingsRead(WeChatSettingsUpdate):
    id: str
    updated_at: datetime
    is_primary: bool = True
    sort_order: int = 0
    created_at: datetime | None = None
