# 前端优化方案 A — 菜单精简与模块合并技术文档

> **版本**：v1.0  
> **日期**：2026-09-11  
> **适用项目**：获客系统前端（`D:\nanxi-dev\frontend\`）  
> **技术栈**：原生 JS + Hash 路由 + 单文件 app.js（4664 行）  
> **目标**：13 项菜单 → 7 项，UI 合并 + 路由调整，**不删除任何原有功能**

---

## 目录

1. [整体架构设计](#1-整体架构设计)
2. [分模块技术实现方案](#2-分模块技术实现方案)
3. [路由系统改造方案](#3-路由系统改造方案)
4. [文件修改清单](#4-文件修改清单)
5. [并行开发任务拆分建议](#5-并行开发任务拆分建议)
6. [测试验证方案](#6-测试验证方案)
7. [风险评估与回滚方案](#7-风险评估与回滚方案)

---

## 1. 整体架构设计

### 1.1 现状诊断

当前侧边栏共 **13 个菜单项**，分 5 个分组：

| 分组 | 菜单项 | 路由 | view 函数行号 |
|------|--------|------|--------------|
| （无） | 工作台 | `#/workbench` | 548 |
| 获客 | 线索池 | `#/leads` | 619 |
| 获客 | 互动中心 | `#/interact` | 817（含 3 Tab） |
| 获客 | 话术库 | `#/scripts` | 2866 |
| 运营 | 账号管理 | `#/accounts` | 3241（含 2 Tab） |
| 运营 | 采集配置 | `#/crawl` | 3614 |
| 运营 | 合规风险 | `#/risk` | 2802 |
| 客户 | 客户与商机 | `#/customers` | 2086 |
| 客户 | 今日跟进 | `#/followups` | 2290 |
| 数据 | 转化漏斗 | `#/funnel` | 2385 |
| 数据 | 数据报表 | `#/reports` | 2445（含 2 Tab） |
| 系统 | 系统监控 | `#/monitor` | 4454 |
| 系统 | 系统设置 | `#/settings` | 3837（含 3 外层 Tab） |

**已存在的半成品合并**：`viewInteract` 已整合私信任务/收件箱/评论为 3 Tab；`viewAccounts` 已整合健康度；`viewReports` 已整合触点归因；`viewSettings` 已整合向导/备份。但旧 view 函数（`viewDm`、`viewDmInbox`、`viewComments`、`viewAttribution`、`viewHealth`、`viewWizard`、`viewBackup`）的函数体仍残留在 app.js 中，路由表仍注册了部分旧路由。

### 1.2 目标菜单结构（7 项）

```
┌─────────────────────────┐
│  工作台      #/workbench │
├─────────────────────────┤
│  获客                    │
│  线索池      #/leads     │
│  互动中心    #/interact  │
│  话术库      #/scripts   │
├─────────────────────────┤
│  客户                    │
│  客户管理    #/customers │
├─────────────────────────┤
│  数据                    │
│  数据报表    #/reports   │
├─────────────────────────┤
│  系统                    │
│  设置        #/settings  │
└─────────────────────────┘
```

**分组调整**：从 5 组（获客/运营/客户/数据/系统）精简为 4 组（获客/客户/数据/系统），"运营"组解散——账号管理、采集配置、合规风险并入"设置"。

### 1.3 模块划分原则

| 新模块 | 合并来源 | 合并方式 |
|--------|----------|----------|
| 互动中心 | 私信任务 + 私信收件箱 + 评论回复 | **统一列表**（非 Tab），类型筛选器 |
| 客户管理 | 客户与商机 + 今日跟进 | **左右分栏**，左侧列表右侧详情，顶部跟进筛选 |
| 数据报表 | 转化漏斗 + 经营数据 + 触点归因 | **顶部 Tab**（3 个） |
| 设置 | 账号管理 + 采集配置 + 合规风险 + 系统监控 + 系统设置 | **左侧 Tab 导航 + 右侧内容**（5 个子页） |

### 1.4 架构不变项

- Hash 路由机制不变（`#/path?param=value`）
- `main.innerHTML` 渲染模式不变
- 所有 API 调用层（`api-*.js`）不变
- 所有 state 管理（`state.*`）不变
- 抽屉/弹窗/Toast 机制不变
- 所有原有 view 函数**保留不删**，仅改变路由表注册和调用方式

---

## 2. 分模块技术实现方案

### 2.1 互动中心（#/interact）

#### 2.1.1 现状

`viewInteract(params)`（817-854 行）当前渲染 3 个 Tab：
- `tab=dm` → `renderDmTab(content)`（859 行起，私信任务队列 + 发送控制）
- `tab=inbox` → `renderInboxTab(content)`（1118 行起，私信收件箱列表）
- `tab=comments` → `renderCommentsTab(content)`（1409 行起，评论回复列表）

#### 2.1.2 目标设计

**取消 Tab，改为统一"待处理互动"列表**：

```
┌──────────────────────────────────────────────┐
│  互动中心                                     │
│  统一管理私信与评论，未处理优先               │
│                                              │
│  [全部] [私信] [评论]    搜索框________       │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ 💬 私信  张三  2小时前  [未回复]        │  │
│  │    "请问装修多少钱？"                   │  │
│  │                        [回复] [标记已读] │  │
│  ├────────────────────────────────────────┤  │
│  │ 💬 评论  李四  3小时前  [未回复]        │  │
│  │    "视频里的方案能发我吗？"             │  │
│  │                        [回复] [标记已读] │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ── 发送控制面板（折叠/展开） ──              │
│  [发送器配置] [开始批量发送] [停止]           │
└──────────────────────────────────────────────┘
```

#### 2.1.3 数据结构

统一互动项数据模型：

```js
{
  id: 'dm_123' | 'cmt_456',       // 统一ID，前缀区分类型
  type: 'dm' | 'comment',          // 类型
  subtype: 'task' | 'inbox',       // 私信细分：任务队列 / 收件箱
  user: { name, avatar, hue },     // 用户信息
  content: '...',                  // 最新消息/评论内容
  time: '2小时前',                 // 展示时间
  timestamp: 1726000000000,        // 排序用时间戳
  status: 'pending' | 'replied' | 'read',  // 处理状态
  source: '线索名' | '视频标题',   // 来源
  raw: { ... }                     // 原始数据对象，供回复弹窗使用
}
```

#### 2.1.4 实现步骤

1. **新建 `renderUnifiedInteract(content)` 函数**（插入在 `viewInteract` 之后，约 855 行处）
   - 并行调用：`API.getDmQueue()`（私信任务）、私信收件箱 API、`API.getComments()`（评论）
   - 将三类数据映射为统一互动项数组
   - 排序：未处理优先（`status === 'pending'` 排前），同状态按 `timestamp` 倒序
   - 渲染筛选器 + 列表

2. **改造 `viewInteract(params)`**（817-854 行）
   - 移除 Tab 渲染逻辑
   - 读取 `params.get('type')`：`'all' | 'dm' | 'comment'`（兼容旧路由 `?type=dm/inbox/comment`）
   - 渲染页面头 + 筛选器 + 列表容器 + 发送控制区
   - 调用 `renderUnifiedInteract`

3. **保留 `renderDmTab` / `renderInboxTab` / `renderCommentsTab`** 不删除
   - `renderDmTab` 中的发送控制面板提取为独立函数 `renderSenderPanel()`，供统一列表底部调用
   - 收件箱和评论的回复弹窗逻辑复用原有事件绑定

4. **筛选器交互**
   - 点击筛选按钮 → 更新 `state.interactFilter` → 重新渲染列表（不触发 hash 变化，避免路由抖动）
   - 旧路由 `#/interact?type=dm` 进入时，自动设置筛选器为"私信"

#### 2.1.5 关键代码骨架

```js
async function viewInteract(params) {
  const filterType = params.get('type') || 'all'; // all | dm | comment
  state.interactFilter = filterType;

  main.innerHTML = `
    <div class="view">
      ${pageHead({ title: '互动中心', desc: '私信与评论统一处理，未处理优先' })}
      <div class="interact-filter" id="interact-filter">
        <button class="filter-btn ${filterType==='all'?'filter-btn--active':''}" data-filter="all">全部</button>
        <button class="filter-btn ${filterType==='dm'?'filter-btn--active':''}" data-filter="dm">私信</button>
        <button class="filter-btn ${filterType==='comment'?'filter-btn--active':''}" data-filter="comment">评论</button>
      </div>
      <div id="interact-list" class="interact-list"></div>
      <div id="sender-panel-mount"></div>
    </div>`;

  // 筛选器点击
  $('#interact-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.interactFilter = btn.dataset.filter;
    $$('#interact-filter .filter-btn').forEach(b =>
      b.classList.toggle('filter-btn--active', b.dataset.filter === state.interactFilter));
    renderInteractList();
  });

  await renderInteractList();
  renderSenderPanel($('#sender-panel-mount')); // 提取自 renderDmTab
}
```

---

### 2.2 客户管理（#/customers）

#### 2.2.1 现状

- `viewCustomers()`（2086-2089 行）→ `renderCustomers()`（2091-2133 行）：商机阶段筛选条 + 客户表格
- `viewFollowups()`（2290-2383 行）：今日跟进待办列表（逾期/今天/明天及以后 三段）
- `openCustomerDrawer(cuId)`（2156 行起）：客户详情抽屉（阶段推进/成交录入/流失标记）

#### 2.2.2 目标设计

**左右分栏布局**，顶部"今日跟进"快捷筛选：

```
┌──────────────────────────────────────────────────────┐
│  客户管理                              [今日跟进(3)]  │
│  客户全生命周期 + 跟进提醒                           │
│                                                      │
│  ┌─阶段筛选条─────────────────────────────────────┐  │
│  │ [全部] [量房] [方案] [报价] [谈判] [成交] [流失]│  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─左侧客户列表(35%)─┐ ┌─右侧详情(65%)──────────┐  │
│  │ 张三  量房  ¥5万  │ │ 基本信息               │  │
│  │ 李四  方案  ¥8万  │ │ 姓名: 张三             │  │
│  │ 王五  报价  ¥12万 │ │ 阶段: 量房             │  │
│  │ ...               │ │ 来源: 抖音评论         │  │
│  │                   │ │                        │  │
│  │                   │ │ ── 跟进记录 ──          │  │
│  │                   │ │ 9/10 电话沟通...       │  │
│  │                   │ │ 9/08 发送方案...       │  │
│  │                   │ │                        │  │
│  │                   │ │ ── 今日待跟进 ──        │  │
│  │                   │ │ ☐ 14:00 回访张三       │  │
│  │                   │ │ [+ 新建跟进]           │  │
│  └───────────────────┘ └────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

#### 2.2.3 实现步骤

1. **改造 `viewCustomers(params)`**（2086 行）
   - 增加 `params` 参数，读取 `params.get('tab')`：`'all' | 'followups'`
   - `tab=followups` 时，默认选中"今日跟进"筛选，列表只显示今日有待跟进的客户

2. **新建 `renderCustomersSplit()` 函数**（替换原 `renderCustomers()`）
   - 顶部：阶段筛选条（保留原逻辑）+ "今日跟进"快捷按钮（显示待办数量 badge）
   - 左侧：客户列表（从表格改为卡片列表，点击选中）
   - 右侧：客户详情面板
     - 基本信息（姓名/阶段/来源/预估价值/下一步动作）
     - 跟进记录时间线（从 `c.logs` 渲染）
     - 今日待跟进（从 `API.getFollowups()` 筛选该客户的待办）
     - 操作按钮：阶段推进、成交录入、新建跟进

3. **保留 `openCustomerDrawer`** 不删除
   - 右侧详情面板可直接复用抽屉中的渲染逻辑（提取 `renderCustomerDetail(c)` 函数）
   - 抽屉仍可从其他页面触发（如工作台点击客户）

4. **今日跟进数据整合**
   - `viewCustomers` 中并行调用 `API.getCustomers()` + `API.getFollowups()`
   - 将 followups 按 `customerId` 分组，挂到对应客户对象上
   - "今日跟进"按钮点击 → 筛选出今日有待办且未完成的客户

#### 2.2.4 状态管理

```js
state.custFilter = 'all';        // 阶段筛选
state.custSelectedId = null;     // 当前选中客户ID
state.custShowFollowupsOnly = false; // 是否只看今日待跟进
```

---

### 2.3 数据报表（#/reports）

#### 2.3.1 现状

- `viewReports(params)`（2445 行起）：当前 2 Tab——`overview`（经营数据概览）和 `attribution`（触点归因，通过 `loadAttributionBodyHtml()` 加载）
- `viewFunnel()`（2385-2443 行）：独立的转化漏斗页面，未被 `viewReports` 整合

#### 2.3.2 目标设计

**顶部 3 Tab**：转化漏斗 / 经营数据 / 触点归因

```
┌──────────────────────────────────────────────┐
│  数据报表                                     │
│  [转化漏斗] [经营数据] [触点归因]             │
│                                              │
│  （Tab 对应内容区）                           │
└──────────────────────────────────────────────┘
```

#### 2.3.3 实现步骤

1. **改造 `viewReports(params)`**（2445 行）
   - Tab 定义从 2 个扩展为 3 个：
     ```js
     const tabs = [
       { key: 'funnel',      label: '转化漏斗' },
       { key: 'overview',    label: '经营数据' },
       { key: 'attribution', label: '触点归因' },
     ];
     ```
   - 默认 Tab：`params.get('tab') || 'overview'`
   - `tab=funnel` 时，调用提取出的 `renderFunnelContent(mount)` 渲染

2. **提取 `renderFunnelContent(mount)` 函数**
   - 从 `viewFunnel()`（2385-2443 行）中提取渲染逻辑
   - 原 `viewFunnel` 函数体改为调用 `renderFunnelContent(main)` 以兼容（或直接从路由表移除并重定向）

3. **Tab 切换**
   - 统一通过 `location.hash = #/reports?tab=xxx` 触发 route() 重新渲染
   - 保持现有模式不变

#### 2.3.4 注意事项

- `viewReports` 中 `overview` Tab 有时间区间选择器（本周/本月/自定义），切换 Tab 后再切回来需保留选择状态 → 存入 `state.reportRange`
- `attribution` Tab 通过 `loadAttributionBodyHtml()` 异步加载 HTML，需保持 loading 状态
- `funnel` Tab 数据来自 `API.getFunnel()`，与 overview 的 `API.fetchSummary()` 是不同接口

---

### 2.4 设置（#/settings）

#### 2.4.1 现状

`viewSettings(params)`（3837 行起）当前有 3 个外层 Tab：
- `settings` → 系统设置（内部又有 5 个子 Tab：AI/话术策略/合规规则/采集设置/通知）
- `wizard` → 上手向导（`renderWizardBody()`）
- `backup` → 数据备份（`renderBackupBody()`）

需要额外整合 4 个独立页面：
- `viewAccounts(params)`（3241 行）：账号列表 + 账号健康度（2 Tab）
- `viewCrawl()`（3614 行）：采集配置
- `viewRisk()`（2802 行）：合规风险
- `viewMonitor()`（4454 行）：系统监控（含 30 秒自动刷新轮询）

#### 2.4.2 目标设计

**左侧垂直 Tab 导航 + 右侧内容区**，共 5 个子页：

```
┌──────────────────────────────────────────────────────┐
│  设置                                                 │
│                                                      │
│  ┌─左侧导航(180px)─┐ ┌─右侧内容──────────────────┐  │
│  │ 账号设置         │ │                            │  │
│  │ 采集配置         │ │  （选中子页的完整内容）    │  │
│  │ 合规风险         │ │                            │  │
│  │ 系统监控         │ │                            │  │
│  │ 系统设置         │ │                            │  │
│  └──────────────────┘ └────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**子页内容映射**：

| 子页 Tab key | 内容来源 | 说明 |
|-------------|----------|------|
| `accounts` | `viewAccounts` 的账号列表 + 健康度 | 内部保留 2 个二级 Tab |
| `crawl` | `viewCrawl` 完整内容 | 采集任务列表 + 新建任务表单 |
| `compliance` | `viewRisk` 完整内容 | 合规指标 + 审计事件流 + 规则引擎 |
| `monitor` | `viewMonitor` 完整内容 | 系统状态 + 数据库 + API统计 + 日志（含轮询） |
| `system` | `viewSettings` 原有内容 | 含系统设置/上手向导/数据备份 3 个三级 Tab |

#### 2.4.3 实现步骤

1. **改造 `viewSettings(params)`**（3837 行）
   - 读取 `params.get('tab')`：`accounts | crawl | compliance | monitor | system`，默认 `system`
   - 渲染左侧导航 + 右侧容器 `#settings-pane`
   - 根据 tab 值调用对应渲染函数

2. **提取各页面内容为可挂载函数**
   - `renderAccountsPane(mount, params)` — 从 `viewAccounts` 提取，注意内部 health Tab 的 `params.get('tab')` 需改为读取二级状态
   - `renderCrawlPane(mount)` — 从 `viewCrawl` 提取，注意 `crawlState.polling` 轮询的清理
   - `renderCompliancePane(mount)` — 从 `viewRisk` 提取
   - `renderMonitorPane(mount)` — 从 `viewMonitor` 提取，**关键**：切换离开 monitor Tab 时必须 `clearInterval(_monitorTimer)`
   - `renderSystemPane(mount, params)` — 原 `viewSettings` 的 settings/wizard/backup 逻辑

3. **Tab 切换事件**
   - 左侧导航点击 → `location.hash = #/settings?tab=xxx` → route() 重新渲染
   - 切换时清理上一个子页的定时器（特别是 monitor 的 30 秒轮询和 crawl 的轮询）

4. **系统设置子页内部结构**
   - `system` Tab 内部保留原有的 3 个外层 Tab（系统设置/上手向导/数据备份）
   - 系统设置内部再保留 5 个二级 Tab（AI/话术策略/合规规则/采集设置/通知）
   - 形成三级 Tab 嵌套，需注意 CSS 层级区分

#### 2.4.4 定时器清理策略

```js
// 在 viewSettings 入口处统一清理
function cleanupSettingsTimers() {
  if (window._monitorTimer) { clearInterval(window._monitorTimer); window._monitorTimer = null; }
  if (crawlState.polling) { clearInterval(crawlState.polling); crawlState.polling = null; }
  if (window._dmBatchTimer) { clearInterval(window._dmBatchTimer); window._dmBatchTimer = null; }
}
```

在 `viewSettings` 函数开头调用 `cleanupSettingsTimers()`，然后根据当前 tab 启动对应定时器。

---

## 3. 路由系统改造方案

### 3.1 新路由表

修改 `app.js` 458-480 行的 `routes` 对象：

```js
const routes = {
  workbench: viewWorkbench,
  leads: viewLeads,
  interact: viewInteract,        // 改造为统一列表
  scripts: viewScripts,
  customers: viewCustomers,      // 改造为左右分栏
  reports: viewReports,          // 改造为3 Tab
  settings: viewSettings,        // 改造为5子页
  notifications: viewNotifications,
  // 以下旧路由保留函数注册，但通过 legacyRedirects 重定向
  // （函数不删，仅不在路由表中注册，或注册后立即重定向）
};
```

**从路由表移除的 key**：`dm`、`dm-inbox`、`comments`、`accounts`、`crawl`、`followups`、`funnel`、`attribution`、`health`、`risk`、`wizard`、`monitor`、`backup`

这些函数本身**不删除**，只是不再被 `routes[name]` 直接调用。

### 3.2 旧路由重定向映射

修改 `app.js` 486-494 行的 `legacyRedirects`：

```js
const legacyRedirects = {
  // 互动中心
  'dm':       'interact?type=dm',
  'dm-inbox': 'interact?type=dm',
  'comments': 'interact?type=comment',
  // 客户管理
  'followups': 'customers?tab=followups',
  // 数据报表
  'funnel':      'reports?tab=funnel',
  'attribution': 'reports?tab=attribution',
  // 设置
  'accounts': 'settings?tab=accounts',
  'health':   'settings?tab=accounts',
  'crawl':    'settings?tab=crawl',
  'risk':     'settings?tab=compliance',
  'monitor':  'settings?tab=monitor',
  'wizard':   'settings?tab=system',
  'backup':   'settings?tab=system',
};
```

**与当前已有映射的差异**：

| 旧路由 | 当前映射 | 新映射 | 变更原因 |
|--------|----------|--------|----------|
| `dm` | `interact?tab=dm` | `interact?type=dm` | 参数名从 tab 改为 type（统一列表用筛选器而非 Tab） |
| `dm-inbox` | `interact?tab=inbox` | `interact?type=dm` | 收件箱合并到私信筛选 |
| `comments` | `interact?tab=comments` | `interact?type=comment` | 参数名统一 |
| `health` | `accounts?tab=health` | `settings?tab=accounts` | 账号管理整体迁入设置 |
| `attribution` | `reports?tab=attribution` | `reports?tab=attribution` | 不变 |
| `wizard` | `settings?tab=wizard` | `settings?tab=system` | 向导成为系统设置子页内的三级 Tab |
| `backup` | `settings?tab=backup` | `settings?tab=system` | 备份成为系统设置子页内的三级 Tab |
| `accounts` | （无，直接路由） | `settings?tab=accounts` | 新增重定向 |
| `crawl` | （无，直接路由） | `settings?tab=crawl` | 新增重定向 |
| `followups` | （无，直接路由） | `customers?tab=followups` | 新增重定向 |
| `funnel` | （无，直接路由） | `reports?tab=funnel` | 新增重定向 |
| `risk` | （无，直接路由） | `settings?tab=compliance` | 新增重定向 |
| `monitor` | （无，直接路由） | `settings?tab=monitor` | 新增重定向 |

### 3.3 URL 参数解析规范

当前 `route()` 函数（481-512 行）已支持 `?query` 解析：

```js
let [p, query] = hash.split('?');
const params = new URLSearchParams(query || '');
routes[name](params);
```

**各页面参数约定**：

| 路由 | 参数 | 取值 | 作用 |
|------|------|------|------|
| `#/interact` | `type` | `all` / `dm` / `comment` | 互动类型筛选 |
| `#/customers` | `tab` | `all` / `followups` | 是否只看今日跟进 |
| `#/reports` | `tab` | `funnel` / `overview` / `attribution` | 报表 Tab |
| `#/settings` | `tab` | `accounts` / `crawl` / `compliance` / `monitor` / `system` | 设置子页 |
| `#/settings` | `sub` | `settings` / `wizard` / `backup` | 系统设置内的三级 Tab（可选） |

**三级 Tab 参数处理**：当 `settings?tab=system&sub=wizard` 时，`renderSystemPane` 读取 `params.get('sub')` 决定内部默认 Tab。

### 3.4 导航高亮逻辑

当前 `route()` 中 508 行：
```js
$$('[data-nav]').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === name ? 'page' : 'false'));
```

改造后 `name` 只有 7 个有效值，`data-nav` 属性也只有 7 个。旧路由重定向后 `name` 会变成新路由名，高亮自动正确。

**需注意**：当在 `settings?tab=accounts` 时，侧边栏"设置"高亮；当在 `customers?tab=followups` 时，侧边栏"客户管理"高亮。这符合预期。

---

## 4. 文件修改清单

### 4.1 index.html（204 行）

#### 修改范围：第 94-167 行（`<nav class="sidenav">` 整个侧边栏）

**具体改动**：

| 行号区间 | 操作 | 内容 |
|----------|------|------|
| 103-114 | 修改 | "获客"分组：保留线索池、互动中心、话术库（不变） |
| 116-127 | 删除 | "运营"分组整个移除（账号管理、采集配置、合规风险） |
| 129-137 | 修改 | "客户"分组：只保留"客户管理"一项，删除"今日跟进"；图标用 `i-people`，文案改"客户管理" |
| 139-147 | 修改 | "数据"分组：只保留"数据报表"一项，删除"转化漏斗" |
| 149-157 | 修改 | "系统"分组：只保留"设置"一项，删除"系统监控"；文案改"设置" |
| 119 | 删除 | `nav-acc-badge` 元素（账号异常 badge 移到设置子页内） |
| 132 | 修改 | `nav-cust-badge` 保留，显示客户数 |
| 135 | 删除 | `nav-fu-badge` 元素（今日跟进数移到客户管理页内按钮） |

**修改后侧边栏结构**（约从 74 行缩减到 50 行）：

```html
<nav class="sidenav" aria-label="主导航">
  <ul class="sidenav__list">
    <li><a href="#/workbench" data-nav="workbench">...</a></li>
  </ul>
  <div class="nav-group">获客</div>
  <ul class="sidenav__list">
    <li><a href="#/leads" data-nav="leads">...</a></li>
    <li><a href="#/interact" data-nav="interact">...</a></li>
    <li><a href="#/scripts" data-nav="scripts">...</a></li>
  </ul>
  <div class="nav-group">客户</div>
  <ul class="sidenav__list">
    <li><a href="#/customers" data-nav="customers">...</a></li>
  </ul>
  <div class="nav-group">数据</div>
  <ul class="sidenav__list">
    <li><a href="#/reports" data-nav="reports">...</a></li>
  </ul>
  <div class="nav-group">系统</div>
  <ul class="sidenav__list">
    <li><a href="#/settings" data-nav="settings">...</a></li>
  </ul>
  <div class="sidenav__footer">...</div>
</nav>
```

### 4.2 app.js（4664 行）

#### 4.2.1 路由系统（458-513 行）

| 行号 | 操作 | 说明 |
|------|------|------|
| 458-480 | 修改 | `routes` 对象：移除 13 个旧路由 key，保留 7 个 + notifications |
| 486-494 | 修改 | `legacyRedirects`：扩展为 13 条映射，调整参数名 |

#### 4.2.2 互动中心（817-1507 行区间）

| 行号 | 操作 | 说明 |
|------|------|------|
| 817-854 | 重写 | `viewInteract(params)`：取消 Tab，改为统一列表 + 筛选器 |
| 855 附近 | 新增 | `renderInteractList()` 函数：合并私信+评论数据，渲染列表 |
| 855 附近 | 新增 | `renderSenderPanel(mount)` 函数：从 `renderDmTab` 提取发送控制区 |
| 859-1117 | 保留 | `renderDmTab(content)`：不删除，但内部发送控制区调用提取出的 `renderSenderPanel` |
| 1118-1408 | 保留 | `renderInboxTab(content)`：不删除 |
| 1409-1507 | 保留 | `renderCommentsTab(content)`：不删除 |

#### 4.2.3 客户管理（2086-2384 行区间）

| 行号 | 操作 | 说明 |
|------|------|------|
| 2086-2089 | 修改 | `viewCustomers(params)`：增加 params，并行加载 followups |
| 2091-2133 | 重写 | `renderCustomers()` → `renderCustomersSplit()`：左右分栏布局 |
| 2135-2154 | 保留 | `customerRow(c, stages)`：不删除，供列表卡片复用 |
| 2156+ | 保留 | `openCustomerDrawer(cuId)`：不删除，提取 `renderCustomerDetail(c)` 供右侧面板复用 |
| 2290-2384 | 保留 | `viewFollowups()`：不删除，函数体保留供参考；跟进项渲染逻辑 `todoItem(f)` 提取复用 |

#### 4.2.4 数据报表（2385-2738 行区间）

| 行号 | 操作 | 说明 |
|------|------|------|
| 2385-2443 | 提取 | `viewFunnel()`：提取渲染逻辑为 `renderFunnelContent(mount)`，原函数改为调用 |
| 2445-2725 | 修改 | `viewReports(params)`：Tab 从 2 个扩展为 3 个，新增 funnel 分支 |
| 2726-2738 | 保留 | `viewAttribution()`：不删除（已被 viewReports 内部调用替代） |

#### 4.2.5 设置（2802-4663 行区间）

| 行号 | 操作 | 说明 |
|------|------|------|
| 2802-2850 | 提取 | `viewRisk()`：提取为 `renderCompliancePane(mount)` |
| 3241-3599 | 提取 | `viewAccounts(params)`：提取为 `renderAccountsPane(mount, params)` |
| 3600-3613 | 保留 | `viewWizard()`：不删除 |
| 3614-3836 | 提取 | `viewCrawl()`：提取为 `renderCrawlPane(mount)`，注意轮询清理 |
| 3837-4422 | 重写 | `viewSettings(params)`：5 子页左侧导航，调用各 pane 渲染函数 |
| 4423-4453 | 保留 | `viewBackup()`：不删除 |
| 4454-4663 | 提取 | `viewMonitor()`：提取为 `renderMonitorPane(mount)`，注意 30 秒轮询清理 |

#### 4.2.6 旧函数保留清单（不删除）

以下函数体保留在 app.js 中，仅从路由表取消注册：
- `viewDm()`（1508 行）
- `viewDmInbox()`（1788 行）
- `viewComments()`（2960 行）
- `viewHealth()`（2739 行）
- `viewFollowups()`（2290 行）
- `viewFunnel()`（2385 行，改为调用提取函数）
- `viewAttribution()`（2726 行）
- `viewRisk()`（2802 行，改为调用提取函数）
- `viewAccounts()`（3241 行，改为调用提取函数）
- `viewWizard()`（3600 行）
- `viewCrawl()`（3614 行，改为调用提取函数）
- `viewBackup()`（4423 行）
- `viewMonitor()`（4454 行，改为调用提取函数）

**保留原因**：
1. 部分函数可能被其他代码直接调用（如工作台跳转）
2. 回滚时只需恢复路由表注册，无需恢复函数体
3. 降低首次改造风险，后续版本再清理

### 4.3 style.css（1207 行）

#### 新增样式（追加到文件末尾，约 +150 行）

| 样式类 | 用途 |
|--------|------|
| `.interact-filter` / `.filter-btn` / `.filter-btn--active` | 互动中心类型筛选器 |
| `.interact-list` / `.interact-item` / `.interact-item--pending` | 统一互动列表 |
| `.cust-split` / `.cust-list` / `.cust-detail` | 客户管理左右分栏 |
| `.cust-list-item` / `.cust-list-item--selected` | 客户列表卡片 |
| `.cust-detail-section` | 详情分区标题 |
| `.settings-layout` / `.settings-nav` / `.settings-nav-item` | 设置页左右布局 |
| `.settings-nav-item--active` | 设置导航激活态 |
| `.settings-pane` | 设置右侧内容区 |

#### 修改样式

| 行号 | 操作 | 说明 |
|------|------|------|
| 672-681 | 保留 | `.nav-group` 不变 |
| 1204-1206 | 保留 | `.tabs` / `.tab--active` 不变（数据报表仍用顶部 Tab） |

---

## 5. 并行开发任务拆分建议

### 5.1 核心矛盾

所有模块都修改 **同一个 app.js 文件**（4664 行），多个子智能体并行修改必然产生 Git 冲突。必须采用**串行分区 + 接口约定**策略。

### 5.2 推荐开发顺序（4 个阶段）

```
阶段0（前置，1人）：路由系统 + 侧边栏菜单
  ↓
阶段1（可并行，2人）：互动中心  |  数据报表
  ↓
阶段2（可并行，2人）：客户管理  |  设置（最大块）
  ↓
阶段3（集成，1人）：联调 + 测试 + 修复
```

### 5.3 任务拆分详情

#### 任务 0：路由骨架 + 菜单（必须最先完成，约 30 分钟）

**负责人**：1 人  
**修改文件**：`index.html`（94-167 行）、`app.js`（458-513 行）、`style.css`（追加）

**交付物**：
- 侧边栏 7 项菜单
- 新路由表（7 项）
- 完整的 `legacyRedirects`（13 条）
- 各新路由的空壳 view 函数（只渲染 pageHead + "开发中"占位）

**接口约定**（后续任务必须遵守）：
- `viewInteract(params)` 签名：`params.get('type')` → `all|dm|comment`
- `viewCustomers(params)` 签名：`params.get('tab')` → `all|followups`
- `viewReports(params)` 签名：`params.get('tab')` → `funnel|overview|attribution`
- `viewSettings(params)` 签名：`params.get('tab')` → `accounts|crawl|compliance|monitor|system`

#### 任务 1：互动中心（约 2-3 小时）

**负责人**：1 人  
**修改范围**：`app.js` 817-1507 行区间  
**依赖**：任务 0 完成

**工作内容**：
1. 重写 `viewInteract(params)`
2. 新增 `renderInteractList()`
3. 提取 `renderSenderPanel(mount)`
4. 新增 CSS（`.interact-filter`、`.interact-list` 等）

**冲突规避**：只修改 817-1507 行区间，不碰其他区域。

#### 任务 2：数据报表（约 1-2 小时）

**负责人**：1 人  
**修改范围**：`app.js` 2385-2738 行区间  
**依赖**：任务 0 完成  
**可与任务 1 并行**：行号区间不重叠（817-1507 vs 2385-2738）

**工作内容**：
1. 提取 `renderFunnelContent(mount)`
2. 修改 `viewReports(params)` 增加 funnel Tab
3. `viewFunnel()` 改为调用提取函数

#### 任务 3：客户管理（约 2-3 小时）

**负责人**：1 人  
**修改范围**：`app.js` 2086-2384 行区间  
**依赖**：任务 0 完成  
**可与任务 4 并行**：行号区间不重叠（2086-2384 vs 2802-4663）

**工作内容**：
1. 修改 `viewCustomers(params)`
2. 重写 `renderCustomersSplit()`
3. 提取 `renderCustomerDetail(c)`
4. 新增 CSS（`.cust-split` 等）

#### 任务 4：设置（最大块，约 3-4 小时）

**负责人**：1 人  
**修改范围**：`app.js` 2802-4663 行区间  
**依赖**：任务 0 完成

**工作内容**：
1. 提取 `renderCompliancePane(mount)`（2802-2850）
2. 提取 `renderAccountsPane(mount, params)`（3241-3599）
3. 提取 `renderCrawlPane(mount)`（3614-3836）
4. 重写 `viewSettings(params)`（3837-4422）
5. 提取 `renderMonitorPane(mount)`（4454-4663）
6. 新增 CSS（`.settings-layout` 等）
7. 定时器清理逻辑

**注意**：此任务行号范围最大，且包含 4 个提取操作，建议单人完成避免内部冲突。

#### 任务 5：集成测试（约 1-2 小时）

**负责人**：1 人  
**依赖**：任务 1-4 全部完成

**工作内容**：
1. 全页面遍历测试
2. 旧路由重定向验证
3. 控制台错误检查
4. 定时器泄漏检查
5. CSS 回归检查

### 5.4 冲突协调策略

1. **行号区间隔离**：每个任务严格限定修改行号区间，区间之间至少留 50 行缓冲
2. **Git 分支策略**：每个任务一个分支，基于任务 0 的分支创建；合并时按任务顺序 merge
3. **CSS 追加而非修改**：所有新样式追加到 style.css 末尾，不修改已有样式规则
4. **函数新增而非修改**：尽量新增函数（`renderXxxPane`、`renderXxxContent`），少改原有函数体
5. **接口先行**：任务 0 完成后，所有 view 函数的参数签名立即冻结，后续任务不得修改

### 5.5 如果只有 1 个开发者

按以下顺序串行执行：
1. 任务 0（路由+菜单）
2. 任务 2（数据报表，最简单）
3. 任务 1（互动中心）
4. 任务 3（客户管理）
5. 任务 4（设置，最复杂）
6. 任务 5（测试）

---

## 6. 测试验证方案

### 6.1 模块测试要点

#### 6.1.1 侧边栏菜单

- [ ] 显示恰好 7 个菜单项
- [ ] 分组为：获客（3项）、客户（1项）、数据（1项）、系统（1项）+ 工作台
- [ ] 点击每个菜单正确跳转
- [ ] 当前页高亮正确（`aria-current="page"`）
- [ ] 北极星指标和版本号正常显示

#### 6.1.2 互动中心

- [ ] 页面加载无控制台错误
- [ ] 显示统一列表，私信和评论混合
- [ ] 未处理项排在前面
- [ ] 按时间倒序排列
- [ ] 筛选器：全部/私信/评论 切换正常
- [ ] 私信项和评论项有图标区分
- [ ] 点击"回复"打开回复弹窗（私信和评论各自的弹窗逻辑）
- [ ] 发送控制面板正常显示和操作
- [ ] 旧路由 `#/dm` → 重定向到 `#/interact?type=dm`
- [ ] 旧路由 `#/dm-inbox` → 重定向到 `#/interact?type=dm`
- [ ] 旧路由 `#/comments` → 重定向到 `#/interact?type=comment`
- [ ] 离开页面后批量发送定时器停止

#### 6.1.3 客户管理

- [ ] 左右分栏布局正常
- [ ] 左侧客户列表显示（阶段、价值、来源）
- [ ] 点击客户，右侧显示详情
- [ ] 详情包含：基本信息、阶段、跟进记录、今日待跟进
- [ ] 阶段筛选条正常工作
- [ ] "今日跟进"按钮显示待办数量
- [ ] 点击"今日跟进"筛选出有待办的客户
- [ ] 跟进记录时间线正常显示
- [ ] 新建跟进功能正常
- [ ] 阶段推进/成交录入功能正常（复用抽屉逻辑）
- [ ] 旧路由 `#/followups` → 重定向到 `#/customers?tab=followups`

#### 6.1.4 数据报表

- [ ] 顶部 3 Tab：转化漏斗/经营数据/触点归因
- [ ] 默认显示经营数据（overview）
- [ ] 转化漏斗 Tab 数据正常显示（漏斗图+指标卡+ROI）
- [ ] 经营数据 Tab 时间区间选择器正常
- [ ] 触点归因 Tab 正常加载
- [ ] Tab 切换不丢失 overview 的时间选择
- [ ] 旧路由 `#/funnel` → 重定向到 `#/reports?tab=funnel`
- [ ] 旧路由 `#/attribution` → 重定向到 `#/reports?tab=attribution`

#### 6.1.5 设置

- [ ] 左侧 5 个子页导航：账号设置/采集配置/合规风险/系统监控/系统设置
- [ ] 默认显示系统设置
- [ ] 账号设置：账号列表 + 健康度二级 Tab 正常
- [ ] 采集配置：任务列表 + 新建表单正常
- [ ] 合规风险：指标卡 + 审计事件流 + 规则引擎正常
- [ ] 系统监控：5 个状态卡 + 数据库 + API统计正常，30 秒自动刷新
- [ ] 系统设置：内部 3 个三级 Tab（系统设置/上手向导/数据备份）正常
- [ ] 切换子页时，上一个子页的定时器停止（特别是监控和采集）
- [ ] 旧路由 `#/accounts` → `#/settings?tab=accounts`
- [ ] 旧路由 `#/health` → `#/settings?tab=accounts`
- [ ] 旧路由 `#/crawl` → `#/settings?tab=crawl`
- [ ] 旧路由 `#/risk` → `#/settings?tab=compliance`
- [ ] 旧路由 `#/monitor` → `#/settings?tab=monitor`
- [ ] 旧路由 `#/wizard` → `#/settings?tab=system`
- [ ] 旧路由 `#/backup` → `#/settings?tab=system`

### 6.2 回归测试清单

#### 未修改模块验证

- [ ] 工作台（#/workbench）数据加载正常
- [ ] 线索池（#/leads）列表、筛选、详情抽屉正常
- [ ] 话术库（#/scripts）分类 Tab、搜索、编辑正常
- [ ] 通知中心正常
- [ ] 顶部栏状态 pill（采集运行中/安全模式）正常
- [ ] 一键暂停按钮正常
- [ ] 通知铃铛正常
- [ ] 安全模式横幅正常显示和隐藏

#### 全局功能验证

- [ ] 所有页面 `Ctrl+F5` 强制刷新后正常
- [ ] 浏览器前进/后退按钮正常
- [ ] 直接输入旧路由 URL 正确重定向
- [ ] 控制台零错误（红色 error）
- [ ] 无未捕获的 Promise rejection
- [ ] 页面切换无内存泄漏（定时器清理）
- [ ] 响应式布局（缩小窗口无严重错位）

#### 数据完整性验证

- [ ] 所有原有 API 调用仍在执行（Network 面板检查）
- [ ] 所有原有数据字段仍在展示
- [ ] 所有原有操作按钮仍可点击并触发正确行为
- [ ] 表单提交正常

### 6.3 测试工具

- **浏览器**：Chrome DevTools
  - Console：零错误
  - Network：API 请求正常
  - Performance：检查定时器泄漏
  - Application：LocalStorage/SessionStorage 未异常
- **强制刷新**：每个页面测试前 `Ctrl+F5`
- **旧路由测试**：地址栏直接输入旧 hash，观察重定向

---

## 7. 风险评估与回滚方案

### 7.1 风险评估

| 风险项 | 概率 | 影响 | 缓解措施 |
|--------|------|------|----------|
| app.js 合并冲突导致功能丢失 | 中 | 高 | 行号区间隔离 + 函数保留不删 + Git 分支管理 |
| 定时器未清理导致内存泄漏/后台请求 | 中 | 中 | 统一 `cleanupSettingsTimers()` + 测试阶段专项检查 |
| 旧路由重定向循环 | 低 | 高 | `legacyRedirects` 的目标路由不在 redirects key 中；route() 中重定向后 `return` 不再执行 |
| 三级 Tab 嵌套导致参数混乱 | 中 | 中 | 明确参数约定：`tab`（二级）+ `sub`（三级），文档冻结 |
| 客户管理左右分栏在小屏幕错位 | 中 | 低 | CSS 使用 flex + min-width，超窄屏降级为上下布局 |
| 互动中心统一列表数据量过大导致卡顿 | 低 | 中 | 分页或虚拟滚动（首版可先全量渲染，数据量 <200 无压力） |
| 设置页 5 子页切换时状态丢失 | 中 | 低 | 关键状态存入 `state.*`，切换 Tab 后恢复 |
| 原有抽屉/弹窗事件绑定失效 | 中 | 高 | 提取渲染函数时保持事件绑定逻辑不变，使用事件委托或重新绑定 |

### 7.2 回滚方案

#### 7.2.1 快速回滚（5 分钟）

**前提**：改造前创建 Git 分支或备份

```bash
cd D:\nanxi-dev\frontend
git checkout -b pre-optimization-backup  # 改造前
# 如需回滚：
git stash  # 或 git checkout -- .
git checkout pre-optimization-backup
```

**文件级备份**：
```bash
copy index.html index.html.bak
copy assets\js\app.js assets\js\app.js.bak
copy assets\css\style.css assets\css\style.css.bak
```

回滚时：
```bash
copy index.html.bak index.html
copy assets\js\app.js.bak assets\js\app.js
copy assets\css\style.css.bak assets\css\style.css
```

#### 7.2.2 模块级回滚（按模块独立回退）

由于所有旧 view 函数**保留不删**，单个模块出问题时可独立回退：

| 模块 | 回退操作 |
|------|----------|
| 互动中心 | 恢复 `viewInteract` 为 3 Tab 版本，恢复 `routes.dm/dm-inbox/comments` 注册 |
| 客户管理 | 恢复 `viewCustomers` 为表格版本，恢复 `routes.followups` 注册 |
| 数据报表 | 恢复 `viewReports` 为 2 Tab，恢复 `routes.funnel` 注册 |
| 设置 | 恢复 `viewSettings` 为 3 Tab，恢复 `routes.accounts/crawl/risk/monitor` 注册 |
| 菜单 | 恢复 index.html 侧边栏为 13 项 |

#### 7.2.3 灰度发布建议

1. **第一阶段**：只上线菜单+路由重定向，各新页面显示"建设中"占位 → 验证导航和重定向
2. **第二阶段**：上线数据报表（最简单）→ 验证 Tab 合并模式
3. **第三阶段**：上线互动中心 → 验证统一列表模式
4. **第四阶段**：上线客户管理 → 验证左右分栏模式
5. **第五阶段**：上线设置（最复杂）→ 验证多子页合并模式
6. **每阶段后观察 24 小时**，无问题再进入下一阶段

---

## 附录 A：行号速查表

### app.js 关键函数行号

| 函数 | 行号 | 改造方式 |
|------|------|----------|
| `route()` | 481 | 修改 redirects |
| `viewWorkbench()` | 548 | 不变 |
| `viewLeads()` | 619 | 不变 |
| `viewInteract(params)` | 817 | 重写 |
| `renderDmTab(content)` | 859 | 保留，提取 senderPanel |
| `renderInboxTab(content)` | 1118 | 保留 |
| `renderCommentsTab(content)` | 1409 | 保留 |
| `viewDm()` | 1508 | 保留（旧） |
| `viewDmInbox()` | 1788 | 保留（旧） |
| `viewCustomers(params)` | 2086 | 修改 |
| `renderCustomers()` | 2091 | 重写为 split 版 |
| `customerRow()` | 2135 | 保留 |
| `openCustomerDrawer()` | 2156 | 保留，提取 detail |
| `viewFollowups()` | 2290 | 保留（旧） |
| `viewFunnel()` | 2385 | 提取内容函数 |
| `viewReports(params)` | 2445 | 修改（+funnel Tab） |
| `loadAttributionBodyHtml()` | 2654 | 不变 |
| `viewAttribution()` | 2726 | 保留（旧） |
| `viewHealth()` | 2739 | 保留（旧） |
| `viewRisk()` | 2802 | 提取 pane |
| `viewScripts()` | 2866 | 不变 |
| `viewComments()` | 2960 | 保留（旧） |
| `viewAccounts(params)` | 3241 | 提取 pane |
| `healthRow()` | 2766 | 保留 |
| `accCard()` | 3350 | 保留 |
| `schedulerConfigPanel()` | 3405 | 保留 |
| `schedulerStatsRow()` | 3436 | 保留 |
| `wizardSkeletonHtml()` | 3471 | 保留 |
| `renderWizardBody()` | 3486 | 保留 |
| `viewWizard()` | 3600 | 保留（旧） |
| `viewCrawl()` | 3614 | 提取 pane |
| `viewSettings(params)` | 3837 | 重写（5 子页） |
| `renderBackupBody()` | 4185 | 保留 |
| `viewBackup()` | 4423 | 保留（旧） |
| `viewMonitor()` | 4454 | 提取 pane |

### index.html 关键区域

| 区域 | 行号 |
|------|------|
| SVG 图标库 | 13-40 |
| 顶部栏 | 55-92 |
| 侧边栏导航 | 95-167 |
| 主内容区 | 170-172 |
| 抽屉/弹窗/Toast | 176-188 |
| JS 引入 | 190-202 |

---

## 附录 B：新增函数清单

以下函数需在 app.js 中新增：

| 函数名 | 插入位置 | 用途 |
|--------|----------|------|
| `renderInteractList()` | 855 行附近 | 互动中心统一列表渲染 |
| `renderSenderPanel(mount)` | 855 行附近 | 发送控制面板（提取自 renderDmTab） |
| `renderCustomersSplit()` | 2091 行（替换 renderCustomers） | 客户管理左右分栏 |
| `renderCustomerDetail(c)` | 2156 行附近 | 客户详情面板（提取自 openCustomerDrawer） |
| `renderFunnelContent(mount)` | 2385 行附近 | 转化漏斗内容（提取自 viewFunnel） |
| `renderCompliancePane(mount)` | 2802 行附近 | 合规风险子页（提取自 viewRisk） |
| `renderAccountsPane(mount, params)` | 3241 行附近 | 账号设置子页（提取自 viewAccounts） |
| `renderCrawlPane(mount)` | 3614 行附近 | 采集配置子页（提取自 viewCrawl） |
| `renderMonitorPane(mount)` | 4454 行附近 | 系统监控子页（提取自 viewMonitor） |
| `renderSystemPane(mount, params)` | 3837 行附近 | 系统设置子页（原 viewSettings 主体） |
| `cleanupSettingsTimers()` | 3837 行附近 | 设置页定时器统一清理 |

---

*文档结束。后续子智能体请按本文档第 5 节的任务拆分执行开发，严格遵守行号区间隔离和接口约定。*
