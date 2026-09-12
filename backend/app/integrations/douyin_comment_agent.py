"""抖音评论自动化 CLI 代理 · 必须由 patchright 解释器执行。

为什么是独立子进程：
    获客系统后端跑在 Python 3.13（未安装 patchright），而浏览器自动化依赖
    patchright。因此由后端以子进程方式调用：
        <patchright_python> -X utf8 douyin_comment_agent.py <action>
    stdin 传入 JSON 入参，stdout 输出单行结果（前缀 @@RESULT@@，便于过滤噪声）。

支持的 action：
    status          只读探测：CDP 是否就绪、是否有抖音页、登录态
    launch_browser  拉起/复用常驻浏览器并打开抖音首页（供扫码登录）
    preview         定位目标评论并把回复内容填入草稿（不发送）
    send            重新定位并真实提交一次评论（同一内容不重复提交）

安全约束（沿用原包设计，不放松）：
    - 发送前必须确认唯一命中目标评论，绝不退化为「回复第一条」
    - 同一 (视频, 作者, 内容) 只允许提交一次，重复会被 records 拦截
    - 出现验证码一律停手，交由人工处理，不自动重试、不绕过验证
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import douyin_comments as dc  # noqa: E402

from douyin_comments import (  # noqa: E402
    COMMENT_ITEMS,
    AttemptStore,
    CommentFlow,
    ensure_comment_ui,
    resolve_video_url,
    visible_challenge,
)

DEFAULT_DATA_DIR = Path(os.environ.get("COMMENT_AGENT_DATA_DIR") or r"D:\nanxi-dev\.data\comment_agent")
DEFAULT_CDP_PORT = int(os.environ.get("DOUYIN_CDP_PORT") or 9222)
# 定位目标评论时的最大滚动轮数（每轮 400px，约 2 条评论）。抖音评论是虚拟列表，
# 单轮渲染窗口很小，必须小步多轮才能不漏。评论量大的视频需要更多轮。
DEFAULT_MAX_SCROLLS = int(os.environ.get("COMMENT_LOCATE_MAX_SCROLLS") or 30)
DRAFT_MARKER = "__nanxiReplyDraft"
# 本代理打开过的页面都打这个标记，下次运行先按标记清场，避免页面越积越多。
PAGE_MARKER = "__nanxiAgentPage"
# 被回复的那条评论，其按钮文案会从「回复」变成「回复中」——用它确认回复对象正确。
REPLYING_LABEL = "回复中"
# 回复输入框出现 / 作用域重渲染的等待上限（秒）
EDITOR_WAIT = float(os.environ.get("COMMENT_EDITOR_WAIT") or 3)
# 自动化自己留下的页面特征（视频页 / 图文页 / 未导航的空白页）。
# 这些页面在 CDP 握手期间若恰好被回收，会让 patchright 直接崩溃，见 prune_stale_pages。
_STALE_PAGE_HINTS = ("/video/", "/note/", "about:blank")

# 与 douyin_comments.CommentFlow.prepare 一致的「克隆后剔除子评论」取值脚本，
# 保证 author 推导与最终唯一性校验使用同一口径。
CLONE_TEXT_JS = """el => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="reply"]')
        .forEach(node => node.remove());
    return copy.innerText || copy.textContent || '';
}"""
CLONE_NAMES_JS = """el => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="reply"]')
        .forEach(node => node.remove());
    return [...copy.querySelectorAll(
        '[data-e2e="comment-user-name"], a[href*="/user/"]'
    )].map(node => node.textContent.trim());
}"""


class AgentError(RuntimeError):
    """可预期的业务错误（回传 detail，不当作崩溃）。"""


# ────────────────────────── 浏览器 ──────────────────────────


def _find_browser_exe() -> str | None:
    candidates = [os.environ.get("PLAYWRIGHT_CHROMIUM_PATH", "")]
    for root in (
        os.environ.get("PROGRAMFILES", ""),
        os.environ.get("PROGRAMFILES(X86)", ""),
        os.environ.get("LOCALAPPDATA", ""),
    ):
        if not root:
            continue
        candidates.append(str(Path(root) / "Google/Chrome/Application/chrome.exe"))
        candidates.append(str(Path(root) / "Microsoft/Edge/Application/msedge.exe"))
    return next((p for p in candidates if p and Path(p).is_file()), None)


def cdp_ready(port: int = DEFAULT_CDP_PORT, timeout: float = 2) -> bool:
    """探测 CDP 端口。

    必须显式绕过系统代理：本机环境设置了 HTTP_PROXY，
    走代理会把 http://127.0.0.1:<port> 判成 502 Bad Gateway。
    """
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as resp:
            return bool(json.load(resp).get("webSocketDebuggerUrl"))
    except Exception:
        return False


def launch_browser(port: int = DEFAULT_CDP_PORT, data_dir: Path = DEFAULT_DATA_DIR) -> dict:
    """拉起常驻浏览器（或复用已就绪的），返回是否新建。"""
    if cdp_ready(port):
        return {"launched": False, "message": f"调试端口 {port} 已就绪，复用现有浏览器"}
    exe = _find_browser_exe()
    if not exe:
        raise AgentError("未找到 Chrome/Edge，请安装浏览器或设置 PLAYWRIGHT_CHROMIUM_PATH")
    profile = data_dir / "browser_profile"
    profile.mkdir(parents=True, exist_ok=True)
    # CREATE_NEW_PROCESS_GROUP：让浏览器脱离本代理进程独立存活（代理执行完即退出）
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    subprocess.Popen(
        [
            exe,
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "https://www.douyin.com/",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    for _ in range(40):
        if cdp_ready(port):
            return {"launched": True, "message": f"浏览器已启动，请扫码登录（调试端口 {port}）"}
        time.sleep(0.5)
    raise AgentError(f"浏览器调试端口 {port} 未就绪，请检查端口占用或浏览器策略")


def prune_stale_pages(keep: int = 1, port: int = DEFAULT_CDP_PORT) -> list[str]:
    """清掉本代理此前遗留的自动化页面，返回被关闭页面的 URL。

    Chrome 在 patchright 握手的瞬间若有一个页面正好被回收，auto-attach 出来的
    session 会失效，驱动抛 Network.setCacheDisabled: session closed 后**直接崩溃**，
    对外表现为「端口在监听但 CDP 握手失败」——让人误判成浏览器坏了。
    因此每次连接前先清场。这里走 CDP 的 HTTP 接口而非 ws：正因为连不上才需要清场。
    """
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/json/list", timeout=5) as resp:
            targets = json.load(resp)
    except Exception:
        return []
    stale = [
        target for target in targets
        if target.get("type") == "page"
        and any(hint in (target.get("url") or "") for hint in _STALE_PAGE_HINTS)
    ]
    closed: list[str] = []
    for target in stale[keep:]:
        try:
            opener.open(f"http://127.0.0.1:{port}/json/close/{target['id']}", timeout=5).read()
        except Exception:
            continue
        closed.append((target.get("url") or "")[:90])
    return closed


def cdp_ws_url(port: int = DEFAULT_CDP_PORT, timeout: float = 5) -> str:
    """拿到 CDP 的 ws:// 地址。

    必须由我们自己（绕过代理）去读 /json/version：patchright 的 connect_over_cdp
    在收到 http:// 地址时会自己做一次 HTTP 发现，而本机存在 HTTP_PROXY，
    那次发现会被代理拦截并返回 502（浏览器明明活着也连不上）。
    直接给 ws:// 地址即可跳过该 HTTP 发现。
    """
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as resp:
            url = json.load(resp).get("webSocketDebuggerUrl")
            if url:
                return url
    except Exception:
        pass
    # Chrome 136+ 的兜底地址；MediaCrawler 的既有方案同样使用它
    return f"ws://127.0.0.1:{port}/devtools/browser"


async def ensure_browser(port: int = DEFAULT_CDP_PORT, data_dir: Path = DEFAULT_DATA_DIR) -> dict:
    """确保常驻浏览器在跑（幂等）：已在跑就什么都不做，没跑就拉起来。"""
    if cdp_ready(port):
        return {"launched": False, "message": f"复用已就绪的浏览器（{port}）"}
    return await asyncio.to_thread(launch_browser, port, data_dir)


async def connect(driver, port: int = DEFAULT_CDP_PORT):
    """连接常驻浏览器。CDP 偶发握手失败很常见，重试一次再报错。"""
    pruned = await asyncio.to_thread(prune_stale_pages, 1, port)
    if pruned:
        print(f"[agent] 连接前清理遗留页面 {len(pruned)} 个：{'、'.join(pruned)}", file=sys.stderr)
    ws_url = await asyncio.to_thread(cdp_ws_url, port)
    last: Exception | None = None
    for _ in range(2):
        try:
            browser = await driver.chromium.connect_over_cdp(ws_url, timeout=15000)
        except Exception as exc:  # noqa: BLE001 — 需要区分端口不可达与握手失败
            last = exc
            await asyncio.sleep(0.8)
            continue
        if not browser.contexts:
            raise AgentError("浏览器没有可用会话，请重启浏览器后重试")
        return browser
    if not cdp_ready(port):
        hint = f"调试端口 {port} 未监听，请先点「启动浏览器」"
    else:
        hint = f"端口 {port} 在监听但 CDP 握手失败，浏览器可能刚启动或在忙，请稍后重试"
    raise AgentError(f"无法连接常驻浏览器：{hint}。原始错误：{last}")


async def read_login_state(context) -> bool | None:
    """只读探测登录态：优先读已有抖音页的 localStorage。

    cookie 名（LOGIN_STATUS）曾被证明会误判，因此这里不用 cookie 判断；
    没有抖音页时返回 None（未知），由调用方决定是否打开页面确认。
    """
    for page in context.pages:
        try:
            if "douyin.com" not in (page.url or ""):
                continue
            state = await page.evaluate(
                "() => window.localStorage.getItem('HasUserLogin')"
            )
            return state == "1"
        except Exception:
            continue
    return None


async def close_agent_pages(context, keep=None) -> int:
    """关掉本代理此前遗留的自动化页面。

    上游只会关掉「同一条草稿」的那一页，换个回复内容或换条视频就会留下一页；
    页面越积越多之后 CDP 握手会随机崩掉（见 prune_stale_pages），所以这里按
    PAGE_MARKER 全量清掉自己的页面，不碰用户自己开的标签页。
    """
    closed = 0
    for page in list(context.pages):
        if page is keep:
            continue
        try:
            if await page.evaluate(f"() => window.{PAGE_MARKER} === true"):
                await page.close()
                closed += 1
        except Exception:
            continue
    return closed


# ────────────────────── 上游补丁（不改上游文件） ──────────────────────
#
# douyin_comments.py 与用户提供的包逐字节一致，要改行为只能在这里打运行时补丁。


def _install_upstream_patches() -> None:
    """补两处：输入框选取的竞态、以及把 page 暴露给该回落逻辑。"""
    bound: dict = {}

    original_prepare = dc.CommentFlow.prepare

    async def prepare(self, *args, **kwargs):
        bound["page"] = self.page
        try:
            return await original_prepare(self, *args, **kwargs)
        finally:
            bound.pop("page", None)

    original_unique = dc.unique_visible

    async def patient_unique(locator, description):
        """唯一的可见匹配；容一个短暂的等待窗口。

        抖音评论区是虚拟列表：点「回复」后 React 会重渲染评论项，
        「目标评论内」这种作用域选择器会在重渲染的瞬间解析为空，
        上一版就在这里随机抛「目标回复输入框数量为 0」。
        整个页面同一时刻只会渲染一个评论输入框，所以作用域为空时
        回落为页面级唯一匹配是等价的、也是安全的。
        """
        page = bound.get("page")
        deadline = asyncio.get_running_loop().time() + EDITOR_WAIT
        while True:
            matches = [item for item in await locator.all() if await item.is_visible()]
            if len(matches) == 1:
                return matches[0]
            if not matches and page is not None and "输入框" in description:
                fallback = [
                    item for item in await page.locator(dc.EDITORS).all()
                    if await item.is_visible()
                ]
                if len(fallback) == 1:
                    print(f"[agent] {description} 作用域瞬时为空，回落页面级唯一匹配",
                          file=sys.stderr)
                    return fallback[0]
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError(
                    f"{description}数量为 {len(matches)}，请在浏览器中保留唯一目标后重试"
                )
            await asyncio.sleep(0.2)

    dc.CommentFlow.prepare = prepare
    dc.unique_visible = patient_unique


_install_upstream_patches()


async def assert_reply_mode(page, target) -> str:
    """确认当前确实处于「回复这一条评论」的状态，返回命中的信号名。

    选错输入框会把「回复某条评论」发成视频下的顶层评论——公开可见且回错对象，
    比发送失败严重得多，所以打字完成后、提交之前必须核对一次。
    """
    if target is None:
        raise AgentError("未记录到目标评论，无法确认回复对象，已停止发送")
    for button in await target.get_by_text(REPLYING_LABEL, exact=True).all():
        try:
            if await button.is_visible():
                return REPLYING_LABEL
        except Exception:
            continue
    hints = page.locator('[class*="comment-input"] >> text=回复@')
    try:
        if await hints.count():
            return "回复@提示"
    except Exception:
        pass
    raise AgentError(
        f"输入框没有进入回复模式（被回复的评论未显示「{REPLYING_LABEL}」），已停止发送——"
        "否则这条内容会变成视频下的顶层评论。请在自动化浏览器里手动点开该评论的「回复」后重试"
    )




# ────────────────────────── 评论定位 ──────────────────────────

# 抖音未登录时会在视频页弹登录框；此时评论项仍存在于 DOM（被遮罩盖住），
# 若不做识别就会误报成「没有匹配到原评论」，把用户带去排查错误方向。
LOGIN_WALL_HINTS = ("扫码登录", "登录后免费畅享", "验证码登录", "密码登录", "登录即代表同意")


async def login_wall(page) -> bool:
    """检测登录弹窗是否遮挡页面。"""
    dialogs = page.locator('[role="dialog"]:visible, [class*="login"]:visible')
    for dialog in await dialogs.all():
        try:
            text = await dialog.inner_text()
        except Exception:
            continue
        if any(hint in text for hint in LOGIN_WALL_HINTS):
            return True
    return False


async def guard_page(page) -> None:
    """发送前的统一前置检查：验证码 / 未登录都要给出可执行的原因。"""
    if await visible_challenge(page):
        raise AgentError("出现验证码，请先在浏览器中手动完成验证，然后再重试")
    if await login_wall(page):
        raise AgentError(
            "抖音未登录：请先点「启动浏览器并登录」，在弹出的浏览器窗口里扫码登录，然后再发送"
        )


async def wait_for_comment_items(page, timeout: float = 20, scroll_step: int = 600) -> int:
    """等评论区加载出第一批评论项，返回数量（不做匹配）。"""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        items = await visible_items(page)
        if items:
            return len(items)
        await page.mouse.wheel(0, scroll_step)
        await asyncio.sleep(0.5)
    raise AgentError(
        "评论区已打开，但在 20 秒内没有加载出评论项；请确认已登录、评论未被折叠，"
        "在浏览器中手动展开评论后重试"
    )


async def visible_items(page) -> list:
    return [
        item for item in await page.locator(COMMENT_ITEMS + ":visible").all()
        if await item.is_visible()
    ]


async def match_author(page, match: str, items: list) -> tuple[list[str], list[str]]:
    """在给定评论项里按原文反查作者；返回 (命中的唯一作者名列表, 本条评论的文本列表)。"""
    candidates: list[str] = []
    texts: list[str] = []
    for item in items:
        try:
            own_text = await item.evaluate(CLONE_TEXT_JS)
            names = await item.evaluate(CLONE_NAMES_JS)
        except Exception:
            continue
        texts.append((own_text or "").strip()[:60])
        if match and match not in own_text:
            continue
        names = [n.strip() for n in (names or []) if n and n.strip()]
        if len(names) == 1:
            candidates.append(names[0])
    return list(dict.fromkeys(candidates)), texts


async def locate_target(page, match: str, max_scrolls: int, scroll_step: int = 400) -> tuple[str, int]:
    """边滚动加载边匹配，命中即停。

    返回 (作者昵称, 累计去重后的评论条数)；未命中时作者为空串，由调用方给出提示。

    注意：抖音评论区是**虚拟列表**，同一时刻只渲染视口附近的几条，滚过去的会被回收。
    因此必须「滚一段就匹配一次」，且累计数按去重文本统计，
    否则会把渲染窗口大小误当成已扫描条数。
    """
    seen: set[str] = set()
    for round_no in range(max_scrolls + 1):
        items = await visible_items(page)
        if items:
            found, texts = await match_author(page, match, items)
            seen.update(t for t in texts if t)
            if len(found) == 1:
                return found[0], len(seen)
            if len(found) > 1:
                raise AgentError(
                    f"原文命中了 {len(found)} 条评论（{('、').join(found[:5])}），"
                    "无法唯一确定目标，已停止发送以避免回错人；请补充更具体的原文片段"
                )
        if round_no < max_scrolls:
            await page.mouse.wheel(0, scroll_step)
            await asyncio.sleep(0.4)
    return "", len(seen)


# ────────────────────────── 动作实现 ──────────────────────────


def _screenshot_path(data_dir: Path) -> Path:
    folder = data_dir / "outputs"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{datetime.now():%Y%m%d-%H%M%S-%f}.png"


async def do_status(payload: dict) -> dict:
    port = int(payload.get("port") or DEFAULT_CDP_PORT)
    data_dir = Path(payload.get("data_dir") or DEFAULT_DATA_DIR)
    out = {
        "cdp_ready": cdp_ready(port),
        "port": port,
        "profile_dir": str(data_dir / "browser_profile"),
        "logged_in": None,
        "page_count": 0,
        "douyin_pages": 0,
        "message": "",
    }
    if not out["cdp_ready"]:
        out["message"] = "自动化浏览器未启动，请先点击「启动浏览器」"
        return out
    from patchright.async_api import async_playwright

    try:
        async with async_playwright() as driver:
            browser = await connect(driver, port)
            context = browser.contexts[0]
            out["page_count"] = len(context.pages)
            out["douyin_pages"] = sum(1 for p in context.pages if "douyin.com" in (p.url or ""))
            out["logged_in"] = await read_login_state(context)
    except AgentError as exc:
        # 端口是通的，只是这次握手没成：ok=False 但 cdp_ready 保持真实值，避免误导
        out["ok"] = False
        out["message"] = str(exc)
        return out

    if out["logged_in"] is True:
        out["message"] = "已登录抖音，可以执行评论回复"
    elif out["logged_in"] is False:
        out["message"] = "浏览器已就绪，但抖音未登录，请扫码登录"
    else:
        out["message"] = "浏览器已就绪；未检测到抖音页面，点击「启动浏览器」会打开登录页"
    return out


async def do_launch(payload: dict) -> dict:
    port = int(payload.get("port") or DEFAULT_CDP_PORT)
    data_dir = Path(payload.get("data_dir") or DEFAULT_DATA_DIR)
    info = launch_browser(port, data_dir)
    await asyncio.sleep(2)
    from patchright.async_api import async_playwright

    async with async_playwright() as driver:
        browser = await connect(driver, port)
        context = browser.contexts[0]
        page = next((p for p in context.pages if "douyin.com" in (p.url or "")), None)
        if page is None:
            page = await context.new_page()
            await page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=30000)
        await page.bring_to_front()
        logged_in = await read_login_state(context)
    return {
        **info,
        "cdp_ready": True,
        "port": port,
        "logged_in": logged_in,
        "profile_dir": str(data_dir / "browser_profile"),
        "message": info["message"] if not logged_in else "已登录抖音，可以执行评论回复",
    }


async def _open_target_page(driver, payload: dict, video_url: str):
    """为本次操作准备一个干净的页面；顺带清掉上一次预览留下的草稿页。"""
    port = int(payload.get("port") or DEFAULT_CDP_PORT)
    data_dir = Path(payload.get("data_dir") or DEFAULT_DATA_DIR)
    # 浏览器没起就顺手拉起来：用户点了「预览并定位」，弹窗出现是预期行为，
    # 比抛一个「请先启动浏览器」让人再点一次更顺。
    await ensure_browser(port, data_dir)
    browser = await connect(driver, port)
    context = browser.contexts[0]
    closed = await close_agent_pages(context)
    if closed:
        print(f"[agent] 关闭上次遗留的自动化页面 {closed} 个", file=sys.stderr)
    page = await context.new_page()
    try:
        await page.evaluate(f"() => window.{PAGE_MARKER} = true")
    except Exception:
        pass
    await page.bring_to_front()
    return context, page


async def resolve_target_author(page, reply_comment: bool, author: str, match: str,
                                max_scrolls: int) -> str:
    """要回复某条具体评论但没给作者名时，靠评论原文把它定位出来。

    库里昵称已脱敏（l***a），不能当作者名用，所以原文是唯一定位依据。
    未命中时报错而不降级为「回复第一条」——那会回错人。
    """
    if not (reply_comment and not author):
        return author
    if not match:
        raise AgentError("缺少可定位的原评论内容：请补齐评论原文，或手动指定 author")
    found, scanned = await locate_target(page, match, max_scrolls)
    if not found:
        raise AgentError(
            f"已滚动浏览 {scanned} 条评论，仍未匹配到这条原文。"
            "可能评论已被删除或折叠，也可能它排在更靠后的位置（本视频评论较多时尤其如此）——"
            "可在自动化浏览器里手动滚动到该评论后再试，或提供更独特的原文片段"
        )
    return found


async def do_preview(payload: dict) -> dict:
    data_dir = Path(payload.get("data_dir") or DEFAULT_DATA_DIR)
    text = (payload.get("text") or "").strip()
    if not text:
        raise AgentError("回复内容不能为空")
    author = (payload.get("author") or "").strip()
    match = (payload.get("match") or "").strip()
    reply_comment = bool(payload.get("reply_comment"))
    max_scrolls = int(payload.get("max_scrolls") or DEFAULT_MAX_SCROLLS)
    video_url = await asyncio.to_thread(resolve_video_url, payload["video_url"])

    from patchright.async_api import async_playwright

    async with async_playwright() as driver:
        context, page = await _open_target_page(driver, payload, video_url)
        shot = _screenshot_path(data_dir)
        try:
            await page.goto(video_url, wait_until="domcontentloaded", timeout=30000)
            await ensure_comment_ui(page)
            await wait_for_comment_items(page)
            await guard_page(page)
            author = await resolve_target_author(page, reply_comment, author, match, max_scrolls)
            flow = CommentFlow(page)
            prepared = await flow.prepare(video_url, text, author, match, navigate=False)
            reply_mode = await assert_reply_mode(page, flow.target)
            await page.screenshot(path=str(shot))
            await page.evaluate(
                f"(m) => window.{DRAFT_MARKER} = m",
                {"video_url": video_url, "text": text, "author": author, "match": match},
            )
            return {
                "status": "preview",
                "video_url": prepared["video_url"],
                "text": prepared["text"],
                "author": author,
                "match": match,
                "target": prepared.get("target", ""),
                "reply_mode": reply_mode,
                "visible_comments": len(await visible_items(page)),
                "screenshot": str(shot),
                "message": "已定位目标评论并把回复填入草稿，尚未发送",
            }
        except Exception:
            try:
                await page.screenshot(path=str(shot.with_stem(shot.stem + "-error")))
            except Exception:
                pass
            raise


async def do_send(payload: dict) -> dict:
    data_dir = Path(payload.get("data_dir") or DEFAULT_DATA_DIR)
    text = (payload.get("text") or "").strip()
    if not text:
        raise AgentError("回复内容不能为空")
    author = (payload.get("author") or "").strip()
    match = (payload.get("match") or "").strip()
    reply_comment = bool(payload.get("reply_comment"))
    video_url = await asyncio.to_thread(resolve_video_url, payload["video_url"])

    from patchright.async_api import async_playwright

    async with async_playwright() as driver:
        context, page = await _open_target_page(driver, payload, video_url)
        shot = _screenshot_path(data_dir)
        try:
            await page.goto(video_url, wait_until="domcontentloaded", timeout=30000)
            await ensure_comment_ui(page)
            await wait_for_comment_items(page)
            await guard_page(page)
            max_scrolls = int(payload.get("max_scrolls") or DEFAULT_MAX_SCROLLS)
            author = await resolve_target_author(page, reply_comment, author, match, max_scrolls)
            flow = CommentFlow(page)
            prepared = await flow.prepare(video_url, text, author, match, navigate=False)
            reply_mode = await assert_reply_mode(page, flow.target)
            if await visible_challenge(page):
                raise AgentError("出现验证码，请先在浏览器中手动完成验证，再重新发送")
            store = AttemptStore(data_dir / "records")
            try:
                result = await flow.submit(store, prepared, timeout=float(payload.get("timeout") or 20))
            except RuntimeError as exc:
                raise AgentError(str(exc)) from exc
            try:
                await page.screenshot(path=str(shot))
            except Exception:
                pass
            return {**result, "author": author, "match": match, "reply_mode": reply_mode,
                    "screenshot": str(shot)}
        except Exception:
            try:
                await page.screenshot(path=str(shot.with_stem(shot.stem + "-error")))
            except Exception:
                pass
            raise


ACTIONS = {
    "status": do_status,
    "launch_browser": do_launch,
    "preview": do_preview,
    "send": do_send,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="抖音评论自动化 CLI 代理")
    parser.add_argument("action", choices=sorted(ACTIONS))
    args = parser.parse_args()

    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("入参必须是 JSON 对象")
    except ValueError as exc:
        print(f"@@RESULT@@{json.dumps({'ok': False, 'status': 'error', 'message': f'入参解析失败：{exc}'}, ensure_ascii=False)}")
        return 2

    try:
        data = asyncio.run(ACTIONS[args.action](payload))
        out = {"ok": data.get("status", "ok") not in ("rejected", "error"), **data}
    except AgentError as exc:
        out = {"ok": False, "status": "error", "message": str(exc)}
    except Exception as exc:  # 未预期异常：不吞，交给上层展示
        out = {"ok": False, "status": "error",
               "message": f"{type(exc).__name__}: {exc}"}
    print(f"@@RESULT@@{json.dumps(out, ensure_ascii=False)}")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
