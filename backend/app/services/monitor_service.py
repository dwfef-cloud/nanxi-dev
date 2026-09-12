"""系统监控 Service · 健康检查 / 数据库 / API 统计 / 账号 / 任务 / 日志（P4-C）

只读聚合服务，不修改业务数据。构造注入 Repository 与 AIService。
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.api_stats import get_api_stats

try:
    import psutil  # P2-10：CPU/内存指标（可选依赖，缺失时降级为 0）
except Exception:  # pragma: no cover
    psutil = None
from app.core.mediacrawler_runtime import media_crawler_is_ready
from app.db.init import get_db_path
from app.repositories.base import Repository

logger = logging.getLogger(__name__)


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


class MonitorService:
    """系统监控聚合服务"""

    def __init__(self, repo: Repository, ai_service) -> None:
        self._repo = repo
        self._ai = ai_service
        # P2-6：scheduler.status 短 TTL 缓存 + 锁，避免高频轮询时状态抖动
        self._sched_lock = threading.Lock()
        self._sched_cache: dict = {"status": "stopped", "ts": 0.0}
        self._SCHED_TTL = 3.0  # 秒
        # P3-11: desktop heartbeat (in-memory cache; within 5min = online)
        self._desktop_lock = threading.Lock()
        self._desktop_heartbeat: dict = {"ts": 0.0, "info": {}}
        self._DESKTOP_ONLINE_WINDOW = 300.0  # seconds

    # ═══════════════════════════════════════════════════════════
    # 综合健康状态
    # ═══════════════════════════════════════════════════════════

    def get_health(self) -> dict[str, Any]:
        db_info = self._db_probe()
        ai_settings = {}
        try:
            s = self._ai.get_settings()
            ai_settings = {
                "configured": bool(getattr(s, "configured", False)),
                "model": getattr(s, "model", ""),
                "provider": getattr(s, "provider", ""),
            }
        except Exception:
            ai_settings = {"configured": False, "model": "", "provider": ""}

        crawler_running = media_crawler_is_ready()
        running_crawl_tasks = len(self._repo.list_crawl_tasks(status="running"))

        # P2-10：CPU / 内存占用（非阻塞采样，首次调用可能为 0，属正常）
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
        }
        database = {
            "status": "ok" if db_info["exists"] else "error",
            "db_path": str(db_info["path"]),
            "file_size_mb": db_info["size_mb"],
            "message": "可连接" if db_info["exists"] else "文件缺失",
        }
        ai_config = {
            "status": "ok" if ai_settings["configured"] else "warning",
            "api_key_configured": ai_settings["configured"],
            "model": ai_settings["model"],
            "provider": ai_settings["provider"],
            "message": "已配置" if ai_settings["configured"] else "未配置 API Key",
        }
        crawler = {
            "status": "ok" if crawler_running else "stopped",
            "running": crawler_running,
            "tasks_count": running_crawl_tasks,
            "message": "运行中" if crawler_running else "未运行",
        }
        desktop = self._desktop_health()

        # 推导 overall
        if database["status"] == "error":
            overall = "critical"
        elif any(c["status"] == "error" for c in (database,)) or crawler["status"] == "stopped":
            overall = "degraded"
        elif any(c["status"] == "warning" for c in (ai_config,)):
            overall = "degraded"
        else:
            overall = "healthy"

        return {
            "backend": backend,
            "database": database,
            "aiConfig": ai_config,
            "crawler": crawler,
            "desktop": desktop,
            "overall": overall,
        }
    # ════════════════════════════════════════
    # P3-11: desktop heartbeat
    # ════════════════════════════════════════

    def record_desktop_heartbeat(self, info: dict | None = None) -> dict:
        """P3-11: desktop app calls this periodically to report liveness."""
        with self._desktop_lock:
            self._desktop_heartbeat = {"ts": time.time(), "info": info or {}}
        return {"ok": True, "message": "heartbeat received"}

    def _desktop_health(self) -> dict:
        """P3-11: derive desktop status from latest heartbeat."""
        with self._desktop_lock:
            ts = self._desktop_heartbeat["ts"]
        if ts and (time.time() - ts) <= self._DESKTOP_ONLINE_WINDOW:
            return {
                "status": "online",
                "message": f"desktop online ({int(time.time()-ts)}s since heartbeat)",
            }
        return {
            "status": "not_implemented",
            "message": "desktop not connected (call /api/monitor/desktop-heartbeat within 5min to go online)",
        }


    # ═══════════════════════════════════════════════════════════
    # 数据库信息
    # ═══════════════════════════════════════════════════════════

    def _db_probe(self) -> dict[str, Any]:
        """探测数据库文件大小与可读性"""
        path = get_db_path()
        try:
            size = os.path.getsize(path)
            exists = True
        except OSError:
            size = 0
            exists = False
        return {"path": path, "exists": exists, "size_mb": round(size / 1024 / 1024, 3)}

    def get_database_info(self) -> dict[str, Any]:
        probe = self._db_probe()
        path: Path = probe["path"]
        tables: list[dict[str, Any]] = []
        total_records = 0

        if probe["exists"]:
            try:
                conn = sqlite3.connect(str(path))
                try:
                    rows = conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' "
                        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                    ).fetchall()
                    for (tname,) in rows:
                        try:
                            cnt = conn.execute(f"SELECT COUNT(*) FROM {tname}").fetchone()[0]
                        except sqlite3.Error:
                            cnt = 0
                        tables.append({"table": tname, "count": int(cnt)})
                        total_records += int(cnt)
                finally:
                    conn.close()
            except sqlite3.Error as e:
                logger.warning(
                    "数据库健康检查失败 读取表信息出错: path=%s err=%s",
                    path, e, exc_info=True,
                )

        return {
            "file_path": str(path),
            "file_size_mb": probe["size_mb"],
            "table_count": len(tables),
            "total_records": total_records,
            "last_backup_at": self._latest_backup(),
            "tables": tables,
        }

    @staticmethod
    def _latest_backup() -> str | None:
        """扫描 D:\\.backups\\ 取最新备份文件时间"""
        backup_dir = Path(r"D:\.backups")
        if not backup_dir.is_dir():
            return None
        latest: float | None = None
        try:
            for f in backup_dir.iterdir():
                if f.is_file():
                    mt = f.stat().st_mtime
                    if latest is None or mt > latest:
                        latest = mt
        except OSError:
            return None
        if latest is None:
            return None
        return datetime.fromtimestamp(latest, tz=timezone.utc).isoformat()

    # ═══════════════════════════════════════════════════════════
    # API 统计（来自内存中间件）
    # ═══════════════════════════════════════════════════════════

    def get_api_stats(self) -> dict[str, Any]:
        return get_api_stats()

    # ═══════════════════════════════════════════════════════════
    # 账号健康度总览
    # ═══════════════════════════════════════════════════════════

    def get_accounts_health(self) -> list[dict[str, Any]]:
        result = []
        for acc in self._repo.list_accounts():
            # 预警数：非健康限流状态 + 健康分低于阈值
            warning_count = 0
            if acc.limit_status in ("warn", "throttled40", "safe_mode", "banned"):
                warning_count += 1
            if acc.health_score < 60:
                warning_count += 1
            result.append({
                "account_id": acc.id,
                "nickname": acc.nickname or acc.name,
                "health_score": acc.health_score,
                "limit_status": acc.limit_status,
                "today_sent": acc.today_sent,
                "warning_count": warning_count,
            })
        # 健康分升序（最差的排前面）
        result.sort(key=lambda x: x["health_score"])
        return result

    # ═══════════════════════════════════════════════════════════
    # 任务运行态
    # ═══════════════════════════════════════════════════════════

    def get_tasks_status(self) -> dict[str, Any]:
        crawl_tasks = self._repo.list_crawl_tasks()
        ct = {"total": len(crawl_tasks), "running": 0, "completed": 0, "failed": 0}
        for t in crawl_tasks:
            if t.status == "running":
                ct["running"] += 1
            elif t.status == "completed":
                ct["completed"] += 1
            elif t.status == "failed":
                ct["failed"] += 1

        # DM 队列：按线索状态聚合
        leads = self._repo.list_leads()
        dm = {"pending": 0, "sent": 0, "failed": 0, "throttled": 0}
        for l in leads:
            if l.status == "pending_outreach":
                dm["pending"] += 1
            elif l.status == "sent":
                dm["sent"] += 1
            elif l.status == "send_failed":
                dm["failed"] += 1
            elif l.status == "throttled":
                dm["throttled"] += 1

        # 调度器状态：唯一来源 = runtime_state.task_running && !safe_mode_active
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

        return {
            "crawl_tasks": ct,
            "dm_queue": dm,
            "scheduler": {"status": sched_status, "next_run": None},
        }

    # ═══════════════════════════════════════════════════════════
    # 最近系统日志（审计事件）
    # ═══════════════════════════════════════════════════════════

    def get_recent_logs(self, lines: int = 100) -> list[dict[str, Any]]:
        events = self._repo.list_compliance_events(limit=max(1, min(lines, 500)))
        return [
            {
                "id": e.id,
                "event_type": e.type,
                "severity": e.level,
                "message": e.text,
                "created_at": _iso(e.created_at),
            }
            for e in events
        ]
