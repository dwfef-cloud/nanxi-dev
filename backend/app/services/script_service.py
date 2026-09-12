"""话术库 Service · 依赖 Repository 接口"""
import random
from datetime import datetime, timezone

from app.models.domain import Script, ScriptVariant
from app.repositories.base import Repository
from app.schemas.script import (
    ScriptCreate, ScriptRead, ScriptTemplateRead, ScriptUpdate,
    VariantCreate, VariantRead, VariantUpdate,
)


class ScriptService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo

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
        )
        saved = self._repo.save_script(script)
        return self._to_read(saved)

    def update_script(self, script_id: str, payload: ScriptUpdate) -> ScriptRead:
        """P1-7: 更新话术级字段（active/name/category）。不存在抛 KeyError → 404"""
        script = self._repo.get_script(script_id)
        if payload.name is not None:
            script.name = payload.name
        if payload.category is not None:
            script.category = payload.category  # type: ignore[assignment]
        if payload.active is not None:
            script.active = payload.active
        saved = self._repo.save_script(script)
        return self._to_read(saved)

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
        return self._to_variant_read(saved)

    def update_variant(
        self, script_id: str, variant_id: str, payload: VariantUpdate,
    ) -> VariantRead:
        """更新变体。R2 命中时（conv_rate < 8% 且 sample_enough）自动切换为 switched_off。"""
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

        # R2 自动切换：样本量足够且转化率 < 8% → switched_off
        if (
            target.sample_enough
            and target.conv_rate is not None
            and target.conv_rate < 8.0
            and target.status == "active"
        ):
            target.status = "switched_off"  # type: ignore[assignment]
            target.r2_note = f"R2 自动切换：转化率 {target.conv_rate}% < 8%"

        saved = self._repo.save_variant(target)
        return self._to_variant_read(saved)

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
        return ScriptRead(
            id=script.id,
            name=script.name,
            industry=script.industry,
            category=script.category,
            is_main=script.is_main,
            active=script.active,
            intro=script.intro,
            welcome_msg=script.welcome_msg,
            variants=[self._to_variant_read(v) for v in variants],
        )

    @staticmethod
    def _to_variant_read(v: ScriptVariant) -> VariantRead:
        return VariantRead(
            variant_id=v.variant_id,
            text=v.text,
            weight=v.weight,
            status=v.status,
            sent=v.sent,
            replied=v.replied,
            wechat_added=v.wechat_added,
            conv_rate=v.conv_rate,
            sample_enough=v.sample_enough,
        )
