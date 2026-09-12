# -*- coding: utf-8 -*-
"""P2-8: provider enum validation -> 422"""
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

# 1) imports + type alias
patch(
    r"app\schemas\settings.py",
    "from __future__ import annotations\n\nfrom pydantic import BaseModel, Field\n",
    "from __future__ import annotations\n\nfrom typing import Literal\n\nfrom pydantic import BaseModel, Field\n\n# P2-8: allowed AI providers; invalid value must fail validation with 422\nAIProvider = Literal[\"doubao\", \"dashscope\"]\n",
)

# 2) AISettings.provider uses enum
patch(
    r"app\schemas\settings.py",
    '    provider: str = Field(default="doubao", description="提供商：doubao / dashscope")\n',
    '    provider: AIProvider = Field(default="doubao", description="提供商：doubao / dashscope")\n',
)

# 3) AISettingsUpdate.provider uses enum
patch(
    r"app\schemas\settings.py",
    "    provider: str | None = None\n    api_key: str | None = None\n",
    "    provider: AIProvider | None = None\n    api_key: str | None = None\n",
)

# 4) generic PUT /settings also validates ai.provider (free-dict path)
patch(
    r"app\services\settings_service.py",
    "from datetime import datetime, timedelta, timezone\nfrom typing import Any\n",
    "from datetime import datetime, timedelta, timezone\nfrom typing import Any\n\nfrom fastapi import HTTPException\n",
)
patch(
    r"app\services\settings_service.py",
    """        for cat_key, cat_data in partial.items():
            if cat_key not in category_map or not isinstance(cat_data, dict):
                continue
            category, update_cls = category_map[cat_key]
""",
    """        for cat_key, cat_data in partial.items():
            if cat_key not in category_map or not isinstance(cat_data, dict):
                continue
            # P2-8: validate provider on the free-dict generic path too
            if cat_key == "ai" and isinstance(cat_data.get("provider"), str):
                if cat_data["provider"] not in _ALLOWED_PROVIDERS:
                    raise HTTPException(
                        status_code=422,
                        detail=f"非法 provider: {cat_data['provider']!r}，只支持 doubao / dashscope",
                    )
            category, update_cls = category_map[cat_key]
""",
)
patch(
    r"app\services\settings_service.py",
    "_CST = timezone(timedelta(hours=8))\n",
    "_CST = timezone(timedelta(hours=8))\n\n# P2-8: whitelist of allowed AI providers\n_ALLOWED_PROVIDERS = {\"doubao\", \"dashscope\"}\n",
)

print("P2-8 DONE")
