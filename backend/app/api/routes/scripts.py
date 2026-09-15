"""话术库路由 · GET/POST /api/scripts, 变体管理, 模板列表"""
from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import get_script_service
from app.schemas.script import (
    CommentVariantPickRead, ScriptCreate, ScriptRead, ScriptTemplateRead, ScriptUpdate,
    VariantCreate, VariantRead, VariantUpdate,
)
from app.services.script_service import ScriptService

router = APIRouter(prefix="/scripts", tags=["scripts"])


@router.get("", response_model=list[ScriptRead], response_model_by_alias=True)
def list_scripts(
    category: str | None = None,
    service: ScriptService = Depends(get_script_service),
) -> list[ScriptRead]:
    """话术列表，支持 category 过滤"""
    return service.list_scripts(category=category)


@router.get("/templates", response_model=list[ScriptTemplateRead], response_model_by_alias=True)
def list_templates(
    service: ScriptService = Depends(get_script_service),
) -> list[ScriptTemplateRead]:
    """行业话术模板包"""
    return service.list_templates()


@router.post("/comment/pick", response_model=CommentVariantPickRead, response_model_by_alias=True)
def pick_comment_variant(
    service: ScriptService = Depends(get_script_service),
) -> CommentVariantPickRead:
    """按权重从「评论类」话术里挑一条变体，供评论回复自动取内容。

    权重取话术库的变体配置（如 40/35/25），让 A/B 流量分配真正生效；
    返回的 scriptId / variantId 需原样回传给 /api/comments/execute 以完成归因。
    """
    picked = service.pick_comment_variant()
    if picked is None:
        raise HTTPException(
            status_code=404,
            detail="没有可用的评论类话术：请先在话术库创建 category=comment、"
                   "且至少含一个 active 变体的话术",
        )
    script, variant = picked
    return CommentVariantPickRead(
        script_id=script.id,
        script_name=script.name,
        variant_id=variant.variant_id,
        variant_label=variant.variant_id,
        text=variant.text,
        weight=variant.weight,
    )


@router.post("", response_model=ScriptRead, response_model_by_alias=True)
def create_script(
    payload: ScriptCreate,
    service: ScriptService = Depends(get_script_service),
) -> ScriptRead:
    """新建话术"""
    return service.create_script(payload)


@router.patch("/{script_id}", response_model=ScriptRead, response_model_by_alias=True)
def update_script(
    script_id: str,
    payload: ScriptUpdate,
    service: ScriptService = Depends(get_script_service),
) -> ScriptRead:
    """P1-7: 更新话术（启用/禁用 active、改名 name、改分类 category）"""
    try:
        return service.update_script(script_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{script_id}/variants", response_model=VariantRead, response_model_by_alias=True)
def add_variant(
    script_id: str,
    payload: VariantCreate,
    service: ScriptService = Depends(get_script_service),
) -> VariantRead:
    """新增话术变体"""
    try:
        return service.add_variant(script_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.patch("/{script_id}/variants/{variant_id}", response_model=VariantRead, response_model_by_alias=True)
def update_variant(
    script_id: str,
    variant_id: str,
    payload: VariantUpdate,
    service: ScriptService = Depends(get_script_service),
) -> VariantRead:
    """更新变体（权重/状态/文本）。R2 命中时自动切换 switched_off"""
    try:
        return service.update_variant(script_id, variant_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{script_id}/variants/{variant_id}")
def delete_variant(
    script_id: str,
    variant_id: str,
    service: ScriptService = Depends(get_script_service),
) -> dict:
    """删除单个变体（A/B/C）。历史归因记录不清理。"""
    try:
        service.delete_variant(script_id, variant_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "deleted": variant_id}


@router.delete("/{script_id}")
def delete_script(
    script_id: str,
    service: ScriptService = Depends(get_script_service),
) -> dict:
    """删除整条话术（连带其全部变体）。历史归因记录不清理。"""
    try:
        service.delete_script(script_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "deleted": script_id}
