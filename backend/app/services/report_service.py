"""
ReportService · 报表聚合服务
==============================
周报 / 月报 / 自定义区间汇总 / 近 N 天趋势。

聚合数据源：
  - leads（新增线索）：leads.created_at
  - messages（触达/回复）：direction='out' 为触达，direction='in' 为回复
  - leads.wechat_added_at（加微）
  - leads.status='deal_won' + deal_at（成交/金额）

转化率 = 成交数 / 新增线索数（保留2位小数，分母为0时返回0）
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException

from app.repositories.base import Repository

_DATE_HINT = "应为 YYYY-MM-DD 格式，例如 2026-01-31"

# 统一时区口径：业务侧（东八区）日期。库内时间戳以 UTC 存储（形如 2026-09-10T19:00:52+00:00），
# 所有日期归属/分桶/区间过滤一律先转东八区再取 .date()，避免跨天错位。
TZ = timezone(timedelta(hours=8))

_NAIVE_FALLBACK_FORMATS = (
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
)


def _parse_dt(value) -> datetime | None:
    """把 datetime / ISO 字符串（+00:00 / Z / 裸字符串）解析成 aware datetime。

    - 带 +00:00 / Z / 其它偏移 → 按其自身时区解析，后续统一转东八区
    - 不带时区的裸字符串 → 按 UTC 解释（与库内 100% UTC 存储一致，见抽样统计），
      绝不再叠加一次 +8，避免双重偏移
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if not s:
            return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            for fmt in _NAIVE_FALLBACK_FORMATS:
                try:
                    dt = datetime.strptime(s, fmt)
                    break
                except ValueError:
                    continue
            else:
                return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _date_part(dt_str) -> str | None:
    """时间戳（datetime 或字符串）→ 东八区日期 YYYY-MM-DD"""
    dt = _parse_dt(dt_str)
    return dt.astimezone(TZ).date().isoformat() if dt else None


def _in_range(dt_str, start_date: str, end_date: str) -> bool:
    """判断时间戳在东八区下的日期是否落在 [start_date, end_date] 区间内"""
    d = _date_part(dt_str)
    if d is None:
        return False
    return start_date <= d <= end_date


# ═══════════════════════════════════════════════════════
# 日期参数校验（非法值统一返回 422，禁止静默降级或 500）
# ═══════════════════════════════════════════════════════

def _is_blank(value) -> bool:
    """None / 空串 / 纯空白均视为「未提供」"""
    return value is None or (isinstance(value, str) and value.strip() == "")


def _parse_date(value, field: str) -> date:
    """严格解析单个 YYYY-MM-DD 日期参数，失败抛 422（不再抛裸 ValueError）"""
    if _is_blank(value):
        raise HTTPException(status_code=422, detail=f"{field} 不能为空，{_DATE_HINT}")
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail=f"{field} 格式非法，{_DATE_HINT}")


def _resolve_date_range(start_date, end_date, default_days: int = 7) -> tuple[str, str] | None:
    """校验并返回 (start_date, end_date) 的 YYYY-MM-DD 字符串。

    - 两端都未提供：返回 None（调用方自行走近 N 天兜底，行为不变）
    - 仅提供一端（含另一端为空串）：422，避免静默丢弃用户传的那个日期
    - 格式非法 / start_date > end_date：422
    """
    has_start = not _is_blank(start_date)
    has_end = not _is_blank(end_date)
    if not has_start and not has_end:
        return None
    if has_start != has_end:
        missing = "end_date" if has_start else "start_date"
        raise HTTPException(
            status_code=422,
            detail=f"start_date 与 end_date 必须同时提供或同时省略，缺少 {missing}",
        )
    start = _parse_date(start_date, "start_date")
    end = _parse_date(end_date, "end_date")
    if start > end:
        raise HTTPException(
            status_code=422,
            detail=f"start_date 不能晚于 end_date（{start.isoformat()} > {end.isoformat()}）",
        )
    return start.isoformat(), end.isoformat()


def _default_range(days: int = 7) -> tuple[str, str]:
    """默认区间：[东八区今天-days+1, 东八区今天]（与过滤口径一致）"""
    today = datetime.now(TZ).date()
    return (today - timedelta(days=days - 1)).isoformat(), today.isoformat()


class ReportService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo

    # ═══════════════════════════════════════════════════════
    # 日报（当日 / 指定单日）
    # ═══════════════════════════════════════════════════════

    def get_daily_report(self, date_str: str | None = None) -> dict:
        """日报：聚合指定单日（默认今天）的核心指标

        返回结构与区间汇总一致，便于前端日报卡片直接复用。
        额外返回 leads_by_status：当日（累计快照）各状态线索数。
        """
        if not date_str:
            date_str = datetime.now(TZ).date().isoformat()
        metrics = self._aggregate(date_str, date_str)
        # P2-11：补充各状态线索数（当前全量快照）
        leads_by_status: dict[str, int] = {}
        for lead in self._repo.list_leads():
            leads_by_status[lead.status] = leads_by_status.get(lead.status, 0) + 1
        return {
            "date": date_str,
            **metrics,
            "leads_by_status": leads_by_status,
        }

    # ═══════════════════════════════════════════════════════
    # 周报
    # ═══════════════════════════════════════════════════════

    def get_weekly_report(self, date_str: str) -> dict:
        """以 date_str 所在周（周一到周日）聚合

        date_str 非法时返回 422（原 date.fromisoformat 裸抛 ValueError → 500）。
        """
        ref = _parse_date(date_str, "date")
        monday = ref - timedelta(days=ref.weekday())
        sunday = monday + timedelta(days=6)
        metrics = self._aggregate(monday.isoformat(), sunday.isoformat())
        return {
            "week_start": monday.isoformat(),
            "week_end": sunday.isoformat(),
            **metrics,
        }

    # ═══════════════════════════════════════════════════════
    # 月报
    # ═══════════════════════════════════════════════════════

    def get_monthly_report(self, year: int, month: int) -> dict:
        """以自然月聚合"""
        first_day = date(year, month, 1)
        last_day_num = calendar.monthrange(year, month)[1]
        last_day = date(year, month, last_day_num)
        metrics = self._aggregate(first_day.isoformat(), last_day.isoformat())
        return {
            "year": year,
            "month": month,
            **metrics,
        }

    # ═══════════════════════════════════════════════════════
    # 自定义区间汇总
    # ═══════════════════════════════════════════════════════

    def get_summary(self, start_date: str | None = None, end_date: str | None = None) -> dict:
        """自定义日期区间汇总（缺省走近 7 天；非法参数返回 422）"""
        resolved = _resolve_date_range(start_date, end_date)
        start_date, end_date = resolved if resolved else _default_range(7)
        metrics = self._aggregate(start_date, end_date)
        return {
            "start_date": start_date,
            "end_date": end_date,
            **metrics,
        }

    # ═══════════════════════════════════════════════════════
    # 近 N 天趋势（前端趋势图用）
    # ═══════════════════════════════════════════════════════

    def get_daily_trend(self, days: int = 14, start_date: str | None = None,
                        end_date: str | None = None) -> dict:
        """每日新增线索 / 加微数趋势。

        传 start_date/end_date 时按该闭区间逐日统计（与漏斗卡片同口径）；
        非法 / 区间倒置 / 只传一端（含另一端为空串）时返回 422。
        """
        leads = self._repo.list_leads()
        today = datetime.now(TZ).date()

        # ── 生成日期序列：优先用显式区间，否则按 days 倒数 ──
        dates: list[date] = []
        resolved = _resolve_date_range(start_date, end_date)
        if resolved:
            s = date.fromisoformat(resolved[0])
            e = date.fromisoformat(resolved[1])
            span = min((e - s).days + 1, 366)
            dates = [s + timedelta(days=i) for i in range(span)]
        if not dates:
            days = max(1, min(int(days or 14), 366))
            dates = [today - timedelta(days=i) for i in range(days - 1, -1, -1)]

        # 初始化每天为 0
        trend_map: dict[str, dict[str, int]] = {
            d.isoformat(): {"new_leads": 0, "added_wechat": 0} for d in dates
        }
        # 统计
        for lead in leads:
            created = _date_part(lead.created_at.isoformat() if lead.created_at else None)
            if created and created in trend_map:
                trend_map[created]["new_leads"] += 1
            wechat = _date_part(lead.wechat_added_at.isoformat() if lead.wechat_added_at else None)
            if wechat and wechat in trend_map:
                trend_map[wechat]["added_wechat"] += 1
        points = [
            {"date": k, "new_leads": v["new_leads"], "added_wechat": v["added_wechat"]}
            for k, v in trend_map.items()
        ]
        return {"days": len(dates), "points": points}

    # ═══════════════════════════════════════════════════════
    # 核心聚合逻辑
    # ═══════════════════════════════════════════════════════

    def _aggregate(self, start_date: str, end_date: str) -> dict:
        """在指定日期区间内聚合所有指标"""
        leads = self._repo.list_leads()
        messages = self._repo.list_messages()

        new_leads = 0
        added_wechat = 0
        deals = 0
        deal_amount = 0.0

        for lead in leads:
            # 新增线索：按 created_at
            created = _date_part(lead.created_at.isoformat() if lead.created_at else None)
            if created and _in_range(created, start_date, end_date):
                new_leads += 1
            # 加微：按 wechat_added_at
            wechat = _date_part(lead.wechat_added_at.isoformat() if lead.wechat_added_at else None)
            if wechat and _in_range(wechat, start_date, end_date):
                added_wechat += 1
            # 成交：按 deal_at
            if lead.status == "deal_won":
                deal_dt = _date_part(lead.deal_at.isoformat() if lead.deal_at else None)
                if deal_dt and _in_range(deal_dt, start_date, end_date):
                    deals += 1
                    deal_amount += float(lead.deal_amount or 0)

        # 触达 / 回复：按 messages.direction
        contacted = 0
        replied = 0
        for msg in messages:
            msg_date = _date_part(msg.created_at.isoformat() if msg.created_at else None)
            if not msg_date or not _in_range(msg_date, start_date, end_date):
                continue
            if msg.direction == "out":
                contacted += 1
            elif msg.direction == "in":
                replied += 1

        # 转化率 = 成交数 / 新增线索数
        conversion_rate = round(deals / new_leads, 2) if new_leads > 0 else 0.0

        return {
            "new_leads": new_leads,
            "contacted": contacted,
            "replied": replied,
            "added_wechat": added_wechat,
            "deals": deals,
            "deal_amount": round(deal_amount, 2),
            "conversion_rate": conversion_rate,
        }
