from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


class BusinessProfileUpdate(_Camel):
    industry: str = ""
    product: str = ""
    service_area: str = ""
    target_customer: str = ""
    price_range: str = ""
    conversion_goal: str = "添加微信"
    tone: str = "专业、真诚"
    self_intro: str = ""


class BusinessProfileRead(BusinessProfileUpdate):
    id: str
    updated_at: datetime
    is_primary: bool = True
    sort_order: int = 0
    created_at: datetime | None = None
