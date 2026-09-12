# -*- coding: utf-8 -*-
"""P2-14: add avatarHue to AccountRead (deterministic hue from nickname/id)."""
import io, os

ROOT = r"D:\nanxi-dev\backend"

def patch(relpath, old, new, count=1):
    p = os.path.join(ROOT, relpath)
    s = io.open(p, encoding="utf-8").read()
    found = s.count(old)
    assert found == count, f"{relpath}: expected {count}, got {found}: {old[:60]!r}"
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
    print("OK", relpath)

patch(
    r"app\schemas\account.py",
    "from datetime import datetime\nfrom typing import Literal\n\nfrom pydantic import BaseModel, ConfigDict\nfrom pydantic.alias_generators import to_camel\n",
    "from datetime import datetime\nfrom typing import Literal\n\nimport zlib\nfrom pydantic import BaseModel, ConfigDict, model_validator\nfrom pydantic.alias_generators import to_camel\n",
)

patch(
    r"app\schemas\account.py",
    '''class AccountRead(_Camel):
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
''',
    '''class AccountRead(_Camel):
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
        if not self.avatar_hue:
            seed = (self.nickname or "") + "|" + (self.id or "")
            # 稳定哈希（不依赖 PYTHONHASHSEED），0-359
            self.avatar_hue = zlib.crc32(seed.encode("utf-8")) % 360
        return self
''',
)

print("P2-14 DONE")
