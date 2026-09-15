"""资料文件导入（P3）：解析产品资料 → AI 抽取结构化画像 → 确认写入。

两步走（AI 不可全信，必须人工过目）：
  1. POST /api/materials/import  (multipart file) → 解析 + AI 抽取（dry run，不写库）→ extracted
  2. POST /api/materials/apply   (JSON extracted)  → upsert 画像 + 草稿话术
"""
from __future__ import annotations

import json

import base64
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.core.dependencies import get_ai_service, get_repository, get_script_service
from app.repositories.base import Repository
from app.schemas.script import ScriptCreate, VariantCreate
from app.services.ai_service import AIService
from app.services.material_parser import extract_text
from app.services.script_service import ScriptService

router = APIRouter(prefix="/materials", tags=["materials"])

MAX_BYTES = 10 * 1024 * 1024

EXTRACT_PROMPT = """你是抖音获客系统的资料录入助手。下面是一份产品/业务资料文本。
请从中抽取结构化信息，只返回 JSON（不要 Markdown 代码块），字段如下：
{
  "business": { "industry":"行业", "product":"主营产品", "serviceArea":"服务区域", "targetCustomer":"目标客户", "priceRange":"价格区间", "conversionGoal":"转化目标" },
  "product": { "productName":"产品名", "description":"一句话介绍", "sellingPoints":"核心卖点(用换行分隔的多条)", "targetCustomers":"适用客户", "priceRange":"价格", "faq":"常见问答", "forbiddenClaims":"禁用夸大宣传词" },
  "audience": { "name":"客户画像名", "industry":"行业", "region":"地区", "needs":"意向需求(逗号分隔)", "painPoints":"痛点(换行分隔)", "intentKeywords":"意向关键词(逗号分隔)", "excludedKeywords":"排除词(逗号分隔)" },
  "scriptHints": { "comment":"评论区首触话术建议(1-2句)", "private_message":"私信开场建议(1-2句)", "wechat_guide":"加微引导建议(1-2句)", "objection":"异议应对建议(1-2句)" }
}
若某字段资料里没有，填空字符串。scriptHints 是给话术库的起草提示，不是完整话术。"""

_SCRIPT_CAT_LABELS = {
    "comment": "评论区首次触达",
    "private_message": "私信开场",
    "wechat_guide": "加微引导",
    "objection": "异议应对",
}


class ApplyPayload(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    business: dict = {}
    product: dict = {}
    audience: dict = {}
    script_hints: dict = {}
    make_draft_scripts: bool = True


class ImportPayload(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    filename: str = "file.txt"
    content: str = ""  # base64 编码的文件内容（避免依赖 python-multipart）


@router.post("/import")
async def import_material(
    payload: ImportPayload,
    ai: AIService = Depends(get_ai_service),
):
    try:
        data = base64.b64decode(payload.content or "")
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="content 不是合法 base64")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 10MB 限制")
    text, warn = extract_text(payload.filename or "file.txt", data)
    if not text:
        raise HTTPException(status_code=422, detail=warn or "无法从文件提取文本")
    try:
        content = ai._call_llm(
            EXTRACT_PROMPT + "\n\n【资料文本】\n" + text,
            system="你是严谨的资料录入助手，输出严格 JSON。",
            timeout=60,
        )
        extracted = ai._extract_json(content)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"AI 抽取失败：{e}")
    extracted = extracted if isinstance(extracted, dict) else {}
    extracted.setdefault("business", {})
    extracted.setdefault("product", {})
    extracted.setdefault("audience", {})
    extracted.setdefault("scriptHints", extracted.get("scriptHints") or {})
    return {"filename": payload.filename, "textLen": len(text), "warn": warn, "extracted": extracted}


def _snake_keys(d: dict) -> dict:
    """AI 抽取的键是 camelCase（serviceArea），画像模型属性是 snake_case（service_area），
    归一化后才能用 hasattr 命中。"""
    if not isinstance(d, dict):
        return {}
    return {re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower(): v for k, v in d.items()}


@router.post("/apply")
async def apply_material(
    payload: ApplyPayload,
    repo: Repository = Depends(get_repository),
    scripts: ScriptService = Depends(get_script_service),
):
    biz = _snake_keys(payload.business or {})
    prod = _snake_keys(payload.product or {})
    aud = _snake_keys(payload.audience or {})
    hints = payload.script_hints or {}
    applied = {"business": False, "product": False, "audience": False, "scripts": []}

    # ── upsert 画像（合并到 default 单例，仅非空字段覆盖）──
    if any(str(v).strip() for v in biz.values()):
        p = repo.get_business_profile()
        for k, v in biz.items():
            if str(v or "").strip() and hasattr(p, k):
                setattr(p, k, str(v).strip())
        repo.save_business_profile(p)
        applied["business"] = True
    if any(str(v).strip() for v in prod.values()):
        p = repo.get_product_knowledge()
        for k, v in prod.items():
            if str(v or "").strip() and hasattr(p, k):
                setattr(p, k, str(v).strip())
        repo.save_product_knowledge(p)
        applied["product"] = True
    if any(str(v).strip() for v in aud.values()):
        p = repo.get_audience_profile()
        for k, v in aud.items():
            if str(v or "").strip() and hasattr(p, k):
                setattr(p, k, str(v).strip())
        repo.save_audience_profile(p)
        applied["audience"] = True

    # ── 草稿话术（source=imported，active=False 不自动参与发送/AB）──
    if payload.make_draft_scripts:
        for cat, label in _SCRIPT_CAT_LABELS.items():
            hint = (hints.get(cat) or "").strip()
            if not hint:
                continue
            name = f"导入草稿 · {label}"
            created = scripts.create_script(
                ScriptCreate(
                    name=name,
                    category=cat,
                    industry=(biz.get("industry") or "通用"),
                    intro="由资料文件导入（草稿，确认后启用）",
                    active=False,
                    source="imported",
                )
            )
            scripts.add_variant(
                created.id,
                VariantCreate(variant_id="A", text=hint, status="draft", weight=100),
            )
            applied["scripts"].append({"id": created.id, "name": name, "category": cat})

    return {"applied": applied}
