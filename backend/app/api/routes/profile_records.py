"""画像记录集接口：业务画像 / 产品知识库 / 目标客户 / 微信转化 的「多条记录 + 主记录」。

- GET    /api/workbench/records/{card}                   列表（主记录排最前）
- POST   /api/workbench/records/{card}                   新增一条（新记录默认成为主记录）
- PUT    /api/workbench/records/{card}/{rid}             更新指定一条
- DELETE /api/workbench/records/{card}/{rid}             删除指定一条（删主记录会自动补主）
- POST   /api/workbench/records/{card}/{rid}/primary     设为唯一主记录

兼容：旧的单数端点（GET/PUT /api/workbench/product 等）保持不变，
仓储的 get_xxx() 返回主记录，onboarding / AI 生成 / 话术变量无需任何改动。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.dependencies import get_repository
from app.models.domain import (
    AudienceProfile,
    BusinessProfile,
    ProductKnowledge,
    WeChatSettings,
)
from app.repositories.base import Repository
from app.schemas.business import BusinessProfileRead, BusinessProfileUpdate
from app.schemas.workbench import (
    AudienceProfileRead,
    AudienceProfileUpdate,
    ProductKnowledgeRead,
    ProductKnowledgeUpdate,
    WeChatSettingsRead,
    WeChatSettingsUpdate,
)

router = APIRouter(prefix="/workbench", tags=["profile-records"])

# card → 该卡片的模型 / 入参 schema / 读 schema / 仓储方法
CARDS: dict[str, dict[str, Any]] = {
    "business": {
        "label": "业务画像",
        "model": BusinessProfile,
        "update": BusinessProfileUpdate,
        "read": BusinessProfileRead,
        "list": lambda repo: repo.list_business_profiles(),
        "get": lambda repo, rid: repo.get_business_profile_by_id(rid),
        "save": lambda repo, obj: repo.save_business_profile(obj),
        "delete": lambda repo, rid: repo.delete_business_profile(rid),
        "set_primary": lambda repo, rid: repo.set_primary_business_profile(rid),
    },
    "product": {
        "label": "产品知识库",
        "model": ProductKnowledge,
        "update": ProductKnowledgeUpdate,
        "read": ProductKnowledgeRead,
        "list": lambda repo: repo.list_product_knowledge(),
        "get": lambda repo, rid: repo.get_product_knowledge_by_id(rid),
        "save": lambda repo, obj: repo.save_product_knowledge(obj),
        "delete": lambda repo, rid: repo.delete_product_knowledge(rid),
        "set_primary": lambda repo, rid: repo.set_primary_product_knowledge(rid),
    },
    "audience": {
        "label": "目标客户",
        "model": AudienceProfile,
        "update": AudienceProfileUpdate,
        "read": AudienceProfileRead,
        "list": lambda repo: repo.list_audience_profiles(),
        "get": lambda repo, rid: repo.get_audience_profile_by_id(rid),
        "save": lambda repo, obj: repo.save_audience_profile(obj),
        "delete": lambda repo, rid: repo.delete_audience_profile(rid),
        "set_primary": lambda repo, rid: repo.set_primary_audience_profile(rid),
    },
    "wechat": {
        "label": "微信转化",
        "model": WeChatSettings,
        "update": WeChatSettingsUpdate,
        "read": WeChatSettingsRead,
        "list": lambda repo: repo.list_wechat_settings(),
        "get": lambda repo, rid: repo.get_wechat_settings_by_id(rid),
        "save": lambda repo, obj: repo.save_wechat_settings(obj),
        "delete": lambda repo, rid: repo.delete_wechat_settings(rid),
        "set_primary": lambda repo, rid: repo.set_primary_wechat_settings(rid),
    },
}


def _cfg(card: str) -> dict[str, Any]:
    cfg = CARDS.get(card)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"未知卡片：{card}")
    return cfg


def _dump(cfg: dict[str, Any], obj: Any) -> dict:
    """dataclass → camelCase dict（与旧单数端点响应结构一致）"""
    return cfg["read"].model_validate(obj).model_dump(by_alias=True, mode="json")


def _new_id() -> str:
    return uuid4().hex[:12]


@router.get("/records/{card}")
def list_records(card: str, repo: Repository = Depends(get_repository)) -> dict:
    cfg = _cfg(card)
    items = cfg["list"](repo)
    return {
        "card": card,
        "label": cfg["label"],
        "items": [_dump(cfg, it) for it in items],
        "primaryId": next((it.id for it in items if it.is_primary), None),
        "total": len(items),
    }


@router.post("/records/{card}")
def create_record(
    card: str,
    payload: Any = Body(default_factory=dict),
    repo: Repository = Depends(get_repository),
) -> dict:
    cfg = _cfg(card)
    data = cfg["update"].model_validate(payload or {})
    now = datetime.now(timezone.utc)
    # 新记录直接成为主记录：最新填写的那条通常就是当前主推的
    obj = cfg["model"](
        **data.model_dump(),
        id=_new_id(),
        is_primary=True,
        sort_order=0,
        created_at=now,
        updated_at=now,
    )
    cfg["save"](repo, obj)
    cfg["set_primary"](repo, obj.id)
    return _dump(cfg, obj)


@router.put("/records/{card}/{record_id}")
def update_record(
    card: str,
    record_id: str,
    payload: Any = Body(default_factory=dict),
    repo: Repository = Depends(get_repository),
) -> dict:
    cfg = _cfg(card)
    existing = cfg["get"](repo, record_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="记录不存在")

    data = cfg["update"].model_validate(payload or {})
    now = datetime.now(timezone.utc)
    # 逐字段覆盖，保留该条原有的 id / 主记录标记 / 创建时间
    for field, value in data.model_dump().items():
        setattr(existing, field, value)
    existing.updated_at = now
    cfg["save"](repo, existing)
    return _dump(cfg, existing)


@router.delete("/records/{card}/{record_id}")
def delete_record(
    card: str,
    record_id: str,
    repo: Repository = Depends(get_repository),
) -> dict:
    cfg = _cfg(card)
    if cfg["get"](repo, record_id) is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    cfg["delete"](repo, record_id)
    remaining = cfg["list"](repo)
    return {
        "ok": True,
        "deleted": record_id,
        "primaryId": next((it.id for it in remaining if it.is_primary), None),
        "total": len(remaining),
    }


@router.post("/records/{card}/{record_id}/primary")
def set_primary(
    card: str,
    record_id: str,
    repo: Repository = Depends(get_repository),
) -> dict:
    cfg = _cfg(card)
    if cfg["get"](repo, record_id) is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    cfg["set_primary"](repo, record_id)
    return {"ok": True, "primaryId": record_id}
