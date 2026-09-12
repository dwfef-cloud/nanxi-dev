# -*- coding: utf-8 -*-
"""P3-11: desktop heartbeat in MonitorService + route.
monitor_service.py is CRLF; monitor.py route is LF."""

def read(p):
    with open(p, "rb") as f:
        return f.read()

def write(p, d):
    with open(p, "wb") as f:
        f.write(d)

def enc_crlf(lines):
    return b"\r\n".join(l.encode("utf-8") if isinstance(l, str) else l for l in lines)

# ═══════════ monitor_service.py (CRLF) ═══════════
p = r"D:\nanxi-dev\backend\app\services\monitor_service.py"
d = read(p)

# 1) __init__: add heartbeat cache after _SCHED_TTL line
old_init = enc_crlf([
    '        self._sched_cache: dict = {"status": "stopped", "ts": 0.0}',
    '        self._SCHED_TTL = 3.0  # 秒',
])
new_init = enc_crlf([
    '        self._sched_cache: dict = {"status": "stopped", "ts": 0.0}',
    '        self._SCHED_TTL = 3.0  # 秒',
    '        # P3-11: desktop heartbeat (in-memory cache; within 5min = online)',
    '        self._desktop_lock = threading.Lock()',
    '        self._desktop_heartbeat: dict = {"ts": 0.0, "info": {}}',
    '        self._DESKTOP_ONLINE_WINDOW = 300.0  # seconds',
])
assert old_init in d, "P3-11 init anchor not found"
d = d.replace(old_init, new_init, 1)

# 2) replace desktop block in get_health
old_desktop = enc_crlf([
    '        desktop = {',
    '            "status": "unknown",',
    '            "message": "\u684c\u9762\u7aef\u72b6\u6001\u6682\u672a\u63a5\u5165",',
    '        }',
])
if old_desktop not in d:
    # match ascii-safe: find 'desktop = {' then the closing '}'
    i = d.find(b'        desktop = {')
    assert i >= 0, "desktop block not found"
    j = d.find(b'        }', i) + len(b'        }')
    old_desktop = d[i:j]
new_desktop = b'        desktop = self._desktop_health()'
d = d.replace(old_desktop, new_desktop, 1)

# 3) add methods before get_health return / after get_health.
#    Insert record_desktop_heartbeat + _desktop_health right after the get_health method.
#    Anchor: the 'return {' block end of get_health -> find 'overall": overall,\n        }'
anchor = enc_crlf([
    '            "overall": overall,',
    '        }',
])
assert anchor in d, "P3-11 get_health return anchor not found"
methods = enc_crlf([
    '',
    '    # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '    # P3-11: desktop heartbeat',
    '    # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
    '    def record_desktop_heartbeat(self, info: dict | None = None) -> dict:',
    '        """P3-11: desktop app calls this periodically to report liveness."""',
    '        with self._desktop_lock:',
    '            self._desktop_heartbeat = {"ts": time.time(), "info": info or {}}',
    '        return {"ok": True, "message": "heartbeat received"}',
    '',
    '    def _desktop_health(self) -> dict:',
    '        """P3-11: derive desktop status from latest heartbeat."""',
    '        with self._desktop_lock:',
    '            ts = self._desktop_heartbeat["ts"]',
    '        if ts and (time.time() - ts) <= self._DESKTOP_ONLINE_WINDOW:',
    '            return {',
    '                "status": "online",',
    '                "message": f"desktop online ({int(time.time()-ts)}s since heartbeat)",',
    '            }',
    '        return {',
    '            "status": "not_implemented",',
    '            "message": "desktop not connected (call /api/monitor/desktop-heartbeat within 5min to go online)",',
    '        }',
    '',
])
d = d.replace(anchor, anchor + methods, 1)
write(p, d)
print("P3-11 service done")

# ═══════════ monitor.py route (LF) ═══════════
p = r"D:\nanxi-dev\backend\app\api\routes\monitor.py"
d = read(p)
if b"desktop-heartbeat" not in d:
    endpoint = (
        b'\n\n@router.post("/desktop-heartbeat")\n'
        b'def desktop_heartbeat(\n'
        b'    payload: dict | None = None,\n'
        b'    service: MonitorService = Depends(get_monitor_service),\n'
        b') -> dict:\n'
        b'    """P3-11: desktop heartbeat. Within 5min monitor/health shows online."""\n'
        b'    return service.record_desktop_heartbeat(payload or {})\n'
    )
    d = d.rstrip() + endpoint + b"\n"
    write(p, d)
    print("P3-11 route done")
else:
    print("P3-11 route already present")
