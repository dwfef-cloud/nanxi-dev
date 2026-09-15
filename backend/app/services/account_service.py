"""抖音账号 Service · v1.0 契约对齐

健康分五维因子计算 + 限流状态机 + 日频配置。
依赖 Repository 接口（不直接依赖 MemoryRepository）。
"""
import logging
from datetime import datetime, timezone

from app.core import douyin_profile
from app.core.mediacrawler_runtime import set_account_user_data_dir
from app.models.domain import Account
from app.repositories.base import Repository
from app.schemas.account import AccountCreate, AccountRead, AccountUpdate
from app.services import _tracking

logger = logging.getLogger(__name__)

# 五维因子键
_FACTOR_KEYS = ("dailyFreq", "banHistory", "login", "unsubscribe", "complaint")

# 因子扣分权重
_FACTOR_SCORE = {"good": 0, "warn": -10, "bad": -25}

# 限流状态机：不可自动降级的状态（需人工恢复）
_LOCKED_STATUSES = frozenset({"throttled40", "banned"})


class AccountService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo
        self._notification_service = None  # P4-A 注入

    def set_notification_service(self, svc) -> None:
        """注入通知服务（P4-A），用于账号预警自动提醒"""
        self._notification_service = svc

    # ═══════════════════════════════════════════════════════
    # CRUD
    # ═══════════════════════════════════════════════════════

    def list_accounts(self) -> list[Account]:
        return self._repo.list_accounts()

    def get_account(self, account_id: str) -> Account:
        return self._repo.get_account(account_id)

    def create_account(self, payload: AccountCreate) -> Account:
        account = Account(
            nickname=payload.nickname,
            name=payload.nickname,  # v0.1 兼容字段
            platform=payload.platform,
            daily_limit=payload.daily_limit,
            notes=payload.notes,
            health_score=100,  # 新账号满分
            factors={k: "good" for k in _FACTOR_KEYS},
            limit_status="healthy",
        )
        saved = self._repo.save_account(account)
        # v008：分配账号专属登录目录（此刻还没有 Cookie，只是先定下"这个账号用哪份目录"）
        try:
            if not saved.profile_dir:
                saved.profile_dir = douyin_profile.profile_dir_for(saved.id).name
                saved = self._repo.save_account(saved)
        except Exception as e:
            logger.warning("分配账号登录目录失败: account_id=%s err=%s", saved.id, e)
        # 埋点：账号就绪/登录（best-effort）
        try:
            _tracking.record_account_event(
                self._repo, account_id=saved.id, action="login",
                detail=f"nickname={saved.nickname or saved.name}", success=True,
            )
        except Exception as e:
            logger.warning(
                "埋点失败 账号 login 事件写入失败: account_id=%s err=%s",
                saved.id, e, exc_info=True,
            )
        return saved

    # ═══════════════════════════════════════════════════════
    # v008：多账号登录态隔离
    # ═══════════════════════════════════════════════════════

    def activate_account(self, account_id: str) -> dict:
        """切换当前使用的抖音账号：之后采集 / 评论都用该账号那份登录态。

        只记录"用哪个账号"，不搬运任何 Cookie —— 该账号首次仍需扫码一次，
        扫码后 Cookie 常驻其专属目录，之后切回来免扫。
        """
        account = self._repo.get_account(account_id)  # 不存在时 KeyError → 路由转 404
        if not account.profile_dir:
            account.profile_dir = douyin_profile.profile_dir_for(account.id).name
            account = self._repo.save_account(account)
        douyin_profile.set_active_account_id(self._repo, account.id)
        try:
            set_account_user_data_dir(douyin_profile.user_data_dir_name_for(account.id))
        except Exception as e:
            logger.warning("切换 MediaCrawler 登录目录失败: %s", e)
        profile = douyin_profile.profile_dir_for(account.id)
        # 新账号目录为空时，继承当前已有的登录态，省掉一次扫码
        inherited = douyin_profile.inherit_login(profile)
        # 评论浏览器是独立子进程，靠状态文件拿到"当前账号用哪个目录"
        douyin_profile.write_active_profile(account.id, profile, account.nickname or account.name)
        return {
            "accountId": account.id,
            "nickname": account.nickname or account.name,
            "profileDir": str(profile),
            "loggedIn": douyin_profile.profile_has_login(profile),
            "inherited": inherited,
        }

    def get_active_account(self) -> dict:
        """当前激活账号 + 其登录目录 + 该目录是否已有登录态。"""
        aid, profile = douyin_profile.resolve_active_profile(self._repo)
        nickname = None
        if aid:
            try:
                acc = self._repo.get_account(aid)
                nickname = acc.nickname or acc.name
            except KeyError:
                aid = None
        return {
            "accountId": aid,
            "nickname": nickname,
            "profileDir": str(profile),
            "loggedIn": douyin_profile.profile_has_login(profile),
        }

    def sync_douyin_account(self) -> Account:
        """扫码登录后，把当前激活账号标记为已登录（写回账号列表）。

        判定目录由 core.douyin_profile 给出：选中了账号就查该账号专属目录，
        未选则沿用默认共享目录。多账号各自登录、互不覆盖。
        """
        aid, profile = douyin_profile.resolve_active_profile(self._repo)
        if not douyin_profile.profile_has_login(profile):
            raise ValueError("未检测到抖音登录态，请先在「上线向导 → 扫码登录」完成抖音扫码")

        target_id = aid or "douyin:active"
        try:
            existing = self._repo.get_account(target_id)
            existing.status = "active"
            existing.factors = {**(existing.factors or {}), "login": "good"}
            existing.health_score = self._calc_health_score(existing.factors)
            existing.updated_at = datetime.now(timezone.utc)
            return self._repo.save_account(existing)
        except KeyError:
            account = Account(
                id=target_id,
                nickname="抖音登录账号",
                name="抖音登录账号",
                platform="douyin",
                daily_limit=80,
                health_score=100,
                factors={k: "good" for k in _FACTOR_KEYS},
                limit_status="healthy",
                status="active",
                profile_dir=douyin_profile.profile_dir_for(target_id).name,
            )
            return self._repo.save_account(account)

    def update_account(self, account_id: str, payload: AccountUpdate) -> Account:
        """更新账号。

        - factors 更新 → 自动重算 health_score → 自动推导 limit_status（非锁定状态）
        - limit_status 显式传入 → 手动切换状态机
        - R1 触发（daily_outreach >= daily_limit 且原 limit=80）→ throttled40 + daily_limit=40
        """
        account = self._repo.get_account(account_id)
        old_limit_status = account.limit_status  # P4-A 预警对比基线
        old_health = account.health_score

        # ── 健康分因子更新（部分更新） ──
        if payload.factors is not None:
            for key, value in payload.factors.items():
                if key in _FACTOR_KEYS and value in ("good", "warn", "bad"):
                    account.factors[key] = value  # type: ignore[assignment]
            # 自动重算健康分
            account.health_score = self._calc_health_score(account.factors)
            # P2-2：factors 局部更新不得覆盖手动设置的 limit_status，故此处不再自动推导。
            # limit_status 仅由显式传入 limit_status / health_score / R1 规则驱动。

        # ── 健康分手动覆盖 ──
        if payload.health_score is not None:
            account.health_score = max(0, min(100, payload.health_score))
            if account.limit_status not in _LOCKED_STATUSES:
                account.limit_status = self._derive_limit_status(account.health_score)

        # ── 限流状态手动切换 ──
        if payload.limit_status is not None:
            account.limit_status = payload.limit_status  # type: ignore[assignment]
            # 进入 throttled40 时自动降日频
            if payload.limit_status == "throttled40" and account.daily_limit == 80:
                account.daily_limit = 40
                account.r1_note = "R1 命中：日频达上限，降速至 40/天"
            # 恢复 healthy 时重置日频
            if payload.limit_status == "healthy" and account.daily_limit == 40:
                account.daily_limit = 80
                account.r1_note = None

        # ── 日频配置 ──
        if payload.daily_limit is not None:
            account.daily_limit = payload.daily_limit
        if payload.daily_outreach is not None:
            account.daily_outreach = payload.daily_outreach
            # R1 自动触发：日频达上限且当前状态为 healthy/warn
            if (
                account.daily_outreach >= account.daily_limit
                and account.limit_status in ("healthy", "warn")
                and account.daily_limit == 80
            ):
                account.limit_status = "throttled40"  # type: ignore[assignment]
                account.daily_limit = 40
                account.r1_note = "R1 自动触发：日频达 80，降速至 40/天"

        # ── 备注与风控 ──
        if payload.notes is not None:
            account.notes = payload.notes
        if payload.last_ban_reason is not None:
            account.last_ban_reason = payload.last_ban_reason
        if payload.r1_note is not None:
            account.r1_note = payload.r1_note
        if payload.r3_note is not None:
            account.r3_note = payload.r3_note

        account.updated_at = datetime.now(timezone.utc)

        # P4-A：账号预警通知（限流状态变差 或 健康分跌破 60）
        if self._notification_service:
            worsened = account.limit_status != old_limit_status and account.limit_status not in ("healthy",)
            health_dropped = account.health_score < 60 and old_health >= 60
            if worsened:
                self._notification_service.create(
                    type="account_warning",
                    title=f"账号限流预警 · {account.nickname or account.name}",
                    content=f"限流状态 {old_limit_status} → {account.limit_status}，请及时检查账号。",
                    level="error" if account.limit_status in ("safe_mode", "banned", "throttled40") else "warning",
                    related_type="account",
                    related_id=account.id,
                )
            elif health_dropped:
                self._notification_service.create(
                    type="account_warning",
                    title=f"账号健康分偏低 · {account.nickname or account.name}",
                    content=f"健康分降至 {account.health_score}（<60），关注风控与日频。",
                    level="warning",
                    related_type="account",
                    related_id=account.id,
                )

        return self._repo.save_account(account)

    # ═══════════════════════════════════════════════════════
    # 健康分 & 状态机
    # ═══════════════════════════════════════════════════════

    @staticmethod
    def _calc_health_score(factors: dict[str, str]) -> int:
        """五维因子计算健康分：满分 100，warn -10，bad -25，clamp 0-100"""
        score = 100
        for key in _FACTOR_KEYS:
            score += _FACTOR_SCORE.get(factors.get(key, "good"), 0)
        return max(0, min(100, score))

    @staticmethod
    def _derive_limit_status(health_score: int) -> str:
        """根据健康分推导限流状态（throttled40/banned 需单独触发，不自动推导）"""
        if health_score < 40:
            return "safe_mode"
        if health_score < 60:
            return "warn"
        return "healthy"
