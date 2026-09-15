"""抖音账号登录态目录（Chrome profile）解析 · 多账号隔离。

一个抖音账号 = 一份独立 Chrome user-data-dir。扫码一次后 Cookie 常驻该目录，
之后采集/评论免扫；切换账号 = 换目录。

目录布局（都在 MediaCrawler 的 browser_data 下）：
    默认（未选账号）: cdp_dy_user_data_dir
    账号专属:         cdp_acct_<slug>_dy_user_data_dir

MediaCrawler 侧的目录名由 config.USER_DATA_DIR 推导：
    USER_DATA_DIR % PLATFORM -> "acct_<slug>_dy_user_data_dir"
    CDP 模式再加 "cdp_" 前缀 -> "cdp_acct_<slug>_dy_user_data_dir"
故本模块提供的 user_data_dir_name_for() 直接给 mediacrawler_runtime 改写配置用。
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

DEFAULT_MC_ROOT = Path(r"D:\24\MediaCrawler-main (1)\MediaCrawler-main")

# 当前激活账号存 system_settings：category="douyin" / key="active_account_id"
ACTIVE_CATEGORY = "douyin"
ACTIVE_KEY = "active_account_id"


def media_crawler_root() -> Path:
    return Path(os.getenv("MEDIA_CRAWLER_ROOT", "").strip() or DEFAULT_MC_ROOT)


def account_slug(account_id: str) -> str:
    """账号 id → 目录名安全片段（账号 id 多为 uuid，含连字符）。"""
    safe = "".join(ch for ch in (account_id or "") if ch.isalnum() or ch in "-_")
    return safe[:24] or "default"


def default_profile_dir() -> Path:
    """未选择账号时的共享目录（兼容既有部署与历史登录态）。"""
    return media_crawler_root() / "browser_data" / "cdp_dy_user_data_dir"


def profile_dir_for(account_id: str) -> Path:
    return media_crawler_root() / "browser_data" / f"cdp_acct_{account_slug(account_id)}_dy_user_data_dir"


def user_data_dir_name_for(account_id: str) -> str:
    """给 MediaCrawler config.USER_DATA_DIR 用的值（%s 由平台名 dy 填充）。"""
    return f"acct_{account_slug(account_id)}_%s_user_data_dir"


def get_active_account_id(repo) -> str | None:
    try:
        return (repo.get_system_settings(ACTIVE_CATEGORY) or {}).get(ACTIVE_KEY) or None
    except Exception:
        return None


def set_active_account_id(repo, account_id: str | None) -> None:
    repo.set_system_setting(ACTIVE_CATEGORY, ACTIVE_KEY, account_id or "")


def resolve_active_profile(repo) -> tuple[str | None, Path]:
    """返回 (激活账号 id, 对应 profile 目录)；未选账号时 id 为 None、用默认目录。"""
    aid = get_active_account_id(repo)
    if not aid:
        return None, default_profile_dir()
    return aid, profile_dir_for(aid)


def cookie_candidates(profile: Path) -> list[Path]:
    """Chrome Cookie 库候选路径。

    新版 Chrome 把 Cookie 库放在 Default/Network/Cookies（老版是 Default/Cookies）。
    只认老路径会把"已登录"误判成"未登录"，故两条都要列，新版优先。
    """
    return [
        profile / "Default" / "Network" / "Cookies",
        profile / "Default" / "Cookies",
        profile / "Cookies",
    ]


def profile_has_login(profile: Path) -> bool:
    """该 profile 是否已有抖音登录态（存在 Chrome Cookie 库）。"""
    return any(p.is_file() for p in cookie_candidates(profile))


# 登录态必需文件：Cookie 库 + Local State（Chrome 用它存解密 Cookie 的主密钥，
# 不一起搬的话新目录解不开旧 Cookie）。其余 200MB+ 全是缓存，不复制。
_INHERIT_FILES = (
    "Local State",
    "Default/Network/Cookies",
    "Default/Cookies",
    "Default/Preferences",
)
_INHERIT_DIRS = ("Default/Local Storage",)


def inherit_login(dst: Path, src: Path | None = None) -> bool:
    """把已有登录态复制到新账号目录，让切换账号不必重新扫码。

    复制的是"当前默认目录里那个抖音号"。若要用另一个抖音号，仍需在浏览器里
    退出后重新扫码 —— 本函数只在目标目录为空时生效，已有登录态则不覆盖。
    """
    src = src or default_profile_dir()
    if not profile_has_login(src) or profile_has_login(dst):
        return False
    copied = False
    for rel in _INHERIT_FILES:
        s, d = src / rel, dst / rel
        if not s.is_file():
            continue
        try:
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, d)
            copied = True
        except OSError:
            continue
    for rel in _INHERIT_DIRS:
        s, d = src / rel, dst / rel
        if not s.is_dir():
            continue
        try:
            shutil.copytree(s, d, dirs_exist_ok=True)
            copied = True
        except OSError:
            continue
    return copied


# ── 跨进程传递 ──────────────────────────────────────────────
# 评论自动化浏览器跑在独立子进程（另一套 python），拿不到 Repository，
# 所以把"当前账号用哪个目录"落到状态文件，子进程直接读。
_ACTIVE_FILE = Path(r"D:\nanxi-dev\.data\active_douyin_profile.json")


def write_active_profile(account_id: str | None, profile: Path, nickname: str = "") -> None:
    try:
        _ACTIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ACTIVE_FILE.write_text(
            json.dumps(
                {"accountId": account_id or "", "profileDir": str(profile), "nickname": nickname},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass


def read_active_profile() -> Path:
    """供无 Repository 注入的场景（评论 agent 子进程）读取当前账号目录。"""
    try:
        data = json.loads(_ACTIVE_FILE.read_text(encoding="utf-8"))
        p = (data.get("profileDir") or "").strip()
        if p:
            return Path(p)
    except Exception:
        pass
    return default_profile_dir()
