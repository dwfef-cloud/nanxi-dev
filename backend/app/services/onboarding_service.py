"""
OnboardingService · 上手向导业务逻辑
=======================================
5 步配置聚合提交，保存到对应配置表：
  BusinessProfile / ProductKnowledge / AudienceProfile / ScriptStrategy / WeChatSettings

每步配置独立保存，返回成功保存的步骤列表。
"""
from __future__ import annotations

import glob
import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

# 本机 HTTP_PROXY 会拦截访问 127.0.0.1 的请求，检测本地服务一律绕代理。
_OPENER = build_opener(ProxyHandler({}))

from app.core import douyin_profile
from app.models.domain import (
    AudienceProfile, BusinessProfile, ProductKnowledge,
    ScriptStrategy, WeChatSettings,
)
from app.repositories.base import Repository
from app.schemas.onboarding import WizardPayload


class OnboardingService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo

    def submit_wizard(self, payload: WizardPayload) -> dict:
        """提交上手向导 5 步配置

        逐步骤保存到对应配置表（单例 upsert），返回已保存的步骤名列表。
        """
        saved: list[str] = []
        now = datetime.now(timezone.utc)

        # 第1步：业务画像
        if payload.business is not None:
            profile = self._repo.get_business_profile()
            for field, value in payload.business.model_dump().items():
                setattr(profile, field, value)
            profile.updated_at = now
            self._repo.save_business_profile(profile)
            saved.append("business")

        # 第2步：产品知识库
        if payload.product is not None:
            pk = self._repo.get_product_knowledge()
            for field, value in payload.product.model_dump().items():
                setattr(pk, field, value)
            pk.updated_at = now
            self._repo.save_product_knowledge(pk)
            saved.append("product")

        # 第3步：目标客户
        if payload.audience is not None:
            ap = self._repo.get_audience_profile()
            for field, value in payload.audience.model_dump().items():
                setattr(ap, field, value)
            ap.updated_at = now
            self._repo.save_audience_profile(ap)
            saved.append("audience")

        # 第4步：话术策略
        if payload.scripts is not None:
            ss = self._repo.get_script_strategy()
            for field, value in payload.scripts.model_dump().items():
                setattr(ss, field, value)
            ss.updated_at = now
            self._repo.save_script_strategy(ss)
            saved.append("scripts")

        # 第5步：微信转化设置
        if payload.wechat is not None:
            ws = self._repo.get_wechat_settings()
            for field, value in payload.wechat.model_dump().items():
                setattr(ws, field, value)
            ws.updated_at = now
            self._repo.save_wechat_settings(ws)
            saved.append("wechat")

        return {
            "ok": True,
            "saved": saved,
            "message": f"已保存 {len(saved)} 步配置" if saved else "未提交任何配置",
        }

    # ═══════════════════════════════════════════════════════
    # 上手状态查询 / 跳过
    # ═══════════════════════════════════════════════════════

    def get_status(self) -> dict:
        """查询上手状态：5 步各自是否已填写 + 整体状态（pending/in_progress/completed/skipped）"""
        settings = self._repo.get_system_settings("onboarding")
        skipped = settings.get("status") == "skipped"

        # 逐步骤判断是否已填写
        # 注：原第 4 步「话术策略」已删除（话术只在「话术库」一处维护），故共 4 步。
        biz = self._repo.get_business_profile()
        pk = self._repo.get_product_knowledge()
        ap = self._repo.get_audience_profile()
        ws = self._repo.get_wechat_settings()

        steps = {
            "business": any([biz.industry, biz.service_area]),
            "product": any([pk.product_name, pk.description]),
            "audience": any([ap.name, ap.needs]),
            "wechat": bool(ws.wechat_id),
        }
        done_count = sum(1 for v in steps.values() if v)
        total = len(steps)

        if skipped:
            status = "skipped"
        elif done_count >= total:
            status = "completed"
            # 同步状态标记
            self._repo.set_system_setting("onboarding", "status", "completed")
        elif done_count > 0:
            status = "in_progress"
        else:
            status = "pending"

        return {
            "status": status,
            "skipped": skipped,
            "done_count": done_count,
            "total": total,
            "steps": steps,
        }

    def skip(self) -> dict:
        """跳过上手向导，写入状态标记"""
        self._repo.set_system_setting("onboarding", "status", "skipped")
        return {"ok": True, "status": "skipped", "message": "已跳过上手向导"}

    # ═══════════════════════════════════════════════════════
    # 环境自检 (readiness)
    # ═══════════════════════════════════════════════════════

    _DEFAULT_CRAWLER_ROOT = r"D:\24\MediaCrawler-main (1)\MediaCrawler-main"
    _DEFAULT_CRAWLER_URL = "http://127.0.0.1:8090"

    def get_readiness(self) -> dict:
        """环境自检清单：逐项返回 backend/crawl_service/douyin_login/ai/account/business/database。

        blocking 仅由 crawl_service 与 douyin_login 两项决定；顶层 ok = blocking 为空。
        """
        items: list[dict] = [
            self._check_backend(),
            self._check_crawl_service(),
            self._check_douyin_login(),
            self._check_ai(),
            self._check_account(),
            self._check_business(),
            self._check_database(),
        ]
        blocking = [i["key"] for i in items if i["key"] in ("crawl_service", "douyin_login") and not i["ok"]]
        return {
            "ok": not blocking,
            "checkedAt": datetime.now(timezone.utc).isoformat(),
            "blocking": blocking,
            "items": items,
        }

    def _check_backend(self) -> dict:
        detail = "FastAPI · 运行中"
        try:
            from fastapi.routing import APIRoute

            from app.api.router import api_router
            n = self._count_routes(api_router.routes, APIRoute, set())
            if n:
                detail = f"FastAPI · {n} 条路由"
        except Exception:
            pass
        return {"key": "backend", "label": "后端服务", "ok": True,
                "detail": detail, "action": None, "link": None}

    @staticmethod
    def _count_routes(routes, api_route_cls, seen: set) -> int:
        """递归统计路由数。

        新版 FastAPI 的 include_router 产生惰性 _IncludedRouter（不展开），
        需通过 original_router 递归下钻。
        """
        n = 0
        for r in routes:
            if isinstance(r, api_route_cls):
                n += 1
                continue
            orig = getattr(r, "original_router", None)
            if orig is None or id(orig) in seen:
                continue
            seen.add(id(orig))
            n += OnboardingService._count_routes(orig.routes, api_route_cls, seen)
        return n

    def _check_crawl_service(self) -> dict:
        url = os.environ.get("MEDIA_CRAWLER_API_URL", "").strip() or self._DEFAULT_CRAWLER_URL
        url = url.rstrip("/")
        status = None
        error_message = None
        try:
            req = urllib.request.Request(url + "/api/crawler/status")
            with _OPENER.open(req, timeout=2) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace") or "{}")
            status = payload.get("status")
            error_message = payload.get("error_message")
        except Exception:
            status = None

        if status is not None:
            # MediaCrawler 空闲时常返回 status=error 且 error_message 为空，避免误导成故障
            display_status = status
            if status == "error" and not error_message:
                display_status = "空闲"
            detail = f"{url} · {display_status}"
            if error_message:
                detail += f" · {error_message}"
            return {"key": "crawl_service", "label": "采集服务（MediaCrawler）", "ok": True,
                    "detail": detail,
                    "action": {"type": "start_crawl_service", "label": "启动采集服务"},
                    "link": None}
        return {"key": "crawl_service", "label": "采集服务（MediaCrawler）", "ok": False,
                "detail": f"未启动（{url}）",
                "action": {"type": "start_crawl_service", "label": "启动采集服务"},
                "link": None}

    def _check_douyin_login(self) -> dict:
        # v008：按当前激活账号的专属目录判定；未选账号时回退默认共享目录
        aid, profile = douyin_profile.resolve_active_profile(self._repo)
        label = "抖音登录态"
        if aid:
            try:
                acc = self._repo.get_account(aid)
                label = f"抖音登录态 · {acc.nickname or acc.name}"
            except Exception:
                pass
        bd = profile
        candidates = douyin_profile.cookie_candidates(profile)
        candidates += [Path(p) for p in glob.glob(str(profile / "*.json"))]

        hit: Path | None = None
        for p in candidates:
            try:
                if p.is_file():
                    hit = p
                    break
            except OSError:
                continue

        if hit is None:
            # 递归查找 Cookies / *cookie*.json（限深度 3）
            try:
                base_depth = len(bd.parts)
                for p in bd.rglob("*"):
                    try:
                        if len(p.parts) - base_depth > 3 or not p.is_file():
                            continue
                        name = p.name.lower()
                        if name == "cookies" or (name.endswith(".json") and "cookie" in name):
                            hit = p
                            break
                    except OSError:
                        continue
            except OSError:
                pass

        if hit is None:
            return {"key": "douyin_login", "label": label, "ok": False,
                    "detail": "未检测到登录记录",
                    "action": {"type": "goto_step", "label": "去扫码登录", "step": 2},
                    "link": None}

        try:
            mtime = datetime.fromtimestamp(hit.stat().st_mtime)
        except OSError:
            mtime = datetime.now()
        stamp = mtime.strftime("%Y-%m-%d %H:%M")
        stale = datetime.now() - mtime > timedelta(days=30)
        if stale:
            detail = f"上次登录 {stamp}，已超过 30 天，可能已失效（登录态会在首次采集时实际验证）"
        else:
            detail = f"上次登录 {stamp}（登录态会在首次采集时实际验证）"
        return {"key": "douyin_login", "label": label, "ok": True,
                "detail": detail, "action": None, "link": None}

    def _check_ai(self) -> dict:
        try:
            cfg = self._repo.get_system_settings("ai") or {}
        except Exception:
            cfg = {}
        provider = (cfg.get("provider") or "doubao").strip() or "doubao"
        api_key = (cfg.get("api_key") or "").strip()
        if api_key:
            return {"key": "ai", "label": "AI 模型", "ok": True,
                    "detail": f"{provider} · 已配置", "action": None, "link": "#/settings"}
        return {"key": "ai", "label": "AI 模型", "ok": False,
                "detail": f"{provider} · 未配置 API Key", "action": None, "link": "#/settings"}

    def _check_account(self) -> dict:
        try:
            n = len(self._repo.list_accounts())
        except Exception:
            n = 0
        if n > 0:
            return {"key": "account", "label": "抖音账号", "ok": True,
                    "detail": f"已绑定 {n} 个",
                    "action": {"type": "goto_step", "label": "去绑定", "step": 3},
                    "link": None}
        return {"key": "account", "label": "抖音账号", "ok": False,
                "detail": "未绑定账号",
                "action": {"type": "goto_step", "label": "去绑定", "step": 3},
                "link": None}

    def _check_business(self) -> dict:
        try:
            st = self.get_status()
            done, total = st.get("done_count", 0), st.get("total", 4)
        except Exception:
            done, total = 0, 4
        return {"key": "business", "label": "业务资料", "ok": done >= total,
                "detail": f"{done}/{total} 步已填", "action": None,
                "link": "#/settings?tab=business"}

    def _check_database(self) -> dict:
        try:
            n = len(self._repo.list_leads())
        except Exception as e:
            return {"key": "database", "label": "数据库", "ok": False,
                    "detail": f"读取失败：{type(e).__name__}: {e}",
                    "action": None, "link": None}
        return {"key": "database", "label": "数据库", "ok": True,
                "detail": f"leads {n} 条 · 可写", "action": None, "link": None}
