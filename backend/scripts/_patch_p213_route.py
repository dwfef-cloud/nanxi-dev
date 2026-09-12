# -*- coding: utf-8 -*-
"""P2-13: backup route two-step restore + schema."""
import io, os

ROOT = r"D:\nanxi-dev\backend"

def patch(relpath, old, new, count=1):
    p = os.path.join(ROOT, relpath)
    s = io.open(p, encoding="utf-8").read()
    found = s.count(old)
    assert found == count, f"{relpath}: expected {count}, got {found}: {old[:70]!r}"
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
    print("OK", relpath)

# ── schema: extend RestoreResponse + add confirm request ──
patch(
    r"app\schemas\backup.py",
    '''class RestoreResponse(BaseModel):
    """恢复操作响应"""
    success: bool
    message: str = Field(default="")
    restored_from: str = Field(default="", description="从哪个备份恢复")
    pre_restore_backup: str | None = Field(default=None, description="恢复前临时备份文件名")
''',
    '''class RestoreResponse(BaseModel):
    """恢复操作响应（两阶段：prepare 返回 token，confirm 真正执行）"""
    success: bool = True
    message: str = Field(default="")
    restored_from: str = Field(default="", description="从哪个备份恢复")
    pre_restore_backup: str | None = Field(default=None, description="恢复前临时备份文件名")
    # P2-13：prepare 阶段返回
    confirmed: bool = Field(default=True, description="是否已真正执行恢复")
    confirm_token: str | None = Field(default=None, description="二次确认 token（prepare 阶段返回）")
    expires_in: int | None = Field(default=None, description="token 有效期（秒）")


class RestoreConfirmRequest(BaseModel):
    """P2-13：确认恢复请求体"""
    token: str = Field(description="prepare 阶段返回的确认 token")
''',
)

# ── route: import confirm schema ──
patch(
    r"app\api\routes\backup.py",
    """from app.schemas.backup import (
    BackupInfo,
    BackupListResponse,
    BackupSettings,
    BackupSettingsUpdate,
    DeleteResponse,
    ExportResponse,
    RestoreResponse,
)""",
    """from app.schemas.backup import (
    BackupInfo,
    BackupListResponse,
    BackupSettings,
    BackupSettingsUpdate,
    DeleteResponse,
    ExportResponse,
    RestoreConfirmRequest,
    RestoreResponse,
)""",
)

# ── route: restore -> prepare, add confirm endpoint ──
patch(
    r"app\api\routes\backup.py",
    '''@router.post("/{filename}/restore", response_model=RestoreResponse)
def restore_backup(
    filename: str,
    service: BackupService = Depends(get_backup_service),
) -> RestoreResponse:
    """从指定备份恢复数据库（恢复前自动创建临时备份）"""
    try:
        result = service.restore_backup(filename)
        return RestoreResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"恢复失败: {e}")
''',
    '''@router.post("/{filename}/restore", response_model=RestoreResponse)
def restore_backup(
    filename: str,
    service: BackupService = Depends(get_backup_service),
) -> RestoreResponse:
    """P2-13 第一阶段：预览恢复内容并返回确认 token（不立即覆盖生产库）。

    真正覆盖需再调用 POST /{filename}/restore/confirm 并携带 token。
    """
    try:
        result = service.prepare_restore(filename)
        return RestoreResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"准备恢复失败: {e}")


@router.post("/{filename}/restore/confirm", response_model=RestoreResponse)
def confirm_restore_backup(
    filename: str,
    payload: RestoreConfirmRequest,
    service: BackupService = Depends(get_backup_service),
) -> RestoreResponse:
    """P2-13 第二阶段：凭 token 真正执行恢复（token 60 秒内有效，一次性）。"""
    try:
        result = service.confirm_restore(payload.token)
        # 路径参数 filename 必须与 token 绑定的备份一致
        if result.get("restored_from") != filename:
            raise HTTPException(status_code=400, detail="token 与备份文件名不匹配")
        return RestoreResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"恢复失败: {e}")
''',
)

print("P2-13 route DONE")
