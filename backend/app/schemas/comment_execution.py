"""评论真实发送 Schema · 自动化执行契约

POST /api/comments/execute          → 预览 / 真实发送
GET  /api/comments/agent/status     → 自动化浏览器与登录态
POST /api/comments/agent/browser/start → 拉起浏览器供扫码登录
"""
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


class CommentExecutionRequest(_Camel):
    """评论执行请求。

    - task_id 存在时会自动补齐 video_url / text / match（match 取原评论原文，
      用于在页面上唯一定位目标评论；昵称在库中已脱敏，不作为定位依据）
    - confirm=false（默认）只预览：定位评论 + 填入草稿 + 截图，不发送
    - confirm=true 才真实提交，且同一（视频, 作者, 内容）不会重复提交
    - script_id / variant_id 是「这条内容用的是哪条话术」的凭据，由调用方
      （通常是 POST /api/scripts/comment/pick）带回来。发送成功后据此回写
      话术使用记录与变体发送数，让话术库的转化率与 R2 切换真正有数据。
    """
    task_id: str | None = None
    video_url: str = ""
    text: str = ""
    author: str = ""
    match: str = ""
    confirm: bool = False
    current_page: bool = False
    # 定位目标评论时的最大滚动轮数；不传则由自动化侧用默认值（20 轮 × 700px）
    max_scrolls: int | None = None
    # 话术来源（用于统计回写），不传则本次不计入话术效果
    script_id: str | None = None
    variant_id: str | None = None


class CommentExecutionResponse(_Camel):
    """执行结果。

    status 取值：
      preview  已定位并填入草稿，未发送
      accepted 平台已接受，返回 comment_id；公开可见性仍需刷新确认
      rejected 平台明确拒绝，message 为原因
      unknown  证据不足（网络异常/验证码/未捕获响应），未自动重发，需人工核查
      error    执行失败，message 为原因
    """
    status: str
    ok: bool = True
    message: str = ""
    task_id: str | None = None
    video_url: str | None = None
    text: str | None = None
    author: str = ""
    match: str = ""
    target: str = ""
    # 命中的回复模式信号（如「回复中」）；为空说明没能确认回复对象，不会发送
    reply_mode: str = ""
    comment_id: str | None = None
    record: str | None = None
    screenshot: str | None = None
    visible_comments: int | None = None


class CommentAgentStatusResponse(_Camel):
    """自动化浏览器状态"""
    ok: bool = True
    cdp_ready: bool = False
    logged_in: bool | None = None
    port: int = 9222
    page_count: int = 0
    douyin_pages: int = 0
    profile_dir: str = ""
    data_dir: str = ""
    interpreter: str | None = None
    message: str = ""
