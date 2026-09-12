"""今日跟进 · Schema 定义

严格对照 api-contract.md 第三节 3.2。
响应字段使用 camelCase（customerId / customerName）。
"""
from pydantic import BaseModel, ConfigDict, Field


class FollowUpCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    """新建跟进待办 · 关联客户而非线索"""
    customer_id: str | None = Field(validation_alias="customerId", default=None)
    customer_name: str = Field(validation_alias="customerName", default="")
    type: str = ""
    text: str = ""
    due: str = ""
    overdue: bool = False


class FollowUpComplete(BaseModel):
    """标记完成 · 可选备注"""
    note: str | None = None


class FollowUpRead(BaseModel):
    """跟进待办详情 · camelCase 输出"""
    model_config = ConfigDict(from_attributes=True)

    id: str
    customerId: str | None = Field(validation_alias="customer_id", default=None)
    customerName: str = Field(validation_alias="customer_name")
    type: str
    text: str
    due: str
    overdue: bool
    done: bool

class FollowUpDelay(BaseModel):
    """延期跟进 · 推迟 N 天，或显式指定新的截止时间"""
    model_config = ConfigDict(populate_by_name=True)
    days: int = Field(default=1, ge=1, le=60, description="向后推迟天数")
    due: str | None = Field(default=None, description="显式指定新的截止时间文本（覆盖 days）")


class FollowUpUpdate(BaseModel):
    """编辑跟进 · 修改内容/类型/截止时间/状态，均可选"""
    model_config = ConfigDict(populate_by_name=True)
    customer_name: str | None = Field(validation_alias="customerName", default=None)
    type: str | None = None
    text: str | None = None
    due: str | None = None
    done: bool | None = None
