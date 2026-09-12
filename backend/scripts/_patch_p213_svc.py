# -*- coding: utf-8 -*-
"""P2-13: two-step backup restore with short-lived confirmation token."""
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

# ── backup_service: imports ──
patch(
    r"app\services\backup_service.py",
    "import json\nimport os\nimport re\nimport shutil\nimport time\n",
    "import json\nimport os\nimport re\nimport secrets\nimport shutil\nimport threading\nimport time\n",
)

# ── token store in __init__ ──
patch(
    r"app\services\backup_service.py",
    """        self._backup_dir.mkdir(parents=True, exist_ok=True)
        self._export_dir.mkdir(parents=True, exist_ok=True)
""",
    """        self._backup_dir.mkdir(parents=True, exist_ok=True)
        self._export_dir.mkdir(parents=True, exist_ok=True)
        # P2-13：恢复二次确认 token 存储（短时有效）
        self._restore_tokens: dict[str, dict] = {}
        self._restore_token_lock = threading.Lock()
        self._RESTORE_TTL = 60  # 秒
""",
)

# ── add prepare/confirm methods right before restore_backup ──
patch(
    r"app\services\backup_service.py",
    '''    def restore_backup(self, filename: str) -> dict:
        """从备份文件恢复数据库

        恢复前先创建当前数据库的临时备份（_pre_restore_*），
        然后复制备份文件覆盖当前数据库。失败时回滚。
        """
        backup_path = self._resolve_backup_path(filename)''',
    '''    # ═══════════════════════════════════════════════════════════
    # P2-13：恢复二次确认（两阶段）
    # ═══════════════════════════════════════════════════════════

    def prepare_restore(self, filename: str) -> dict:
        """第一阶段：预览要恢复的内容，返回短时确认 token。不真正覆盖生产库。"""
        backup_path = self._resolve_backup_path(filename)
        if not backup_path.exists():
            raise FileNotFoundError(f"备份文件不存在: {filename}")

        stat = backup_path.stat()
        token = secrets.token_urlsafe(24)
        now = time.time()
        with self._restore_token_lock:
            # 顺手清理过期 token
            self._restore_tokens = {
                t: meta for t, meta in self._restore_tokens.items()
                if meta["expires_at"] > now
            }
            self._restore_tokens[token] = {
                "filename": filename,
                "expires_at": now + self._RESTORE_TTL,
            }

        return {
            "confirmed": False,
            "confirm_token": token,
            "expires_in": self._RESTORE_TTL,
            "restored_from": filename,
            "message": (
                f"即将用备份 {filename} 覆盖生产库（{_fmt_size(stat.st_size)}，"
                f"{datetime.fromtimestamp(stat.st_mtime, tz=_CST).strftime('%Y-%m-%d %H:%M:%S')}）。"
                f"请在 {self._RESTORE_TTL} 秒内调用 /restore/confirm 携带 token 确认。"
            ),
        }

    def confirm_restore(self, token: str) -> dict:
        """第二阶段：凭 token 真正执行恢复。token 错误/过期则拒绝。"""
        now = time.time()
        with self._restore_token_lock:
            meta = self._restore_tokens.get(token)
            if meta is None:
                raise ValueError("确认 token 无效或不存在，请重新发起恢复预览")
            if meta["expires_at"] <= now:
                self._restore_tokens.pop(token, None)
                raise ValueError("确认 token 已过期，请重新发起恢复预览")
            # 一次性使用
            self._restore_tokens.pop(token, None)

        filename = meta["filename"]
        result = self.restore_backup(filename)
        result["confirmed"] = True
        return result

    def restore_backup(self, filename: str) -> dict:
        """从备份文件恢复数据库

        恢复前先创建当前数据库的临时备份（_pre_restore_*），
        然后复制备份文件覆盖当前数据库。失败时回滚。
        """
        backup_path = self._resolve_backup_path(filename)''',
)

print("P2-13 service DONE")
