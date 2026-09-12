# -*- coding: utf-8 -*-
"""临时补丁脚本：对源码做精确字符串替换。用完即弃。"""
import io
import os

ROOT = r"D:\nanxi-dev\backend"


def patch(relpath, old, new, count=1):
    p = os.path.join(ROOT, relpath)
    s = io.open(p, encoding="utf-8").read()
    found = s.count(old)
    assert found == count, f"{relpath}: expected {count} match, got {found} for: {old[:60]!r}"
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
    print("OK", relpath)


# ── P2-7: sqlite repo mark_notification_read returns bool ──
patch(
    r"app\repositories\sqlite.py",
    '''    def mark_notification_read(self, notification_id: str) -> None:
        self._execute("UPDATE notifications SET read = 1 WHERE id = ?", (notification_id,))
''',
    '''    def mark_notification_read(self, notification_id: str) -> bool:
        cur = self._execute("UPDATE notifications SET read = 1 WHERE id = ?", (notification_id,))
        return cur.rowcount > 0
''',
)

# ── P2-7: notification_service raises 404 ──
patch(
    r"app\services\notification_service.py",
    "from app.models.domain import Notification, now_utc\n",
    "from fastapi import HTTPException\nfrom app.models.domain import Notification, now_utc\n",
)
patch(
    r"app\services\notification_service.py",
    '''    def mark_read(self, notification_id: str) -> None:
        self._repo.mark_notification_read(notification_id)
''',
    '''    def mark_read(self, notification_id: str) -> None:
        existed = self._repo.mark_notification_read(notification_id)
        if not existed:
            # P2-7: non-existent notification must 404, not silently 200
            raise HTTPException(status_code=404, detail=f"Notification not found: {notification_id}")
''',
)

print("ALL PATCHES APPLIED")
