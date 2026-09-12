"""抖音视频地址工具。

库里存在 `/video/999`、`/video/v001`、`/video/video_001`、`/video/v_fa6f026d`
这类占位地址——非空，但打开后没有评论区。拿它们去跑浏览器定位会白滚
20-30 轮评论区（约一分多钟）才失败，所以必须在入口处识别出来。
"""
import re

# 真实抖音视频 id 是 19 位数字；短于 15 位的纯数字、或以 v/video_ 开头的
# 都是造数据留下的占位值。短链（v.douyin.com/xxx）等其他形式一律视为可用。
_PLACEHOLDER_RE = re.compile(r"/video/(?:v\w*|video_\w*|\d{1,14})(?:[/?#]|$)")


def usable_video_url(url: str) -> bool:
    """判断视频地址是否可用（非空且不是占位值）。"""
    url = (url or "").strip()
    if not url:
        return False
    return _PLACEHOLDER_RE.search(url) is None


# import_comments 落库时把评论 id 拼进 external_id，形如 douyin-comment-7655613046819193634。
_COMMENT_ID_PREFIX = "douyin-comment-"


def extract_comment_id(external_id: str = "", comment_id: str = "") -> str:
    """还原评论 id —— 回复检测的匹配键。

    优先取显式 comment_id 列；为空时从 external_id 拆出。库里 106 条真实线索
    的 comment_id 列是空的，但 external_id 里完整保留了评论 id，这里做还原。
    无法还原时返回空串（调用方据此跳过回复检测，不要用假值去匹配）。
    """
    cid = (comment_id or "").strip()
    if cid:
        return cid
    ext = (external_id or "").strip()
    if ext.startswith(_COMMENT_ID_PREFIX):
        return ext[len(_COMMENT_ID_PREFIX):].strip()
    return ""
