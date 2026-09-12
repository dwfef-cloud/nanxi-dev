# -*- coding: utf-8 -*-
"""P3 修复后验证脚本"""
import requests

BASE = "http://127.0.0.1:8000"
results = {}


def show(title, method, path, expect=None, **kw):
    try:
        r = getattr(requests, method)(BASE + path, timeout=15, **kw)
        body = r.text
        if len(body) > 500:
            body = body[:500] + "...[truncated]"
        print(f"\n=== {title} ===")
        print(f"{method.upper()} {path} -> {r.status_code}")
        print(body)
        ok = (expect is None) or (r.status_code == expect)
        results[title] = (r.status_code, ok)
        return r
    except Exception as e:
        print(f"\n=== {title} === ERROR: {e}")
        results[title] = (None, False)
        return None


print("=" * 60)
print("P3 修复后验证")
print("=" * 60)

# P3-7: export status -> 200
r = show("P3-7 export/status", "get", "/api/export/status", expect=200)
# P3-7: export leads returns export_id
r = show("P3-7 export/leads has export_id", "get", "/api/export/leads?format=csv", expect=200)
if r and "exportId" in r.text:
    print(">>> exportId present: OK")

# P3-9: send-batch empty queue returns message field
r = show("P3-9 send-batch empty queue has message", "post", "/api/dm/send-batch",
         json={"count": 5}, expect=200)
if r and '"message"' in r.text:
    print(">>> message field present: OK")

# P3-10: min>max returns 400
show("P3-10 min>max -> 400", "put", "/api/dm/sender/config",
     json={"minInterval": 60, "maxInterval": 30}, expect=400)

# reset config to sane values (the earlier test polluted minInterval=60)
show("P3-10 reset config", "put", "/api/dm/sender/config",
     json={"minInterval": 30, "maxInterval": 60}, expect=200)

# P3-11: monitor health desktop
show("P3-11 monitor/health desktop", "get", "/api/monitor/health", expect=200)
# P3-11: desktop heartbeat
show("P3-11 desktop heartbeat", "post", "/api/monitor/desktop-heartbeat",
     json={"platform": "windows"}, expect=200)
# P3-11: after heartbeat, desktop should be online
r = show("P3-11 after heartbeat desktop=online", "get", "/api/monitor/health", expect=200)
if r and '"online"' in r.text:
    print(">>> desktop online after heartbeat: OK")

# P3-13: enter safe mode, resume -> 409
show("P3-13 enter safe mode", "post", "/api/compliance/safe-mode/enter",
     json={"source": "manual", "reason": "test"}, expect=200)
show("P3-13 resume in safe mode -> 409", "post", "/api/compliance/resume", expect=409)
# exit safe mode
show("P3-13 exit safe mode", "post", "/api/compliance/safe-mode/exit", json={}, expect=200)

# P3-8: configs
show("P3-8 dm_sender config", "get", "/api/dm/sender/config", expect=200)

print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)
allok = True
for k, (code, ok) in results.items():
    mark = "PASS" if ok else "FAIL"
    if not ok:
        allok = False
    print(f"  [{mark}] {k}  (status={code})")
print("\nALL PASS" if allok else "\nSOME FAILED")
