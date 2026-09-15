from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.api.router import api_router
from app.core.api_stats import register_api_stats
from app.core import douyin_profile
from app.core.mediacrawler_runtime import set_account_user_data_dir, start_media_crawler
from app.core.dependencies import get_backup_service, get_repository

ROOT = Path(__file__).resolve().parent


def _restore_active_account() -> None:
    """重启后恢复上次选中的抖音账号：同步状态文件 + MediaCrawler 登录目录。

    必须在拉起 MediaCrawler 之前执行，否则采集会退回默认共享目录。
    """
    repo = get_repository()
    aid, profile = douyin_profile.resolve_active_profile(repo)
    nickname = ""
    if aid:
        try:
            acc = repo.get_account(aid)
            nickname = acc.nickname or acc.name or ""
        except Exception:
            nickname = ""
        set_account_user_data_dir(douyin_profile.user_data_dir_name_for(aid))
    douyin_profile.write_active_profile(aid, profile, nickname)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # v008：先恢复上次选中的账号，再拉起 MediaCrawler（决定它用哪份登录态）
    try:
        _restore_active_account()
    except Exception as e:
        print(f"[main] 恢复激活账号失败（不影响启动）: {e}")
    app.state.media_crawler_process = start_media_crawler()
    # 自动备份启动检查（只追加，不修改现有逻辑）
    try:
        backup_service = get_backup_service()
        backup_service.auto_backup_check()
    except Exception as e:
        print(f"[main] 自动备份启动检查失败（不影响启动）: {e}")
    yield
    process = getattr(app.state, "media_crawler_process", None)
    if process is not None and process.poll() is None:
        process.terminate()
    # 关闭阶段：释放 Repository 持有的 sqlite 长连接（幂等，失败不影响退出）
    try:
        repo = get_repository()
        close_repo = getattr(repo, "close", None)
        if callable(close_repo):
            close_repo()
    except Exception as e:
        print(f"[main] 释放 Repository 连接失败（不影响退出）: {e}")


def create_app() -> FastAPI:
    app = FastAPI(title="Douyin Lead System", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # P4-C：API 统计中间件（内存计数，供 /api/monitor/api-stats 读取）
    register_api_stats(app)
    app.include_router(api_router)
    # 前端：使用项目根目录下的 frontend/（新版业务工作台），老版 webui 已归档备份
    FRONTEND_DIR = ROOT.parent.parent / "frontend"
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="frontend-assets")
    # 导出文件静态目录（D 盘）
    _exports_dir = Path(r"D:\.exports")
    _exports_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/exports", StaticFiles(directory=str(_exports_dir)), name="exports")

    @app.get("/")
    def home() -> FileResponse:
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    return app


app = create_app()
