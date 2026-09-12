"""抖音评论真实发送 · 子进程桥接层

背景：本项目后端跑在 Python 3.13（未安装 patchright），浏览器自动化必须由
装了 patchright 的解释器执行，因此这里不直接驱动浏览器，而是把请求转成
一次子进程调用：

    后端(asyncio) → <patchright python> -X utf8 douyin_comment_agent.py <action>
                  ← stdout 里 @@RESULT@@ 前缀的单行 JSON

对外仍保留原设计的调用契约（prepare=预览 / execute=真实发送），
另加 browser_status / launch_browser 用于管理扫码登录用的常驻浏览器。

环境变量：
    DOUYIN_AGENT_PYTHON      指定 patchright 解释器，默认自动探测
    DOUYIN_CDP_PORT          常驻浏览器调试端口，默认 9222
    COMMENT_AGENT_DATA_DIR   浏览器 profile / 截图 / 发送记录目录
    COMMENT_AGENT_TIMEOUT    单次调用的最长等待秒数，默认 180
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_RESULT_PREFIX = "@@RESULT@@"
_PROJECT_ROOT = Path(__file__).resolve().parents[3]

# 已确认可用的 patchright 环境（按优先级探测）
_PYTHON_CANDIDATES = (
    r"E:\douyin_mcp_env\Scripts\python.exe",
    r"E:\BossHunter-work\venv\Scripts\python.exe",
)


class CommentAgentError(RuntimeError):
    """自动发送相关的可预期错误（由路由转成 400）。"""


def _is_windows() -> bool:
    return os.name == "nt"


def resolve_agent_python() -> str:
    """定位装了 patchright 的解释器；找不到就明确报错，不静默降级。"""
    explicit = os.environ.get("DOUYIN_AGENT_PYTHON")
    if explicit:
        if Path(explicit).is_file():
            return explicit
        raise CommentAgentError(f"DOUYIN_AGENT_PYTHON 指向的文件不存在：{explicit}")
    for candidate in _PYTHON_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    raise CommentAgentError(
        "未找到装了 patchright 的 Python 解释器。请设置环境变量 DOUYIN_AGENT_PYTHON "
        "指向该解释器，例如 E:\\douyin_mcp_env\\Scripts\\python.exe"
    )


class DouyinCommentExecutor:
    """通过已登录的常驻 CDP 浏览器执行一次评论：先预览，再真实提交。"""

    def __init__(self) -> None:
        self.agent_script = Path(__file__).resolve().parent / "douyin_comment_agent.py"
        self.cdp_port = int(os.environ.get("DOUYIN_CDP_PORT") or 9222)
        self.data_dir = Path(
            os.environ.get("COMMENT_AGENT_DATA_DIR")
            or (_PROJECT_ROOT / ".data" / "comment_agent")
        )
        self.timeout = float(os.environ.get("COMMENT_AGENT_TIMEOUT") or 180)

    # ── 子进程调用 ──────────────────────────────────────────

    async def _run(self, action: str, payload: dict, timeout: float | None = None,
                   tolerate: bool = False) -> dict:
        interpreter = resolve_agent_python()
        if not self.agent_script.is_file():
            raise CommentAgentError(f"自动化代理脚本缺失：{self.agent_script}")

        body = {
            **payload,
            "port": payload.get("port") or self.cdp_port,
            "data_dir": str(payload.get("data_dir") or self.data_dir),
        }
        env = {
            **os.environ,
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            # 本机存在 HTTP_PROXY，必须让 localhost 直连：
            # 否则 patchright 的 CDP 发现请求会被代理拦成 502（浏览器活着也连不上）
            "NO_PROXY": "127.0.0.1,localhost,::1",
            "no_proxy": "127.0.0.1,localhost,::1",
        }
        proc = await asyncio.create_subprocess_exec(
            interpreter, "-X", "utf8", str(self.agent_script), action,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self.agent_script.parent),
            env=env,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(json.dumps(body, ensure_ascii=False).encode("utf-8")),
                timeout=timeout or self.timeout,
            )
        except asyncio.TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise CommentAgentError(
                f"自动化执行超时（>{timeout or self.timeout:.0f}s）。"
                "请检查浏览器是否卡住、是否弹出验证码，处理后在浏览器里重试"
            ) from exc

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        result = self._parse(stdout)
        if result is None:
            tail = (stderr or stdout).strip().splitlines()[-4:]
            logger.error("评论自动化代理无有效输出 action=%s stderr=%s", action, stderr[-2000:])
            raise CommentAgentError(
                "自动化代理未返回结果，最后输出：" + (" / ".join(tail) if tail else "（空）")
            )
        if not result.get("ok", True) and not tolerate:
            raise CommentAgentError(result.get("message") or "自动化执行失败")
        return result

    @staticmethod
    def _parse(stdout: str) -> dict | None:
        for line in reversed(stdout.splitlines()):
            if line.startswith(_RESULT_PREFIX):
                try:
                    return json.loads(line[len(_RESULT_PREFIX):])
                except ValueError:
                    return None
        return None

    # ── 对外接口 ────────────────────────────────────────────

    async def browser_status(self) -> dict:
        """探测自动化浏览器与抖音登录态（只读，不打开新页面）。

        tolerate=True：浏览器没起来 / CDP 握手失败时也要拿到 cdp_ready 等真实字段，
        让前端能准确区分「没启动」和「启动了但没登录」。
        """
        return await self._run("status", {}, timeout=60, tolerate=True)

    async def launch_browser(self) -> dict:
        """拉起/复用常驻浏览器并打开抖音首页，供扫码登录。"""
        return await self._run("launch_browser", {}, timeout=120)

    async def prepare(self, video_url: str, text: str, author: str = "", match: str = "",
                      current_page: bool = False, max_scrolls: int | None = None) -> dict:
        """预览：定位目标评论并把回复内容填入草稿，不发送。"""
        return await self._run("preview", {
            "video_url": video_url,
            "text": text,
            "author": author,
            "match": match,
            "reply_comment": True,
            "current_page": current_page,
            "max_scrolls": max_scrolls,
        })

    async def execute(self, payload: dict, timeout: float = 15) -> dict:
        """真实发送一次评论；相同（视频, 作者, 内容）不会重复提交。"""
        # 子进程预算 = 提交等待 + 导航/滚动定位的余量（默认 20 轮滚动可能耗时 30s+）
        budget = max(float(timeout), 30.0) + 120.0
        return await self._run("send", {
            "video_url": payload["video_url"],
            "text": payload["text"],
            "author": payload.get("author", ""),
            "match": payload.get("match", ""),
            "reply_comment": bool(payload.get("reply_comment")),
            "timeout": timeout,
            "max_scrolls": payload.get("max_scrolls"),
        }, timeout=budget)

    # ── 供 /health 类探针使用的同步信息 ──────────────────────

    def describe(self) -> dict:
        try:
            interpreter = resolve_agent_python()
        except CommentAgentError as exc:
            interpreter = None
            error = str(exc)
        else:
            error = ""
        return {
            "interpreter": interpreter,
            "agent_script": str(self.agent_script),
            "agent_script_exists": self.agent_script.is_file(),
            "cdp_port": self.cdp_port,
            "data_dir": str(self.data_dir),
            "platform": sys.platform if not _is_windows() else "windows",
            "error": error,
        }
