"""抖音账号 Schema · v1.0 契约对齐

含健康分五维因子、限流状态机、日频配置。
响应字段使用 camelCase（与 api-contract.md 第二节一致）。
"""
from datetime import datetime
from typing import Literal

import zlib
from pydantic import BaseModel, ConfigDict, model_validator
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


class AccountCreate(_Camel):
    """新增账号请求"""
    nickname: str
    platform: str = "douyin"
    daily_limit: int = 80
    notes: str = ""


class AccountUpdate(_Camel):
    """更新账号请求（状态/备注/健康分因子）"""
    # ── 限流状态机（手动切换） ──
    limit_status: Literal["healthy", "warn", "throttled40", "safe_mode", "banned"] | None = None
    # ── 健康分五维因子（部分更新，只传需要改的因子） ──
    factors: dict[str, str] | None = None  # key: dailyFreq/banHistory/login/unsubscribe/complaint, value: good/warn/bad
    # ── 日频配置 ──
    daily_limit: int | None = None
    daily_outreach: int | None = None
    # ── 健康分手动覆盖（一般由因子自动计算） ──
    health_score: int | None = None
    # ── 风控备注 ──
    notes: str | None = None
    last_ban_reason: str | None = None
    r1_note: str | None = None
    r3_note: str | None = None


class AccountRead(_Camel):
    """账号响应 · 含健康分和限流状态"""
    id: str
    nickname: str
    platform: str
    health_score: int
    limit_status: str
    daily_outreach: int
    daily_limit: int
    factors: dict[str, str]
    last_ban_reason: str | None = None
    updated_at: datetime
    # P2-14: 头像背景色 hue（0-360）。ORM 无此字段，按昵称/id 确定性生成，
    # 避免前端出现 hsl(undefined ...)。
    avatar_hue: int = 0

    @model_validator(mode="after")
    def _fill_avatar_hue(self) -> "AccountRead":
        # 始终按 昵称+id 确定性生成（域模型默认 150 无区分度，会导致所有头像同色）
        seed = (self.nickname or "") + "|" + (self.id or "")
        self.avatar_hue = zlib.crc32(seed.encode("utf-8")) % 360
        return self
