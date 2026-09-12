"""Single-comment preparation and one-shot submission through the visible UI."""

import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


COMMENT_ITEMS = '[data-e2e="comment-item"]'
EDITORS = (
    '[contenteditable="true"]:visible, textarea[placeholder*="评论"]:visible, '
    'textarea[placeholder*="回复"]:visible, input[placeholder*="评论"]:visible, '
    'input[placeholder*="回复"]:visible'
)


def _parse_douyin_url(value):
    parsed = urlsplit(value.strip())
    if (parsed.scheme != "https"
            or parsed.hostname not in ("www.douyin.com", "douyin.com", "v.douyin.com",
                                       "www.iesdouyin.com")
            or parsed.port not in (None, 443) or parsed.username is not None):
        raise ValueError("请使用抖音 HTTPS 视频、图文链接或 v.douyin.com 分享短链接")
    return parsed


def normalize_video_url(value):
    parsed = _parse_douyin_url(value)
    match = re.fullmatch(r"/(video|note)/(\d+)/?", parsed.path)
    if parsed.hostname not in ("www.douyin.com", "douyin.com") or not match:
        raise ValueError("链接未指向视频或图文作品，请打开作品后复制地址，或输入分享短链接")
    return f"https://www.douyin.com/{match[1]}/{match[2]}"


class DouyinRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _parse_douyin_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def resolve_video_url(value):
    parsed = _parse_douyin_url(value)
    if parsed.hostname != "v.douyin.com":
        return normalize_video_url(value)
    if not re.fullmatch(r"/[A-Za-z0-9_-]+/?", parsed.path):
        raise ValueError("分享短链接不完整，请重新复制")
    request = Request(value.strip(), headers={"User-Agent": "Mozilla/5.0"})
    try:
        with build_opener(DouyinRedirectHandler()).open(request, timeout=15) as response:
            return normalize_video_url(response.geturl())
    except OSError as exc:
        raise ValueError("短链接解析失败，请检查网络，或在浏览器打开后复制作品完整地址") from exc


def classify_publish(data, text):
    if not isinstance(data, dict):
        return {"status": "unknown", "message": "响应不是有效的评论结果"}
    code = data.get("status_code")
    if code is not None and code != 0:
        return {"status": "rejected", "message": str(data.get("status_msg") or code)}
    comment = data.get("comment") or {}
    if (code == 0 and isinstance(comment, dict) and comment.get("cid")
            and comment.get("text") == text):
        return {"status": "accepted", "comment_id": str(comment["cid"]),
                "message": "服务端已接受；公开可见性仍需刷新后人工检查"}
    return {"status": "unknown", "message": "没有收到可确认的评论ID，不自动重发"}


class AttemptStore:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)

    def reserve(self, payload):
        identity = {key: payload.get(key, "") for key in ("video_url", "text", "author")}
        key = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        path = self.folder / f"{key}.json"
        # Exclusive creation also prevents two simultaneous processes from sending twice.
        with path.open("x", encoding="utf-8") as stream:
            json.dump({**payload, "status": "pending",
                       "time": datetime.now(timezone.utc).isoformat()},
                      stream, ensure_ascii=False, indent=2)
        return path

    def finish(self, path, result):
        data = json.loads(path.read_text(encoding="utf-8"))
        data.update(result)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


async def visible_challenge(page):
    dialogs = page.locator(
        '[role="dialog"]:visible, [class*="captcha"]:visible, '
        '[id*="captcha"]:visible, [class*="verify"]:visible'
    )
    for dialog in await dialogs.all():
        if re.search("验证码|安全验证|短信验证|滑块|拖动", await dialog.inner_text()):
            return True
    return False


async def unique_visible(locator, description):
    matches = [item for item in await locator.all() if await item.is_visible()]
    if len(matches) != 1:
        raise RuntimeError(f"{description}数量为 {len(matches)}，请在浏览器中保留唯一目标后重试")
    return matches[0]


async def ensure_comment_ui(page, require_editor=False, timeout=20):
    deadline = asyncio.get_running_loop().time() + timeout
    opened = False
    activated = False
    while asyncio.get_running_loop().time() < deadline:
        if await visible_challenge(page):
            raise RuntimeError("请先在浏览器中手动完成验证，然后重新预览")
        if await page.locator(EDITORS).count():
            return
        panel_visible = await page.locator(
            '[data-e2e="comment-list"]:visible, ' + COMMENT_ITEMS + ":visible"
        ).count()
        placeholders = [
            item for item in await page.get_by_text("留下你的精彩评论吧", exact=True).all()
            if await item.is_visible()
        ]
        if not require_editor and (panel_visible or placeholders):
            return
        # The collapsed composer is not contenteditable until its placeholder is clicked.
        if require_editor and placeholders and not activated:
            if len(placeholders) != 1:
                raise RuntimeError("评论输入入口不唯一，请在浏览器中保留目标评论面板")
            await placeholders[0].click()
            activated = True
        elif not opened and not panel_visible and not placeholders:
            entry = page.locator('[data-e2e="feed-comment-icon"]:visible')
            if not await entry.count():
                entry = page.get_by_role("tab", name=re.compile(r"^评论\s*[（(]?\d*[)）]?$"))
            if await entry.count():
                button = await unique_visible(entry, "评论入口")
                await button.click()
                opened = True
        await asyncio.sleep(0.2)
    if require_editor:
        raise RuntimeError("评论输入框未出现，请检查登录、评论权限，或手动点击评论输入区域后重试")
    raise RuntimeError("评论面板未出现，请在浏览器点击“抢首评”或“评论”后，用 --current-page 重试")


class CommentFlow:
    def __init__(self, page):
        self.page = page
        self.editor = None
        self.target = None
        self.target_snapshot = ""
        self.text = ""
        self.video_url = ""
        self._submitted = False

    async def prepare(self, video_url, text, author="", match="", navigate=True):
        self.video_url = await asyncio.to_thread(resolve_video_url, video_url)
        self.text = text.strip()
        if not self.text:
            raise ValueError("评论内容不能为空")
        if match and not author:
            raise ValueError("筛选原评论时必须指定作者")
        self.page.set_default_timeout(8000)
        if navigate:
            await self.page.goto(self.video_url, wait_until="domcontentloaded", timeout=30000)
        elif normalize_video_url(self.page.url) != self.video_url:
            raise RuntimeError("当前视频与指定地址不符")
        await ensure_comment_ui(self.page)
        if author:
            candidates = []
            # Only loaded comments are eligible. Never fall back to the first comment.
            for item in await self.page.locator(COMMENT_ITEMS + ":visible").all():
                own_text = await item.evaluate("""el => {
                    const copy = el.cloneNode(true);
                    copy.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="reply"]')
                        .forEach(node => node.remove());
                    return copy.innerText || copy.textContent || '';
                }""")
                names = await item.evaluate("""el => {
                    const copy = el.cloneNode(true);
                    copy.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="reply"]')
                        .forEach(node => node.remove());
                    return [...copy.querySelectorAll(
                        '[data-e2e="comment-user-name"], a[href*="/user/"]'
                    )].map(node => node.textContent.trim());
                }""")
                if author in names and (not match or match in own_text):
                    candidates.append((item, own_text))
            if len(candidates) != 1:
                raise RuntimeError(f"匹配到 {len(candidates)} 条原评论，请加载目标评论或补充原评论关键词")
            self.target, self.target_snapshot = candidates[0]
            await self.target.scroll_into_view_if_needed()
            reply = await unique_visible(self.target.get_by_text("回复", exact=True), "回复按钮")
            await reply.click()
        await ensure_comment_ui(self.page, require_editor=True)
        if self.target and await self.target.locator(EDITORS).count():
            self.editor = await unique_visible(self.target.locator(EDITORS), "目标回复输入框")
        else:
            self.editor = await unique_visible(self.page.locator(EDITORS), "评论输入框")
        placeholder = " ".join([
            await self.editor.get_attribute("placeholder") or "",
            await self.editor.get_attribute("data-placeholder") or "",
            await self.editor.get_attribute("aria-label") or "",
        ])
        if not author and "回复" in placeholder:
            raise RuntimeError("当前输入框处于回复模式，请先取消回复或指定作者")
        existing = await self.editor.evaluate("el => el.value ?? el.innerText")
        if existing.strip() and existing.strip() != self.text:
            raise RuntimeError("输入框已有其他草稿，请先处理，避免覆盖")
        await self.editor.click()
        await self.page.keyboard.press("Control+A")
        await self.page.keyboard.type(self.text, delay=30)
        if (await self.editor.evaluate("el => el.value ?? el.innerText")).strip() != self.text:
            raise RuntimeError("输入内容校验失败，未发送")
        return {"video_url": self.video_url, "text": self.text, "author": author,
                "match": match, "target": self.target_snapshot}

    async def find_send(self):
        # Semantic labels first, restricted to the editor's nearest composer.
        parent = self.editor
        for _ in range(5):
            parent = parent.locator("..")
            if await parent.locator(EDITORS).count() != 1:
                break
            buttons = parent.locator(
                'button:visible, [role="button"]:visible, [data-e2e*="send"]:visible, '
                '[data-e2e*="publish"]:visible'
            )
            matches = []
            for button in await buttons.all():
                label = " ".join([
                    await button.inner_text(),
                    await button.get_attribute("aria-label") or "",
                    await button.get_attribute("data-e2e") or "",
                ])
                if re.search(r"发送|发布|(^|\W)(send|publish)(\W|$)", label, re.I):
                    matches.append(button)
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise RuntimeError("发送按钮不唯一，请手动发送")
            if "comment-input-inner-container" in (await parent.get_attribute("class") or "").split():
                # Observed Douyin send-arrow path; do not guess among adjacent @/emoji icons.
                arrow = parent.locator(
                    '.commentInput-right-ct span:visible:has('
                    '> svg > path[d^="M12.34 16.117a1.16"])'
                )
                if await arrow.count():
                    return await unique_visible(arrow, "发送箭头")
        raise RuntimeError("未找到明确标注的发送按钮；请手动点击，不使用坐标猜测")

    async def submit(self, store, payload, timeout=15, manual=False):
        if self._submitted:
            raise RuntimeError("本次流程已提交过，不允许重发")
        if normalize_video_url(self.page.url) != self.video_url:
            raise RuntimeError("视频页面已变化，请重新预览")
        if await visible_challenge(self.page):
            raise RuntimeError("出现验证码，请先手动完成，再重新预览")
        if (await self.editor.evaluate("el => el.value ?? el.innerText")).strip() != self.text:
            raise RuntimeError("草稿内容已改变，请重新预览")
        button = None if manual else await self.find_send()
        if button is not None and (
            not await button.is_enabled()
            or await button.get_attribute("aria-disabled") == "true"
            or await button.get_attribute("disabled") is not None
        ):
            raise RuntimeError("发送按钮不可用，请检查登录和评论权限")
        try:
            record = store.reserve(payload)
        except FileExistsError:
            raise RuntimeError("已有相同评论的发送记录，请先核查 records，禁止重复提交") from None
        self._submitted = True
        response_result = asyncio.get_running_loop().create_future()
        video_id = self.video_url.rsplit("/", 1)[1]

        async def on_response(response):
            try:
                url = urlsplit(response.url)
                if (url.hostname not in ("www.douyin.com", "douyin.com")
                        or not url.path.rstrip("/").endswith("/comment/publish")
                        or response.request.method != "POST"):
                    return
                params = parse_qs(response.request.post_data or "")
                if params.get("text") != [self.text] or params.get("aweme_id") != [video_id]:
                    return
                result = classify_publish(await response.json(), self.text)
                if not response_result.done():
                    response_result.set_result(result)
            except Exception:
                # Unparseable responses cannot establish success.
                pass

        self.page.on("response", on_response)
        result = {"status": "unknown", "message": "发送结果未知，请人工核查，不自动重发"}
        try:
            if button is not None:
                await button.click()
            result = await asyncio.wait_for(response_result, timeout)
        except asyncio.TimeoutError:
            if await visible_challenge(self.page):
                result["message"] = "提交后出现验证码，请手动处理并检查结果；不自动重发"
        except Exception as exc:
            result["message"] = f"点击或确认期间异常：{exc}；请人工核查，不自动重发"
        finally:
            self.page.remove_listener("response", on_response)
            store.finish(record, result)
        return {**result, "record": str(record)}
