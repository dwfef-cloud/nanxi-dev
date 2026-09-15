from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import ProxyHandler, build_opener


DEFAULT_ROOT = Path(r"D:\24\MediaCrawler-main (1)\MediaCrawler-main")
DEFAULT_API_URL = "http://127.0.0.1:8090"

# 本机 HTTP_PROXY 会拦截访问 127.0.0.1 的请求（挂起或 502），本地调用一律绕代理。
_OPENER = build_opener(ProxyHandler({}))

# 进程句柄追踪：只记录“由本后端进程拉起”的服务，外部手工启动的不会被记录。
_managed_process: subprocess.Popen[str] | None = None
_managed_python: str | None = None
_managed_root: Path | None = None
_last_start_error: str | None = None
_log_handle = None


def media_crawler_api_url() -> str:
    """单一来源：与 mediacrawler_client 使用同一个环境变量与同一个默认端口。"""
    return os.getenv("MEDIA_CRAWLER_API_URL", DEFAULT_API_URL).rstrip("/")


def _crawler_host_port() -> tuple[str, int]:
    parsed = urlparse(media_crawler_api_url())
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8090
    return host, port


def _project_root() -> Path:
    # .../backend/app/core/mediacrawler_runtime.py -> 仓库根目录
    return Path(__file__).resolve().parents[3]


def _log_path() -> Path:
    override = os.getenv("MEDIA_CRAWLER_LOG")
    if override:
        return Path(override)
    return _project_root() / ".bak" / "mediacrawler.log"


def _fetch_crawler_status(timeout: float = 1.0) -> dict | None:
    url = f"{media_crawler_api_url()}/api/crawler/status"
    try:
        with _OPENER.open(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else {}
    except (HTTPError, URLError, OSError, ValueError):
        return None


def media_crawler_is_ready() -> bool:
    return _fetch_crawler_status(timeout=0.5) is not None


def _resolve_python(root: Path) -> str | None:
    """按优先级解析 MediaCrawler 自带的 venv python，最后兜底 sys.executable。"""
    candidates: list[Path] = []
    if sys.platform == "win32":
        candidates.append(root / ".venv" / "Scripts" / "python.exe")
    else:
        candidates.append(root / ".venv" / "bin" / "python")
    # 跨平台兜底：即使当前不是 Windows，也尝试 Windows 目录布局。
    candidates.append(root / ".venv" / "Scripts" / "python.exe")
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    if sys.executable:
        return sys.executable
    return None


def _build_command(root: Path) -> list[str]:
    host, port = _crawler_host_port()
    python = _resolve_python(root)
    if python is not None:
        return [python, "-m", "uvicorn", "api.main:app", "--host", host, "--port", str(port)]
    # 最后的兜底：本机确实没有任何可用 python 时才退化为 uv。
    return ["uv", "run", "uvicorn", "api.main:app", "--host", host, "--port", str(port)]


# config.USER_DATA_DIR 默认值（%s 由平台名填充，如 dy）
_DEFAULT_USER_DATA_DIR = "%s_user_data_dir"

# 当前账号专属的 user-data-dir 名（由账号服务切换账号时设置）
_account_user_data_dir: str | None = None


def set_account_user_data_dir(name: str | None) -> None:
    """切换账号后调用：下次拉起 MediaCrawler 时使用账号专属登录目录。"""
    global _account_user_data_dir
    _account_user_data_dir = name or None


def _clear_config_cache(root: Path) -> None:
    """删除 base_config 的字节码缓存，避免改完 .py 仍加载旧值。"""
    cache_dir = root / "config" / "__pycache__"
    if not cache_dir.is_dir():
        return
    for pyc in cache_dir.glob("base_config*.pyc"):
        try:
            pyc.unlink()
        except OSError:
            pass


def _ensure_douyin_platform(root: Path, user_data_dir: str | None = None) -> None:
    """启动前校准 MediaCrawler 配置：平台恒为抖音 + 账号专属登录目录。

    - PLATFORM 必须为 "dy"：被改成 xhs 等会让采集打开小红书登录页。
    - USER_DATA_DIR 按账号隔离：传入账号专属名时写作 "acct_xxx_%s_user_data_dir"，
      CDP 模式展开为 browser_data/cdp_acct_xxx_dy_user_data_dir，与
      core.douyin_profile.profile_dir_for() 保持一致。
    """
    cfg = root / "config" / "base_config.py"
    try:
        text = cfg.read_text(encoding="utf-8")
    except OSError:
        return

    changed = False
    if not re.search(r'^PLATFORM\s*=\s*["\']dy["\']', text, re.M):
        new = re.sub(r'^PLATFORM\s*=\s*["\'][^"\']*["\']', 'PLATFORM = "dy"', text, flags=re.M)
        if new != text:
            text, changed = new, True

    want_udd = user_data_dir or _DEFAULT_USER_DATA_DIR
    if not re.search(r'^USER_DATA_DIR\s*=\s*["\']' + re.escape(want_udd) + r'["\']', text, re.M):
        new = re.sub(
            r'^USER_DATA_DIR\s*=\s*["\'][^"\']*["\']',
            'USER_DATA_DIR = "' + want_udd + '"',
            text,
            flags=re.M,
        )
        if new != text:
            text, changed = new, True

    if changed:
        try:
            cfg.write_text(text, encoding="utf-8")
        except OSError:
            return
        _clear_config_cache(root)


def _open_log_target() -> object:
    global _log_handle
    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _log_handle = open(path, "a", encoding="utf-8")
        return _log_handle
    except OSError:
        return subprocess.DEVNULL


def _launch() -> subprocess.Popen[str] | None:
    """真正拉起服务；任何失败都只记录错误并返回 None，绝不向上抛异常。"""
    global _managed_process, _managed_python, _managed_root, _last_start_error

    root = Path(os.getenv("MEDIA_CRAWLER_ROOT", str(DEFAULT_ROOT)))
    _managed_root = root
    _ensure_douyin_platform(root, _account_user_data_dir)
    if not (root / "pyproject.toml").exists():
        _last_start_error = f"MediaCrawler 目录无效（缺少 pyproject.toml）：{root}"
        return None

    command = _build_command(root)
    _managed_python = command[0]
    try:
        process = subprocess.Popen(
            command,
            cwd=str(root),
            stdout=_open_log_target(),
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
        )
    except (OSError, ValueError) as exc:
        _managed_process = None
        _last_start_error = f"启动 MediaCrawler 失败（{command[0]}）：{exc}"
        return None

    _managed_process = process
    _last_start_error = None
    return process


def media_crawler_service_status() -> dict:
    root = _managed_root or Path(os.getenv("MEDIA_CRAWLER_ROOT", str(DEFAULT_ROOT)))
    payload = _fetch_crawler_status(timeout=1.0)
    reachable = payload is not None
    managed = _managed_process is not None and _managed_process.poll() is None
    python_path = _managed_python or _resolve_python(root)
    return {
        "running": reachable,
        "reachable": reachable,
        "managed": managed,
        "url": media_crawler_api_url(),
        "pid": _managed_process.pid if managed else None,
        "root": str(root),
        "pythonPath": python_path,
        "crawlerStatus": (payload or {}).get("status"),
        "lastError": _last_start_error,
    }


def start_media_crawler() -> subprocess.Popen[str] | None:
    """启动时自动拉起（保留原契约：返回 Popen 或 None）。"""
    global _managed_process
    if os.getenv("MEDIA_CRAWLER_AUTOSTART", "true").lower() in {"0", "false", "no"}:
        return None
    if "PYTEST_CURRENT_TEST" in os.environ or media_crawler_is_ready():
        return None
    if _managed_process is not None and _managed_process.poll() is None:
        return _managed_process
    return _launch()


def start_media_crawler_service() -> dict:
    """供路由层调用：已就绪则不重复拉起；否则启动并轮询等待约 20 秒。"""
    global _last_start_error

    if media_crawler_is_ready():
        _last_start_error = None
        return media_crawler_service_status()

    process = _launch()
    if process is None:
        return media_crawler_service_status()

    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if media_crawler_is_ready():
            _last_start_error = None
            return media_crawler_service_status()
        if process.poll() is not None:
            _last_start_error = (
                f"MediaCrawler 进程已退出（exit code={process.returncode}），请查看 {_log_path()}"
            )
            return media_crawler_service_status()
        time.sleep(0.5)

    _last_start_error = f"启动超时，请查看 {_log_path()}"
    return media_crawler_service_status()


def stop_media_crawler_service() -> dict:
    """只允许停止由本后端进程拉起的服务；外部手工启动的一律拒绝。"""
    global _managed_process, _last_start_error

    process = _managed_process
    if process is None or process.poll() is not None:
        _managed_process = None
        _last_start_error = "该服务不是由本系统启动，请手动停止"
        return media_crawler_service_status()

    try:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    except OSError as exc:
        _last_start_error = f"停止 MediaCrawler 失败：{exc}"
    _managed_process = None

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and media_crawler_is_ready():
        time.sleep(0.5)

    if media_crawler_is_ready():
        _last_start_error = "已发送停止信号，但服务仍然可访问"
    else:
        _last_start_error = None
    return media_crawler_service_status()
