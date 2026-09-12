"""P2-9 历史乱码数据清洗脚本

背景：
  历史写入路径在某些环境下（控制台编码 / 旧导出工具）把中文写成了 '????'
  或 UTF-8→Latin-1 双重编码的 mojibake（如 'ä»ä¹ 18:00' 实际是 '今天 18:00'）。

本脚本：
  1. 扫描所有业务表的 TEXT 列；
  2. 识别两类乱码：
       a. 连续 '?'（>=2 个，即 GBK/控制台 lossy 转写，不可恢复，仅标记报告）；
       b. U+FFFD 替换符 / UTF-8↔Latin-1 双重编码 mojibake（可尝试恢复）；
  3. 对 b 类尝试反向解码恢复；对 a 类无法从其它字段恢复的，原样保留并报告，
     不臆造数据（避免破坏业务）；
  4. 幂等、可重复执行；默认 dry-run，加 --apply 才写库。

用法：
  python scripts/clean_garbled_text.py            # 只扫描、打印报告（dry-run）
  python scripts/clean_garbled_text.py --apply     # 真正写库修复
  DB_PATH 环境变量指定数据库，默认 D:\\.data\\lead_system.db
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys

# 连续 2 个及以上 '?' 视为 lossy 乱码标记
QUESTION_RUN = re.compile(r"\?{2,}")
# U+FFFD 替换符
REPLACEMENT_CHAR = re.compile("\ufffd")


def _db_path() -> str:
    return os.environ.get("DB_PATH", r"D:\.data\lead_system.db")


def looks_like_double_encoded(s: str) -> bool:
    """粗判是否为 UTF-8 字节被当作 Latin-1 误读的 mojibake。"""
    if "\ufffd" in s:
        return True
    # 常见 mojibake 区间：à÷ÿ 等拉丁补充字符高频出现
    hits = sum(1 for ch in s if "À" <= ch <= "ÿ" or "Ā" <= ch <= "˿")
    return hits >= 2 and hits / max(len(s), 1) > 0.15


def try_recover(s: str) -> str | None:
    """尝试把双重编码 mojibake 还原为正确中文。失败返回 None。"""
    try:
        recovered = s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None
    # 还原后不应再含乱码，且应含 CJK（确保是中文而非普通 Latin-1 文本）
    if QUESTION_RUN.search(recovered) or "\ufffd" in recovered:
        return None
    if any("一" <= ch <= "鿿" for ch in recovered):
        return recovered
    return None


def is_bad(s: str) -> bool:
    if not isinstance(s, str) or not s:
        return False
    if QUESTION_RUN.search(s) or REPLACEMENT_CHAR.search(s):
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写库修复（默认 dry-run）")
    args = ap.parse_args()

    path = _db_path()
    print(f"[clean] DB = {path}  mode = {'APPLY' if args.apply else 'DRY-RUN'}")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row

    tables = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    ]

    fixed = 0
    flagged = 0
    for table in tables:
        try:
            cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
        except sqlite3.Error:
            continue
        text_cols = [c[1] for c in cols if c[2].upper() in ("TEXT", "", "VARCHAR")]
        # 主键列名（用于 UPDATE 定位）
        pk_col = next((c[1] for c in cols if c[5] == 1), None)
        if not text_cols:
            continue

        for col in text_cols:
            try:
                rows = conn.execute(f'SELECT rowid AS _rowid, "{col}" AS v FROM "{table}"').fetchall()
            except sqlite3.Error:
                continue
            for row in rows:
                val = row["v"]
                if not is_bad(val):
                    continue
                rowid = row["_rowid"]
                # 1) 优先尝试双重编码恢复
                recovered = try_recover(val) if looks_like_double_encoded(val) else None
                if recovered:
                    print(f"[RECOVER] {table}.{col} rowid={rowid}: {val!r} -> {recovered!r}")
                    if args.apply:
                        conn.execute(
                            f'UPDATE "{table}" SET "{col}"=? WHERE rowid=?',
                            (recovered, rowid),
                        )
                    fixed += 1
                    continue
                # 2) lossy '????' 无法恢复：标记报告，不臆造
                flagged += 1
                print(f"[FLAGGED-UNRECOVERABLE] {table}.{col} rowid={rowid}: {val!r}")

    if args.apply:
        conn.commit()
    conn.close()
    print(f"[clean] 完成：可恢复修复 {fixed} 处，不可恢复标记 {flagged} 处")
    if not args.apply:
        print("[clean] dry-run 未写库；加 --apply 执行修复")
    return 0


if __name__ == "__main__":
    sys.exit(main())
