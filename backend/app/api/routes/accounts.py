"""抖音账号路由 · v1.0 契约对齐

GET/POST/PATCH /api/accounts
含健康分五维因子、限流状态机、日频配置。
"""
from fastapi import APIRouter, Depends, HTTPException

from app.core.dependencies import get_account_service
from app.schemas.account import AccountCreate, AccountRead, AccountUpdate
from app.services.account_service import AccountService

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.get("", response_model=list[AccountRead], response_model_by_alias=True)
def list_accounts(
    service: AccountService = Depends(get_account_service),
) -> list[AccountRead]:
    """账号列表（含健康分和限流状态）"""
    return service.list_accounts()


@router.get("/active")
def get_active_account(
    service: AccountService = Depends(get_account_service),
) -> dict:
    """当前激活账号 + 其登录目录 + 该目录是否已有登录态（多账号登录态隔离）"""
    return service.get_active_account()


@router.get("/{account_id}", response_model=AccountRead, response_model_by_alias=True)
def get_account(
    account_id: str,
    service: AccountService = Depends(get_account_service),
) -> AccountRead:
    try:
        return service.get_account(account_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Account not found") from exc


@router.post("", response_model=AccountRead, response_model_by_alias=True)
def create_account(
    payload: AccountCreate,
    service: AccountService = Depends(get_account_service),
) -> AccountRead:
    """新增账号"""
    return service.create_account(payload)


@router.post("/sync-douyin", response_model=AccountRead, response_model_by_alias=True)
def sync_douyin_account_route(
    service: AccountService = Depends(get_account_service),
) -> AccountRead:
    """登录后把已登录的抖音号同步进账号列表（幂等 upsert）"""
    try:
        return service.sync_douyin_account()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/{account_id}/activate")
def activate_account(
    account_id: str,
    service: AccountService = Depends(get_account_service),
) -> dict:
    """切换当前使用的抖音账号：之后采集 / 评论都用该账号那份登录态。

    只记录"用哪个账号"，不搬运 Cookie —— 该账号首次仍需扫码一次，
    扫码后 Cookie 常驻其专属目录，之后切回来免扫。
    """
    try:
        return service.activate_account(account_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Account not found") from exc


@router.patch("/{account_id}", response_model=AccountRead, response_model_by_alias=True)
def update_account(
    account_id: str,
    payload: AccountUpdate,
    service: AccountService = Depends(get_account_service),
) -> AccountRead:
    """更新账号（状态/备注/健康分因子/日频配置）"""
    try:
        return service.update_account(account_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Account not found") from exc
