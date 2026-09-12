"""
P3-15 数据分析统一API集成测试
覆盖：funnel / by-account / by-script / by-industry / by-source / export
"""
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_analytics_funnel_returns_six_stages() -> None:
    """漏斗API返回6个阶段，每阶段含数量/上步转化率/整体转化率"""
    response = client.get("/api/analytics/funnel")
    assert response.status_code == 200
    data = response.json()
    assert "start_date" in data
    assert "end_date" in data
    assert len(data["stages"]) == 6
    labels = [s["label"] for s in data["stages"]]
    assert labels == ["曝光", "入库", "触达", "回复", "加微", "成交"]
    for stage in data["stages"]:
        assert "value" in stage
        assert "step_rate" in stage
        assert "overall_rate" in stage
        assert isinstance(stage["value"], int)
        assert isinstance(stage["step_rate"], float)
        assert isinstance(stage["overall_rate"], float)
    assert "bottleneck" in data
    assert "suggestion" in data
    assert "generated_at" in data


def test_analytics_funnel_with_date_range() -> None:
    """漏斗API支持自定义日期范围"""
    response = client.get("/api/analytics/funnel?start_date=2026-01-01&end_date=2026-12-31")
    assert response.status_code == 200
    data = response.json()
    assert data["start_date"] == "2026-01-01"
    assert data["end_date"] == "2026-12-31"
    assert len(data["stages"]) == 6


def test_analytics_funnel_bottleneck_is_valid_stage() -> None:
    """瓶颈定位必须是漏斗阶段之一（或None）"""
    data = client.get("/api/analytics/funnel").json()
    valid_labels = {"曝光", "入库", "触达", "回复", "加微", "成交", None}
    assert data["bottleneck"] in valid_labels
    if data["bottleneck"]:
        assert data["suggestion"], "有瓶颈时必须给出优化建议"


def test_analytics_by_account_returns_rows() -> None:
    """按账号分析返回行数据，含健康度和转化率"""
    response = client.get("/api/analytics/by-account")
    assert response.status_code == 200
    data = response.json()
    assert "rows" in data
    assert isinstance(data["rows"], list)
    for row in data["rows"]:
        assert "name" in row
        assert "leads" in row
        assert "contacted" in row
        assert "replied" in row
        assert "wechat" in row
        assert "deal" in row
        assert "reply_rate" in row
        assert "wechat_rate" in row
        assert "health_score" in row


def test_analytics_by_account_with_date_range() -> None:
    """按账号分析支持日期范围"""
    response = client.get("/api/analytics/by-account?start_date=2026-01-01&end_date=2026-12-31")
    assert response.status_code == 200
    data = response.json()
    assert data["start_date"] == "2026-01-01"
    assert data["end_date"] == "2026-12-31"


def test_analytics_by_script_returns_top_bottom() -> None:
    """按话术分析返回全部行+TOP5+BOTTOM5"""
    response = client.get("/api/analytics/by-script")
    assert response.status_code == 200
    data = response.json()
    assert "rows" in data
    assert "top5" in data
    assert "bottom5" in data
    assert isinstance(data["rows"], list)
    assert isinstance(data["top5"], list)
    assert isinstance(data["bottom5"], list)
    assert len(data["top5"]) <= 5
    assert len(data["bottom5"]) <= 5
    for row in data["rows"]:
        assert "script_id" in row
        assert "name" in row
        assert "uses" in row
        assert "leads" in row
        assert "wechat" in row
        assert "deal" in row
        assert "conversion_rate" in row


def test_analytics_by_industry_returns_rows() -> None:
    """按行业分析返回行数据，含转化率"""
    response = client.get("/api/analytics/by-industry")
    assert response.status_code == 200
    data = response.json()
    assert "rows" in data
    for row in data["rows"]:
        assert "name" in row
        assert "leads" in row
        assert "wechat" in row
        assert "deal" in row
        assert "deal_amount" in row
        assert "wechat_rate" in row


def test_analytics_by_source_returns_rows() -> None:
    """按来源分析返回行数据，含中文标签和转化率"""
    response = client.get("/api/analytics/by-source")
    assert response.status_code == 200
    data = response.json()
    assert "rows" in data
    for row in data["rows"]:
        assert "source" in row
        assert "label" in row
        assert "leads" in row
        assert "wechat" in row
        assert "deal" in row
        assert "deal_amount" in row
        assert "wechat_rate" in row
        assert "deal_rate" in row


def test_analytics_export_xlsx_returns_file_info() -> None:
    """综合导出xlsx返回文件信息，含多sheet行数"""
    response = client.get("/api/analytics/export?format=xlsx")
    assert response.status_code == 200
    data = response.json()
    assert "file_url" in data
    assert "file_name" in data
    assert "row_count" in data
    assert "format" in data
    assert "sheets" in data
    assert data["format"] in ("xlsx", "csv")
    assert "leads" in data["sheets"]
    assert "customers" in data["sheets"]
    assert "deals" in data["sheets"]
    assert data["file_url"].startswith("/exports/")


def test_analytics_export_with_date_range() -> None:
    """综合导出支持日期范围"""
    response = client.get("/api/analytics/export?format=xlsx&start_date=2026-01-01&end_date=2026-12-31")
    assert response.status_code == 200
    data = response.json()
    assert data["start_date"] == "2026-01-01"
    assert data["end_date"] == "2026-12-31"


def test_analytics_export_csv_fallback() -> None:
    """CSV格式导出也能正常返回"""
    response = client.get("/api/analytics/export?format=csv")
    assert response.status_code == 200
    data = response.json()
    assert data["format"] == "csv"
    assert "file_url" in data
