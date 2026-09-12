# -*- coding: utf-8 -*-
"""P2-10: add cpuPercent / memoryPercent to monitor/health via psutil."""
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

# 1) schema: BackendHealth 增加 cpu/memory 指标
patch(
    r"app\schemas\monitor.py",
    '''class BackendHealth(ComponentHealth):
    version: str = ""
    uptime: float = 0.0
''',
    '''class BackendHealth(ComponentHealth):
    version: str = ""
    uptime: float = 0.0
    # P2-10：宿主机 CPU / 内存占用百分比（psutil）
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
''',
)

# 2) service: import psutil (graceful) + 采集指标
patch(
    r"app\services\monitor_service.py",
    "from app.core.api_stats import get_api_stats\n",
    "from app.core.api_stats import get_api_stats\n\ntry:\n    import psutil  # P2-10：CPU/内存指标（可选依赖，缺失时降级为 0）\nexcept Exception:  # pragma: no cover\n    psutil = None\n",
)

patch(
    r"app\services\monitor_service.py",
    '''        backend = {
            "status": "ok",
            "version": "0.1.0",
            "uptime": get_api_stats()["uptime"],
            "message": "运行中",
        }''',
    '''        # P2-10：CPU / 内存占用（非阻塞采样，首次调用可能为 0，属正常）
        cpu_percent, memory_percent = 0.0, 0.0
        if psutil is not None:
            try:
                cpu_percent = float(psutil.cpu_percent(interval=None))
                memory_percent = float(psutil.virtual_memory().percent)
            except Exception:
                cpu_percent, memory_percent = 0.0, 0.0

        backend = {
            "status": "ok",
            "version": "0.1.0",
            "uptime": get_api_stats()["uptime"],
            "message": "运行中",
            "cpu_percent": cpu_percent,
            "memory_percent": memory_percent,
        }''',
)

print("P2-10 DONE")
