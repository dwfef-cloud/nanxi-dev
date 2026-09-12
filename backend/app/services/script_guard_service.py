"""话术质检 Service · 两层质检（v003）

分层设计：
- 第一层 · 违禁词/敏感词：调用本地词库 CLI（douyin-sensitive-check），
  子进程失败/超时一律优雅降级为「未启用」，不影响第二层与接口可用性。
- 第二层 · 话术套路：走数据库自建规则（script_guard_rules），
  通用敏感词库抓不到「帮您反馈一下」这类翻车话术，必须自建。

D7 为占位规则（非正则），单独走重复率检测分支（find_duplicate_replies）。
"""
import logging
import os
import re
import subprocess
import sys

from app.repositories.base import Repository
from app.schemas.script_guard import (
    GuardRuleCreate,
    GuardRuleRead,
    GuardRuleUpdate,
)

logger = logging.getLogger(__name__)

# 本地词库 CLI（可用环境变量覆盖，避免硬编码）
DEFAULT_SENSITIVE_CHECK_CLI = (
    r"C:\Users\天选Air\.workbuddy\skills\douyin-sensitive-check\scripts\check.py"
)
SENSITIVE_CHECK_CLI_ENV = "SENSITIVE_CHECK_CLI"
SENSITIVE_CHECK_TIMEOUT = 8  # 秒

SENSITIVE_LAYER = "sensitive_word"
PATTERN_LAYER = "script_pattern"
SENSITIVE_CATEGORY = "违禁词/敏感词"
SENSITIVE_HIT_ADVICE = "平台限流/违禁词，建议替换为合规表达"
ADWORD_HIT_ADVICE = "广告极限词，改为可验证的具体表述"
MEDICAL_HIT_ADVICE = "医疗健康违禁词，公屏禁止使用"

# D7 占位符（非正则），需单独分支
D7_RULE_CODE = "D7"
D7_PLACEHOLDER = "（重复率检测，非正则）"
D7_DUPLICATE_THRESHOLD = 2  # 近 24h 同账号相同回复 ≥2 次即命中
D7_WINDOW_HOURS = 24

# 降级提示文案
NOTICE = "本内容为通用提效建议，不构成专业意见。平台规则以官方为准。"


class ScriptGuardService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo

    # ═══════════════════════════════════════════════════════
    # 主入口
    # ═══════════════════════════════════════════════════════

    def check(self, content: str, account: str | None = None) -> dict:
        """两层质检主入口，返回 {pass, block_count, warn_count, hits, sanitized, ...}。"""
        text = content or ""

        # ── 第一层：违禁词/敏感词（外部 CLI，best-effort）──
        available, error, sensitive_hits = self._check_sensitive_words(text)

        # ── 第二层：话术套路（数据库规则）──
        pattern_hits = self._check_script_patterns(text, account)

        hits = sensitive_hits + pattern_hits
        block_count = sum(1 for h in hits if h["severity"] == "block")
        warn_count = sum(1 for h in hits if h["severity"] == "warn")

        return {
            "pass": block_count == 0,
            "block_count": block_count,
            "warn_count": warn_count,
            "hits": hits,
            "sanitized": self._sanitize(text, hits),
            "sensitive_check_available": available,
            "sensitive_check_error": error,
            "notice": NOTICE,
        }

    # ═══════════════════════════════════════════════════════
    # 第一层 · 违禁词/敏感词（调用外部 CLI，不自己实现词库）
    # ═══════════════════════════════════════════════════════

    def _check_sensitive_words(self, text: str) -> tuple[bool, str | None, list[dict]]:
        """返回 (available, error_reason, hits)。

        CLI 不存在 / 执行失败 / 超时 → available=False + 原因，命中留空，不抛异常。
        """
        if not text.strip():
            return True, None, []

        cli_path = os.environ.get(SENSITIVE_CHECK_CLI_ENV) or DEFAULT_SENSITIVE_CHECK_CLI
        if not os.path.isfile(cli_path):
            logger.warning("敏感词 CLI 不存在，降级跳过第一层: %s", cli_path)
            return False, f"敏感词词库 CLI 不存在: {cli_path}", []

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"  # Windows 下避免 GBK 输出

        try:
            proc = subprocess.run(
                [sys.executable, cli_path, text],
                capture_output=True,
                encoding="utf-8",
                errors="ignore",
                timeout=SENSITIVE_CHECK_TIMEOUT,
                env=env,
            )
        except subprocess.TimeoutExpired:
            logger.warning("敏感词 CLI 超时(%ss)，降级跳过第一层", SENSITIVE_CHECK_TIMEOUT)
            return False, f"敏感词检测超时（>{SENSITIVE_CHECK_TIMEOUT}s），已跳过第一层", []
        except Exception as exc:  # noqa: BLE001 - 任何异常都不能影响接口可用性
            logger.warning("敏感词 CLI 执行失败，降级跳过第一层: %s", exc, exc_info=True)
            return False, f"敏感词检测执行失败: {exc}", []

        out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        if proc.returncode != 0 and "检测通过" not in out:
            return False, f"敏感词检测异常退出（code={proc.returncode}）", []

        if "检测通过" in out:
            return True, None, []

        hits = self._parse_sensitive_output(out)
        if not hits:
            # 解析不出结构化结果 → 保留原始输出，便于人工排查
            logger.info("敏感词 CLI 输出无法结构化解析，保留原文: %s", out[:500])
            return True, None, [
                {
                    "layer": SENSITIVE_LAYER,
                    "rule_code": None,
                    "category": SENSITIVE_CATEGORY,
                    "severity": "warn",
                    "matched": "",
                    "advice": f"{SENSITIVE_HIT_ADVICE}（原始输出：{out.strip()[:200]}）",
                }
            ]
        return True, None, hits

    @staticmethod
    def _parse_sensitive_output(out: str) -> list[dict]:
        """解析 CLI stdout：以 `▸` 标注的即命中词。

        注意 CLI 只在「违禁词」段落打印 `[分类]`，平台限流词/广告极限词/医疗段落
        仅靠段落标题区分，故这里按段落标题推断分类与严重级别。
        """
        # 段落标题关键字 → (分类, 严重级别, 建议)
        sections: list[tuple[str, str, str, str]] = [
            ("违禁词（高风险", "违禁/敏感词", "block", SENSITIVE_HIT_ADVICE),
            ("平台限流词", "", "block", SENSITIVE_HIT_ADVICE),
            ("广告极限词", "", "warn", ADWORD_HIT_ADVICE),
            ("医疗", "医疗健康违禁词", "block", MEDICAL_HIT_ADVICE),
        ]

        hits: list[dict] = []
        seen: set[str] = set()
        category, severity, advice = SENSITIVE_CATEGORY, "block", SENSITIVE_HIT_ADVICE

        for line in out.splitlines():
            stripped = line.strip()
            if not stripped:
                continue

            if "标注后文案" in stripped:
                break  # 之后是标注后的文案，不再解析

            if not stripped.startswith("▸"):
                for keyword, cat, sev, adv in sections:
                    if keyword in stripped:
                        category = cat or SENSITIVE_CATEGORY
                        severity, advice = sev, adv
                        break
                continue

            token = stripped.lstrip("▸").strip()
            if not token:
                continue
            hit_category = category
            cat_match = re.search(r"\[([^\]]+)\]", token)
            if cat_match:
                hit_category = cat_match.group(1).strip()
            word = re.split(r"[（\[\s]", token)[0].strip()
            if not word or word in seen:
                continue
            seen.add(word)

            hit_severity = severity
            hit_advice = advice
            if "广告极限词" in hit_category:
                hit_severity, hit_advice = "warn", ADWORD_HIT_ADVICE
            elif "医疗" in hit_category:
                hit_severity, hit_advice = "block", MEDICAL_HIT_ADVICE

            hits.append(
                {
                    "layer": SENSITIVE_LAYER,
                    "rule_code": None,
                    "category": hit_category,
                    "severity": hit_severity,
                    "matched": word,
                    "advice": hit_advice,
                }
            )
        return hits

    # ═══════════════════════════════════════════════════════
    # 第二层 · 话术套路（数据库自建规则）
    # ═══════════════════════════════════════════════════════

    def _check_script_patterns(self, text: str, account: str | None) -> list[dict]:
        hits: list[dict] = []
        for rule in self._repo.list_guard_rules(enabled_only=True):
            rule_code = str(rule.get("rule_code") or "")
            pattern = str(rule.get("pattern") or "")
            severity = str(rule.get("severity") or "warn")
            category = str(rule.get("category") or "话术套路")
            advice = rule.get("advice")

            # D7：占位规则，单独走重复率检测
            if rule_code == D7_RULE_CODE or pattern == D7_PLACEHOLDER:
                hit = self._check_duplicate(rule_code, category, severity, advice, text, account)
                if hit:
                    hits.append(hit)
                continue

            if not pattern or "（重复率检测" in pattern:
                continue
            try:
                m = re.search(pattern, text)
            except re.error as exc:
                # 单条规则正则写错不能让整个检测挂掉
                logger.warning("质检规则正则非法，已跳过: rule_code=%s err=%s", rule_code, exc)
                continue
            if m is None:
                continue
            hits.append(
                {
                    "layer": PATTERN_LAYER,
                    "rule_code": rule_code or None,
                    "category": category,
                    "severity": severity,
                    "matched": m.group(0),
                    "advice": advice,
                }
            )
        return hits

    def _check_duplicate(
        self,
        rule_code: str,
        category: str,
        severity: str,
        advice: str | None,
        text: str,
        account: str | None,
    ) -> dict | None:
        """D7：同账号近 24h 内相同回复 ≥2 次（模板群发）"""
        try:
            count = self._repo.find_duplicate_replies(text, account, hours=D7_WINDOW_HOURS)
        except Exception as exc:  # noqa: BLE001
            logger.warning("重复率检测失败，已跳过 D7: %s", exc, exc_info=True)
            return None
        if count < D7_DUPLICATE_THRESHOLD:
            return None
        return {
            "layer": PATTERN_LAYER,
            "rule_code": rule_code or D7_RULE_CODE,
            "category": category,
            "severity": severity,
            "matched": f"近{D7_WINDOW_HOURS}小时相同回复 {count} 次",
            "advice": advice,
        }

    # ═══════════════════════════════════════════════════════
    # 内部 · 打码
    # ═══════════════════════════════════════════════════════

    @staticmethod
    def _sanitize(text: str, hits: list[dict]) -> str:
        """把 block 级命中处替换为 [待修改]，供人工在原文上继续修改。"""
        result = text
        for h in hits:
            if h.get("severity") != "block":
                continue
            matched = h.get("matched") or ""
            if not matched or matched == D7_PLACEHOLDER:
                continue
            result = result.replace(matched, "[待修改]")
        return result

    # ═══════════════════════════════════════════════════════
    # 规则 CRUD（直接转调仓储）
    # ═══════════════════════════════════════════════════════

    def list_rules(self, enabled_only: bool = True) -> list[GuardRuleRead]:
        return [GuardRuleRead(**r) for r in self._repo.list_guard_rules(enabled_only=enabled_only)]

    def create_rule(self, payload: GuardRuleCreate) -> GuardRuleRead:
        data = payload.model_dump(exclude_none=True, by_alias=False)
        return GuardRuleRead(**self._repo.create_guard_rule(data))

    def update_rule(self, rule_id: int, payload: GuardRuleUpdate) -> GuardRuleRead | None:
        data = payload.model_dump(exclude_none=True, by_alias=False)
        updated = self._repo.update_guard_rule(rule_id, data)
        if updated is None:
            return None
        return GuardRuleRead(**updated)
