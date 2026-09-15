-- ============================================================
-- 获客系统 SQLite 数据库 Schema
-- 设计原则：
--   1. datetime 存 ISO 字符串 (TEXT)
--   2. list[str] / dict 存 JSON 字符串 (TEXT)
--   3. bool 存 INTEGER (0/1)
--   4. 所有主键用 TEXT (uuid4 hex)
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════════════════════
-- 获客域
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leads (
    id                  TEXT PRIMARY KEY,
    nickname            TEXT NOT NULL DEFAULT '',
    source_url          TEXT NOT NULL DEFAULT '',
    source_keyword      TEXT NOT NULL DEFAULT '',
    platform            TEXT NOT NULL DEFAULT 'douyin',
    external_id         TEXT NOT NULL DEFAULT '',
    source_task_id      TEXT NOT NULL DEFAULT '',
    source              TEXT NOT NULL DEFAULT 'own_comment',
    comment             TEXT NOT NULL DEFAULT '',
    video               TEXT NOT NULL DEFAULT '',
    -- 精准获客（v002）：评论级溯源字段
    video_id            TEXT NOT NULL DEFAULT '',
    comment_id          TEXT NOT NULL DEFAULT '',
    comment_user_id     TEXT NOT NULL DEFAULT '',
    comment_time        TEXT NOT NULL DEFAULT '',
    matched_keywords    TEXT NOT NULL DEFAULT '[]',
    referral_note       TEXT,
    score               INTEGER NOT NULL DEFAULT 0,
    intent_level        TEXT NOT NULL DEFAULT 'C',
    intent              TEXT NOT NULL DEFAULT 'mid',
    tags                TEXT NOT NULL DEFAULT '[]',
    note                TEXT NOT NULL DEFAULT '',
    customer_need       TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'collected',
    account             TEXT,
    throttled_note      TEXT,
    fail_note           TEXT,
    reject_reason       TEXT,
    wechat_added_at     TEXT,
    manual              INTEGER NOT NULL DEFAULT 0,
    deal_amount         REAL,
    deal_at             TEXT,
    hue                 INTEGER NOT NULL DEFAULT 200,
    region              TEXT NOT NULL DEFAULT '',
    next_followup_at    TEXT,
    lost_reason         TEXT NOT NULL DEFAULT '',
    lost_reason_category TEXT NOT NULL DEFAULT 'other',
    lost_reason_note    TEXT,
    conversion_amount   REAL NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_external ON leads(platform, external_id);

CREATE TABLE IF NOT EXISTS accounts (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL DEFAULT '',
    nickname            TEXT NOT NULL DEFAULT '',
    platform            TEXT NOT NULL DEFAULT 'douyin',
    avatar_hue          INTEGER NOT NULL DEFAULT 150,
    health_score        INTEGER NOT NULL DEFAULT 80,
    factors             TEXT NOT NULL DEFAULT '{}',
    limit_status        TEXT NOT NULL DEFAULT 'healthy',
    status              TEXT NOT NULL DEFAULT 'idle',
    daily_outreach      INTEGER NOT NULL DEFAULT 0,
    daily_limit         INTEGER NOT NULL DEFAULT 80,
    daily_send_count    INTEGER NOT NULL DEFAULT 0,
    risk_level          INTEGER NOT NULL DEFAULT 0,
    weight              INTEGER NOT NULL DEFAULT 1,
    today_sent          INTEGER NOT NULL DEFAULT 0,
    today_success       INTEGER NOT NULL DEFAULT 0,
    last_ban_reason     TEXT,
    r1_note             TEXT,
    r3_note             TEXT,
    notes               TEXT NOT NULL DEFAULT '',
    -- 账号专属 Chrome 登录目录名；空 = 沿用默认共享目录 cdp_dy_user_data_dir
    profile_dir         TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    industry            TEXT NOT NULL DEFAULT '通用',
    category            TEXT NOT NULL DEFAULT 'private_message',
    is_main             INTEGER NOT NULL DEFAULT 0,
    active              INTEGER NOT NULL DEFAULT 1,
    intro               TEXT NOT NULL DEFAULT '',
    welcome_msg         TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scripts_category ON scripts(category);

CREATE TABLE IF NOT EXISTS script_variants (
    id                  TEXT PRIMARY KEY,
    script_id           TEXT NOT NULL,
    variant_id          TEXT NOT NULL,
    text                TEXT NOT NULL,
    weight              INTEGER NOT NULL DEFAULT 50,
    status              TEXT NOT NULL DEFAULT 'active',
    sent                INTEGER NOT NULL DEFAULT 0,
    replied             INTEGER NOT NULL DEFAULT 0,
    wechat_added        INTEGER,
    conv_rate           REAL,
    sample_enough       INTEGER NOT NULL DEFAULT 0,
    r2_note             TEXT,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_script ON script_variants(script_id);

CREATE TABLE IF NOT EXISTS script_templates (
    industry            TEXT PRIMARY KEY,
    count               INTEGER NOT NULL DEFAULT 0,
    desc                TEXT NOT NULL DEFAULT '',
    installed           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comment_tasks (
    id                  TEXT PRIMARY KEY,
    lead_id             TEXT NOT NULL,
    comment_content     TEXT NOT NULL DEFAULT '',
    video_title         TEXT NOT NULL DEFAULT '',
    -- v009：评论人 / 评论时间 / 视频 ID（推送到待办互动后回复页要能直接看到）
    comment_author      TEXT NOT NULL DEFAULT '',
    comment_time        TEXT NOT NULL DEFAULT '',
    video_id            TEXT NOT NULL DEFAULT '',
    -- 精准获客（v002）
    video_url           TEXT NOT NULL DEFAULT '',
    comment_id          TEXT NOT NULL DEFAULT '',
    reply_failure_reason TEXT NOT NULL DEFAULT '',
    priority            TEXT NOT NULL DEFAULT 'P2',
    reply_script_id     TEXT,
    -- v004：实际使用的变体 ID（话术效果归因用）
    reply_variant_id    TEXT NOT NULL DEFAULT '',
    reply_content       TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'pending',
    account             TEXT,
    scheduled_at        TEXT,
    replied_at          TEXT,
    user_visited        INTEGER NOT NULL DEFAULT 0,
    user_dm             INTEGER NOT NULL DEFAULT 0,
    user_replied_comment INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_tasks_status ON comment_tasks(status);
CREATE INDEX IF NOT EXISTS idx_comment_tasks_lead ON comment_tasks(lead_id);

-- ═══════════════════════════════════════════════════════════
-- 客户域
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS customers (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    source              TEXT NOT NULL DEFAULT 'own_comment',
    stage               TEXT NOT NULL DEFAULT 'added',
    lead_id             TEXT,
    est_value           REAL NOT NULL DEFAULT 0,
    deal_amount         REAL,
    deal_at             TEXT,
    wechat_added_at     TEXT,
    manual              INTEGER NOT NULL DEFAULT 0,
    referrer            TEXT,
    next_action         TEXT,
    next_at             TEXT,
    lost_reason         TEXT,
    lost_reason_category TEXT,
    lost_reason_note    TEXT,
    lost_at             TEXT,
    hue                 INTEGER NOT NULL DEFAULT 200,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(stage);

CREATE TABLE IF NOT EXISTS customer_logs (
    id                  TEXT PRIMARY KEY,
    customer_id         TEXT NOT NULL,
    text                TEXT NOT NULL,
    time                TEXT NOT NULL DEFAULT '',
    by                  TEXT NOT NULL DEFAULT '系统',
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_logs_customer ON customer_logs(customer_id);

CREATE TABLE IF NOT EXISTS followups (
    id                  TEXT PRIMARY KEY,
    customer_id         TEXT,
    customer_name       TEXT NOT NULL DEFAULT '',
    type                TEXT NOT NULL DEFAULT '',
    text                TEXT NOT NULL DEFAULT '',
    due                 TEXT NOT NULL DEFAULT '',
    overdue             INTEGER NOT NULL DEFAULT 0,
    done                INTEGER NOT NULL DEFAULT 0,
    lead_id             TEXT NOT NULL DEFAULT '',
    event_type          TEXT NOT NULL DEFAULT '',
    content             TEXT NOT NULL DEFAULT '',
    scheduled_at        TEXT,
    result              TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════
-- 消息域
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversations (
    id                  TEXT PRIMARY KEY,
    lead_id             TEXT NOT NULL,
    account_name        TEXT NOT NULL DEFAULT 'default',
    status              TEXT NOT NULL DEFAULT 'open',
    last_message_at     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    sender              TEXT NOT NULL,
    content             TEXT NOT NULL,
    is_ai_generated     INTEGER NOT NULL DEFAULT 0,
    direction           TEXT NOT NULL DEFAULT 'out',
    variant             TEXT,
    is_read             INTEGER NOT NULL DEFAULT 0,
    script_id           TEXT,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- ═══════════════════════════════════════════════════════════
-- 合规域 / 分析域
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS compliance_events (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    level               TEXT NOT NULL,
    text                TEXT NOT NULL,
    time                TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compliance_rules (
    rule_id             TEXT PRIMARY KEY,
    desc                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'standby',
    hit_at              TEXT,
    target              TEXT
);

CREATE TABLE IF NOT EXISTS runtime_state (
    id                          TEXT PRIMARY KEY DEFAULT 'default',
    safe_mode_active            INTEGER NOT NULL DEFAULT 0,
    safe_mode_reason            TEXT NOT NULL DEFAULT '',
    safe_mode_triggered_at      TEXT,
    safe_mode_trigger_source    TEXT,
    task_running                INTEGER NOT NULL DEFAULT 1,
    updated_at                  TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════
-- 任务域 / 行为事件
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tasks (
    id                  TEXT PRIMARY KEY,
    task_type           TEXT NOT NULL,
    payload             TEXT NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'pending',
    error_message       TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS behavior_events (
    id                  TEXT PRIMARY KEY,
    lead_id             TEXT NOT NULL,
    event_type          TEXT NOT NULL,
    content             TEXT NOT NULL DEFAULT '',
    value               REAL NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_behavior_lead ON behavior_events(lead_id);

-- ═══════════════════════════════════════════════════════════
-- 配置域（画像表：支持多条记录 + 主记录 is_primary）
--   每条记录一个 id（首条为 'default'），is_primary=1 的那条是「主记录」，
--   话术变量 / AI 生成 / 旧单数接口统一取主记录。
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS business_profile (
    id                  TEXT PRIMARY KEY DEFAULT 'default',
    industry            TEXT NOT NULL DEFAULT '',
    product             TEXT NOT NULL DEFAULT '',
    service_area        TEXT NOT NULL DEFAULT '',
    target_customer     TEXT NOT NULL DEFAULT '',
    price_range         TEXT NOT NULL DEFAULT '',
    conversion_goal     TEXT NOT NULL DEFAULT '添加微信',
    tone                TEXT NOT NULL DEFAULT '专业、真诚',
    self_intro          TEXT NOT NULL DEFAULT '',
    is_primary          INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_knowledge (
    id                  TEXT PRIMARY KEY DEFAULT 'default',
    product_name        TEXT NOT NULL DEFAULT '',
    description         TEXT NOT NULL DEFAULT '',
    selling_points      TEXT NOT NULL DEFAULT '',
    target_customers    TEXT NOT NULL DEFAULT '',
    price_range         TEXT NOT NULL DEFAULT '',
    faq                 TEXT NOT NULL DEFAULT '',
    forbidden_claims    TEXT NOT NULL DEFAULT '',
    service_process     TEXT NOT NULL DEFAULT '',
    case_studies        TEXT NOT NULL DEFAULT '',
    is_primary          INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audience_profile (
    id                  TEXT PRIMARY KEY DEFAULT 'default',
    name                TEXT NOT NULL DEFAULT '',
    industry            TEXT NOT NULL DEFAULT '',
    region              TEXT NOT NULL DEFAULT '',
    needs               TEXT NOT NULL DEFAULT '',
    pain_points         TEXT NOT NULL DEFAULT '',
    intent_keywords     TEXT NOT NULL DEFAULT '',
    excluded_keywords   TEXT NOT NULL DEFAULT '',
    excluded_customers  TEXT NOT NULL DEFAULT '',
    is_primary          INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS script_strategy (
    id                  TEXT PRIMARY KEY DEFAULT 'default',
    comment_script      TEXT NOT NULL DEFAULT '',
    private_message_script TEXT NOT NULL DEFAULT '',
    wechat_script       TEXT NOT NULL DEFAULT '',
    objection_script    TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wechat_settings (
    id                  TEXT PRIMARY KEY DEFAULT 'default',
    wechat_id           TEXT NOT NULL DEFAULT '',
    guide_timing        TEXT NOT NULL DEFAULT '客户明确表达兴趣后',
    guide_reason        TEXT NOT NULL DEFAULT '发送详细方案和案例',
    compliance_note     TEXT NOT NULL DEFAULT '',
    offer_hook          TEXT NOT NULL DEFAULT '',
    is_primary          INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════
-- 系统配置中心 · key-value 存储（AI / 策略 / 合规 / 采集 / 通知）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_settings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    category            TEXT NOT NULL,
    key                 TEXT NOT NULL,
    value               TEXT,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, key)
);
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings(category);

-- ═══════════════════════════════════════════════════════════
-- 采集域 · CrawlTask（MediaCrawler 对接）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS crawl_tasks (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL DEFAULT '',
    crawl_type          TEXT NOT NULL DEFAULT 'comment',
    keyword             TEXT NOT NULL DEFAULT '',
    competitor_account  TEXT NOT NULL DEFAULT '',
    video_url           TEXT NOT NULL DEFAULT '',
    source              TEXT NOT NULL DEFAULT 'own_comment',
    intent_keywords     TEXT NOT NULL DEFAULT '',
    excluded_keywords   TEXT NOT NULL DEFAULT '',
    max_comments        INTEGER NOT NULL DEFAULT 100,
    -- 精准获客（v002）：精准采集参数
    time_range          INTEGER NOT NULL DEFAULT 7,
    max_videos          INTEGER NOT NULL DEFAULT 20,
    max_comments_per_video INTEGER NOT NULL DEFAULT 50,
    sort_type           TEXT NOT NULL DEFAULT 'latest',
    status              TEXT NOT NULL DEFAULT 'pending',
    collected_count     INTEGER NOT NULL DEFAULT 0,
    imported_count      INTEGER NOT NULL DEFAULT 0,
    error_message       TEXT NOT NULL DEFAULT '',
    started_at          TEXT,
    finished_at         TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawl_tasks_status ON crawl_tasks(status);

-- ═══════════════════════════════════════════════════════════
-- 调度域 · SchedulerConfig（多账号调度）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scheduler_config (
    id                          INTEGER PRIMARY KEY,
    strategy                    TEXT NOT NULL DEFAULT 'round_robin',
    health_threshold_warn       INTEGER NOT NULL DEFAULT 60,
    health_threshold_critical   INTEGER NOT NULL DEFAULT 30,
    max_concurrent              INTEGER NOT NULL DEFAULT 3,
    updated_at                  TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════
-- 私信发送执行域 · DmSendResult（P4-D）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dm_send_results (
    id                  TEXT PRIMARY KEY,
    lead_id             TEXT NOT NULL,
    account_id          TEXT,
    content             TEXT NOT NULL,
    status              TEXT NOT NULL,
    message             TEXT,
    sender_mode         TEXT NOT NULL,  -- mock/cdp
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_send_results_lead ON dm_send_results(lead_id);
CREATE INDEX IF NOT EXISTS idx_dm_send_results_created ON dm_send_results(created_at);


-- ═══════════════════════════════════════════════════════════
-- 通知域 · Notification（P4-A 通知提醒系统）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    title               TEXT NOT NULL,
    content             TEXT NOT NULL,
    level               TEXT NOT NULL DEFAULT 'info',
    read                INTEGER NOT NULL DEFAULT 0,
    related_type        TEXT,
    related_id          TEXT,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

-- ═══════════════════════════════════════════════════════════
-- 话术使用归因域 · script_usage（埋点补全 Task4）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS script_usage (
    id                  TEXT PRIMARY KEY,
    script_id           TEXT NOT NULL,
    variant_id          TEXT,
    lead_id             TEXT NOT NULL,
    channel             TEXT NOT NULL DEFAULT 'dm',   -- comment / dm
    result              TEXT,                          -- wechat_added / deal_won / none
    used_at             TEXT NOT NULL,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_script_usage_lead ON script_usage(lead_id);
CREATE INDEX IF NOT EXISTS idx_script_usage_script ON script_usage(script_id);

-- ═══════════════════════════════════════════════════════════
-- 账号操作审计域 · account_events（埋点补全 Task5）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS account_events (
    id                  TEXT PRIMARY KEY,
    account_id          TEXT NOT NULL,
    action              TEXT NOT NULL,                 -- login/comment_sent/dm_sent/throttled/error
    detail              TEXT,
    success             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_events_account ON account_events(account_id);
CREATE INDEX IF NOT EXISTS idx_account_events_created ON account_events(created_at);
