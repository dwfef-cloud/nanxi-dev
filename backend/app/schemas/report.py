"""
报表域 Schema · 周报 / 月报 / 区间汇总 / 导出响应
===================================================
"""
from pydantic import BaseModel


class _ReportMetrics(BaseModel):
    """报表通用指标字段"""
    new_leads: int = 0
    contacted: int = 0
    replied: int = 0
    added_wechat: int = 0
    deals: int = 0
    deal_amount: float = 0.0
    conversion_rate: float = 0.0


class WeeklyReport(_ReportMetrics):
    """周报：以周一到周日为统计区间"""
    week_start: str
    week_end: str


class MonthlyReport(_ReportMetrics):
    """月报：以自然月为统计区间"""
    year: int
    month: int


class SummaryReport(_ReportMetrics):
    """自定义区间汇总报表"""
    start_date: str
    end_date: str


class DailyReport(_ReportMetrics):
    """日报：指定单日（默认今天）汇总"""
    date: str
    leads_by_status: dict[str, int] = {}


class DailyTrendPoint(BaseModel):
    """单日趋势点"""
    date: str
    new_leads: int = 0
    added_wechat: int = 0


class TrendResponse(BaseModel):
    """近 N 天趋势响应"""
    days: int
    points: list[DailyTrendPoint]


class ExportResponse(BaseModel):
    """导出文件响应"""
    # P3-7：export_id 为未来异步化预留（当前同步导出，每次导出即完成）
    export_id: str | None = None
    file_url: str
    file_name: str
    row_count: int
    format: str


class ExportStatusResponse(BaseModel):
    """P3-7：导出进度状态查询（当前为同步导出）"""
    mode: str = "sync"
    note: str = "当前为同步导出，无需进度查询；导出请求返回时文件已生成完毕"
    total: int = 0
    done: int = 0
    percent: int = 100
