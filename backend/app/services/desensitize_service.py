"""数据脱敏 Service · 依据《个人信息保护法》最小化原则
=====================================================
纯函数 `desensitize(text)` 负责单段文本脱敏；`DesensitizeService` 在此之上
提供存量清洗（扫描 leads 的 nickname/comment/referral_note）。

脱敏规则（安全第一，宁可少脱敏也不误伤）：
  - 手机号：11 位、1 开头，前后均不能再接数字（避免订单号/长数字串被截断）
  - 微信号：仅替换「引导词 + 账号」中的账号部分，引导词原样保留
  - 人名：仅「常见姓氏 + 明确称谓」（张先生/李女士/王经理），
          不处理无称谓的裸姓名，避免误伤普通词汇

同名实体在同一段文本内保持同一编号（手机号/微信/人名各维护一套编号）。
"""
from __future__ import annotations

import re

__all__ = ["desensitize", "DesensitizeService"]

# ── 手机号：11 位、1 开头；负向断言避免被更长数字串吞掉或截断 ──
PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")

# ── 微信号：仅捕获账号部分（第 1 组），引导词与连接词保留 ──
WECHAT_RE = re.compile(
    r"(?:微信|vx|VX|vx|v信|加我)\s*(?:是|号|为)?\s*[:：]?\s*([A-Za-z0-9_-]{5,})"
)

# ── 人名：常见姓氏 + 明确称谓（强信号，避免误伤普通词）──
_SURNAMES = (
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
    "戚谢邹喻柏水窦章云苏潘葛范彭郎鲁韦昌马苗凤花方俞任袁柳唐费廉岑薛雷贺"
    "倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵汪祁毛禹"
    "狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜"
    "郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房裘解应宗丁宣邓郁单杭洪"
    "包诸左石崔吉钮龚程邢裴陆荣翁荀羊惠甄曲封芮储靳段富巫乌焦巴弓牧山谷车侯全"
    "班秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎薄印宿白怀蒲从鄂索咸赖"
    "卓蔺屠蒙池乔胥苍双闻莘党翟谭贡劳姬申扶堵冉宰郦雍桑桂濮牛寿通边扈燕冀浦尚"
    "农温别庄晏柴瞿阎充连茹习宦艾鱼容向古易慎戈廖庾终居衡步都耿满弘匡国文寇广"
    "禄阙东欧殳沃利蔚越夔隆师巩聂晁勾敖融冷辛阚那简饶空曾沙养鞠须丰巢关蒯相查"
    "荆红游权逯盖益桓"
)
_TITLES = "先生|女士|小姐|经理|总监|老板|老师|医生|师傅|主任|局长|护士|警官|律师"
# 必须带姓氏才认定为人名（裸「先生」不脱敏，避免误伤普通词）
_NAME_RE = re.compile(rf"[{_SURNAMES}](?:{_TITLES})")

_TYPE_PREFIX = {"phone": "电话", "wechat": "微信", "name": "用户"}


def _label(index: int) -> str:
    """1→A、2→B … 26→Z，超过 26 直接用数字，保证唯一可读"""
    if 1 <= index <= 26:
        return chr(ord("A") + index - 1)
    return str(index)


def desensitize(text: str) -> dict:
    """对单段文本脱敏。

    返回 {original, desensitized, replacements:[{type,from,to}], count}。
    count 为「去重后的实体数」（同一手机号出现多次只算一条替换映射）。
    """
    original = text or ""
    replacements: list[dict] = []
    counters: dict[str, int] = {}
    seen: dict[tuple[str, str], str] = {}

    def _assign(kind: str, value: str) -> str:
        key = (kind, value)
        cached = seen.get(key)
        if cached is not None:
            return cached
        counters[kind] = counters.get(kind, 0) + 1
        label = f"【{_TYPE_PREFIX[kind]}{_label(counters[kind])}】"
        seen[key] = label
        replacements.append({"type": kind, "from": value, "to": label})
        return label

    result = original

    # ① 微信号优先：避免「微信+手机号」写法被手机号规则先截断
    def _wechat_repl(m: re.Match) -> str:
        account = m.group(1)
        return m.group(0).replace(account, _assign("wechat", account), 1)

    result = WECHAT_RE.sub(_wechat_repl, result)

    # ② 手机号
    result = PHONE_RE.sub(lambda m: _assign("phone", m.group(0)), result)

    # ③ 人名（仅强称谓模式）
    result = _NAME_RE.sub(lambda m: _assign("name", m.group(0)), result)

    return {
        "original": original,
        "desensitized": result,
        "replacements": replacements,
        "count": len(replacements),
    }


class DesensitizeService:
    """串联仓储的脱敏服务：单条脱敏 + 存量清洗（dry_run 优先）"""

    FIELDS = ("nickname", "comment", "referral_note")

    def __init__(self, repo) -> None:
        self._repo = repo

    def desensitize(self, text: str) -> dict:
        return desensitize(text)

    def batch_clean(self, limit: int = 200, dry_run: bool = True) -> dict:
        """扫描 leads 的 nickname/comment/referral_note 并脱敏。

        dry_run=True：只统计 + 返回样例，不落库。
        dry_run=False：仅回写「确实发生变化」的字段，并将 leads.desensitized 置 1。
        """
        rows = self._repo.list_leads_for_desensitize(limit=int(limit))
        scanned = len(rows)
        changed = 0
        samples: list[dict] = []

        for row in rows:
            updates: dict[str, str] = {}
            changes: list[dict] = []
            for field in self.FIELDS:
                raw = (row.get(field) or "").strip()
                if not raw:
                    continue
                res = desensitize(raw)
                if res["count"] <= 0 or res["desensitized"] == raw:
                    continue
                updates[field] = res["desensitized"]
                changes.append(
                    {
                        "field": field,
                        "count": res["count"],
                        "before": raw,
                        "after": res["desensitized"],
                    }
                )
            if not updates:
                continue
            changed += 1
            if len(samples) < 5:
                samples.append({"lead_id": row.get("id"), "changes": changes})
            if not dry_run:
                self._repo.update_lead_desensitize(row.get("id"), updates)

        return {
            "scanned": scanned,
            "changed": changed,
            "dry_run": bool(dry_run),
            "samples": samples,
        }
