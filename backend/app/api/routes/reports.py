"""
报表路由 · 周报 / 月报 / 自定义区间汇总 / 趋势
=================================================
GET /api/reports/weekly?date=YYYY-MM-DD     所在周（周一到周日）聚合
GET /api/reports/monthly?year=2026&month=9  自然月聚合
GET /api/reports/summary?start_date=&end_date=  自定义区间汇总
GET /api/reports/trend?days=14              近 N 天每日线索/加微趋势
"""
from fastapi import APIRouter, Depends, Query

from app.core.dependencies import get_report_service
from app.schemas.report import (
    DailyReport, MonthlyReport, SummaryReport, TrendResponse, WeeklyReport,
)
from app.services.report_service import ReportService

router = APIRouter(tags=["reports"])


@router.get("/reports/daily", response_model=DailyReport)
def get_daily_report(
    date: str | None = Query(None, description="指定日期 YYYY-MM-DD，缺省为今天"),
    service: ReportService = Depends(get_report_service),
) -> dict:
    """日报：返回当日（或指定日期）汇总

    新增线索 / 私信发送 / 回复 / 加微 / 成交数 / 成交金额 / 转化率。
    """
    return service.get_daily_report(date)


@router.get("/reports/weekly", response_model=WeeklyReport)
def get_weekly_report(
    date: str = Query(..., description="参考日期 YYYY-MM-DD，取该日期所在周"),
    service: ReportService = Depends(get_report_service),
) -> dict:
    """周报：以 date 所在周（周一到周日）聚合"""
    return service.get_weekly_report(date)


@router.get("/reports/monthly", response_model=MonthlyReport)
def get_monthly_report(
    year: int = Query(..., ge=2020, le=2100, description="年份"),
    month: int = Query(..., ge=1, le=12, description="月份"),
    service: ReportService = Depends(get_report_service),
) -> dict:
    """月报：自然月聚合"""
    return service.get_monthly_report(year, month)


@router.get("/reports/summary", response_model=SummaryReport)
def get_summary(
    start_date: str | None = Query(None, description="开始日期 YYYY-MM-DD，缺省走近 7 天"),
    end_date: str | None = Query(None, description="结束日期 YYYY-MM-DD，缺省走近 7 天"),
    service: ReportService = Depends(get_report_service),
) -> dict:
    """自定义日期区间汇总报表

    格式非法 / 只传一端 / 区间倒置均返回 422（Service 层校验）。
    """
    return service.get_summary(start_date, end_date)


@router.get("/reports/trend", response_model=TrendResponse)
def get_trend(
    days: int = Query(14, ge=1, le=366, description="趋势天数（未传 start_date/end_date 时生效）"),
    start_date: str | None = Query(None, description="开始日期 YYYY-MM-DD"),
    end_date: str | None = Query(None, description="结束日期 YYYY-MM-DD"),
    service: ReportService = Depends(get_report_service),
) -> dict:
    """每日新增线索 / 加微数趋势（前端趋势图用）

    传 start_date/end_date 时按区间逐日统计，与漏斗卡片保持同一口径。
    格式非法 / 只传一端 / 区间倒置均返回 422（Service 层校验）。
    """
    return service.get_daily_trend(days, start_date, end_date)
