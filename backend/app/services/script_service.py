"""话术库 Service · 依赖 Repository 接口"""
import random
from datetime import datetime, timezone

from app.models.domain import Script, ScriptVariant
from app.repositories.base import Repository
from app.schemas.script import (
    ScriptCreate, ScriptRead, ScriptTemplateRead, ScriptUpdate,
    VariantCreate, VariantRead, VariantUpdate,
)

# R2 自动停用所需的最小样本量：发送次数不到这个数就不下判断
R2_SAMPLE_MIN = 30


class ScriptService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo

    # ═══════════════════════════════════════════════════════
    # 变体效果统计（R2 的数据来源）
    # ═══════════════════════════════════════════════════════

    def _all_variant_stats(self) -> dict[tuple[str, str], dict[str, int]]:
        """全部变体的效果统计，失败时退化为空（不影响话术库读取）。"""
        try:
            return self._repo.variant_usage_stats()
        except Exception:  # noqa: BLE001 — 统计是展示层数据，不能拖垮话术库
            return {}

    def _stats_for(self, script_id: str) -> dict[str, dict[str, int]]:
        """某条话术下「变体 ID → 统计」。"""
        return {
            vid: st
            for (sid, vid), st in self._all_variant_stats().items()
            if sid == script_id
        }

    def apply_r2(self, script_id: str) -> list[str]:
        """按真实统计执行 R2 自动停用，返回被停用的变体 ID 列表。

        规则：加微转化率 < 配置阈值（默认 8%）且发送样本 ≥ R2_SAMPLE_MIN（30）时，
        把该变体置为 switched_off，权重让给其它变体。

        跳过条件：
        - 样本不足或没有发送记录（数据不够，不能下判断）；
        - 变体已不是 active（用户手动停用/草稿）；
        - r2_note 以「手动」开头（用户手动重新启用过，尊重用户选择）。
        """
        threshold = self._r2_switch_threshold()
        stats = self._stats_for(script_id)
        switched: list[str] = []
        for variant in self._repo.list_variants(script_id):
            st = stats.get(variant.variant_id) or {}
            sent = int(st.get("sent", 0) or 0)
            wechat_added = int(st.get("wechat_added", 0) or 0)

            # 把实时统计回写到冗余列，便于排查与旧接口兼容
            variant.sent = sent
            variant.replied = int(st.get("replied", 0) or 0)
            variant.wechat_added = wechat_added
            variant.conv_rate = round(wechat_added / sent * 100, 1) if sent else None
            variant.sample_enough = sent >= R2_SAMPLE_MIN

            manual_override = (variant.r2_note or "").startswith("手动")
            if (
                variant.sample_enough
                and variant.conv_rate is not None
                and variant.conv_rate < threshold
                and variant.status == "active"
                and not manual_override
            ):
                variant.status = "switched_off"  # type: ignore[assignment]
                variant.r2_note = (
                    f"R2 自动停用：加微转化率 {variant.conv_rate}% < {threshold}%"
                    f"（样本 {sent}）"
                )
                switched.append(variant.variant_id)

            self._repo.save_variant(variant)
        return switched

    # ═══════════════════════════════════════════════════════
    # 话术 CRUD
    # ═══════════════════════════════════════════════════════

    def list_scripts(self, category: str | None = None) -> list[ScriptRead]:
        scripts = self._repo.list_scripts(category=category)
        return [self._to_read(s) for s in scripts]

    def get_script(self, script_id: str) -> ScriptRead:
        script = self._repo.get_script(script_id)
        return self._to_read(script)

    def create_script(self, payload: ScriptCreate) -> ScriptRead:
        script = Script(
            name=payload.name,
            industry=payload.industry,
            category=payload.category,  # type: ignore[arg-type]
            is_main=payload.is_main,
            active=payload.active,
            intro=payload.intro,
            welcome_msg=payload.welcome_msg,
            source=payload.source or "manual",
            generated_from=payload.generated_from or "",
            variables=payload.variables or "",
        )
        saved = self._repo.save_script(script)
        return self._to_read(saved)

    def update_script(self, script_id: str, payload: ScriptUpdate) -> ScriptRead:
        """更新话术级字段（active/name/category/intro/welcome_msg）。不存在抛 KeyError → 404"""
        script = self._repo.get_script(script_id)
        if payload.name is not None:
            script.name = payload.name
        if payload.category is not None:
            script.category = payload.category  # type: ignore[assignment]
        if payload.active is not None:
            script.active = payload.active
        if payload.intro is not None:
            script.intro = payload.intro
        if payload.welcome_msg is not None:
            script.welcome_msg = payload.welcome_msg
        if payload.source is not None:
            script.source = payload.source
        if payload.generated_from is not None:
            script.generated_from = payload.generated_from
        if payload.variables is not None:
            script.variables = payload.variables
        saved = self._repo.save_script(script)
        return self._to_read(saved)

    def delete_script(self, script_id: str) -> None:
        """删除话术及其变体。不存在抛 KeyError → 404。

        历史归因（script_usage / 评论任务的 reply_script_id）保留不动。
        """
        self._repo.delete_script(script_id)

    def delete_variant(self, script_id: str, variant_id: str) -> None:
        """删除单个变体。话术或变体不存在抛 KeyError → 404。"""
        self._repo.delete_variant(script_id, variant_id)

    # ═══════════════════════════════════════════════════════
    # 变体 CRUD
    # ═══════════════════════════════════════════════════════

    def add_variant(self, script_id: str, payload: VariantCreate) -> VariantRead:
        # 确认话术存在
        self._repo.get_script(script_id)
        variant = ScriptVariant(
            script_id=script_id,
            variant_id=payload.variant_id,
            text=payload.text,
            weight=payload.weight,
            status=payload.status,  # type: ignore[arg-type]
        )
        saved = self._repo.save_variant(variant)
        return self._to_variant_read(saved, self._stats_for(script_id))

    def update_variant(
        self, script_id: str, variant_id: str, payload: VariantUpdate,
    ) -> VariantRead:
        """更新变体（文本 / 权重 / 状态）。

        这里只做用户显式要求的改动，不再顺手跑 R2 —— 自动停用改由 `apply_r2()`
        在「发送 / 加微结果回写」时执行，避免用户手动编辑文本时被莫名其妙停用。
        用户手动把变体改回 active 时打一个「手动」标记，之后的 R2 不再动它。
        """
        variants = self._repo.list_variants(script_id)
        target = None
        for v in variants:
            if v.variant_id == variant_id:
                target = v
                break
        if target is None:
            raise KeyError(f"Variant {variant_id} not found in script {script_id}")

        if payload.text is not None:
            target.text = payload.text
        if payload.weight is not None:
            target.weight = payload.weight
        if payload.status is not None:
            target.status = payload.status  # type: ignore[assignment]
            if payload.status == "active":
                # 用户手动启用：R2 不再自动停用它
                target.r2_note = "手动启用，不参与自动停用"
            elif payload.status in ("switched_off", "draft"):
                target.r2_note = None

        saved = self._repo.save_variant(target)
        return self._to_variant_read(saved, self._stats_for(script_id))

    def _r2_switch_threshold(self) -> float:
        """读取「系统设置 → 话术策略」的 r2_switch_threshold（%），未配置或异常时默认 8.0。

        与 settings_service.CAT_STRATEGY 的字段名保持一致，保证设置页可调。
        """
        try:
            raw = self._repo.get_system_settings("strategy")
            val = raw.get("r2_switch_threshold")
            return float(val) if val not in (None, "") else 8.0
        except (TypeError, ValueError):
            return 8.0

    # ═══════════════════════════════════════════════════════
    # 权重挑选 · 评论回复取内容
    # ═══════════════════════════════════════════════════════

    def pick_variant(self, script_id: str) -> ScriptVariant | None:
        """按 weight 加权随机挑一个 active 变体，无可选变体时返回 None。

        与前端手动点选的区别：这里让 A/B 权重真正生效（权重为 0 的变体不会被选中）。
        """
        variants = [v for v in self._repo.list_variants(script_id) if v.status == "active"]
        if not variants:
            return None
        weights = [max(int(v.weight or 0), 0) for v in variants]
        total = sum(weights)
        if total <= 0:
            return random.choice(variants)
        hit = random.uniform(0, total)
        acc = 0.0
        for variant, weight in zip(variants, weights):
            acc += weight
            if hit <= acc:
                return variant
        return variants[-1]

    def pick_comment_variant(self) -> tuple[Script, ScriptVariant] | None:
        """从启用中的 category=comment 话术里按权重挑一条变体。

        返回 (话术, 变体)；没有任何可用的评论话术时返回 None（调用方负责报错）。
        """
        for script in self._repo.list_scripts(category="comment", active=True):
            variant = self.pick_variant(script.id)
            if variant is not None:
                return script, variant
        return None

    # ═══════════════════════════════════════════════════════
    # 模板包
    # ═══════════════════════════════════════════════════════

    def list_templates(self) -> list[ScriptTemplateRead]:
        templates = self._repo.list_script_templates()
        return [
            ScriptTemplateRead(
                industry=t.industry,
                count=t.count,
                desc=t.desc,
                installed=t.installed,
            )
            for t in templates
        ]

    # ═══════════════════════════════════════════════════════
    # 内部转换
    # ═══════════════════════════════════════════════════════

    def _to_read(self, script: Script) -> ScriptRead:
        variants = self._repo.list_variants(script.id)
        stats = self._stats_for(script.id)
        return ScriptRead(
            id=script.id,
            name=script.name,
            industry=script.industry,
            category=script.category,
            is_main=script.is_main,
            active=script.active,
            intro=script.intro,
            welcome_msg=script.welcome_msg,
            source=script.source,
            generated_from=script.generated_from,
            variables=script.variables,
            variants=[self._to_variant_read(v, stats) for v in variants],
        )

    def _to_variant_read(
        self, v: ScriptVariant, stats: dict[str, dict[str, int]] | None = None,
    ) -> VariantRead:
        """变体响应。发送 / 回复 / 加微 / 转化率一律用实时统计，不用库里的冗余列。"""
        st = (stats or {}).get(v.variant_id) or {}
        sent = int(st.get("sent", v.sent) or 0)
        replied = int(st.get("replied", v.replied) or 0)
        wechat_added = int(st.get("wechat_added", v.wechat_added or 0) or 0)
        return VariantRead(
            variant_id=v.variant_id,
            text=v.text,
            weight=v.weight,
            status=v.status,
            sent=sent,
            replied=replied,
            wechat_added=wechat_added,
            conv_rate=round(wechat_added / sent * 100, 1) if sent else None,
            sample_enough=sent >= R2_SAMPLE_MIN,
            r2_note=v.r2_note,
        )
