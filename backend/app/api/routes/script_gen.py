"""按业务画像 AI 生成话术（替代前端死模板 buildSceneScripts）。

三个端点：
- POST /api/scripts/generate-preview  仅 AI 计算，不写库（用于 P2 刷新差异预览）
- POST /api/scripts/generate           调 AI + 落库（source='generated'，带 generatedFrom 快照）
- POST /api/scripts/{id}/optimize      单条话术的 AI 优化/扩写：只喂用户勾选的那几个画像变量
"""
from datetime import datetime, timezone
from typing import Any
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.dependencies import get_ai_service, get_repository, get_script_service
from app.repositories.base import Repository
from app.schemas.script import ScriptCreate, ScriptUpdate, VariantCreate, VariantUpdate
from app.services.ai_service import AIService
from app.services.script_service import ScriptService

router = APIRouter(prefix="/scripts", tags=["scripts"])

SCENES = ["comment", "welcome", "private_message", "wechat_guide", "objection"]
SCENE_NAMES = {
    "comment": "评论区首次触达",
    "welcome": "欢迎语首句",
    "private_message": "私信开场",
    "wechat_guide": "加微引导",
    "objection": "异议应对",
}
_VARIANT_WEIGHTS = [100, 70, 50]

GEN_SYSTEM = (
    "你是抖音私域获客的资深话术策划。语言口语、真诚、不夸大、不承诺效果，"
    "像真人客服在聊天，不要营销腔。每条控制在 40 字内，可直接发送。"
)

GEN_PROMPT = """根据下面的业务画像，为 5 类场景各写 1~3 条话术变体（用于 A/B）。
严格只输出 JSON，结构如下（键名固定，不要改）：
{
  "comment": ["..."],
  "welcome": ["..."],
  "private_message": ["..."],
  "wechat_guide": ["..."],
  "objection": ["..."]
}
要求：
- comment：在别人的评论区公开回复，自然引出价值、引导对方回 1/私信，不硬广。
- welcome：用户进私信后第一句，让对方开口说需求。
- private_message：私信开场，承接评论里的兴趣点。
- wechat_guide：引导加微信，理由具体（发资料/方案/案例），不骚扰。
- objection：对方说「太贵了 / 再考虑 / 先看看」时的软化应对。
- 把画像里的产品、行业、区域、痛点、需求自然融进去，但不要堆砌。
- 把自我介绍、服务流程、成功案例、优惠钩子自然融进话术；对方属于「不接的客户」那类时不要引导加微。
- 不要出现微信号明文（加微引导里用「我发你」「加我微信」即可）。

【业务画像】
"""


def _split_lines(s: str) -> list[str]:
    return [x.strip() for x in (s or "").replace("\\r", "\\n").split("\\n") if x.strip()]


def _split_comma(s: str) -> list[str]:
    return [x.strip() for x in (s or "").replace("，", ",").split(",") if x.strip()]


def _snapshot(biz: Any, prod: Any, aud: Any) -> str:
    """与前端 profileKeySnapshot 的键保持一致，供 P2 刷新比对。"""
    return json.dumps(
        {
            "industry": getattr(biz, "industry", "") or "",
            "product": getattr(prod, "product_name", "") or "",
            "area": getattr(biz, "service_area", "") or "",
            "goal": getattr(biz, "conversion_goal", "") or "",
            "selling": " / ".join(_split_lines(getattr(prod, "selling_points", ""))),
            "pain": " / ".join(_split_lines(getattr(aud, "pain_points", ""))),
            "need": " / ".join(_split_comma(getattr(aud, "intent_keywords", ""))),
        },
        ensure_ascii=False,
    )


def _context(biz: Any, prod: Any, aud: Any, wx: Any) -> str:
    lines = [
        f"行业：{getattr(biz, 'industry', '') or '（未填）'}",
        f"产品：{getattr(prod, 'product_name', '') or '（未填）'}",
        f"产品简介：{getattr(prod, 'description', '') or '（未填）'}",
        f"核心卖点：{getattr(prod, 'selling_points', '') or '（未填）'}",
        f"价格：{getattr(prod, 'price_range', '') or '（未填）'}",
        f"服务区域：{getattr(biz, 'service_area', '') or '（未填）'}",
        f"目标客户：{getattr(biz, 'target_customer', '') or '（未填）'}",
        f"转化目标：{getattr(biz, 'conversion_goal', '') or '（未填）'}",
        f"语气：{getattr(biz, 'tone', '') or '（未填）'}",
        f"客户群：{getattr(aud, 'name', '') or '（未填）'}",
        f"需求：{getattr(aud, 'needs', '') or '（未填）'}",
        f"痛点：{getattr(aud, 'pain_points', '') or '（未填）'}",
        f"意向关键词：{getattr(aud, 'intent_keywords', '') or '（未填）'}",
        f"加微时机：{getattr(wx, 'guide_timing', '') or '（未填）'}",
        f"加微理由：{getattr(wx, 'guide_reason', '') or '（未填）'}",
        f"禁用词：{getattr(prod, 'forbidden_claims', '') or '（无）'}",
        f"自我介绍：{getattr(biz, 'self_intro', '') or '（未填）'}",
        f"服务流程与周期：{getattr(prod, 'service_process', '') or '（未填）'}",
        f"成功案例：{getattr(prod, 'case_studies', '') or '（未填）'}",
        f"不接的客户：{getattr(aud, 'excluded_customers', '') or '（未填）'}",
        f"优惠钩子：{getattr(wx, 'offer_hook', '') or '（未填）'}",
    ]
    return GEN_PROMPT + "\\n".join(lines)


def _ai_scenes(ai: AIService, ctx: str, timeout: int) -> dict:
    try:
        content = ai._call_llm(ctx, system=GEN_SYSTEM, timeout=timeout)
        data = ai._extract_json(content)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"AI 生成失败：{e}")
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="AI 返回结构异常")
    scenes: dict[str, list[str]] = {}
    for sc in SCENES:
        val = data.get(sc)
        if isinstance(val, str):
            val = [val]
        if isinstance(val, list):
            scenes[sc] = [str(x).strip() for x in val if str(x).strip()][:3]
        else:
            scenes[sc] = []
    return scenes


def _profiles(repo: Repository):
    return (
        repo.get_business_profile(),
        repo.get_product_knowledge(),
        repo.get_audience_profile(),
        repo.get_wechat_settings(),
    )


@router.post("/generate-preview")
def generate_preview(
    repo: Repository = Depends(get_repository),
    ai: AIService = Depends(get_ai_service),
) -> dict:
    biz, prod, aud, wx = _profiles(repo)
    scenes = _ai_scenes(ai, _context(biz, prod, aud, wx), timeout=120)
    return {"scenes": scenes, "snapshot": _snapshot(biz, prod, aud)}


@router.post("/generate")
def generate(
    repo: Repository = Depends(get_repository),
    scripts: ScriptService = Depends(get_script_service),
    ai: AIService = Depends(get_ai_service),
) -> dict:
    biz, prod, aud, wx = _profiles(repo)
    scenes = _ai_scenes(ai, _context(biz, prod, aud, wx), timeout=120)
    snapshot = _snapshot(biz, prod, aud)
    created_ids: dict[str, str] = {}

    for sc in SCENES:
        texts = scenes.get(sc) or []
        if not texts:
            continue
        # 找该分类下已有的 generated 话术（刷新语义：原地替换变体，不重复建）
        existing = [s for s in scripts.list_scripts(category=sc)
                    if (s.source or "manual") == "generated"]
        if existing:
            sid = existing[0].id
            cur = scripts.get_script(sid)
            cur_ids = [v.variant_id for v in cur.variants]
            want_ids = [chr(65 + i) for i in range(len(texts))]
            for i, t in enumerate(texts):
                vid = want_ids[i]
                if vid in cur_ids:
                    scripts.update_variant(sid, vid, VariantUpdate(text=t))
                else:
                    scripts.add_variant(sid, VariantCreate(variant_id=vid, text=t, weight=_VARIANT_WEIGHTS[i], status="active"))
            for vid in cur_ids:
                if vid not in want_ids:
                    scripts.update_variant(sid, vid, VariantUpdate(status="switched_off"))
        else:
            created = scripts.create_script(ScriptCreate(
                name=f"{SCENE_NAMES[sc]} · {getattr(biz, 'industry', '') or '通用'}",
                category=sc,  # type: ignore[arg-type]
                industry=getattr(biz, "industry", "") or "通用",
                active=True,
                source="generated",
                generated_from=snapshot,
                intro=f"由 AI 按业务画像生成（{len(texts)} 个变体）",
            ))
            sid = created.id
            for i, t in enumerate(texts):
                scripts.add_variant(sid, VariantCreate(variant_id=chr(65 + i), text=t, weight=_VARIANT_WEIGHTS[i], status="active"))
        scripts.update_script(sid, ScriptUpdate(source="generated", generated_from=snapshot))
        created_ids[sc] = sid

    return {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scenes": {sc: len(scenes.get(sc, [])) for sc in SCENES},
        "scriptIds": created_ids,
    }


# ═══════════════════════════════════════════
# 单条话术的 AI 优化：只喂用户勾选的那几个变量
# ═══════════════════════════════════════════

"""变量 → 画像字段。键必须与前端 app.js 的 SCRIPT_VARS[].key 完全一致，
否则用户勾选的变量在后端取不到值。新增画像字段时两处一起加。"""
VAR_FIELDS: dict[str, tuple[str, str]] = {
    "行业": ("business", "industry"),
    "产品": ("product", "product_name"),
    "区域": ("business", "service_area"),
    "客户类型": ("business", "target_customer"),
    "价格": ("product", "price_range"),
    "目标": ("business", "conversion_goal"),
    "语气": ("business", "tone"),
    "人设": ("business", "self_intro"),
    "服务流程": ("product", "service_process"),
    "成功案例": ("product", "case_studies"),
    "不接客户": ("audience", "excluded_customers"),
    "优惠": ("wechat", "offer_hook"),
    "简介": ("product", "description"),
    "卖点": ("product", "selling_points"),
    "客户特点": ("business", "target_customer"),
    "常见问题": ("product", "faq"),
    "客户群": ("audience", "name"),
    "客户行业": ("audience", "industry"),
    "客户区域": ("audience", "region"),
    "需求": ("audience", "needs"),
    "意向词": ("audience", "intent_keywords"),
    "痛点": ("audience", "pain_points"),
    "排除词": ("audience", "excluded_keywords"),
    "微信号": ("wechat", "wechat_id"),
    "引导时机": ("wechat", "guide_timing"),
    "引导理由": ("wechat", "guide_reason"),
}

OPT_SCENE_REQ = {
    "comment": "在别人的评论区公开回复，自然引出价值、引导对方回 1 / 私信，不硬广。",
    "welcome": "用户进私信后第一句，让对方开口说需求。",
    "private_message": "私信开场，承接评论里的兴趣点。",
    "wechat_guide": "引导加微信，理由具体（发资料 / 方案 / 案例），不骚扰；不要出现微信号明文。",
    "objection": "对方说「太贵了 / 再考虑 / 先看看」时的软化应对。",
    "nurture": "长期培育，保持存在感但不打扰。",
}

OPT_SYSTEM = (
    "你是抖音私域获客的资深话术策划。语言口语、真诚、不夸大、不承诺效果，"
    "像真人客服在聊天，不要营销腔。每条控制在 40 字内，可直接发送。"
)

OPT_PROMPT = """优化一条已有话术。

【话术】
名称：{name}
场景：{scene}
场景要求：{req}

【本次参与的画像变量】(只准用这些，写成 {{变量名}} 占位符)
{var_lines}

【现有变体】
{old_lines}

要求：
- 输出里的画像信息必须写成 {{变量名}} 占位符（只能用上面列出的变量名），
  **不要把画像的具体值硬写进文案** —— 占位符会在发送时自动替换成最新画像。
- 每条 40 字内，口语化，一条只讲一个点。
- 现有变体里已有的信息尽量保留，补进上面这些变量让话术更有针对性。
- 不要出现微信号明文、不要用「最」「第一」「 guaranteed 」这类绝对化表述。
- {task}

严格只输出 JSON：{{"variants":[{{"variantId":"A","text":"..."}}]}}
"""


class OptimizeIn(BaseModel):
    """单条话术 AI 优化请求。

    variables  用户勾选的画像变量（前端 SCRIPT_VARS 的 key）
    mode       optimize=改写现有变体（一变体一条）；new=追加全新变体
    count      mode=new 时生成几条（1~3）
    variants   当前变体（含前端未保存的编辑），[{variantId, text}]
    """
    variables: list[str] = Field(default_factory=list)
    mode: str = "optimize"
    count: int = 2
    variants: list[dict[str, Any]] = Field(default_factory=list)


def _var_lines(keys: list[str], biz: Any, prod: Any, aud: Any, wx: Any) -> tuple[str, list[str]]:
    """把勾选的变量拼成「变量名：值」；返回 (提示词片段, 画像里还没填的变量名)。"""
    objs = {"business": biz, "product": prod, "audience": aud, "wechat": wx}
    lines: list[str] = []
    missing: list[str] = []
    for k in keys:
        ref = VAR_FIELDS.get(k)
        if not ref:
            continue
        val = str(getattr(objs[ref[0]], ref[1], "") or "").strip()
        if not val:
            missing.append(k)
            continue
        val = val.replace("\\n", " / ").replace("\n", " / ")
        val = " / ".join(x.strip() for x in val.replace("，", ",").split(",") if x.strip()) or val
        lines.append(f"- {{{k}}} = {val}")
    return ("\n".join(lines) if lines else "（没有可用的画像值）"), missing


@router.post("/{script_id}/optimize")
def optimize_script(
    script_id: str,
    body: OptimizeIn,
    repo: Repository = Depends(get_repository),
    scripts: ScriptService = Depends(get_script_service),
    ai: AIService = Depends(get_ai_service),
) -> dict:
    """按用户勾选的画像变量优化 / 扩写一条话术。

    只把勾选项的画像值喂给 AI —— 用户没勾的变量不参与，这样「这次想突出什么」可控。
    只算不写库：前端拿到草稿可勾选、可编辑，点应用才落库。
    """
    try:
        cur = scripts.get_script(script_id)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="话术不存在：" + script_id)

    biz, prod, aud, wx = _profiles(repo)
    keys = [k for k in (body.variables or []) if k in VAR_FIELDS]
    if not keys:
        raise HTTPException(status_code=400, detail="请至少勾选一个画像变量")

    var_lines, missing = _var_lines(keys, biz, prod, aud, wx)
    scene = getattr(cur, "category", "") or ""
    req = OPT_SCENE_REQ.get(scene, "承接客户兴趣，推进到加微信。")

    incoming = [v for v in (body.variants or []) if str((v or {}).get("text", "")).strip()]
    if not incoming:
        incoming = [
            {"variantId": str(getattr(v, "variant_id", "") or ""), "text": str(getattr(v, "text", "") or "")}
            for v in (getattr(cur, "variants", None) or [])
        ]
    incoming = [v for v in incoming if v.get("text", "").strip()]
    if not incoming:
        raise HTTPException(status_code=400, detail="这条话术还没有可优化的变体内容")

    mode = "new" if body.mode == "new" else "optimize"
    if mode == "new":
        task = f"另写 {max(1, min(3, int(body.count or 2)))} 条全新变体，variantId 依次用 {_next_ids(incoming, max(1, min(3, int(body.count or 2))))}，与现有变体不重复。"
    else:
        task = "对上面每个现有变体各输出一条优化版，variantId 必须与原来一致（不要新增、不要改名）。"

    old_lines = "\n".join(f"- {v['variantId']}：{v['text']}" for v in incoming)
    ctx = OPT_PROMPT.format(
        name=getattr(cur, "name", "") or "",
        scene=SCENE_NAMES.get(scene, scene),
        req=req,
        var_lines=var_lines,
        old_lines=old_lines,
        task=task,
    )

    try:
        content = ai._call_llm(ctx, system=OPT_SYSTEM, timeout=120)
        data = ai._extract_json(content)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"AI 生成失败：{e}")

    raw = (data or {}).get("variants") if isinstance(data, dict) else None
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=502, detail="AI 返回结构异常（缺 variants）")

    drafts: list[dict] = []
    if mode == "optimize":
        by_id = {str(v["variantId"]): v["text"] for v in incoming}
        for item in raw:
            if not isinstance(item, dict):
                continue
            vid = str(item.get("variantId") or "").strip()
            text = str(item.get("text") or "").strip()
            if not text or vid not in by_id:
                continue
            drafts.append({"variantId": vid, "old": by_id[vid], "text": text, "isNew": False})
    else:
        want = _next_ids(incoming, max(1, min(3, int(body.count or 2))))
        texts = [str((x or {}).get("text") or "").strip() for x in raw if isinstance(x, dict)]
        texts = [t for t in texts if t][: len(want)]
        drafts = [
            {"variantId": want[i], "old": "", "text": t, "isNew": True}
            for i, t in enumerate(texts)
        ]

    if not drafts:
        raise HTTPException(status_code=502, detail="AI 没给出可用的优化结果，换一批试试")

    return {
        "ok": True,
        "mode": mode,
        "drafts": drafts,
        "missing": missing,
        "usedVars": keys,
    }


def _next_ids(variants: list[dict], n: int) -> list[str]:
    """下 n 个可用的变体字母（A/B/C…），已用的跳过。"""
    used = {str(v.get("variantId") or "").strip() for v in variants}
    out: list[str] = []
    for i in range(26):
        c = chr(65 + i)
        if c not in used:
            out.append(c)
            if len(out) >= n:
                break
    while len(out) < n:
        out.append("V" + str(len(used) + len(out) + 1))
    return out

