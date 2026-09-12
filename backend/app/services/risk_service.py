"""风险聚合 Service · 危机升级 L1/L2/L3（对应 skill 危机升级机制）
================================================================
关键设计：L2/L3 **不由单条 LLM 判断**，而由跨评论的聚合规则判定——
单条评论无法知道是否「集中投诉」或「正在被多账号转发」。

判定规则（简单、可解释，不引入 NLP）：
  - L1：存在负面评论，但无同类聚簇（同类 <3 条）→ 逐条按「灭火四步」处理
  - L2：同类负面 ≥3 条 → 统一口径后逐条一对一处理
  - L3：出现传播迹象（曝光/投诉/12315/举报 等词 ≥2 条，
        或同一负面文本被多账号重复出现）→ 必须走官方与法务渠道

「同类」按关键字归到 质量 / 物流 / 价格 / 服务 / 其他，取首个命中类别。
所有对外文本均经脱敏，避免聚合结果二次泄露个人信息。
"""
from __future__ import annotations

from app.services.desensitize_service import desensitize

__all__ = ["RiskService", "NOTICE"]

NOTICE = (
    "⚠️ 本内容为通用提效建议，不构成专业意见。"
    "平台规则、违规词、私信合规等请以官方与持证运营人士意见为准。"
)

# ── 负面判定关键词（用于 sentiment 缺失或漏标时的兜底）──
NEGATIVE_KEYWORDS = (
    "差评", "太差", "很差", "差劲", "垃圾", "骗人", "骗子", "退款", "退货",
    "投诉", "举报", "曝光", "坑人", "坑爹", "假货", "态度差", "服务差",
    "质量差", "物流慢", "发货慢", "太贵", "黑心", "维权", "12315",
    "无语", "恶心", "烂", "失望", "欺诈", "不放", "不退款", "没人管",
)

# ── 分类优先级：按顺序命中即归类 ──
CLUSTER_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("质量", ("质量", "品质", "做工", "次品", "假货", "瑕疵", "开裂", "掉色", "坏了", "用不了", "效果差")),
    ("物流", ("物流", "快递", "发货", "到货", "配送", "包邮", "运费", "收货", "没收到")),
    ("价格", ("价格", "太贵", "便宜", "收费", "退款", "退钱", "加价", "报价", "费用", "坑钱", "乱收费")),
    ("服务", ("服务", "态度", "客服", "回复", "售后", "不理人", "敷衍", "没人管", "推脱")),
]
DEFAULT_TOPIC = "其他"

# ── 传播迹象关键词：出现 ≥2 条即视为舆情扩散，升级 L3 ──
PROPAGATION_KEYWORDS = (
    "曝光", "投诉", "12315", "举报", "维权", "黑猫", "消协", "工商",
    "市场监管", "媒体", "起诉", "法院", "315", "律师函",
)

ADVICE = {
    "none": "近区间未发现负面评论，保持常规运营节奏即可。",
    "L1": (
        "存在负面评论但未形成同类聚集（L1）：按「灭火四步」逐条处理——"
        "① 先认事实不辩解；② 给出具体动作与时限；③ 一对一私信承接；"
        "④ 复盘记录。避免使用空转、甩锅、道德绑架类话术。"
    ),
    "L2": (
        "同类负面 ≥3 条，属集中投诉（L2）：① 团队内先对齐事实与统一说辞，"
        "禁止各说各话；② 在公开渠道置顶统一说明，给出明确处理时限；"
        "③ 逐条一对一处理并留痕。禁忌：各说各话、删评（删评只会放大舆情）。"
    ),
    "L3": (
        "出现传播迹象（多账号转发 / 曝光·投诉·举报等词 ≥2 条），升级为 L3："
        "**必须走官方与法务渠道，本系统只给框架不替代专业处置**——"
        "① 立即停止自动化群发与集中回复，避免二次放大；"
        "② 固定证据（评论、时间、账号、截图），同步法务与官方客服；"
        "③ 由官方/持证运营人士统一对外发声；"
        "④ 严禁删评、对骂、私下承诺。"
    ),
}


def _matched_negative(comment: str) -> str | None:
    for kw in NEGATIVE_KEYWORDS:
        if kw in comment:
            return kw
    return None


def _is_negative(comment: str, sentiment: str | None) -> bool:
    if (sentiment or "").lower() == "negative":
        return True
    return _matched_negative(comment) is not None


def _classify(comment: str) -> str:
    for topic, keywords in CLUSTER_KEYWORDS:
        if any(kw in comment for kw in keywords):
            return topic
    return DEFAULT_TOPIC


def _normalize(comment: str) -> str:
    return "".join(comment.split()).lower()


class RiskService:
    def __init__(self, repo) -> None:
        self._repo = repo

    def summarize(self, start_date: str | None = None, end_date: str | None = None) -> dict:
        rows = self._repo.list_leads_for_risk(start_date=start_date, end_date=end_date)

        negatives: list[dict] = []
        for row in rows:
            comment = (row.get("comment") or "").strip()
            if not comment:
                continue
            if _is_negative(comment, row.get("sentiment")):
                negatives.append(
                    {
                        "lead_id": row.get("id"),
                        "comment": comment,
                        "topic": _classify(comment),
                        "keyword": _matched_negative(comment),
                    }
                )

        negative_count = len(negatives)

        # ── 聚簇（同类 = 关键字分类）──
        groups: dict[str, list[dict]] = {}
        for item in negatives:
            groups.setdefault(item["topic"], []).append(item)

        clusters: list[dict] = []
        for topic, items in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            clusters.append(
                {
                    "topic": topic,
                    "count": len(items),
                    "sample_comments": [
                        desensitize(i["comment"])["desensitized"] for i in items[:2]
                    ],
                    "samples_desensitized": True,
                }
            )
        max_cluster = max((c["count"] for c in clusters), default=0)

        # ── 传播迹象 ──
        propagation_hits = [i for i in negatives if any(k in i["comment"] for k in PROPAGATION_KEYWORDS)]
        dup_map: dict[str, list[dict]] = {}
        for item in negatives:
            dup_map.setdefault(_normalize(item["comment"]), []).append(item)
        duplicated = [v for v in dup_map.values() if len(v) >= 2]
        propagation = len(propagation_hits) >= 2 or len(duplicated) >= 1

        # ── 定级 ──
        if negative_count == 0:
            level = "none"
        elif propagation:
            level = "L3"
        elif max_cluster >= 3:
            level = "L2"
        else:
            level = "L1"

        l1_items = [
            {
                "lead_id": i["lead_id"],
                "comment": desensitize(i["comment"])["desensitized"],
                "reason": f"命中「{i['topic']}」类负面" + (f"（关键词：{i['keyword']}）" if i["keyword"] else ""),
            }
            for i in negatives
        ]

        return {
            "level": level,
            "negative_count": negative_count,
            "clusters": clusters,
            "l1_items": l1_items,
            "advice": ADVICE[level],
            "notice": NOTICE,
            "official_escalation_required": level == "L3",
        }
