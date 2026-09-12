"""
Repository 抽象接口 · 数据底座契约
====================================
所有业务层（Service）只依赖本接口，不感知底层是内存还是 SQLite。

实现方：
  - MemoryRepository（开发/测试用，重启丢失）
  - SqliteRepository（生产用，待实现）

子智能体开发时：
  1. 业务层 from app.repositories.base import Repository
  2. 依赖注入传入具体实现
  3. 新增查询方法先在本接口声明，再到各实现里补
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable

from app.models.domain import (
    Account, AccountEvent, CommentReplyTask, ComplianceEvent, ComplianceRule, Conversation,
    CrawlTask, Customer, CustomerLog, DmSendResult, FollowUp, Lead,
    LeadBehaviorEvent, Message, Notification, ProductKnowledge, RuntimeState,
    Script, ScriptStrategy, ScriptTemplate, ScriptUsage, ScriptVariant, Task,
    AudienceProfile, BusinessProfile, WeChatSettings,
)


class Repository(ABC):
    """数据访问层抽象接口"""

    # ═══════════════════════════════════════════════════════
    # 获客域 · Lead
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_leads(
        self,
        status: str | None = None,
        source: str | None = None,
        keyword: str | None = None,
        min_score: int | None = None,
    ) -> list[Lead]:
        """线索列表，支持按状态/来源/关键词/最低分筛选"""

    @abstractmethod
    def get_lead(self, lead_id: str) -> Lead:
        """按 ID 获取线索，不存在抛 KeyError"""

    @abstractmethod
    def save_lead(self, lead: Lead) -> Lead:
        """新增或更新线索（upsert）"""

    @abstractmethod
    def find_lead_by_external(self, platform: str, external_id: str) -> Lead | None:
        """按平台+外部ID去重查找"""

    @abstractmethod
    def delete_lead(self, lead_id: str) -> None:
        """删除线索（软删除可选，当前硬删除）"""

    # ═══════════════════════════════════════════════════════
    # 获客域 · Account
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_accounts(self) -> list[Account]:
        ...

    @abstractmethod
    def get_account(self, account_id: str) -> Account:
        ...

    @abstractmethod
    def save_account(self, account: Account) -> Account:
        ...

    # ═══════════════════════════════════════════════════════
    # 获客域 · Script / Variant / Template
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_scripts(self, category: str | None = None, active: bool | None = None) -> list[Script]:
        ...

    @abstractmethod
    def get_script(self, script_id: str) -> Script:
        ...

    @abstractmethod
    def save_script(self, script: Script) -> Script:
        ...

    @abstractmethod
    def list_variants(self, script_id: str) -> list[ScriptVariant]:
        ...

    @abstractmethod
    def save_variant(self, variant: ScriptVariant) -> ScriptVariant:
        ...

    @abstractmethod
    def list_script_templates(self) -> list[ScriptTemplate]:
        ...

    # ═══════════════════════════════════════════════════════
    # 获客域 · CommentReplyTask（评论引流策略核心）
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_comment_tasks(self, status: str | None = None) -> list[CommentReplyTask]:
        ...

    @abstractmethod
    def get_comment_task(self, task_id: str) -> CommentReplyTask:
        ...

    @abstractmethod
    def save_comment_task(self, task: CommentReplyTask) -> CommentReplyTask:
        ...

    # ═══════════════════════════════════════════════════════
    # 客户域 · Customer / Log
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_customers(self, stage: str | None = None) -> list[Customer]:
        ...

    @abstractmethod
    def get_customer(self, customer_id: str) -> Customer:
        ...

    @abstractmethod
    def save_customer(self, customer: Customer) -> Customer:
        ...

    @abstractmethod
    def list_customer_logs(self, customer_id: str) -> list[CustomerLog]:
        ...

    @abstractmethod
    def save_customer_log(self, log: CustomerLog) -> CustomerLog:
        ...

    @abstractmethod
    def delete_customer(self, customer_id: str) -> None:
        """删除客户及其跟进日志（不存在抛 KeyError）"""

    # ═══════════════════════════════════════════════════════
    # 客户域 · FollowUp
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_followups(self, date: str | None = None, done: bool | None = None) -> list[FollowUp]:
        """date 格式 'today' / 'overdue' / 'upcoming' 或具体日期"""

    @abstractmethod
    def get_followup(self, followup_id: str) -> FollowUp:
        ...

    @abstractmethod
    def save_followup(self, followup: FollowUp) -> FollowUp:
        ...

    # ═══════════════════════════════════════════════════════
    # 消息域 · Conversation / Message
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_conversations(self) -> list[Conversation]:
        ...

    @abstractmethod
    def get_conversation(self, conversation_id: str) -> Conversation:
        ...

    @abstractmethod
    def save_conversation(self, conversation: Conversation) -> Conversation:
        ...

    @abstractmethod
    def list_messages(self, conversation_id: str | None = None) -> list[Message]:
        ...

    @abstractmethod
    def save_message(self, message: Message) -> Message:
        ...

    # ═══════════════════════════════════════════════════════
    # 合规域 · Event / Rule / Runtime
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_compliance_events(self, limit: int | None = None) -> list[ComplianceEvent]:
        ...

    @abstractmethod
    def save_compliance_event(self, event: ComplianceEvent) -> ComplianceEvent:
        ...

    @abstractmethod
    def list_compliance_rules(self) -> list[ComplianceRule]:
        ...

    @abstractmethod
    def save_compliance_rule(self, rule: ComplianceRule) -> ComplianceRule:
        ...

    @abstractmethod
    def get_runtime(self) -> RuntimeState:
        ...

    @abstractmethod
    def save_runtime(self, state: RuntimeState) -> RuntimeState:
        ...

    # ═══════════════════════════════════════════════════════
    # 任务域 · Task / Behavior
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_tasks(self) -> list[Task]:
        ...

    @abstractmethod
    def get_task(self, task_id: str) -> Task:
        ...

    @abstractmethod
    def save_task(self, task: Task) -> Task:
        ...

    @abstractmethod
    def list_behavior_events(self, lead_id: str | None = None) -> list[LeadBehaviorEvent]:
        ...

    @abstractmethod
    def save_behavior_event(self, event: LeadBehaviorEvent) -> LeadBehaviorEvent:
        ...

    # ═══════════════════════════════════════════════════════
    # 采集域 · CrawlTask
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_crawl_tasks(self, status: str | None = None) -> list[CrawlTask]:
        ...

    @abstractmethod
    def get_crawl_task(self, task_id: str) -> CrawlTask:
        ...

    @abstractmethod
    def save_crawl_task(self, task: CrawlTask) -> CrawlTask:
        ...

    @abstractmethod
    def delete_crawl_task(self, task_id: str) -> None:
        ...

    # ═══════════════════════════════════════════════════════
    # 配置域 · 单例
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def get_business_profile(self) -> BusinessProfile: ...
    @abstractmethod
    def save_business_profile(self, profile: BusinessProfile) -> BusinessProfile: ...

    @abstractmethod
    def get_product_knowledge(self) -> ProductKnowledge: ...
    @abstractmethod
    def save_product_knowledge(self, value: ProductKnowledge) -> ProductKnowledge: ...

    @abstractmethod
    def get_audience_profile(self) -> AudienceProfile: ...
    @abstractmethod
    def save_audience_profile(self, value: AudienceProfile) -> AudienceProfile: ...

    @abstractmethod
    def get_script_strategy(self) -> ScriptStrategy: ...
    @abstractmethod
    def save_script_strategy(self, value: ScriptStrategy) -> ScriptStrategy: ...

    @abstractmethod
    def get_wechat_settings(self) -> WeChatSettings: ...
    @abstractmethod
    def save_wechat_settings(self, value: WeChatSettings) -> WeChatSettings: ...

    # ═══════════════════════════════════════════════════════
    # 系统配置中心 · key-value
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def get_system_settings(self, category: str) -> dict[str, str]:
        """按 category 读取所有 key-value 对"""

    @abstractmethod
    def set_system_setting(self, category: str, key: str, value: str) -> None:
        """写入单条配置（upsert）"""

    @abstractmethod
    def get_all_system_settings(self) -> dict[str, dict[str, str]]:
        """读取所有分类的全部配置"""

    # ═══════════════════════════════════════════════════════
    # 聚合查询（分析域用，可由实现方优化为 SQL）
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def summary(self) -> dict[str, int]:
        """各实体计数概览"""

    @abstractmethod
    def funnel_stats(self, window_days: int = 30) -> dict:
        """六级漏斗：曝光→入库→触达→回复→加微→成交"""

    @abstractmethod
    def attribution_stats(self, window_days: int = 30) -> dict:
        """6 触点归因：各来源的线索/加微/成交数"""

    @abstractmethod
    def compliance_summary(self) -> dict:
        """合规汇总：退订/黑名单/投诉/审计数"""

    # ═══════════════════════════════════════════════════════
    # 调度域 · SchedulerConfig / 发送计数
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def get_scheduler_config(self) -> dict:
        """读取调度器配置（单例），返回 dict 或空 dict"""

    @abstractmethod
    def save_scheduler_config(self, data: dict) -> dict:
        """保存调度器配置（upsert 单例）"""

    @abstractmethod
    def increment_account_send(self, account_id: str, success: bool) -> None:
        """累加账号今日发送数（today_sent +1，成功时 today_success +1）"""


    # ═══════════════════════════════════════════════════════
    # 通知域 · Notification（P4-A 通知提醒系统）
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def list_notifications(self, unread_only: bool = False, limit: int = 50, offset: int = 0) -> list[Notification]:
        """通知列表，按创建时间倒序，支持未读过滤与分页"""

    @abstractmethod
    def get_unread_count(self) -> int:
        """未读通知数（铃铛角标依据）"""

    @abstractmethod
    def mark_notification_read(self, notification_id: str) -> bool:
        """标记单条已读。返回是否真的存在该通知（不存在返回 False）"""

    @abstractmethod
    def mark_all_read(self) -> None:
        """全部通知已读"""

    @abstractmethod
    def create_notification(self, notification: Notification) -> Notification:
        """创建通知（upsert）"""

    # ═══════════════════════════════════════════════════════
    # 私信发送执行域 · DmSendResult（P4-D）
    # ═══════════════════════════════════════════════════════

    @abstractmethod
    def create_dm_send_result(self, result: DmSendResult) -> DmSendResult:
        """记录一次私信发送结果（追加写入）"""

    @abstractmethod
    def list_dm_send_results(self, limit: int = 50) -> list[DmSendResult]:
        """发送结果列表，按创建时间倒序"""

    @abstractmethod
    def list_retryable_send_results(self, now_iso: str, limit: int = 50) -> list[DmSendResult]:
        """P2-12: 取出到期可重试的失败发送记录（retry_status=pending 且 next_retry_at<=now）"""

    @abstractmethod
    def update_dm_send_result_retry(self, result: DmSendResult) -> None:
        """P2-12: 回写单条发送记录的重试状态/次数/下次时间"""

    # ═══════════════════════════════════════════════════════════
    # 话术使用归因域 · ScriptUsage（埋点补全 Task4）
    # 默认 no-op：SqliteRepository 覆盖实现，MemoryRepository 直接继承。
    # 埋点为 best-effort，失败不影响主流程。
    # ═══════════════════════════════════════════════════════════

    def save_script_usage(self, usage: ScriptUsage) -> ScriptUsage:
        return usage

    def update_script_usage_result(self, lead_id: str, result: str) -> None:
        return None

    def list_script_usages(self, lead_id: str | None = None) -> list[ScriptUsage]:
        return []

    # ═══════════════════════════════════════════════════════════
    # 账号操作审计域 · AccountEvent（埋点补全 Task5）
    # ═══════════════════════════════════════════════════════════

    def save_account_event(self, event: AccountEvent) -> AccountEvent:
        return event

    def list_account_events(self, limit: int = 50) -> list[AccountEvent]:
        return []

    # ═══════════════════════════════════════════════════════════
    # 评论洞察与话术质检域（v003）
    # 默认实现为 no-op / 空结果：SqliteRepository 覆盖实现，
    # MemoryRepository 直接继承（开发/测试环境无此需求，不影响主流程）。
    # ═══════════════════════════════════════════════════════════

    def list_guard_rules(self, enabled_only: bool = True) -> list[dict]:
        """话术质检规则列表，enabled_only=True 时仅返回启用的规则"""
        return []

    def get_guard_rule(self, rule_id: int) -> dict | None:
        """按 id 读取单条质检规则，不存在返回 None"""
        return None

    def create_guard_rule(self, payload: dict) -> dict:
        """新增质检规则，返回落库后的完整记录"""
        return payload

    def update_guard_rule(self, rule_id: int, payload: dict) -> dict | None:
        """局部更新质检规则（仅更新 payload 中出现的字段），不存在返回 None"""
        return None

    def find_duplicate_replies(
        self, reply_content: str, account: str | None, hours: int = 24
    ) -> int:
        """D7 模板群发检测：同账号近 N 小时内 reply_content 完全相同的回复条数"""
        return 0

    def update_lead_insight(self, lead_id: str, insight: dict) -> bool:
        """回写线索 AI 分级结果（intent_category/intent/intent_level/sentiment/risk_level/insight_json）"""
        return False

    # ═══════════════════════════════════════════════════════════
    # 数据脱敏与风险聚合域（P2）
    # 默认 no-op / 空结果：SqliteRepository 覆盖实现，
    # MemoryRepository 直接继承（开发/测试无此需求，不影响主流程）。
    # ═══════════════════════════════════════════════════════════

    def list_leads_for_risk(
        self, start_date: str | None = None, end_date: str | None = None
    ) -> list[dict]:
        """风险聚合用：取有 comment 的线索（可按 created_at 日期区间过滤）"""
        return []

    def list_leads_for_desensitize(self, limit: int = 200) -> list[dict]:
        """存量脱敏用：取尚未脱敏（desensitized != 1）的线索 id/nickname/comment/referral_note"""
        return []

    def update_lead_desensitize(self, lead_id: str, fields: dict) -> bool:
        """回写脱敏结果：字段白名单 nickname/comment/referral_note，并将 desensitized 置 1"""
        return False
