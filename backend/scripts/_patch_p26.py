# -*- coding: utf-8 -*-
"""P2-6: stabilize monitor scheduler.status (single source + short TTL cache + lock)."""
import io, os

ROOT = r"D:\nanxi-dev\backend"

def patch(relpath, old, new, count=1):
    p = os.path.join(ROOT, relpath)
    s = io.open(p, encoding="utf-8").read()
    found = s.count(old)
    assert found == count, f"{relpath}: expected {count}, got {found}: {old[:70]!r}"
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
    print("OK", relpath)

# 1) imports
patch(
    r"app\services\monitor_service.py",
    "import os\nimport sqlite3\nfrom datetime import datetime, timezone\n",
    "import os\nimport sqlite3\nimport threading\nimport time\nfrom datetime import datetime, timezone\n",
)

# 2) cache fields in __init__
patch(
    r"app\services\monitor_service.py",
    '''    def __init__(self, repo: Repository, ai_service) -> None:
        self._repo = repo
        self._ai = ai_service
''',
    '''    def __init__(self, repo: Repository, ai_service) -> None:
        self._repo = repo
        self._ai = ai_service
        # P2-6：scheduler.status 短 TTL 缓存 + 锁，避免高频轮询时状态抖动
        self._sched_lock = threading.Lock()
        self._sched_cache: dict = {"status": "stopped", "ts": 0.0}
        self._SCHED_TTL = 3.0  # 秒
''',
)

# 3) deterministic derivation + cached read
patch(
    r"app\services\monitor_service.py",
    '''        # 调度器状态：从 runtime_state 读取 task_running
        try:
            runtime = self._repo.get_runtime()
            sched_status = "running" if runtime.task_running and not runtime.safe_mode_active else "stopped"
        except Exception:
            sched_status = "stopped"
''',
    '''        # 调度器状态：唯一来源 = runtime_state.task_running && !safe_mode_active
        # P2-6：加锁 + 短 TTL 缓存，避免高频轮询时 running/stopped 抖动；
        # 读取失败一律降级为 stopped（绝不因读取出错而误报 running）。
        now = time.monotonic()
        with self._sched_lock:
            if now - self._sched_cache["ts"] >= self._SCHED_TTL:
                try:
                    runtime = self._repo.get_runtime()
                    sched_status = (
                        "running"
                        if runtime.task_running and not runtime.safe_mode_active
                        else "stopped"
                    )
                except Exception:
                    sched_status = "stopped"
                self._sched_cache = {"status": sched_status, "ts": now}
            else:
                sched_status = self._sched_cache["status"]
''',
)

print("P2-6 DONE")
