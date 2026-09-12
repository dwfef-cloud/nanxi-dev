"""P2-9 数据清洗脚本：修复历史 ???? 乱码数据

策略：
1. 扫描所有表的文本列，查找含连续 ? 的记录
2. 若字段几乎全是 ?（乱码率>50%）→ 替换为 "[乱码数据]"
3. 若部分可读 → 将连续 2+ 个 ? 替换为 "[乱码]"
4. 先 dry-run 打印，确认后 --apply 实际执行
"""
import re
import sqlite3
import sys

DB_PATH = r"D:\.data\lead_system.db"

# 需要清洗的表和文本列（根据扫描结果）
TARGETS = [
    ("accounts", ["name", "nickname"]),
    ("leads", ["nickname", "source_keyword", "comment", "video", "note", "customer_need", "account", "fail_note", "throttled_note"]),
    ("customers", ["name", "notes"]),
    ("followups", ["customer_name", "type", "text", "next_step"]),
    ("messages", ["content"]),
    ("compliance_events", ["text"]),
    ("crawl_tasks", ["name", "keyword"]),
    ("notifications", ["title", "content"]),
]

GARBAGE_RE = re.compile(r"\?{2,}")


def clean_value(val: str) -> tuple[str, bool]:
    """返回 (清洗后的值, 是否有变更)"""
    if not val or not isinstance(val, str):
        return val, False
    if "?" not in val:
        return val, False

    # 计算 ? 占比
    q_count = val.count("?")
    total = len(val)
    if total == 0:
        return val, False

    # 乱码率 > 50% → 整体替换
    if q_count / total > 0.5:
        # 保留少量可读的前缀/后缀（如 "E2E????2" → "E2E[乱码数据]2"）
        # 提取前后非?部分
        prefix = ""
        suffix = ""
        # 前导非?字符
        m = re.match(r"^([^\?]+)", val)
        if m:
            prefix = m.group(1)
        # 尾部非?字符
        m = re.search(r"([^\?]+)$", val)
        if m:
            suffix = m.group(1)

        # 如果前后缀太短或全是数字字母，不保留
        if len(prefix) <= 3 and len(suffix) <= 3:
            new_val = "[乱码数据]"
        else:
            new_val = f"{prefix}[乱码数据]{suffix}"
        return new_val, True

    # 部分可读：替换连续 ? 为 [乱码]
    new_val = GARBAGE_RE.sub("[乱码]", val)
    # 清理孤立的单个?（如果周围也是乱码区域）
    new_val = re.sub(r"\?+", "[乱码]", new_val)
    new_val = re.sub(r"\[乱码\](\[乱码\])+", "[乱码]", new_val)
    return new_val, (new_val != val)


def main():
    apply_mode = "--apply" in sys.argv
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    total_changes = 0
    changes_detail = []

    for table, columns in TARGETS:
        # 确认表存在
        try:
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        except sqlite3.Error:
            continue
        existing_cols = [c for c in columns if c in cols]
        if not existing_cols:
            continue

        for col in existing_cols:
            # 找出含 ? 的记录
            rows = conn.execute(
                f"SELECT rowid, {col} FROM {table} WHERE {col} LIKE '%?%'"
            ).fetchall()
            for row in rows:
                old_val = row[col]
                if not old_val:
                    continue
                new_val, changed = clean_value(old_val)
                if changed:
                    total_changes += 1
                    changes_detail.append(f"{table}.{col} rowid={row['rowid']}: {old_val[:40]!r} -> {new_val[:40]!r}")
                    if apply_mode:
                        conn.execute(
                            f"UPDATE {table} SET {col} = ? WHERE rowid = ?",
                            (new_val, row["rowid"]),
                        )

    if apply_mode:
        conn.commit()
        print(f"[APPLIED] 共清洗 {total_changes} 条记录")
    else:
        print(f"[DRY-RUN] 预计清洗 {total_changes} 条记录")

    for line in changes_detail[:30]:
        print(f"  {line}")
    if len(changes_detail) > 30:
        print(f"  ... 还有 {len(changes_detail) - 30} 条")

    # 验证清洗后剩余的 ????
    print("\n--- 清洗后剩余含 ? 的记录 ---")
    remaining = 0
    for table, columns in TARGETS:
        try:
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        except sqlite3.Error:
            continue
        for col in columns:
            if col not in cols:
                continue
            cnt = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {col} LIKE '%?%'"
            ).fetchone()[0]
            if cnt > 0:
                remaining += cnt
                print(f"  {table}.{col}: {cnt} 条仍含 ?")

    print(f"\n剩余含 ? 的记录总数: {remaining}")
    conn.close()


if __name__ == "__main__":
    main()
