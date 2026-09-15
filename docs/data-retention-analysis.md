# 数据保留策略与大数据量处理方案 · 分析报告

> 分析对象：`D:\nanxi-dev`（FastAPI + 原生 SQLite + 原生 JS 前端）
> 生成日期：2026-09-15
> 范围：`leads`、`comment_tasks` 两张增长最快的表，以及它们在前后端的访问路径

---

## 0. 现状速览（一句话结论）

**当前架构是"单机小数据量"假设下的全量加载模型：后端一次 `SELECT *` 把整张表拉回 Python，前端再一次性拿到全部记录做内存过滤。SQLite 本身扛得住百万行，但当前代码在十万行级别就会出现接口变慢、前端卡顿，且没有任何业务数据归档/清理机制——只有文件级备份，越攒越大。**

---

## 1. 当前存储机制

### 1.1 数据库与连接

| 项 | 现状 | 来源 |
|---|---|---|
| 数据库 | 单文件 SQLite，默认 `backend/data/lead_system.db`，支持 `DB_PATH` 环境变量迁移 | `backend/app/db/init.py:25-34` |
| 日志模式 | **已开启 WAL**（`PRAGMA journal_mode = WAL`），读不阻塞写 | `init.py:53`、`repositories/sqlite.py:102` |
| 连接模型 | **进程内单例长连接** `self._conn`，全局一把 `threading.Lock` 串行化所有 `_execute`/`_query` | `repositories/sqlite.py:153-164` |
| PRAGMA 调优 | 只设了 `WAL` + `foreign_keys=ON`，**未设** `cache_size / mmap_size / synchronous / temp_store / busy_timeout` | `sqlite.py:102-103` |
| 关闭行为 | 关闭时主动 `wal_checkpoint(TRUNCATE)`，`-wal` 残留小 | `sqlite.py:141-151` |

### 1.2 关键表结构与索引

**`leads`（约 40 列，业务主表）** — `db/schema.sql:17-62`

```sql
-- 现有索引（只有 3 个）
CREATE INDEX idx_leads_status  ON leads(status);
CREATE INDEX idx_leads_source  ON leads(source);
CREATE INDEX idx_leads_external ON leads(platform, external_id);
```

- `created_at TEXT NOT NULL`（ISO 字符串，如 `2026-09-15T10:23:45+00:00`），**无索引**。
- `tags / matched_keywords` 是 JSON 字符串，注释里明说 "SQL LIKE 不可靠"，keyword 搜索在 Python 层做。
- 现有终态：`collected / pending_outreach / throttled / sent / replied / wechat_added / deal_won / send_failed / rejected`。

**`comment_tasks`（评论回复任务）** — `db/schema.sql:129-158`

```sql
CREATE INDEX idx_comment_tasks_status ON comment_tasks(status);
CREATE INDEX idx_comment_tasks_lead   ON comment_tasks(lead_id);
```

- 状态机：`pending / locating / replying / replied / failed / cancelled / user_replied / user_dm / ignored`。
- 同样 `created_at` **无索引**，但列表查询固定 `ORDER BY created_at DESC`。

### 1.3 数据量增长来源

| 来源 | 落表 | 增长速度估算 |
|---|---|---|
| 评论采集（MediaCrawler 对接） | `leads` + `crawl_tasks` | 每个采集任务几百~几千条评论 |
| 评论回复任务推送 | `comment_tasks` | 与入库 leads 大致 1:1~1:0.3 |
| 私信发送回执 | `dm_send_results`、`messages`、`script_usage` | 每次触达 1 行，比 leads 更快 |
| 行为事件 / 账号事件 | `behavior_events`、`account_events` | 高频埋点，长期会比 leads 还大 |

### 1.4 是否有自动清理/归档？

**没有。** 通读 `services/backup_service.py`：

- 它只做 **`.db` 文件级拷贝** 到 `D:\.backups\`，按 `retain_count` 保留最近 N 份（默认 7）。
- `auto_backup_check()` 是**启动钩子**（不是定时任务）：进程启动时若距上次自动备份 >24h 才跑一次。
- `export_all_json()` 是**全量导出**，本身就是大数据量下的痛点（见 §2.3）。
- 整个仓库没有任何 `DELETE FROM leads WHERE ...` 类的业务清理逻辑，`delete_lead` 只在用户手动点删除时调用。

---

## 2. 性能瓶颈分析

### 2.1 后端：全表扫描 + 无 LIMIT

**`list_leads()`（`repositories/sqlite.py:219-250`）**

```python
sql = "SELECT * FROM leads WHERE 1=1 ... ORDER BY created_at DESC"
rows = self._query(sql, tuple(params))     # ← 没有 LIMIT，全表返回
leads = [self._row_to_lead(r) for r in rows]
if keyword:                                 # ← Python 层再过滤一次
    leads = [l for l in leads if needle in l.nickname.lower() ...]
```

问题：

1. **`ORDER BY created_at DESC` 无索引** → SQLite 必须把全表所有行取出做 sort。10 万行以内还能接受，50 万行以上单次查询秒级。
2. **`SELECT *` + Python ORM 逐行构造对象** → 10 万行 × 40 列 ≈ 几百 MB 内存，且每次请求都重建。
3. **keyword 过滤在内存里** → 即使后端过滤了 status，只要带 keyword，仍然先把全表捞回来再筛。

**`list_comment_tasks()`（`sqlite.py:527-535`）**：同样 `SELECT * ... ORDER BY created_at DESC`，无 LIMIT。

**`GET /leads`（`api/routes/leads.py:10-20`）**：`response_model=list[LeadRead]`，接口层**没有 page/limit/offset**，唯一的过滤参数是 `status / source / min_score / keyword`。

**`GET /comments/tasks`（`api/routes/comments.py:47-57`）**：只有 `status` 一个过滤，同样全量返回。

### 2.2 SQLite 单表百万级的真实表现

SQLite 本身在百万行、有正确索引的情况下，主键/二级索引点查和范围扫都很快（毫秒~几十毫秒），**真正的瓶颈不在 SQLite，在应用层**：

| 场景 | 10 万行 | 100 万行 |
|---|---|---|
| `SELECT * FROM leads ORDER BY created_at DESC`（无索引） | ~200ms | 3~8s |
| 有 `(status, created_at)` 索引 + 只查一页 50 条 | ~5ms | ~10ms |
| Python 把 100 万行 `Row → Lead` 对象 | ~500MB 内存 | 几 GB，直接 OOM |
| FastAPI 序列化 100 万条 JSON | 几百 MB 响应体 | 浏览器直接卡死 |

结论：**不需要换数据库**，把"全量拉回"改成"分页拉一页"就够撑到百万级。

### 2.3 前端：全量过滤 + 分批 DOM 渲染（治标不治本）

`frontend/assets/js/app.js` 的 `viewCommentGrowth`（`:1319`）：

```js
const [leads, existing, crawlTasksRaw] = await Promise.all([
  API.getLeads(),                       // ← 一次拿全量 leads
  readTasks(),                          // ← 一次拿全量 comment_tasks
  CrawlAPI.listTasks(),
]);
// ...
function filteredTasks() {              // ← app.js:1508
  return tasks.filter((t) => { ... });  // 在 JS 里对全量数组做过滤
}
```

渲染侧 `fillRowsProgressive`（`app.js:114-128`）做了优化：

```js
function fillRowsProgressive(tbody, rows, rowHtmlFn, first = 40, chunk = 120) {
  if (rows.length <= first) return;
  const rest = rows.slice(first);
  // 首屏 40 行，其余按 120 行/帧追加
}
```

**这个分批只解决了 DOM 节点数量问题，没解决数据量问题：**

- 网络：`API.getLeads()` 一次性下载全部 leads JSON，50 万行 ≈ 几百 MB 响应，浏览器直接卡死。
- 内存：`tasks` 数组、`_cgInsight` Map、`_cgState.checked` Set 全量常驻。
- 过滤：`filteredTasks()` 每次点筛选 chip 都要遍历全量数组，10 万条每次 ~50ms 还能接受，100 万条直接掉帧。
- 排序/统计：`metricsHtml()` 里 `tasks.filter(...)` 也是全量跑。

### 2.4 其它隐藏放大点

- `BackupService.export_all_json()`（`backup_service.py:409-437`）里 `self._repo.list_leads()` 同样全量，数据量大时导出 JSON 会成为内存峰值。
- `summary()`（`sqlite.py:1374`）每张表都 `SELECT COUNT(*)`，SQLite 的 COUNT 无 WHERE 是 O(表大小) 但走全表扫描，百万行每次也要几十 ms，dashboard 每刷一次就跑一遍。
- `list_leads_for_risk`（`sqlite.py:1857-1873`）用 `SUBSTR(created_at, 1, 10) >= ?`，**这种写法永远走不到 `created_at` 索引**（即使建了也用不上）。

---

## 3. 数据保留策略建议（务实可操作）

原则：**先归档、后删除；先冷数据、后热数据；归档必须可回查、可恢复。**

### 3.1 保留窗口建议

| 数据类别 | 建议保留 | 处理方式 |
|---|---|---|
| `leads.status IN ('collected','pending_outreach','throttled','sent','replied','wechat_added','send_failed')` | 永久在线（热） | 不动 |
| `leads.status = 'rejected'` | 在线 **30 天**，之后归档 | 归档到 `leads_archive` |
| `leads.status = 'deal_won'` 且 `deal_at` 超过 **180 天** | 归档（成交客户走 `customers` 表，leads 这条可冷备） | 归档到 `leads_archive` |
| `leads.status = 'rejected'` 且 `created_at` 超过 **90 天** | 归档 | 同上 |
| `comment_tasks.status IN ('replied','failed','cancelled','user_replied','user_dm','ignored')` 且 `updated_at` 超过 **90 天** | 归档 | 归档到 `comment_tasks_archive` |
| `dm_send_results / messages / behavior_events / account_events` | 在线 **90 天**，之后删除（不归档，纯日志） | 直接 DELETE |
| `crawl_tasks.status IN ('finished','failed')` 且 `finished_at` 超过 **180 天** | 归档或删除 | 归档 |

> 窗口数字是起点建议，实际以业务复盘频率定。**第一次跑之前先全量备份一次**（复用现有 `BackupService.create_backup("manual")`）。

### 3.2 归档表 DDL

归档表结构与原表**完全一致**，只加一列 `archived_at`，保证 `INSERT INTO ... SELECT *` 能直接搬：

```sql
-- 归档表：结构 = leads + archived_at
CREATE TABLE IF NOT EXISTS leads_archive AS
    SELECT *, NULL AS archived_at FROM leads WHERE 0;

-- 上面这种 AS 写法不保留主键/索引，正式建议显式建：
CREATE TABLE IF NOT EXISTS leads_archive (
    -- 复制 leads 的全部列（与 schema.sql:17-59 完全一致），
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL DEFAULT '',
    -- ... 其余 38 列照抄 leads ...
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT NOT NULL          -- 新增：归档时间
);
CREATE INDEX IF NOT EXISTS idx_leads_archive_status ON leads_archive(status);
CREATE INDEX IF NOT EXISTS idx_leads_archive_archived ON leads_archive(archived_at);
CREATE INDEX IF NOT EXISTS idx_leads_archive_created ON leads_archive(created_at);

-- comment_tasks_archive 同理
CREATE TABLE IF NOT EXISTS comment_tasks_archive (
    -- 复制 comment_tasks 全部列 ...
    archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctasks_archive_status ON comment_tasks_archive(status);
CREATE INDEX IF NOT EXISTS idx_ctasks_archive_archived ON comment_tasks_archive(archived_at);
```

### 3.3 归档 SQL（一次搬一批，事务内完成）

```sql
BEGIN;

-- 1) 选出要归档的 ID（先小批试跑，LIMIT 500）
INSERT INTO leads_archive
SELECT l.*, :now AS archived_at
FROM leads l
WHERE l.status = 'rejected'
  AND l.created_at < :cutoff          -- 例如 90 天前
  AND l.id IN (
      SELECT id FROM leads
      WHERE status = 'rejected' AND created_at < :cutoff
      ORDER BY created_at ASC
      LIMIT 500
  );

-- 2) 从原表删除（用 NOT IN 归档表，防止漏删/误删）
DELETE FROM leads
WHERE status = 'rejected'
  AND created_at < :cutoff
  AND id IN (SELECT id FROM leads_archive WHERE archived_at = :now);

COMMIT;
```

要点：

- **单事务、小批量（500~1000 行）**，避免长事务阻塞业务写入；循环跑直到 affected rows = 0。
- 归档完跑一次 `PRAGMA wal_checkpoint(TRUNCATE); VACUUM;` 回收磁盘空间（VACUUM 要停机或低峰跑）。
- **不要在归档时改业务代码**：列表查询默认不查 archive；只在"历史查询"页提供一个 `?include_archive=1` 开关。

### 3.4 自动清理任务实现思路

仓库里**已经有现成模式可复用**——`BackupService.auto_backup_check()` 是启动钩子（`backup_service.py:343-372`）。照抄一个 `DataRetentionService`：

```python
# backend/app/services/retention_service.py（新增）
class DataRetentionService:
    def __init__(self, repo, backup: BackupService):
        self._repo = repo
        self._backup = backup

    def retention_check(self) -> dict:
        """启动钩子：每天最多跑一次。与 auto_backup_check 同模式。"""
        settings = self._repo.get_system_settings("retention")
        if not _bool(settings.get("enabled"), True):
            return {"skipped": "disabled"}
        if _hours_since(settings.get("last_run_at")) < 24:
            return {"skipped": "too_recent"}

        # 归档前先打一个 backup_auto，保证可回滚
        self._backup.create_backup(backup_type="auto")

        moved_leads = self._archive_leads_batch(limit=500)
        moved_ctasks = self._archive_comment_tasks_batch(limit=500)
        deleted_logs = self._purge_old_logs(keep_days=90)

        self._repo.set_system_setting(
            "retention", "last_run_at", json.dumps(_now_iso())
        )
        return {"moved_leads": moved_leads,
                "moved_comment_tasks": moved_ctasks,
                "deleted_logs": deleted_logs}
```

在 FastAPI 启动钩子（`main.py` 的 `lifespan`/`@app.on_event("startup")`）里紧跟 `auto_backup_check()` 之后调用一次 `retention_check()` 即可，**不必引入 APScheduler**——进程本来就常驻，启动时跑一次 + 手动在设置页点"立即归档"按钮，足够。

---

## 4. 大数据量处理方案

### 4.1 后端 API 分页改造（核心）

**目标：把 `GET /leads` 从"全量列表"改成"分页对象"。**

```python
# api/routes/leads.py 改造思路（保持向后兼容）
@router.get("")
def list_leads(
    status: str | None = None,
    source: str | None = None,
    min_score: int | None = None,
    keyword: str | None = None,
    # ── 新增分页参数 ──
    page: int = 1,
    limit: int = 50,
    include_archive: bool = False,
    service: LeadService = Depends(get_lead_service),
) -> dict:
    page = max(1, page)
    limit = min(200, max(1, limit))          # 上限 200，防止前端误传
    items, total = service.list_leads_paged(
        status=status, source=source, min_score=min_score, keyword=keyword,
        offset=(page - 1) * limit, limit=limit,
        include_archive=include_archive,
    )
    return {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit,
    }
```

`list_leads_paged` 在 repository 层：

```python
def list_leads_paged(self, status=None, source=None, keyword=None,
                     offset=0, limit=50, include_archive=False) -> tuple[list[Lead], int]:
    where, params = ["1=1"], []
    if status and status != "all":
        where.append("status = ?"); params.append(status)
    if source:
        where.append("source = ?"); params.append(source)
    where_sql = " AND ".join(where)

    # keyword 仍在 Python 层做时，必须先 COUNT 全部再分页——
    # 这就是为什么 keyword 搜索应该下推到 SQL（见 §4.4）
    total = self._query_one(
        f"SELECT COUNT(*) AS c FROM leads WHERE {where_sql}", tuple(params)
    )["c"]

    rows = self._query(
        f"SELECT * FROM leads WHERE {where_sql} "
        f"ORDER BY created_at DESC LIMIT ? OFFSET ?",
        tuple(params) + (limit, offset),
    )
    return [self._row_to_lead(r) for r in rows], total
```

`GET /comments/tasks` 同样改造：加 `page / limit`，返回 `{items, total, page, limit}`。

> **兼容策略**：前端老代码继续能跑——可以让旧客户端不传 `page` 时仍返回 `list[LeadRead]`（检测到无分页参数走旧路径），新前端逐步切换。新接口路径用 `/leads?page=1&limit=50` 即可，不必新开路由。

### 4.2 深分页问题与 keyset 方案

`OFFSET 100000, 50` 在 SQLite 里仍然要扫前 10 万行才能扔掉，越翻越慢。列表页是"无限滚动/最近优先"场景时，推荐 **keyset（游标）分页**：

```sql
-- 第 N 页：带上一页最后一条的 created_at 和 id
SELECT * FROM leads
WHERE status = ? AND (created_at, id) < (?, ?)   -- 复合比较
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

配套索引：

```sql
CREATE INDEX idx_leads_status_created ON leads(status, created_at DESC, id DESC);
```

前端把上一页最后一行的 `(createdAt, id)` 存成 `cursor`，下次请求带上即可，没有 OFFSET 成本。**短期用 OFFSET 分页够用，真到 10 万+ 行列表再切 keyset。**

### 4.3 索引优化（先做这步，立竿见影）

```sql
-- ① 列表 ORDER BY created_at DESC 的核心索引
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);

-- ② 列表 90% 是"按状态过滤 + 按时间倒序"，复合索引直接覆盖
CREATE INDEX IF NOT EXISTS idx_leads_status_created
    ON leads(status, created_at DESC);

-- ③ 评论候选池经常按 source_task_id 过滤
CREATE INDEX IF NOT EXISTS idx_leads_source_task
    ON leads(source_task_id, created_at DESC);

-- ④ comment_tasks 同理
CREATE INDEX IF NOT EXISTS idx_comment_tasks_created
    ON comment_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_tasks_status_created
    ON comment_tasks(status, created_at DESC);

-- ⑤ 风险聚合查询用 SUBSTR(created_at,1,10)，永远走不了索引。
--    方案：加一个冗余列 comment_date（DATE 粒度），写入时同步维护
ALTER TABLE leads ADD COLUMN comment_date TEXT;   -- YYYY-MM-DD
CREATE INDEX IF NOT EXISTS idx_leads_comment_date ON leads(comment_date);
-- 或者：在 SQLite 里建表达式索引（3.9+ 支持）
CREATE INDEX IF NOT EXISTS idx_leads_comment_date_expr
    ON leads(SUBSTR(created_at, 1, 10));
```

> 加索引用 `CREATE INDEX IF NOT EXISTS`，在数据量已经很大时会阻塞写——**低峰期跑，或先 `PRAGMA defer_foreign_keys=ON; CREATE INDEX ...;`**。索引建好后跑 `ANALYZE;` 让查询规划器更新统计。

### 4.4 keyword 搜索下推

当前 `list_leads` 的 keyword 在 Python 里过滤（`sqlite.py:241-249`），这是全表扫描的根源。务实做法：

```sql
-- SQLite 支持 FTS5，给 leads 的可搜索列建虚表
CREATE VIRTUAL TABLE leads_fts USING fts5(
    nickname, comment, note,
    content='leads', content_rowid='rowid'
);
-- 写入时触发器同步（或在 save_lead 里手工同步）
```

短期不上 FTS 也可以：把 `nickname / comment / note` 的 LIKE 前缀查询改成 SQL `LIKE ? ESCAPE '\'`，至少能让 SQLite 走全表扫描但只扫一次而不是拉回内存再过滤。**再差也比现在强。**

### 4.5 SQLite 性能调优（一行 PRAGMA 的事）

在 `sqlite.py:102` 连接建立后追加：

```python
self._conn.execute("PRAGMA journal_mode = WAL")
self._conn.execute("PRAGMA foreign_keys = ON")
# ── 新增 ──
self._conn.execute("PRAGMA synchronous = NORMAL")     # WAL 下安全，比 FULL 快 10x
self._conn.execute("PRAGMA cache_size = -65536")      # 64MB 页缓存（负值=KB）
self._conn.execute("PRAGMA mmap_size = 268435456")    # 256MB 内存映射
self._conn.execute("PRAGMA temp_store = MEMORY")       # 排序/临时表走内存
self._conn.execute("PRAGMA busy_timeout = 5000")      # 锁等待 5s，避免偶发 SQLITE_BUSY
self._conn.execute("PRAGwal_autocheckpoint = 1000")    # 默认 1000 页，可显式声明
```

这些是**零风险**优化，不影响正确性，WAL 模式下 `synchronous=NORMAL` 是 SQLite 官方推荐。

### 4.6 前端改造思路（服务端分页）

`viewCommentGrowth` 的改造分两步：

**第一步（最小改动）：先把"全量拿"改成"拿最近 N 条"**

```js
// 旧：API.getLeads() 返回全部
// 新：API.getLeads({ page: 1, limit: 200, status: 'collected' })
// 返回 { items, total, page, limit }
async function viewCommentGrowth(params) {
  const res = await API.getLeads({ page: 1, limit: 200 });
  const tasks = res.items;            // 只有前 200 条
  // 顶部"今日新增/A级/待推送"数字卡仍需全量统计——
  // 这部分让后端新增一个 /leads/stats-meta 接口返回聚合数字，
  // 不要在前端遍历全量数组
}
```

**第二步（彻底）：筛选条件下推到后端**

当前 `filteredTasks()` 的过滤维度：`tab(unpushed/pushed) / task / intent / sentiment / category / status / time`。把这些都变成 query string：

```
GET /leads?source=own_comment&has_comment=1&has_video_url=1
         &intent=A&sentiment=negative&time_from=2026-09-01&time_to=2026-09-15
         &page=1&limit=50
```

前端 `fillRowsProgressive` 保留——它在"单页 50~200 行"时是够用的，只在用户点"加载更多"时请求下一页。

**关键收益点**：`metricsHtml()` 里的"今日新增/A级/待推送/负面评论"四个数字卡，不要再 `tasks.filter(...)` 全量算，让后端在分页接口里顺带返回：

```json
{ "items": [...], "total": 12345,
  "stats": { "today": 32, "gradeA": 187, "pendingPush": 9400, "negative": 12 } }
```

---

## 5. 实施优先级

### P0 · 短期（1~2 天，零风险，立即见效）

| # | 动作 | 预期收益 |
|---|---|---|
| 1 | 加索引：`idx_leads_status_created`、`idx_comment_tasks_status_created`、`idx_leads_created` | 列表查询从秒级降到几十 ms |
| 2 | SQLite PRAGMA 调优：`synchronous=NORMAL`、`cache_size=-65536`、`mmap_size`、`temp_store=MEMORY`、`busy_timeout` | 写性能提升 5~10x，偶发锁错误消失 |
| 3 | 前端 `viewCommentGrowth` 临时硬截断：`leads.slice(0, 500)`，并在 UI 提示"仅显示最近 500 条" | 数据量爆炸时前端不再卡死 |
| 4 | `summary()` 里的 `COUNT(*)` 结果缓存 60s（写接口里失效） | dashboard 不再每次扫全表 |

### P1 · 中期（约 1 周）

| # | 动作 | 说明 |
|---|---|---|
| 5 | 后端 `GET /leads`、`GET /comments/tasks` 加 `page/limit`，返回 `{items,total,page,limit}` | 兼容旧调用（无 page 参数仍返回 list） |
| 6 | 后端新增 `/leads/stats-meta` 聚合接口 | 前端数字卡不再全量遍历 |
| 7 | 前端 `viewCommentGrowth` 改服务端分页：筛选条件下推 query string，"加载更多" | 网络/内存占用从 O(N) 降到 O(limit) |
| 8 | keyword 搜索下推 SQL（先 LIKE，后续升级 FTS5） | 去掉 Python 层全量过滤 |

### P2 · 长期（2~4 周）

| # | 动作 | 说明 |
|---|---|---|
| 9 | 建 `leads_archive` / `comment_tasks_archive` 表（§3.2 DDL） | 结构与主表一致 + `archived_at` |
| 10 | 实现 `DataRetentionService`（§3.4），挂到启动钩子 | 每天自动归档 rejected/deal_won 90 天前数据 |
| 11 | 在设置页加"立即归档"按钮 + 归档结果展示 | 人工可触发、可观察 |
| 12 | 日志类表（`dm_send_results / messages / behavior_events / account_events`）90 天直接 DELETE | 这些是增长最快的表，不归档只删 |
| 13 | 大版本低峰期 `VACUUM` 一次回收磁盘 | 归档后 .db 文件不会自动缩小 |
| 14 | 评估 keyset 分页（§4.2）替代 OFFSET | 列表超过 10 万行时再做，不必提前 |

---

## 6. 关键结论

1. **不需要换数据库**。SQLite + WAL 在有索引 + 分页的前提下，单机 100~500 万行完全够用。当前瓶颈是"全量拉回"的应用层设计，不是存储引擎。
2. **最先做的三件事**：① 加 `(status, created_at)` 复合索引；② PRAGMA 调优；③ 后端分页 API。这三步加起来不到 200 行代码，能扛住从当前到百万级的数据量。
3. **归档比删除重要**。先把 rejected / 90 天前的终态数据搬到 archive 表，主表瘦身后所有查询自然变快；归档本身可查可恢复，业务风险低。
4. **前端 `fillRowsProgressive` 不是万能药**。它解决的是 DOM 渲染分批，但数据还是全量在浏览器内存里。服务端分页才是根治。
5. **现有 `BackupService` 是好底子**——它的启动钩子模式、文件级备份、保留 N 份策略都可以直接复用，新的 `DataRetentionService` 照抄这个模式即可，不必引入 APScheduler。

---

## 附录 · 本次分析涉及的关键代码位置

| 文件 | 行号 | 内容 |
|---|---|---|
| `backend/app/db/schema.sql` | 17-62 | `leads` 表结构与现有索引 |
| `backend/app/db/schema.sql` | 129-158 | `comment_tasks` 表结构与现有索引 |
| `backend/app/db/init.py` | 51-57 | 建库时 WAL/foreign_keys 设置 |
| `backend/app/repositories/sqlite.py` | 100-116 | 连接初始化（缺 PRAGMA 调优） |
| `backend/app/repositories/sqlite.py` | 153-169 | 全局锁 + 单连接执行模型 |
| `backend/app/repositories/sqlite.py` | 219-250 | `list_leads()` 全量 + Python 层 keyword 过滤 |
| `backend/app/repositories/sqlite.py` | 527-535 | `list_comment_tasks()` 全量 |
| `backend/app/repositories/sqlite.py` | 1374-1389 | `summary()` 全表 COUNT |
| `backend/app/repositories/sqlite.py` | 1857-1873 | 风险聚合用 `SUBSTR(created_at,1,10)` 走不到索引 |
| `backend/app/api/routes/leads.py` | 10-20 | `GET /leads` 无分页参数 |
| `backend/app/api/routes/comments.py` | 47-57 | `GET /comments/tasks` 无分页参数 |
| `backend/app/services/backup_service.py` | 343-372 | `auto_backup_check` 启动钩子模式（可复用） |
| `frontend/assets/js/app.js` | 114-128 | `fillRowsProgressive` 分批渲染 |
| `frontend/assets/js/app.js` | 1319-1362 | `viewCommentGrowth` 全量拉数据 |
| `frontend/assets/js/app.js` | 1508+ | `filteredTasks` 前端全量过滤 |
