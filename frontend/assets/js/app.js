/* ═══════════════════════════════════════════════════════════
   获客系统 v1.0 · 轻量 SPA（纯前端）
   信息架构（业务视角）：
     工作台 · 获客（线索池/私信任务/话术库/抖音账号）
     · 客户管理（客户与商机/今日跟进）
     · 经营分析（转化漏斗/触点归因/账号健康度/合规风险）
     · 设置（系统设置/数据备份）
     上线向导在「账号管理 → 上手向导」；业务配置 5 步与话术库合并在「话术与业务配置 → 业务画像」
   所有数据经 window.MOCK_API 获取（见 mock-data.js），
   本文件不含任何后端请求。
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const API = window.MOCK_API;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = $('#main');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n).toLocaleString('zh-CN');
  const wan = (n) => (n >= 10000 ? `¥${(n / 10000).toFixed(1)}万` : `¥${fmt(n)}`);

  /* 全局态 */
  const state = {
    safeMode: { active: false, reason: '', triggerSource: null },
    taskRunning: true,
    leads: [],
    leadsFilter: 'all',
    leadStatusMeta: {},
    sourceMeta: {},
    customers: [],
    stageMeta: {},
    custFilter: 'all',
  };

  /* ══════════ 轻提示 ══════════ */
  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = msg;
    $('#toast-region').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => el.remove(), 2800);
  }

  /**
   * 启动采集前的环境预检。
   * 不弹窗、不铺文案：把结果合进页面上的「环境检查」清单并展开，
   * 由用户自己在清单里点对应项的修复按钮。
   * 返回 true=可以启动；false=有阻塞项，已展开清单。
   */
  async function ensureDouyinLogin() {
    const ok = await loadDiag();
    if (ok === false) {
      crawlState.diag.expanded = true;
      renderDiag();
      toast('环境检查有未就绪项，已展开清单', 'warn');
      return false;
    }
    return true;
  }

  /* ══════════ AI 大模型辅助 ══════════ */
  const aiState = { settings: null, loading: false };

  /** 检查 AI 是否已配置 API Key，未配置时 toast 提示并返回 false */
  async function aiEnsureConfigured() {
    if (!aiState.settings) {
      try { aiState.settings = await API.getAISettings(); } catch (e) { aiState.settings = { configured: false }; }
    }
    if (!aiState.settings || !aiState.settings.configured) {
      toast('AI 服务未配置 API Key，请在设置页填写 DASHSCOPE_API_KEY 或 DOUBAO_API_KEY', 'warn');
      return false;
    }
    return true;
  }

  /** 统一处理 AI 接口错误：503 未配置 / 502 上游失败 / 其他 */
  function aiHandleError(e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes('503') || msg.includes('请配置')) {
      toast('AI 服务未配置：请设置 API Key 后再试', 'warn');
    } else if (msg.includes('502') || msg.includes('上游') || msg.includes('超时')) {
      toast('AI 服务调用失败（上游错误/超时），请稍后重试', 'warn');
    } else {
      toast('AI 服务异常：' + msg, 'warn');
    }
  }

  /* ══════════ 图标 / 页头 / 空状态（统一设计元素） ══════════ */
  // 取 index.html 内联 sprite 中的描边图标；颜色继承 currentColor（.ico 已定 --ink-soft）
  function ico(name, cls = '') {
    return `<span class="ico ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#${name}"/></svg></span>`;
  }
  // 统一页头：图标锚点 + 标题 + 副标题 + 操作区
  function pageHead(o = {}) {
    return `<div class="page-head">
      ${o.icon ? `<span class="page-head__ico">${ico(o.icon)}</span>` : ''}
      <div class="page-head__title">
        <h1>${esc(o.title)}</h1>
        ${o.desc ? `<span class="page-head__desc">${o.desc}</span>` : ''}
      </div>
      ${o.spacer !== false ? '<span class="page-head__spacer"></span>' : ''}
      ${o.actions ? `<div class="page-head__actions">${o.actions}</div>` : ''}
    </div>`;
  }
  // 统一空状态
  function emptyState(icon, text) {
    return `<div class="empty"><div class="empty__ico">${ico(icon)}</div><p>${esc(text)}</p></div>`;
  }
  // 大表格分批补行：首屏只渲染前 first 行，让页面立刻有滚动高度（马上能滚），
  // 其余行按 chunk 分批异步追加；重绘导致旧 tbody 失效时自动放弃
  function fillRowsProgressive(tbody, rows, rowHtmlFn, first = 40, chunk = 120) {
    if (!tbody || !rows || rows.length <= first) return;
    const rest = rows.slice(first);
    let i = 0;
    const step = () => {
      if (!tbody.isConnected) return;
      const end = Math.min(i + chunk, rest.length);
      const t = document.createElement('template');
      t.innerHTML = rest.slice(i, end).map(rowHtmlFn).join('');
      tbody.appendChild(t.content);
      i = end;
      if (i < rest.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  /* ══════════ 顶部栏 / 安全模式 联动 ══════════ */
  function renderTopbar() {
    document.body.classList.toggle('status-paused', !state.taskRunning);
    const pillTask = $('#pill-task');
    const pillSafe = $('#pill-safe');
    const banner = $('#safe-mode-banner');

    if (state.safeMode.active) {
      pillTask.innerHTML = '<span class="status-pill__led" style="background:var(--danger)"></span>已全量暂停';
      pillTask.className = 'status-pill status-pill--danger';
      pillSafe.textContent = '安全模式：开';
      pillSafe.className = 'status-pill status-pill--danger';
      banner.hidden = false;
      $('#safe-banner-reason').textContent =
        `触发原因：${state.safeMode.reason} · ${state.safeMode.triggeredAt} · 已发队列只读，新触达全部暂停，需人工确认方可退出`;
    } else {
      pillTask.innerHTML = state.taskRunning
        ? '<span class="status-pill__led"></span>采集运行中'
        : '<span class="status-pill__led" style="background:var(--warn)"></span>已手动暂停';
      pillTask.className = 'status-pill status-pill--running';
      pillSafe.textContent = '安全模式：关';
      pillSafe.className = 'status-pill status-pill--muted';
      banner.hidden = true;
    }
  }

  async function enterSafeMode(source, reason) {
    await API.enterSafeMode(source, reason);
    state.safeMode = { active: true, reason, triggeredAt: '刚刚', triggerSource: source };
    state.taskRunning = false;
    renderTopbar();
    toast('安全模式已启用，全部触达暂停', 'warn');
    route();
  }

  /* 退出安全模式 — 人工确认弹窗（IMP-004 防误恢复） */
  function openExitSafeModeModal() {
    openModal(`
      <h2 id="modal-title">退出安全模式 — 需人工确认</h2>
      <p style="font-size:13px;color:var(--ink-soft)">
        当前触发原因：<strong>${esc(state.safeMode.reason)}</strong><br>
        退出后系统将立即恢复新触达发送。请确认风险已排除（如账号限流已解除、话术已更换、黑名单已复核）。
      </p>
      <div class="confirm-note">
        本次操作将写入审计日志（复用 v0.2 审计表），记录操作人与退出原因，满足合规留痕要求。
      </div>
      <div class="field" style="margin-top:14px">
        <label for="exit-reason">退出原因（必填）</label>
        <textarea id="exit-reason" placeholder="例：账号「同城装修·班长」限流已解除，健康分回升，已复核黑名单"></textarea>
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-top:6px">
        <input type="checkbox" id="exit-confirm" style="margin-top:3px;accent-color:var(--danger)">
        <span>我已确认风险排除，明白恢复发送可能带来的封号风险</span>
      </label>
      <div class="modal__foot">
        <button type="button" class="btn" data-close>取消</button>
        <button type="button" class="btn btn--primary" id="btn-confirm-exit" disabled>确认退出并恢复</button>
      </div>
    `);
    const btn = $('#btn-confirm-exit');
    $('#exit-confirm').addEventListener('change', (e) => { btn.disabled = !e.target.checked; });
    btn.addEventListener('click', async () => {
      await API.exitSafeMode();
      state.safeMode = { active: false, reason: '', triggeredAt: null, triggerSource: null };
      state.taskRunning = true;
      closeModal();
      renderTopbar();
      toast('已退出安全模式，触达恢复');
      route();
    });
  }

  /* 一键暂停（不进安全模式，仅暂停） */
  $('#btn-pause-all').addEventListener('click', async () => {
    if (state.safeMode.active) { toast('安全模式中，请先人工确认退出', 'warn'); return; }
    if (!state.taskRunning) {
      await API.resumeAll(); state.taskRunning = true; toast('已恢复运行');
    } else {
      await API.pauseAll(); state.taskRunning = false; toast('已暂停全部采集与发送', 'warn');
    }
    renderTopbar(); route();
  });
  $('#btn-exit-safe-mode').addEventListener('click', openExitSafeModeModal);

  /* ══════════ 配置弹窗 ══════════ */
  $('#btn-settings').addEventListener('click', () => {
    openModal(`
      <h2 id="modal-title">系统配置</h2>
      <div class="grid grid--2" style="gap:14px">
        <div class="field"><label for="cfg-daily">单账号日频上限（R1 阈值）</label>
          <input type="number" id="cfg-daily" value="80"><span class="field__hint">达到后自动降速至 40/天，连续 2 天触顶暂停 24h</span></div>
        <div class="field"><label for="cfg-health">安全模式健康分阈值</label>
          <input type="number" id="cfg-health" value="40"><span class="field__hint">health_score 低于该值自动进入安全模式</span></div>
        <div class="field"><label for="cfg-bl">黑名单日增熔断阈值（R3）</label>
          <input type="number" id="cfg-bl" value="3"><span class="field__hint">日增超过 3% 触发全量暂停 + 人工复核</span></div>
        <div class="field"><label for="cfg-refresh">看板刷新策略（Q6）</label>
          <select id="cfg-refresh">
            <option>健康度预警：近实时（30s）</option>
            <option>漏斗/成本：小时级</option>
            <option>全部 T+1（最省资源）</option>
          </select></div>
        <div class="field"><label for="cfg-wecom">企微侧频控（IMP-030 双侧保护）</label>
          <select id="cfg-wecom">
            <option>培育 SOP：D1/D3 各 1 条（默认）</option>
            <option>严格：仅 D1</option>
          </select><span class="field__hint">过度群发把企微号搞封 = 同类风险，护栏覆盖抖音+企微双侧</span></div>
      </div>
      <div class="confirm-note">配置变更将写入审计日志。CORS 已按账号/Token 隔离（替代 v0.2 的 * 通配）。</div>
      <div class="modal__foot">
        <button type="button" class="btn" data-close>取消</button>
        <button type="button" class="btn btn--primary" data-close onclick="void 0" id="btn-save-cfg">保存</button>
      </div>
    `);
    $('#btn-save-cfg').addEventListener('click', () => { closeModal(); toast('配置已保存（演示态，未落库）'); });
  });

  /* ══════════ 弹窗基础设施 ══════════ */
  let modalHideTimer = null;

  function openModal(html, opts) {
    const modal = $('#modal'), bd = $('#modal-backdrop');
    // 取消上一次关闭遗留的延时隐藏，避免「关掉再立刻打开」被反向隐藏
    if (modalHideTimer) { clearTimeout(modalHideTimer); modalHideTimer = null; }
    modal.innerHTML = html;
    // 宽版弹窗：业务画像这类多列表单用（默认 560px 里挤不下）
    modal.classList.toggle('modal--wide', !!(opts && opts.wide));
    modal.classList.toggle('modal--biz', !!(opts && opts.variant === 'biz'));
    modal.hidden = false; bd.hidden = false;
    requestAnimationFrame(() => { modal.classList.add('show'); bd.classList.add('show'); });
    $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closeModal));
    bd.onclick = closeModal;
    document.addEventListener('keydown', escClose);
  }
  function closeModal() {
    const modal = $('#modal'), bd = $('#modal-backdrop');
    modal.classList.remove('show'); bd.classList.remove('show');
    if (modalHideTimer) clearTimeout(modalHideTimer);
    modalHideTimer = setTimeout(() => {
      modal.hidden = true; bd.hidden = true; modalHideTimer = null;
    }, 220);
    document.removeEventListener('keydown', escClose);
  }
  function escClose(e) {
    if (e.key !== 'Escape') return;
    // 有展开的下拉面板时，Esc 先收面板，不关弹窗（否则一按 Esc 整个表单都没了）
    const open = document.querySelector('.bdrop.is-open');
    if (open) { open.classList.remove('is-open'); return; }
    closeModal();
  }

  /* ══════════ 抽屉基础设施 ══════════ */
  function openDrawer(html) {
    const drawer = $('#lead-drawer'), bd = $('#drawer-backdrop');
    drawer.innerHTML = html;
    drawer.hidden = false; bd.hidden = false;
    requestAnimationFrame(() => { drawer.classList.add('open'); bd.classList.add('show'); });
    const close = () => {
      drawer.classList.remove('open'); bd.classList.remove('show');
      setTimeout(() => { drawer.hidden = true; bd.hidden = true; }, 300);
    };
    $('.drawer__close', drawer).addEventListener('click', close);
    bd.onclick = close;
    return close;
  }

  /* ══════════ 路由 ══════════ */
  /* ══════════ 通知中心（P4-A） ══════════ */
  const NOTIF_TYPE_META = {
    new_dm:           { label: '新私信' },
    followup_due:     { label: '跟进' },
    followup_overdue: { label: '跟进逾期' },
    deal_won:         { label: '成交' },
    wechat_added:     { label: '加微' },
    account_warning:  { label: '账号预警' },
    system:           { label: '系统' },
  };
  function notifTypeLabel(t) { return (NOTIF_TYPE_META[t] || { label: t }).label; }

  function notifTime(iso) {
    try {
      const d = new Date(iso);
      const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60) return '刚刚';
      if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
      if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return mm + '-' + dd;
    } catch (e) { return ''; }
  }

  async function renderBellBadge() {
    try {
      const r = await API.getUnreadCount();
      const n = (r && r.count) || 0;
      const badge = $('#bell-badge');
      if (badge) {
        if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? '99+' : String(n); }
        else { badge.hidden = true; }
      }
      const navBadge = $('#nav-notif-badge');
      if (navBadge) {
        if (n > 0) { navBadge.hidden = false; navBadge.textContent = n > 99 ? '99+' : String(n); }
        else { navBadge.hidden = true; }
      }
      return n;
    } catch (e) { return 0; }
  }

  function closeBellPanel() {
    const panel = $('#bell-panel');
    if (panel) panel.classList.remove('bell-panel--open');
    const btn = $('#btn-notifications');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  async function renderBellPanel() {
    const panel = $('#bell-panel');
    panel.innerHTML = '<div class="bell-panel__loading">加载中…</div>';
    let data;
    try { data = await API.getNotifications(false, 20); }
    catch (e) { panel.innerHTML = '<div class="bell-panel__loading">加载失败</div>'; return; }
    const items = (data && data.items) || [];
    if (!items.length) {
      panel.innerHTML = '<div class="bell-panel__empty">' + ico('bell') + '<p>暂无通知</p></div>';
      return;
    }
    const listHtml = items.map((n) => `
      <div class="bell-item ${n.read ? '' : 'bell-item--unread'}" data-notif-id="${esc(n.id)}" data-notif-type="${esc(n.type || '')}" data-related-type="${esc(n.relatedType || '')}" data-related-id="${esc(n.relatedId || '')}">
        <span class="bell-item__dot"></span>
        <div class="bell-item__body">
          <div class="bell-item__top">
            <b>${esc(n.title)}</b>
            <span class="bell-item__time">${esc(notifTime(n.createdAt))}</span>
          </div>
          <div class="bell-item__content">${esc(n.content)}</div>
        </div>
      </div>`).join('');
    panel.innerHTML = `
      <div class="bell-panel__head">通知中心</div>
      <div class="bell-panel__list">${listHtml}</div>
      <div class="bell-panel__foot">
        <button type="button" class="btn-link" id="bell-read-all">全部已读</button>
        <button type="button" class="btn-link" id="bell-view-all">查看全部</button>
      </div>`;
    $$('[data-notif-id]', panel).forEach((el) => el.addEventListener('click', async () => {
      const id = el.dataset.notifId;
      const type = el.dataset.notifType;
      const relatedType = el.dataset.relatedType;
      const relatedId = el.dataset.relatedId;
      try { await API.markNotificationRead(id); } catch (e) {}
      el.classList.remove('bell-item--unread');
      renderBellBadge();
      // 根据通知类型跳转到对应页面
      const routeMap = {
        'new_dm': '#/dm-inbox',
        'followup_due': '#/followups',
        'followup_overdue': '#/followups',
        'deal_won': '#/customers',
        'wechat_added': '#/leads',
        'account_warning': '#/health',
        'system': '#/notifications',
      };
      const target = routeMap[type] || '#/notifications';
      closeBellPanel();
      location.hash = target;
    }));
    $('#bell-read-all', panel).addEventListener('click', async () => {
      try { await API.markAllNotificationsRead(); } catch (e) {}
      toast('已全部标为已读');
      renderBellBadge();
      renderBellPanel();
      if (location.hash === '#/notifications') route();
    });
    $('#bell-view-all', panel).addEventListener('click', () => {
      closeBellPanel();
      location.hash = '#/notifications';
    });
  }

  function toggleBell() {
    const panel = $('#bell-panel');
    if (!panel.classList.contains('bell-panel--open')) {
      panel.classList.add('bell-panel--open');
      $('#btn-notifications').setAttribute('aria-expanded', 'true');
      renderBellPanel();
    } else {
      closeBellPanel();
    }
  }

  async function viewNotifications() {
    main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
    let data;
    try { data = await API.getNotifications(false, 100); }
    catch (e) {
      main.innerHTML = '<div class="view">' + pageHead({ icon: 'bell', title: '通知中心', desc: '' }) + emptyState('bell', '加载失败，请确认后端已启动') + '</div>';
      return;
    }
    const items = (data && data.items) || [];
    const filterState = { type: 'all' };
    const FILTERS = [
      { key: 'all', label: '全部' },
      { key: 'new_dm', label: '新私信' },
      { key: 'followup', label: '跟进' },
      { key: 'deal_won', label: '成交' },
      { key: 'wechat_added', label: '加微' },
      { key: 'account_warning', label: '账号预警' },
      { key: 'system', label: '系统' },
    ];
    function matchFilter(n) {
      if (filterState.type === 'all') return true;
      if (filterState.type === 'followup') return n.type === 'followup_due' || n.type === 'followup_overdue';
      return n.type === filterState.type;
    }
    function renderList() {
      const filtered = items.filter(matchFilter);
      const listEl = $('#notif-list');
      if (!filtered.length) { listEl.innerHTML = emptyState('bell', '没有相关通知'); return; }
      listEl.innerHTML = filtered.map((n) => `
        <div class="notif-item notif-item--${esc(n.level)} ${n.read ? '' : 'notif-item--unread'}" data-notif-id="${esc(n.id)}">
          <span class="notif-item__tag">${esc(notifTypeLabel(n.type))}</span>
          <div class="notif-item__body">
            <div class="notif-item__top">
              <b>${esc(n.title)}</b>
              <span class="notif-item__time">${esc(notifTime(n.createdAt))}</span>
            </div>
            <div class="notif-item__content">${esc(n.content)}</div>
          </div>
        </div>`).join('');
      $$('[data-notif-id]', listEl).forEach((el) => el.addEventListener('click', async () => {
        const id = el.dataset.notifId;
        try { await API.markNotificationRead(id); } catch (e) {}
        el.classList.remove('notif-item--unread');
        const it = items.find((x) => x.id === id);
        if (it) it.read = true;
        renderBellBadge();
      }));
    }
    function renderTabs() {
      const tabsEl = $('#notif-tabs');
      tabsEl.innerHTML = FILTERS.map((f) =>
        `<button type="button" class="notif-tab ${filterState.type === f.key ? 'notif-tab--active' : ''}" data-nf="${f.key}">${f.label}</button>`
      ).join('');
      $$('.notif-tab', tabsEl).forEach((b) => b.addEventListener('click', () => {
        filterState.type = b.dataset.nf;
        renderTabs(); renderList();
      }));
    }
    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'bell', title: '通知中心', desc: '新私信 · 跟进 · 成交 · 加微 · 账号预警，全在这里',
          actions: '<button type="button" class="btn btn--ghost btn--sm" id="notif-read-all">全部已读</button>' })}
        <div class="card">
          <div class="notif-tabs" id="notif-tabs"></div>
          <div class="notif-list" id="notif-list"></div>
        </div>
      </div>`;
    renderTabs();
    renderList();
    $('#notif-read-all').addEventListener('click', async () => {
      try { await API.markAllNotificationsRead(); } catch (e) {}
      items.forEach((n) => { n.read = true; });
      toast('已全部标为已读');
      renderList();
      renderBellBadge();
    });
  }

  /* 通知铃铛事件绑定（P4-A） */
  $('#btn-notifications').addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
  document.addEventListener('click', (e) => {
    const wrap = $('#bell-wrap');
    if (wrap && !wrap.contains(e.target)) closeBellPanel();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBellPanel();
  });

  const routes = {
    workbench: viewWorkbench,
    leads: viewLeads,
    interact: viewInteract,
    dm: viewDm,
    'dm-inbox': viewDmInbox,
    comments: viewComments,
    'comment-growth': viewCommentGrowth,
    scripts: viewScripts,
    accounts: viewAccounts,
    crawl: viewCrawl,
    customers: viewCustomers,
    followups: viewFollowups,
    funnel: viewFunnel,
    reports: viewReports,
    analytics: viewAnalytics,
    attribution: viewReports,
    health: viewHealth,
    risk: viewRisk,
    wizard: viewWizard,
    settings: viewSettings,
    monitor: viewMonitor,
    backup: viewBackup,
    notifications: viewNotifications,
  };
  function route() {
    closeBellPanel();
    closeModal();   // 切页时收起可能开着的弹窗，避免盖在新页面上
    let hash = (location.hash || '#/workbench').replace('#/', '');

    // 旧路由重定向映射
    const legacyRedirects = {
      'dm': 'interact?tab=dm',
      'dm-inbox': 'interact?tab=inbox',
      'comments': 'interact?tab=comments',
      'health': 'accounts?tab=health',
      'funnel': 'analytics',
      'reports': 'analytics',
      'attribution': 'analytics?dim=source',
      'wizard': 'accounts?tab=wizard',
      'backup': 'settings?tab=backup',
    };

    // 分离路径和查询参数
    let [p, query] = hash.split('?');

    // 旧路由重定向
    if (legacyRedirects[p]) {
      location.hash = '#/' + legacyRedirects[p];
      return;
    }

    const name = routes[p] ? p : 'workbench';
    const params = new URLSearchParams(query || '');

    $$('[data-nav]').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === name ? 'page' : 'false'));

    // 子菜单展开/高亮逻辑
    const crawlGroup = document.getElementById('crawl-group');
    const crawlItem = crawlGroup ? crawlGroup.closest('.nav-item--has-sub') : null;
    if (crawlItem) {
      const crawlPages = ['crawl', 'leads', 'interact'];
      if (crawlPages.includes(name)) {
        crawlItem.classList.add('expanded');
      }
    }

    main.innerHTML = '';
    routes[name](params);
    main.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);

  /* 通用指标卡 */
  function sparkline(points, { w = 200, h = 80, color = 'var(--brand)' } = {}) {
    if (!points || points.length < 2) return '';
    const max = Math.max(...points.map(p => p.v), 1);
    const min = Math.min(...points.map(p => p.v), 0);
    const range = max - min || 1;
    const padL = 8, padR = 8, padT = 18, padB = 14;
    const iw = w - padL - padR, ih = h - padT - padB;
    const x = i => padL + (i / (points.length - 1)) * iw;
    const y = v => padT + ih - ((v - min) / range) * ih;
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const areaPath = path + ` L${x(points.length - 1).toFixed(1)},${h - padB} L${x(0).toFixed(1)},${h - padB} Z`;
    // 找最高点和最低点
    let maxIdx = 0, minIdx = 0;
    points.forEach((p, i) => {
      if (p.v > points[maxIdx].v) maxIdx = i;
      if (p.v < points[minIdx].v) minIdx = i;
    });
    const lastIdx = points.length - 1;
    const lastVal = points[lastIdx].v;
    const maxVal = points[maxIdx].v;
    const minVal = points[minIdx].v;
    return `<svg class="spark" data-spark-w="${w}" data-spark-h="${h}" data-spark-color="${color}" data-spark-pts="${points.map((p) => p.v).join(',')}" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible;width:100%;height:${h}px">
      <!-- 最大值/最小值参考线 -->
      <line x1="${padL}" y1="${y(max).toFixed(1)}" x2="${w - padR}" y2="${y(max).toFixed(1)}" stroke="${color}" stroke-width="0.5" stroke-dasharray="3,3" stroke-opacity="0.3"/>
      <line x1="${padL}" y1="${y(min).toFixed(1)}" x2="${w - padR}" y2="${y(min).toFixed(1)}" stroke="${color}" stroke-width="0.5" stroke-dasharray="3,3" stroke-opacity="0.3"/>
      <!-- 面积 -->
      <path d="${areaPath}" fill="${color}" fill-opacity="0.1" stroke="none"/>
      <!-- 折线 -->
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <!-- 最高点 -->
      <circle cx="${x(maxIdx).toFixed(1)}" cy="${y(maxVal).toFixed(1)}" r="3" fill="${color}"/>
      <text x="${x(maxIdx).toFixed(1)}" y="${(y(maxVal) - 6).toFixed(1)}" text-anchor="middle" font-size="9" fill="${color}" font-weight="600">${maxVal}</text>
      <!-- 最低点 -->
      <circle cx="${x(minIdx).toFixed(1)}" cy="${y(minVal).toFixed(1)}" r="3" fill="${color}" fill-opacity="0.5"/>
      <text x="${x(minIdx).toFixed(1)}" y="${(y(minVal) + 11).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--ink-soft)" font-weight="500">${minVal}</text>
      <!-- 最新值端点 -->
      <circle cx="${x(lastIdx).toFixed(1)}" cy="${y(lastVal).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    </svg>`;
  }

  /* 迷你进度环 */
  function miniRing(percent, { size = 36, color = 'var(--brand)' } = {}) {
    const r = (size - 4) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.min(100, Math.max(0, percent)) / 100);
    return `<svg class="mini-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;flex-shrink:0">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
        transform="rotate(-90 ${size/2} ${size/2})"/>
      <text x="${size/2}" y="${size/2 + 3}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--ink)">${percent.toFixed(0)}%</text>
    </svg>`;
  }

  function metric(label, value, foot, tone, size, sparklineData, miniChart) {
    const color = tone === 'brand' ? 'style="color:var(--brand-deep)"' : tone === 'danger' ? 'style="color:var(--danger)"' : '';
    const sizeClass = size === 'large' ? ' metric--large' : '';
    const sparkColor = tone === 'brand' ? 'var(--brand-deep)' : tone === 'danger' ? 'var(--danger)' : 'var(--ink)';
    const spark = sparklineData ? sparkline(sparklineData, { w: 240, h: 96, color: sparkColor }) : '';
    if (size === 'large' && spark) {
      return `<div class="card metric${sizeClass}">
        <div class="metric-large__left">
          <span class="metric__label">${esc(label)}</span>
          <span class="metric-value" ${color}>${esc(value)}</span>
          <span class="metric__foot">${foot || ''}</span>
        </div>
        <div class="metric-large__right">
          <span class="metric-large__spark-label">近14天趋势</span>
          ${spark}
        </div>
      </div>`;
    }
    if (miniChart) {
      return `<div class="card metric metric--with-chart">
        <div class="metric__info">
          <span class="metric__label">${esc(label)}</span>
          <span class="metric-value" ${color}>${esc(value)}</span>
          <span class="metric__foot">${foot || ''}</span>
        </div>
        <div class="metric__chart">${miniChart}</div>
      </div>`;
    }
    return `<div class="card metric${sizeClass}">
      <span class="metric__label">${esc(label)}</span>
      <span class="metric-value" ${color}>${esc(value)}</span>
      <span class="metric__foot">${foot || ''}</span>
    </div>`;
  }

  /* 迷你折线图宽度自适应：按容器实测宽度重设 viewBox，1:1 铺满且不变形 */
  function fitSparklines(root) {
    const scope = root || document;
    let list;
    try {
      list = scope.querySelectorAll('svg.spark[data-spark-pts]');
    } catch (e) {
      return;
    }
    Array.prototype.forEach.call(list, (svg) => {
      const host = svg.parentElement;
      if (!host) return;
      const avail = Math.round(host.clientWidth);
      if (!avail || avail < 40) return;
      const curW = parseInt(svg.getAttribute('data-spark-w'), 10);
      if (curW && Math.abs(curW - avail) < 8) return;
      const h = parseInt(svg.getAttribute('data-spark-h'), 10) || 70;
      const color = svg.getAttribute('data-spark-color') || 'var(--brand)';
      const raw = svg.getAttribute('data-spark-pts') || '';
      const pts = raw.split(',').filter((s) => s !== '').map(Number).filter((n) => !isNaN(n));
      if (pts.length < 2) return;
      const box = document.createElement('div');
      box.innerHTML = sparkline(pts.map((v, i) => ({ date: i, v })), { w: avail, h, color });
      const next = box.firstElementChild;
      if (next) svg.replaceWith(next);
    });
  }

  /* SVG 折线图（无依赖） */
  function lineChart(points, { h = 180, pad = 26 } = {}) {
    const w = 640, iw = w - pad * 2, ih = h - pad * 2;
    const max = Math.max(...points.map((p) => p.v)) || 1;
    const x = (i) => pad + (i / (points.length - 1)) * iw;
    const y = (v) => pad + ih - (v / max) * ih;
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = `${path} L${x(points.length - 1)},${pad + ih} L${pad},${pad + ih} Z`;
    const grid = [0, 0.5, 1].map((t) => `<line class="chart-grid" x1="${pad}" y1="${pad + t * ih}" x2="${w - pad}" y2="${pad + t * ih}"/><text class="chart-axis" x="${pad - 6}" y="${pad + t * ih + 3}" text-anchor="end">${Math.round(max * (1 - t))}</text>`).join('');
    const dots = points.map((p, i) => `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.2"/>`).join('');
    const labels = points.filter((_, i) => i % 3 === 0 || i === points.length - 1)
      .map((p) => { const i = points.indexOf(p); return `<text class="chart-axis" x="${x(i)}" y="${h - 6}" text-anchor="middle">${p.date}</text>`; }).join('');
    return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="近14天加企微数折线图">
      <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1e6e52" stop-opacity=".22"/><stop offset="1" stop-color="#1e6e52" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>${dots}${labels}
    </svg>`;
  }

  /* 柱+线组合图：柱子=线索（松绿），折线=加微（赭金） */
  function comboChart(leadPoints, wechatPoints, { h = 220, w = 640 } = {}) {
    const pad = 40, padB = 28;
    const iw = w - pad * 2, ih = h - pad - padB;
    const maxLead = Math.max(...leadPoints.map(p => p.v), 1);
    const maxWechat = Math.max(...wechatPoints.map(p => p.v), 1);
    const x = i => pad + (i / (leadPoints.length - 1)) * iw;
    const yLead = v => pad + ih - (v / maxLead) * ih;
    const yWechat = v => pad + ih - (v / maxWechat) * ih;
    const barW = (iw / leadPoints.length) * 0.45;

    // 浅色网格线（4条水平线）
    const gridLines = [0.25, 0.5, 0.75, 1].map(ratio => {
      const gy = pad + ih * (1 - ratio);
      return `<line x1="${pad}" y1="${gy.toFixed(1)}" x2="${w - pad}" y2="${gy.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="3,3"/>`;
    }).join('');

    // Y轴刻度（左侧线索数）
    const yLabels = [0, 0.5, 1].map(ratio => {
      const gy = pad + ih * (1 - ratio);
      const val = Math.round(maxLead * ratio);
      return `<text x="${pad - 8}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#9ca3af">${val}</text>`;
    }).join('');

    // 柱子（松绿渐变）
    const bars = leadPoints.map((p, i) => {
      const bx = x(i) - barW / 2;
      const by = yLead(p.v);
      const bh = pad + ih - by;
      const isMax = p.v === maxLead;
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="url(#barGrad)" rx="3"/>${isMax ? `<text x="${x(i).toFixed(1)}" y="${(by - 5).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="600" fill="#1e6e52">${p.v}</text>` : ''}`;
    }).join('');

    // 折线（赭金，带平滑）
    const linePath = wechatPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yWechat(p.v).toFixed(1)}`).join(' ');
    // 折线下方渐变填充
    const areaPath = linePath + ` L${x(wechatPoints.length - 1).toFixed(1)},${pad + ih} L${x(0).toFixed(1)},${pad + ih} Z`;

    // 数据点（赭金，带白边）
    const dots = wechatPoints.map((p, i) => {
      const isMax = p.v === maxWechat && p.v > 0;
      return `<circle cx="${x(i).toFixed(1)}" cy="${yWechat(p.v).toFixed(1)}" r="${isMax ? 5 : 3.5}" fill="#b3741a" stroke="#fff" stroke-width="2"/>${isMax ? `<text x="${x(i).toFixed(1)}" y="${(yWechat(p.v) - 10).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="600" fill="#b3741a">${p.v}</text>` : ''}`;
    }).join('');

    // X轴标签（每隔2个显示，避免拥挤）
    const xLabels = leadPoints.map((p, i) => {
      if (i % 2 === 0 || i === leadPoints.length - 1) {
        return `<text x="${x(i).toFixed(1)}" y="${(h - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#6b7280">${p.date}</text>`;
      }
      return '';
    }).join('');

    // 图例（直接标注，不用单独图例框）
    const legend = `
      <rect x="${pad}" y="8" width="10" height="10" rx="2" fill="url(#barGrad)"/>
      <text x="${pad + 14}" y="17" font-size="10" fill="#374151">线索数</text>
      <line x1="${pad + 70}" y1="13" x2="${pad + 84}" y2="13" stroke="#b3741a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${pad + 77}" cy="13" r="3" fill="#b3741a" stroke="#fff" stroke-width="1.5"/>
      <text x="${pad + 90}" y="17" font-size="10" fill="#374151">加微数</text>`;

    return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="display:block;font-family:inherit;width:100%;height:auto;max-height:${h}px">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1e6e52" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#1e6e52" stop-opacity="0.45"/>
        </linearGradient>
        <linearGradient id="comboAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#b3741a" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="#b3741a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${legend}
      ${gridLines}
      ${yLabels}
      ${bars}
      <path d="${areaPath}" fill="url(#comboAreaGrad)"/>
      <path d="${linePath}" fill="none" stroke="#b3741a" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${xLabels}
      <line x1="${pad}" y1="${pad + ih}" x2="${w - pad}" y2="${pad + ih}" stroke="#d1d5db" stroke-width="1"/>
    </svg>`;
  }

  /* 横向柱状图：来源对比 */
  function hBarChart(data, { h = 200, w = 320 } = {}) {
    if (!data || data.length === 0) return '<div class="empty"><p>暂无数据</p></div>';
    const padL = 64, padR = 12, padT = 10, padB = 10;
    const iw = w - padL - padR;
    const maxVal = Math.max(...data.map(d => d.leads), 1);
    const rowH = (h - padT - padB) / data.length;
    const bars = data.map((d, i) => {
      const y = padT + i * rowH + rowH * 0.2;
      const bh = rowH * 0.6;
      const bw = (d.leads / maxVal) * iw;
      const rate = d.leads > 0 ? ((d.wechat / d.leads) * 100).toFixed(1) : '0.0';
      const label = d.label.length > 6 ? d.label.slice(0, 6) + '…' : d.label;
      // 柱够长就把数值放进柱内（白字），否则放柱外 —— 既让柱子画得更长，也避免文字超出右边界被裁
      const txt = `${d.leads} · 加微${rate}%`;
      const inside = bw > 76;
      const tx = (inside ? padL + bw - 6 : padL + bw + 6).toFixed(1);
      const tAnchor = inside ? 'end' : 'start';
      const tFill = inside ? '#ffffff' : 'var(--ink-soft)';
      return `<text x="${padL - 8}" y="${(y + bh / 2 + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--ink)" font-weight="500">${label}</text><rect x="${padL}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--brand)" fill-opacity="0.7" rx="3"/><text x="${tx}" y="${(y + bh / 2 + 3).toFixed(1)}" text-anchor="${tAnchor}" font-size="10" fill="${tFill}">${txt}</text>`;
    }).join('');
    return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:auto;max-height:${h}px">${bars}</svg>`;
  }
  /* 半圆形仪表盘：转化率展示 */
  function gaugeChart(value, { label = '转化率', max = 100, size = 160 } = {}) {
    const pct = Math.min(100, Math.max(0, (value / max) * 100));
    const r = size / 2 - 10;
    const cx = size / 2;
    const cy = size / 2 + 10;
    // 颜色：低=红，中=黄，高=绿
    const color = pct < 20 ? '#ef4444' : pct < 50 ? '#f59e0b' : '#10b981';
    // 半圆路径：从180度到0度
    const startAngle = Math.PI;
    const endAngle = Math.PI * (1 - pct / 100);
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy - r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy - r * Math.sin(endAngle);
    const largeArc = pct > 50 ? 1 : 0;
    // 线宽与字号随 size 等比缩放：size=160 时仍为 12 / 28 / 11，与原有样式一致
    const sw = Math.max(8, Math.round(size / 13));
    const fsVal = Math.max(14, Math.round(size * 0.175));
    const fsLabel = Math.max(11, Math.round(size * 0.069));
    // 背景弧
    const bgX2 = cx + r * Math.cos(0);
    const bgY2 = cy - r * Math.sin(0);
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:10px 0">
        <svg class="gauge" width="${size}" height="${size * 0.65}" viewBox="0 0 ${size} ${size * 0.65}" style="display:block">
          <!-- 背景弧 -->
          <path d="M ${x1} ${y1} A ${r} ${r} 0 1 1 ${bgX2} ${bgY2}" fill="none" stroke="#e5e7eb" stroke-width="${sw}" stroke-linecap="round"/>
          <!-- 进度弧 -->
          <path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>
          <!-- 中心数字 -->
          <text x="${cx}" y="${cy - size * 0.031}" text-anchor="middle" font-size="${fsVal}" font-weight="700" fill="var(--ink)">${value.toFixed(1)}%</text>
          <text x="${cx}" y="${cy + size * 0.094}" text-anchor="middle" font-size="${fsLabel}" fill="var(--ink-soft)">${label}</text>
        </svg>
      </div>`;
  }


  /* ═══════════════════════════════════════════
     视图：工作台（今日运营总览）
     ═══════════════════════════════════════════ */
  async function viewWorkbench() {
    const [wb, fups, ctRes] = await Promise.all([
      API.getWorkbench(), API.getFollowups(),
      (typeof API.getCommentTasks === 'function' ? API.getCommentTasks() : Promise.resolve([])).catch(() => []),
    ]);
    // 有人回复了我的评论、待继续回复（多级评论检测命中 → status='user_replied'）
    const ctArr = Array.isArray(ctRes) ? ctRes : ((ctRes && ctRes.items) || []);
    // v008：多级评论回复聚合统计
    const replyTaskCount = ctArr.filter((t) => t.status === 'user_replied').length;
    const replyTotal = ctArr.reduce((s, t) => s + (Number(t.replyCount) || 0), 0);
    const peopleSet = new Set();
    ctArr.forEach((t) => {
      let subs = [];
      try { subs = t.subReplies ? JSON.parse(t.subReplies) : []; } catch (e) { subs = []; }
      subs.forEach((r) => { const n = r.nickname || r.user_name; if (n) peopleSet.add(n); });
    });
    const replyPeople = peopleSet.size;
    const maxDepth = ctArr.reduce((m, t) => Math.max(m, Number(t.replyDepth) || 0), 0);
    const replyCount = replyTaskCount;  // 保持下方展示引用兼容
    const t = wb.today;
    const dotColor = { ok: 'var(--ok)', info: 'var(--info)', warn: 'var(--warn)', danger: 'var(--danger)' };
    const undone = fups.filter((f) => !f.done);
    const todoTop = undone.slice(0, 3);

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'home', title: '工作台', desc: `${esc(wb.date)} · 今天该做什么，一眼看完` })}

        <div class="grid grid--metrics">
          ${metric('今日新线索', fmt(t.newLeads), '全部触点汇总 · source 归因')}
          ${metric('待发私信', fmt(t.pendingSend), `今日已发 ${t.sentToday} 条`)}
          ${metric('今日加微 ★', fmt(t.wechatToday), '北极星 · 北极星回调实时计数', 'brand')}
          ${metric('今日成交', wan(t.deal.amount), `${t.deal.count} 单 · IMP-029 录入`)}
          ${metric('待跟进', fmt(t.followupsPending), t.followupsOverdue ? `⚠ ${t.followupsOverdue} 条已逾期` : '无逾期', t.followupsOverdue ? 'danger' : '')}
          ${metric('评论互动', fmt(replyTotal), `${replyPeople} 人参与 · 最深 L${(maxDepth + 1)} · ${replyTaskCount} 条待回复`, replyTotal ? 'brand' : '')}
        </div>

        <div class="grid grid--main-side">
          <div class="card">
            <div class="card__head">
              <span class="card__title">需要你处理</span>
              <span class="card__hint">按严重度排序 · 点右侧跳转处理</span>
            </div>
            ${replyCount > 0 ? `
              <div class="alert-item" style="background:var(--brand-tint-2);border-radius:10px">
                <span class="alert-item__dot" style="background:var(--brand)"></span>
                <span class="alert-item__text">💬 ${replyCount} 人回复了你的评论（共 ${replyTotal} 条回复 · ${replyPeople} 人参与 · 最深 L${(maxDepth + 1)}），待继续回复</span>
                <a class="btn-link" href="#/interact?tab=comments">去回复 →</a>
              </div>` : ''}
            ${wb.alerts.map((a) => `
              <div class="alert-item">
                <span class="alert-item__dot" style="background:${dotColor[a.level]}"></span>
                <span class="alert-item__text">${esc(a.text)}</span>
                <a class="btn-link" href="${esc(a.href)}">${esc(a.action)} →</a>
              </div>`).join('')}
          </div>

          <div class="col-grid" style="min-width:0">
            <div class="card">
              <div class="card__head">
                <span class="card__title">今日待办</span>
                <a class="btn-link" href="#/followups">全部 ${undone.length} 条 →</a>
              </div>
              <div class="todo">
                ${todoTop.map((f) => `
                  <div class="todo-item ${f.overdue ? 'todo-item--overdue' : ''}">
                    <span class="timeline__dot" style="background:${f.overdue ? 'var(--danger)' : 'var(--brand)'};margin:0"></span>
                    <div class="todo__text"><b>${esc(f.customerName)} · ${esc(f.type)}</b>
                      <span class="todo__meta">${esc(f.text)}</span></div>
                    <span class="todo__due ${f.overdue ? 'todo__due--overdue' : ''}">${esc(f.due)}</span>
                  </div>`).join('')}
              </div>
            </div>
            <div class="card">
              <div class="card__head">
                <span class="card__title">实时动态</span>
                <a class="btn-link" href="#/risk">审计日志 →</a>
              </div>
              <ul class="timeline">
                ${wb.activity.slice(0, 4).map((e) => `
                  <li>
                    <span class="timeline__dot" style="background:${dotColor[e.level]}"></span>
                    <span>${esc(e.text)}</span>
                    <span class="timeline__time num">${esc(e.time)}</span>
                  </li>`).join('')}
              </ul>
            </div>
          </div>
        </div>
      </div>`;
  }

  /* ═══════════════════════════════════════════
     视图：线索池（leads 状态机 + source 归因）
     ═══════════════════════════════════════════ */
  async function viewLeads() {
    [state.leadStatusMeta, state.sourceMeta, state.leads] = await Promise.all([
      API.getLeadStatusMeta(), API.getSourceMeta(), API.getLeads(),
    ]);
    renderLeads();
  }

  function renderLeads() {
    const meta = state.leadStatusMeta;
    const srcMeta = state.sourceMeta;
    const filters = [
      { key: 'all', label: '全部', count: state.leads.length },
      ...Object.entries(meta).map(([key, m]) => ({
        key, label: m.label,
        count: state.leads.filter((l) => l.status === key).length,
      })).filter((f) => f.count > 0),
    ];
    const list = state.leadsFilter === 'all' ? state.leads : state.leads.filter((l) => l.status === state.leadsFilter);

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'leads', title: '筛选高意向', desc: '全部触点汇入同一漏斗 · 状态机：采集 → 待发 → 已发 → 回复 → 加微 ★ → 成交' })}
        <div class="filter-bar" role="group" aria-label="按状态筛选">
          ${filters.map((f) => `
            <button type="button" class="filter-chip" data-filter="${f.key}" aria-pressed="${state.leadsFilter === f.key}">
              ${esc(f.label)}<span class="count num">${f.count}</span>
            </button>`).join('')}
        </div>
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead><tr>
                <th>用户</th><th>评论/留言</th><th>来源触点</th><th>意向</th><th>执行账号</th><th>状态</th><th>时间</th><th></th>
              </tr></thead>
              <tbody>
                ${list.length ? list.map((l) => leadRow(l, meta, srcMeta)).join('')
                  : `<tr><td colspan="8"><div class="empty">${emptyState('leads', '该状态下暂无线索')}</div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;

    $$('.filter-chip').forEach((b) => b.addEventListener('click', () => {
      state.leadsFilter = b.dataset.filter;
      renderLeads();
    }));
    $$('[data-lead-id]').forEach((b) => b.addEventListener('click', () => openLeadDrawer(b.dataset.leadId)));
    $$('[data-mark-wechat]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.markWechat;
      await API.markWechatAdded(id);
      state.leads = await API.getLeads();
      toast('已手动标记加微（manual=true），北极星 +1');
      renderLeads();
    }));
    $$('[data-enqueue-lead]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.enqueueLead;
      await API.enqueueLead(id);
      state.leads = await API.getLeads();
      toast('已移入发送队列，状态变为待发送');
      renderLeads();
    }));
  }

  function leadRow(l, meta, srcMeta) {
    const intentTag = { high: '<span class="tag tag--high">高意向</span>', mid: '<span class="tag tag--mid">中意向</span>', low: '<span class="tag tag--low">低意向</span>' }[l.intent];
    const st = meta[l.status] || { label: l.status, cls: '' };
    const src = srcMeta[l.source] || { label: l.source, cls: 'collected' };
    const isDanger = l.status === 'send_failed' || l.status === 'throttled';
    const canMark = ['sent', 'replied'].includes(l.status);
    const canEnqueue = l.status === 'collected';
    return `
      <tr class="${isDanger ? 'row--danger' : ''}" data-lead-id="${l.id}" style="cursor:pointer">
        <td><div class="cell-user">
          <span class="avatar" style="background:hsl(${l.hue} 45% 44%)">${esc(l.nickname.slice(0, 1))}</span>
          <span style="font-weight:600">${esc(l.nickname)}</span>
        </div></td>
        <td class="cell-comment" title="${esc(l.comment)}">${esc(l.comment)}</td>
        <td><span class="tag tag--${src.cls}">${esc(src.label)}</span></td>
        <td>${intentTag}</td>
        <td style="color:var(--ink-soft)">${l.account ? esc(l.account) : '—'}</td>
        <td><span class="tag tag--${st.cls}">${st.label}${l.manual ? ' <small>(手标)</small>' : ''}</span></td>
        <td class="num" style="color:var(--ink-faint)">${esc(l.createdAt)}</td>
        <td>${canEnqueue && !state.safeMode.active ? `<button type="button" class="btn-link" data-enqueue-lead="${l.id}" title="将此线索移入私信发送队列">移入发送队列</button>` : ''}${canMark && !state.safeMode.active ? `<button type="button" class="btn-link" data-mark-wechat="${l.id}" title="IMP-002 降级入口：无直连回调时手动标记">标记加微</button>` : ''}</td>
      </tr>`;
  }

  /* 线索详情抽屉 */
  function openLeadDrawer(leadId) {
    const l = state.leads.find((x) => x.id === leadId);
    if (!l) return;
    const meta = state.leadStatusMeta;
    const src = state.sourceMeta[l.source] || { label: l.source, cls: 'collected' };
    const st = meta[l.status] || { label: l.status, cls: '' };
    const close = openDrawer(`
      <div class="drawer__head">
        <span class="avatar" style="background:hsl(${l.hue} 45% 44%);width:34px;height:34px;font-size:14px">${esc(l.nickname.slice(0, 1))}</span>
        <div class="drawer__title">
          ${esc(l.nickname)}
          <span class="tag tag--${st.cls}" style="margin-left:8px;vertical-align:2px">${st.label}</span>
        </div>
        <button type="button" class="drawer__close" aria-label="关闭">×</button>
      </div>
      <div class="drawer__body">
        <dl class="kv">
          <dt>线索 ID</dt><dd class="num">${esc(l.id)}</dd>
          <dt>来源触点</dt><dd><span class="tag tag--${src.cls}">${esc(src.label)}</span></dd>
          <dt>评论内容</dt><dd>“${esc(l.comment)}”</dd>
          <dt>来源视频</dt><dd>${esc(l.video)}</dd>
          <dt>意向信号</dt><dd>${{ high: '高', mid: '中', low: '低' }[l.intent]}</dd>
          <dt>执行账号</dt><dd>${l.account ? esc(l.account) : '未分配'}</dd>
          <dt>采集时间</dt><dd class="num">${esc(l.createdAt)}</dd>
          ${l.dealAmount ? `<dt>成交金额</dt><dd class="num" style="color:var(--ok);font-weight:700">¥${fmt(l.dealAmount)}</dd>` : ''}
          ${l.wechatAddedAt ? `<dt>加微时间</dt><dd class="num">${esc(l.wechatAddedAt)}${l.manual ? '（手动标记）' : '（自动回调）'}</dd>` : ''}
          ${l.referralNote ? `<dt>转介绍</dt><dd style="color:var(--brand-deep)">${esc(l.referralNote)}</dd>` : ''}
          ${l.throttledNote ? `<dt>暂缓原因</dt><dd style="color:var(--warn)">${esc(l.throttledNote)}</dd>` : ''}
          ${l.failNote ? `<dt>失败原因</dt><dd style="color:var(--danger)">${esc(l.failNote)}</dd>` : ''}
          ${l.rejectReason ? `<dt>过滤原因</dt><dd>${esc(l.rejectReason)}</dd>` : ''}
        </dl>

        ${(l.messages || []).length ? `
          <div>
            <div class="card__title" style="margin-bottom:10px">私信记录</div>
            <div class="msg-list">
              ${(l.messages || []).map((m) => `
                <div class="msg msg--${m.dir === 'out' ? 'out' : 'in'}">
                  ${esc(m.text)}
                  <div class="msg__meta">${m.dir === 'out' ? '系统发送' : '用户'} · ${esc(m.time)}${m.variant ? ` · 变体${m.variant}` : ''}</div>
                </div>`).join('')}
            </div>
          </div>` : emptyState('dm', '暂无私信记录')}

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button type="button" class="btn btn--ghost" id="drawer-ai-analyze" style="border-color:var(--brand);color:var(--brand-deep)">
            <span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 画像分析
          </button>
          ${['sent', 'replied'].includes(l.status) && !state.safeMode.active ? `
            <button type="button" class="btn btn--primary" id="drawer-mark">
              手动标记「已加企微」（IMP-002 降级入口）
            </button>` : ''}
        </div>
        <div id="drawer-ai-result" style="margin-top:10px"></div>
      </div>`);

    const markBtn = $('#drawer-mark');
    if (markBtn) markBtn.addEventListener('click', async () => {
      await API.markWechatAdded(l.id);
      state.leads = await API.getLeads();
      close(); toast('已手动标记加微，北极星 +1'); renderLeads();
    });

    // AI 画像分析
    const aiBtn = $('#drawer-ai-analyze');
    if (aiBtn) aiBtn.addEventListener('click', async () => {
      if (!(await aiEnsureConfigured())) return;
      aiBtn.disabled = true; aiBtn.textContent = '分析中…';
      const resultEl = $('#drawer-ai-result');
      if (resultEl) resultEl.innerHTML = '<div style="color:var(--ink-soft);font-size:13px">AI 正在分析线索画像…</div>';
      try {
        const result = await API.aiAnalyzeLead({
          nickname: l.nickname,
          comment: l.comment || '',
          video_title: l.video || '',
          source_keyword: l.sourceKeyword || '',
        });
        const levelColor = { A: 'var(--danger)', B: 'var(--warn)', C: 'var(--ink-soft)' }[result.intent_level] || 'var(--ink-soft)';
        const tagsHtml = (result.tags || []).map((t) => `<span class="tag tag--low" style="margin:2px 4px 2px 0">${esc(t)}</span>`).join('');
        if (resultEl) resultEl.innerHTML = `
          <div style="background:var(--brand-tint-2);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.7">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-weight:700;color:var(--brand-deep)">AI 画像分析结果</span>
              <span style="color:${levelColor};font-weight:700;font-size:15px">意向 ${result.intent_level}</span>
            </div>
            <div><b>核心需求：</b>${esc(result.customer_need || '—')}</div>
            <div style="margin:4px 0"><b>需求标签：</b>${tagsHtml || '—'}</div>
            <div><b>推荐话术：</b>${esc(result.recommended_script_category || '—')}</div>
            <div><b>跟进建议：</b>${esc(result.follow_up_suggestion || '—')}</div>
            ${result.raw_reasoning ? `<div style="color:var(--ink-faint);font-size:11px;margin-top:4px">判断依据：${esc(result.raw_reasoning)}</div>` : ''}
          </div>`;
        toast('画像分析完成，已自动回写线索标签', 'ok');
        // 刷新线索列表
        state.leads = await API.getLeads();
      } catch (e) {
        aiHandleError(e);
        if (resultEl) resultEl.innerHTML = '';
      } finally {
        aiBtn.disabled = false;
        aiBtn.innerHTML = '<span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 画像分析';
      }
    });
  }


  /* ═══════════════════════════════════════════
     视图：评论候选池工作台（P3）
     ─ 数字卡 / 风险警示条 / 前端筛选 / 商机表
     ─ 行内流程：生成话术 → 质检 → 人工确认建回复任务
     ─ 固定免责声明；不提供任何批量发送能力
     ═══════════════════════════════════════════ */
  const CG_DISCLAIMER = '⚠️ 本内容为通用提效建议，不构成专业意见。平台规则、违规词、私信合规等请以官方与持证运营人士意见为准。';
  const CG_CATEGORY_META = {
    inquiry:  { label: '询价',     cls: 'wechat' },
    solution: { label: '求方案',   cls: 'sent' },
    pain:     { label: '明确痛点', cls: 'throttled' },
    identity: { label: '决策人',   cls: 'replied' },
    other:    { label: '其他',     cls: 'rejected' },
  };
  const CG_SENTIMENT_META = {
    positive: { label: '正面', cls: 'healthy' },
    neutral:  { label: '中性', cls: 'collected' },
    negative: { label: '负面', cls: 'high' },
  };
  // 回复类型 → 生成话术场景（后端 scenario 枚举）
  const CG_SCENARIO_OF = { complaint: 'complaint', objection: 'objection', praise: 'praise', inquiry: 'inquiry' };
  const CG_FILTERS = [
    { key: 'intent', label: '意向', opts: [['all', '全部'], ['A', 'A 级'], ['B', 'B 级'], ['C', 'C 级']] },
    { key: 'sentiment', label: '情绪', opts: [['all', '全部'], ['positive', '正面'], ['neutral', '中性'], ['negative', '负面']] },
    { key: 'category', label: '分类', opts: [['all', '全部'], ['inquiry', '询价'], ['solution', '求方案'], ['pain', '痛点'], ['identity', '决策人'], ['other', '其他']] },
    // 评论时间：预设区间 + 自定义（右侧两个日期框）。命中口径见 _cgDayKey
    { key: 'time', label: '评论时间', opts: [['all', '全部'], ['today', '今天'], ['3d', '近 3 天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['custom', '自定义']] },
  ];
  const _cgInsight = new Map();   // 评论内容 → 分级结果（会话内缓存，避免重复请求）
  const _cgState = {
    filter: { task: 'all', intent: 'all', sentiment: 'all', category: 'all', status: 'all', time: 'all', timeFrom: '', timeTo: '' },
    tab: 'all',                   // 候选池拆分：all / unpushed / pushed
    openId: null,                 // 当前展开的行
    draft: {},                    // taskId → {text, suggestions, guard, notice, busy, created, pushed}
    checked: new Set(),           // 勾选待推送的线索 id
    pushing: false,               // 批量推送中
    crawlTasks: [],               // 采集任务列表（用于按任务筛选）
    deleting: false,              // 批量删除中
  };
  function _cgDraft(id) {
    if (!_cgState.draft[id]) {
      _cgState.draft[id] = { text: '', suggestions: [], guard: null, notice: null, busy: '', created: false, pushed: false };
    }
    return _cgState.draft[id];
  }
  function _cgKeyOf(t) { return String((t && (t.id || t.commentContent)) || ''); }
  function _cgInsightOf(t) { return _cgInsight.get(_cgKeyOf(t)) || null; }
  function _cgIsFallback(ins) { return !!(ins && /兜底/.test(ins.reason || '')); }
  // 评论时间：采集回来格式很杂 —— unix 秒（10 位）/ 毫秒（13 位）/ 'YYYY-MM-DD' / ISO 串 / 空
  function _cgParseTime(v) {
    const raw = String(v || '').trim();
    if (!raw) return null;
    if (/^\d{10}$/.test(raw)) return new Date(parseInt(raw, 10) * 1000);
    if (/^\d{13}$/.test(raw)) return new Date(parseInt(raw, 10));
    const d = new Date(raw.replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }
  // 归一到本地日期键 YYYY-MM-DD：时间范围比较靠它，字符串比较即可
  function _cgDayKey(v) {
    const d = _cgParseTime(v);
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function _cgFmtTime(v) {
    const raw = String(v || '').trim();
    if (!raw) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;   // 只有日期，原样显示
    const d = _cgParseTime(raw);
    if (!d) return raw;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // 列表默认排序：评论时间倒序，最新的在最上面。
  // 与时间筛选同一口径 —— 评论时间为空时回退采集/创建时间，两者都取不到才沉到末尾，
  // 否则那批没有评论时间的老数据会一股脑挤在头部。
  function cgSortKey(t) {
    const d = _cgParseTime(t && t.commentTime) || _cgParseTime(t && t.createdAt);
    return d ? d.getTime() : 0;
  }
  function sortByCommentTimeDesc(list) {
    return (list || []).slice().sort((a, b) => cgSortKey(b) - cgSortKey(a));
  }


  /* ── 候选池：来自「高意向线索」，不是已有任务 ──
     页面原来读 comment_tasks 当候选，导致候选池 == 任务池：拿旧任务的视频
     地址去建新任务，而库里早期任务清一色是 /video/999 这类占位地址，定位必然
     失败。改为直接读 leads，建任务时才真正落 tasks。 */
  const _CG_PLACEHOLDER_RE = /\/video\/(?:v\w*|video_\w*|\d{1,14})(?:[/?#]|$)/;
  // 与后端 app/core/douyin_url.py 同口径：真实抖音视频 id 是 19 位数字
  function _cgUsableVideoUrl(url) {
    const u = String(url || '').trim();
    return !!u && !_CG_PLACEHOLDER_RE.test(u);
  }
  // 线索 → 候选行：形状对齐 comment_tasks，下面的表格/详情逻辑无需改动
  function _cgLeadToCandidate(l) {
    const lv = l.intentLevel || (l.intent === 'high' ? 'A' : (l.intent === 'mid' ? 'B' : 'C'));
    return {
      id: l.id,
      leadId: l.id,
      commentContent: l.comment || '',
      videoTitle: l.video || '',
      videoUrl: l.sourceUrl || '',
      commentId: l.commentId || '',
      account: l.account || '',
      status: l.status || 'collected',
      priority: lv === 'A' ? 'P0' : (lv === 'B' ? 'P1' : 'P2'),
      replyContent: '',
      createdAt: l.createdAt,
      leadIntentLevel: lv,
      // v009：完整上下文（评论人 / 评论时间 / 视频 ID），推送后待办互动要直接看到
      commentAuthor: l.nickname || '',
      commentTime: l.commentTime || '',
      videoId: l.videoId || '',
      // 关联采集任务（用于按任务筛选）
      sourceTaskId: l.sourceTaskId || l.source_task_id || '',
    };
  }
  // 能进候选池的线索：自家视频评论 + 有评论原文 + 视频地址真实可用
  function _cgEligibleLead(l) {
    if (!l || l.source !== 'own_comment') return false;
    if (!String(l.comment || '').trim()) return false;
    return _cgUsableVideoUrl(l.sourceUrl);
  }

  function _cgIsToday(v) {
    if (!v) return false;
    const d = new Date(v);
    if (isNaN(d.getTime())) return false;
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  // 逐条语义分级（并发 3；接口自身有兜底，不会阻塞页面）
  async function _cgLoadInsights(pending) {
    let i = 0;
    // 合并而非覆盖：候选池的意向等级来自线索（采集阶段规则判定），
    // AI 只负责补分类/情绪，不参与改写意向，否则 AI 未配置时整池会掉成 C
    function merge(t, ins) {
      const key = _cgKeyOf(t);
      const prev = _cgInsight.get(key) || {};
      const next = Object.assign({}, prev, ins || {});
      if (prev.leadIntentLevel) next.intentLevel = prev.leadIntentLevel;
      _cgInsight.set(key, next);
    }
    async function worker() {
      while (i < pending.length) {
        const t = pending[i++];
        try {
          const ins = await API.commentInsight({ comment: t.commentContent, videoTitle: t.videoTitle || '' });
          merge(t, ins);
        } catch (e) {
          merge(t, {
            category: 'other', sentiment: 'neutral',
            reason: '分级请求失败：' + (e.message || e),
          });
        }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
  }

  async function viewCommentGrowth(params) {
    const readTasks = typeof API.getCommentGrowthTasks === 'function' ? API.getCommentGrowthTasks : API.getCommentTasks;
    let tasks = [];
    let loadError = '';
    let risk = null;
    let skipped = { notMine: 0, noComment: 0, badUrl: 0, enqueued: 0 };
    try {
      // 候选池 = 高意向线索（自家视频评论 + 有评论原文 + 视频地址可用）。
      // 已推送的线索不再排除：候选池常驻，按「全部 / 未推送 / 已推送」拆分，
      // 推过去只是建一条评论回复任务，真正的发送仍在「待办互动 → 评论回复」。
      const [leads, existing, crawlTasksRaw] = await Promise.all([
        API.getLeads(),
        (typeof readTasks === 'function' ? readTasks() : Promise.resolve([])).catch(() => []),
        (window.CrawlAPI && typeof CrawlAPI.listTasks === 'function')
          ? CrawlAPI.listTasks().catch(() => [])
          : Promise.resolve([]),
      ]);
      // 采集任务按创建时间倒序，用于筛选器
      _cgState.crawlTasks = (Array.isArray(crawlTasksRaw) ? crawlTasksRaw : [])
        .slice()
        .sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0));
      const enqueued = new Set((existing || []).map((t) => t.leadId).filter(Boolean));
      const picked = [];
      (Array.isArray(leads) ? leads : []).forEach((l) => {
        if (!l || l.source !== 'own_comment') { skipped.notMine += 1; return; }
        if (!String(l.comment || '').trim()) { skipped.noComment += 1; return; }
        if (!_cgUsableVideoUrl(l.sourceUrl)) { skipped.badUrl += 1; return; }
        picked.push(l);
      });
      tasks = picked.map(_cgLeadToCandidate);
      // 标记已推送（已有评论回复任务），用于「全部 / 未推送 / 已推送」拆分
      tasks.forEach((t) => { if (enqueued.has(t.leadId)) _cgDraft(t.leadId).pushed = true; });
      // 意向等级直接用线索自带的（采集阶段按关键词命中判定），
      // 这样整池的意向不依赖 AI 是否配置
      tasks.forEach((t) => {
        _cgInsight.set(_cgKeyOf(t), {
          intentLevel: t.leadIntentLevel,
          leadIntentLevel: t.leadIntentLevel,
          reason: '采集阶段判定（' + t.leadIntentLevel + ' 级）',
        });
      });
    } catch (e) {
      loadError = e.message || String(e);
    }
    if (typeof API.getRiskSummary === 'function') {
      try { risk = await API.getRiskSummary(); } catch (e) { risk = null; }
    }

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'dm', title: '评论候选池', desc: '评论用户池：挑出值得跟进的评论 → 查看详情 → 推送到「待办互动 → 评论回复」写话术并发送',
          actions: '<button type="button" class="btn btn--ghost btn--sm" id="cg-backfill" title="早期入库的线索没有视频名称，点此按视频 ID 补齐">补齐视频名称</button>' +
                   '<button type="button" class="btn btn--ghost btn--sm" id="cg-refresh">刷新</button>' })}
        <div id="cg-root" class="cg-body"></div>
        <p class="cg-disclaimer" role="note">${esc(CG_DISCLAIMER)}</p>
      </div>`;

    const root = $('#cg-root');
    const refreshBtn = $('#cg-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { viewCommentGrowth(params); });
    const backfillBtn = $('#cg-backfill');
    if (backfillBtn) backfillBtn.addEventListener('click', async () => {
      backfillBtn.disabled = true;
      try {
        const r = (window.CrawlAPI && typeof CrawlAPI.backfillVideoTitles === 'function')
          ? await CrawlAPI.backfillVideoTitles() : null;
        if (!r) { toast('回填接口未加载，请刷新页面重试', 'warn'); return; }
        toast(`已补齐：线索 ${r.leads_updated || r.leadsUpdated || 0} 条 · 任务 ${r.tasks_updated || r.tasksUpdated || 0} 个`, 'ok');
        viewCommentGrowth(params);
      } catch (e) {
        toast('补齐失败：' + (e.message || e), 'warn');
      } finally {
        backfillBtn.disabled = false;
      }
    });

    let analyzing = false;

    /* ── ① 顶部数字卡 ── */
    function metricsHtml() {
      const graded = tasks.filter((t) => _cgInsightOf(t));
      let todayCount = null;
      const withDate = tasks.filter((t) => t.createdAt);
      if (withDate.length) todayCount = withDate.filter((t) => _cgIsToday(t.createdAt)).length;

      let aCount = null;
      if (graded.length) aCount = graded.filter((t) => (_cgInsightOf(t) || {}).intentLevel === 'A').length;
      else if (tasks.some((t) => t.priority)) aCount = tasks.filter((t) => t.priority === 'P0').length;

      // 候选池里每条都还没推送，所以「待推送」就是剩余候选数
      const pendingCount = tasks.filter((t) => !_cgDraft(t.id).pushed).length;

      let negCount = null;
      if (risk && typeof risk.negativeCount === 'number') negCount = risk.negativeCount;
      else if (graded.length) negCount = graded.filter((t) => (_cgInsightOf(t) || {}).sentiment === 'negative').length;

      const show = (v) => (v === null ? '—' : fmt(v));
      const cards = [
        { label: '今日新增评论', value: show(todayCount), foot: todayCount === null ? '接口未返回发布时间' : '按线索采集时间统计', mod: '' },
        { label: 'A 级商机', value: show(aCount), foot: aCount === null ? '尚未分级' : '可直接承接（问价 / 要方案）', mod: 'cg-metric--lead' },
        { label: '待推送', value: show(pendingCount), foot: '候选池中尚未推送到待办互动的线索', mod: '' },
        { label: '⚠ 负面评论', value: show(negCount), foot: '情绪判定为负面的评论', mod: 'cg-metric--danger' },
      ];
      return `<div class="cg-metrics">${cards.map((c) => `
        <div class="card metric cg-metric ${c.mod}">
          <span class="metric__label">${esc(c.label)}</span>
          <div class="metric-value metric-value--sm">${c.value}</div>
          <span class="metric__foot">${c.foot}</span>
        </div>`).join('')}</div>`;
    }

    /* ── ② 风险警示条（仅 L2/L3 出现） ── */
    function riskHtml() {
      const lvl = risk && risk.level ? risk.level : 'none';
      if (lvl !== 'L2' && lvl !== 'L3') return '';
      const isL3 = lvl === 'L3';
      const clusters = (risk.clusters || []).length;
      return `<div class="cg-risk cg-risk--${isL3 ? 'l3' : 'l2'}" role="alert">
        <span class="cg-risk__badge">${isL3 ? 'L3 高风险' : 'L2 中风险'}</span>
        <div class="cg-risk__body">
          <strong>检测到 ${fmt(risk.negativeCount || 0)} 条负面评论${clusters ? `，集中在 ${clusters} 个话题` : ''}</strong>
          <p>${esc(risk.advice || '统一口径后逐条一对一处理，避免在公开评论区争辩。')}</p>
          ${(isL3 || risk.officialEscalationRequired)
            ? '<p class="cg-risk__escalate">⚠ 必须走官方与法务渠道：暂停公开回复，由官方账号与法务 / 持证运营人士统一对外。</p>' : ''}
        </div>
      </div>`;
    }

    /* ── ③ 筛选栏（纯前端过滤，不重复请求后端） ── */
    // 时间预设 → [起, 止]（YYYY-MM-DD，含当天）：近 N 天 = 今天往前数 N 天
    function cgTimeRange() {
      const f = _cgState.filter;
      const DAY = 86400000;
      const key = (d) => {
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      };
      const today = new Date();
      const back = (n) => key(new Date(today.getTime() - n * DAY));
      switch (f.time) {
        case 'today':  return [key(today), key(today)];
        case '3d':     return [back(2), key(today)];
        case '7d':     return [back(6), key(today)];
        case '30d':    return [back(29), key(today)];
        case 'custom': return [f.timeFrom || '', f.timeTo || ''];
        default:       return ['', ''];
      }
    }
    function cgFilterActive() {
      const f = _cgState.filter;
      return f.task !== 'all' || f.intent !== 'all' || f.sentiment !== 'all' || f.category !== 'all' || f.status !== 'all'
        || f.time !== 'all' || !!f.timeFrom || !!f.timeTo;
    }
    // 换筛选 / 换页签 / 改时间区间 = 换视图，已选一律清空。
    // 不清的话勾选集会跟着跑到别的筛选下，出现「筛了 B 级，已选却还是 622」。
    function cgClearChecked() { _cgState.checked.clear(); }

    function filterHtml() {
      const f = _cgState.filter;
      // 统一的下拉列表样式
      const selectStyle = 'padding:3px 8px;border:1px solid #d8d8de;border-radius:6px;font-size:12px;background:#fff;max-width:160px';
      // 采集任务筛选器：选项来自 crawlTasks，按创建时间倒序
      const taskOpts = [['all', '全部任务']];
      (_cgState.crawlTasks || []).forEach((t) => {
        if (t && t.id) taskOpts.push([String(t.id), t.name || ('任务 ' + String(t.id).slice(0, 8))]);
      });
      // 通用下拉列表渲染
      const renderSelect = (key, label, opts, title) => `<span class="cg-filter__group" style="display:flex;align-items:center;gap:6px">
        <span class="cg-filter__label"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>
        <select class="cg-filter-select" data-cg-filter-select="${esc(key)}" aria-label="${esc(label)}筛选" style="${selectStyle}">
          ${opts.map(([v, l]) => `<option value="${esc(v)}" ${f[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
      </span>`;
      // 评论时间：选"自定义"时显示日期范围
      const timeSelect = renderSelect('time', '评论时间', CG_FILTERS.find((g) => g.key === 'time').opts, '按评论发布时间筛；该条评论没有评论时间时按采集时间计');
      const timeRange = f.time === 'custom' ? `<span class="cg-filter__range" style="display:flex;align-items:center;gap:4px">
        <input type="date" class="cg-date" data-cg-t="from" value="${esc(f.timeFrom || '')}" aria-label="评论时间起" style="padding:2px 4px;border:1px solid #d8d8de;border-radius:4px;font-size:11px">
        <span class="cg-filter__tilde">至</span>
        <input type="date" class="cg-date" data-cg-t="to" value="${esc(f.timeTo || '')}" aria-label="评论时间止" style="padding:2px 4px;border:1px solid #d8d8de;border-radius:4px;font-size:11px">
      </span>` : '';
      // 全部/未推送/已推送 页签计数
      const unpushedN = tasks.filter((t) => !_cgDraft(t.id).pushed).length;
      const pushedN = tasks.length - unpushedN;
      const tabBtn = (key, label, count) => `<button type="button" class="cg-tab" data-cg-tab="${key}"
        style="margin-left:6px;border:1px solid #d8d8de;background:${_cgState.tab===key?'#2b6cff':'transparent'};color:${_cgState.tab===key?'#fff':'#333'};padding:3px 11px;border-radius:999px;cursor:pointer;font-size:12px">${label} ${fmt(count)}</button>`;
      return `<div class="filter-bar cg-filter" style="flex-wrap:nowrap;white-space:nowrap;overflow-x:auto">
        ${renderSelect('task', '采集任务', taskOpts, '按采集评论时创建的任务筛选')}
        ${CG_FILTERS.filter((g) => g.key !== 'time').map((g) => renderSelect(g.key, g.label, g.opts)).join('')}
        ${timeSelect}
        ${timeRange}
        <span style="margin-left:12px;display:flex;align-items:center">
          ${tabBtn('all', '全部', tasks.length)}
          ${tabBtn('unpushed', '未推送', unpushedN)}
          ${tabBtn('pushed', '已推送', pushedN)}
        </span>
        <span class="cg-filter__spacer"></span>
        ${cgFilterActive()
          ? '<button type="button" class="btn-link" data-cg-freset="1">清空筛选</button>' : ''}
        ${analyzing ? '<span class="muted cg-filter__hint">正在逐条分级…</span>' : ''}
      </div>`;
    }

    function filteredTasks() {
      const f = _cgState.filter;
      const tab = _cgState.tab || 'all';
      const [from, to] = cgTimeRange();
      const list = tasks.filter((t) => {
        const pushed = _cgDraft(t.id).pushed;
        if (tab === 'unpushed' && pushed) return false;
        if (tab === 'pushed' && !pushed) return false;
        // 按采集任务筛选：sourceTaskId 匹配当前选中的任务 ID
        if (f.task !== 'all' && String(t.sourceTaskId || '') !== String(f.task)) return false;
        const ins = _cgInsightOf(t) || {};
        if (f.intent !== 'all' && (ins.intentLevel || 'C') !== f.intent) return false;
        if (f.sentiment !== 'all' && (ins.sentiment || 'neutral') !== f.sentiment) return false;
        if (f.category !== 'all' && (ins.category || 'other') !== f.category) return false;
        if (f.status !== 'all' && t.status !== f.status) return false;
        if (from || to) {
          // 评论时间缺失时退回采集时间，避免老线索在筛时间时凭空消失
          const day = _cgDayKey(t.commentTime) || _cgDayKey(t.createdAt);
          if (!day) return false;
          if (from && day < from) return false;
          if (to && day > to) return false;
        }
        return true;
      });
      // 默认排序：评论时间倒序（最新在最上）
      return sortByCommentTimeDesc(list);
    }

    /* ── ④⑤ 商机表 + 行内展开处理 ── */
    function detailHtml(t) {
      const d = _cgDraft(t.id);
      const ins = _cgInsightOf(t) || {};
      const canPush = !d.pushed && !d.busy;
      const videoLabel = t.videoTitle || (t.videoId ? ('视频 ' + t.videoId) : '未知视频');
      const fallbackHtml = _cgIsFallback(ins)
        ? '<div class="cg-notice cg-notice--warn">AI 未配置或不可用，当前分级为兜底值（其他 / C 级），配置 API Key 后可获得真实分级。</div>' : '';
      const tip = d.pushed
        ? '已推送到「待办互动 → 评论回复」'
        : '推送后到「待办互动 → 评论回复」写话术并发送；本页只做筛选，不发送';
      return `<tr class="cg-detail"><td colspan="7"><div class="cg-detail__inner">
        <div class="cg-detail__meta">
          <span>👤 评论人：${esc(t.commentAuthor || '未知')}</span>
          <span>🎬 视频名称：${esc(videoLabel)}${t.videoUrl ? ` <a href="${esc(t.videoUrl)}" target="_blank" rel="noopener">打开视频↗</a>` : ''}</span>
          <span>🆔 视频 ID：${esc(t.videoId || '—')}</span>
          <span>🕒 评论时间：${esc(_cgFmtTime(t.commentTime))}</span>
          <span>📱 评论账号：${esc(t.account || '—')}</span>
          <span>🏷 优先度：${esc(t.priority || '—')}</span>
          <span>🔗 关联线索：${esc(t.leadId || '—')}</span>
          ${ins.reason ? `<span class="muted">分级依据：${esc(ins.reason)}</span>` : ''}
        </div>
        ${fallbackHtml}
        <div class="cg-detail__actions">
          <button type="button" class="btn btn--primary btn--sm" data-cg-push="${esc(t.id)}" ${(canPush && !d.busy) ? '' : 'disabled'} title="${esc(tip)}">${d.pushed ? '已推送' : (d.busy === 'push' ? '推送中…' : '推送到待办互动')}</button>
          <span class="muted cg-detail__hint">${esc(tip)}</span>
        </div>
      </div></td></tr>`;
    }

    function rowHtml(t) {
      const ins = _cgInsightOf(t) || {};
      const cat = CG_CATEGORY_META[ins.category] || CG_CATEGORY_META.other;
      const sen = CG_SENTIMENT_META[ins.sentiment] || CG_SENTIMENT_META.neutral;
      const lv = ins.intentLevel || 'C';
      const isOpen = _cgState.openId === t.id;
      const isNeg = ins.sentiment === 'negative';
      const d = _cgState.draft[t.id];
      const checked = _cgState.checked.has(t.id);
      const videoLabel = t.videoTitle || (t.videoId ? ('视频 ' + t.videoId) : '未知视频');
      return `<tr class="cg-row ${isNeg ? 'row--danger' : ''} ${isOpen ? 'cg-row--open' : ''}" data-cg-select="${esc(t.id)}" title="点击展开详情">
        <td style="width:36px"><input type="checkbox" data-cg-check="${esc(t.id)}" ${checked ? 'checked' : ''} aria-label="选择这条线索"></td>
        <td style="width:104px">
          <div style="font-weight:600;font-size:12.5px">${esc(t.commentAuthor || '未知')}</div>
          <div class="muted" style="font-size:11px">${esc(_cgFmtTime(t.commentTime))}</div>
        </td>
        <td>
          <div class="cg-row__comment">${esc(t.commentContent || '(无评论内容)')}</div>
          <div class="cg-row__sub">🎬 ${esc(videoLabel)}${t.videoUrl ? ` · <a href="${esc(t.videoUrl)}" target="_blank" rel="noopener" data-cg-stop="1">打开视频↗</a>` : ''}</div>
        </td>
        <td><span class="tag tag--${cat.cls}">${esc(cat.label)}</span></td>
        <td><span class="cg-lv cg-lv--${lv.toLowerCase()}">${esc(lv)}</span></td>
        <td><span class="tag tag--${sen.cls}">${esc(sen.label)}</span></td>
        <td style="text-align:right;white-space:nowrap">
          <button type="button" class="btn btn--primary btn--sm" data-cg-push="${esc(t.id)}" ${(d && (d.pushed || d.busy)) ? 'disabled' : ''}>${(d && d.pushed) ? '已推送' : '推送'}</button>
          <button type="button" class="btn btn--ghost btn--sm" data-cg-delete="${esc(t.id)}" title="删除这条线索" style="margin-left:4px;color:var(--danger);border-color:var(--danger)">删除</button>
          <span class="btn-link">${isOpen ? '收起' : '详情'}</span>
        </td>
      </tr>${isOpen ? detailHtml(t) : ''}`;
    }

    function tableHtml() {
      const list = filteredTasks();
      const skippedTotal = skipped.notMine + skipped.noComment + skipped.badUrl;
      const skippedTip = `视频地址不可用 ${skipped.badUrl} · 无评论原文 ${skipped.noComment} · 非自家视频 ${skipped.notMine}`;
      const allChecked = list.length > 0 && list.every((t) => _cgState.checked.has(t.id));
      // 已选只数当前筛选/页签内的：换视图会清空，这里再兜一次，防数据刷新后残留
      const checkedCount = list.filter((t) => _cgState.checked.has(t.id)).length;
      return `<div class="card cg-tablecard">
        <div class="card__head">
          <span class="card__title">评论候选池</span>
          <span class="card__hint">本页只做筛选与推送，回复在「待办互动 → 评论回复」</span>
          <span class="card__spacer"></span>
          ${skippedTotal ? `<span class="tag" title="${esc(skippedTip)}">已排除 ${fmt(skippedTotal)} 条</span>` : ''}
          <span class="tag tag--pending">候选 ${fmt(list.length)}</span>
          <span class="tag tag--collected" style="margin-left:4px">筛出 ${fmt(list.length)} / ${fmt(tasks.length)}</span>
        </div>
        ${loadError ? `<div class="cg-notice cg-notice--warn">评论任务加载失败：${esc(loadError)}。请确认后端服务已启动。</div>` : ''}
        ${list.length ? `<div class="cg-batchbar">
          <label class="cg-checkall" data-cg-checkall="1"><input type="checkbox" ${allChecked ? 'checked' : ''}> 全选本页</label>
          <span class="muted">已选 ${fmt(checkedCount)} 条</span>
          <span style="flex:1"></span>
          <button type="button" class="btn btn--sm btn--ghost" data-cg-delete-batch="1" ${(checkedCount && !_cgState.deleting) ? '' : 'disabled'} style="color:var(--danger);border-color:var(--danger)">
            ${_cgState.deleting ? '删除中…' : `删除选中 (${fmt(checkedCount)})`}
          </button>
          <button type="button" class="btn btn--primary btn--sm" data-cg-push-batch="1" ${(checkedCount && !_cgState.pushing) ? '' : 'disabled'}>
            ${_cgState.pushing ? '推送中…' : `推送到待办互动 (${fmt(checkedCount)})`}
          </button>
        </div>
        <div class="table-wrap"><table class="data cg-table">
          <thead><tr>
            <th style="width:36px"></th>
            <th style="width:104px">评论人</th>
            <th>评论内容 / 来源视频</th>
            <th style="width:88px">分类</th>
            <th style="width:64px">意向</th>
            <th style="width:72px">情绪</th>
            <th style="width:120px;text-align:right">操作</th>
          </tr></thead>
          <tbody data-cg-tbody="1">${list.slice(0, 40).map(rowHtml).join('')}</tbody>
        </table></div>` : emptyState('empty', tasks.length
          ? '当前筛选条件下没有匹配的评论'
          : '暂无候选评论。候选池收「自家视频评论 + 有评论原文 + 视频地址真实可用」的线索；已推送的仍在「已推送」页签，可先到「采集评论」按高意向关键词采集。')}
      </div>`;
    }

    function paint() {
      const list = filteredTasks();
      root.innerHTML = metricsHtml() + riskHtml() + filterHtml() + tableHtml();
      fillRowsProgressive(root.querySelector('[data-cg-tbody]'), list, rowHtml);
    }

    /* ── 行内动作实现 ── */
    async function cgPush(id) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      const d = _cgDraft(id);
      if (!t.leadId) {
        d.notice = { type: 'warn', text: '该评论缺少关联线索 ID，无法推送，请先到「筛选高意向」补全线索。' };
        paint();
        return;
      }
      if (typeof API.pushCommentTasks !== 'function') {
        d.notice = { type: 'warn', text: '推送接口未加载，请刷新页面重试。' };
        paint();
        return;
      }
      d.busy = 'push';
      d.notice = null;
      paint();
      try {
        const res = await API.pushCommentTasks([t.leadId], {
          account: t.account || undefined,
          priority: t.priority || undefined,
        });
        if (!res || !res.created) {
          const item = ((res && res.items) || []).find((i) => i.leadId === t.leadId) || {};
          d.notice = { type: 'warn', text: '未推送：' + (item.reason || '该线索已在待办互动中') };
        } else {
          d.pushed = true;
          d.created = true;
          _cgState.checked.delete(t.id);
          d.notice = { type: 'ok', text: `已推送到「待办互动 → 评论回复」（任务 ${(res.taskIds || [])[0] || '已创建'}），到那边写话术后发送。` };
          toast('已推送到「待办互动 → 评论回复」', 'ok');
        }
      } catch (e) {
        d.notice = { type: 'warn', text: '推送失败：' + (e.message || e) };
      } finally {
        d.busy = '';
        paint();
      }
    }

    async function cgPushBatch() {
      // 只推当前筛选/页签内勾选的：否则会出现「筛了 B 级却把整池 622 条推过去」
      const visible = filteredTasks();
      const ids = visible.map((t) => t.id).filter((id) => _cgState.checked.has(id));
      if (!ids.length) return;
      if (typeof API.pushCommentTasks !== 'function') {
        toast('推送接口未加载，请刷新页面重试', 'warn');
        return;
      }
      _cgState.pushing = true;
      paint();
      try {
        const res = await API.pushCommentTasks(ids);
        const createdIds = new Set(((res && res.items) || []).filter((i) => i.status === 'created').map((i) => i.leadId));
        createdIds.forEach((id) => {
          const d = _cgDraft(id);
          d.pushed = true;
          d.created = true;
        });
        _cgState.checked.clear();
        toast(
          `已推送 ${res.created || 0} 条到「待办互动 → 评论回复」` + (res.skipped ? `，跳过 ${res.skipped} 条（已在待办中）` : ''),
          (res.created ? 'ok' : 'warn'),
        );
      } catch (e) {
        toast('批量推送失败：' + (e.message || e), 'warn');
      } finally {
        _cgState.pushing = false;
        paint();
      }
    }

    /* ── 删除单条线索 ── */
    async function cgDelete(id) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      if (!confirm(`确定删除这条评论线索吗？\n\n评论人：${t.commentAuthor || '未知'}\n评论：${(t.commentContent || '').slice(0, 50)}\n\n删除后不可恢复。`)) return;
      try {
        await API.deleteLead(id);
        tasks = tasks.filter((x) => x.id !== id);
        _cgState.checked.delete(id);
        delete _cgState.draft[id];
        toast('已删除', 'ok');
        paint();
      } catch (e) {
        toast('删除失败：' + (e.message || e), 'warn');
      }
    }

    /* ── 批量删除线索 ── */
    async function cgDeleteBatch() {
      const visible = filteredTasks();
      const ids = visible.map((t) => t.id).filter((id) => _cgState.checked.has(id));
      if (!ids.length) return;
      if (!confirm(`确定删除选中的 ${ids.length} 条评论线索吗？删除后不可恢复。`)) return;
      _cgState.deleting = true;
      paint();
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await API.deleteLead(id);
          tasks = tasks.filter((x) => x.id !== id);
          _cgState.checked.delete(id);
          delete _cgState.draft[id];
          ok += 1;
        } catch (e) {
          fail += 1;
        }
      }
      _cgState.deleting = false;
      toast(`已删除 ${ok} 条` + (fail ? `，失败 ${fail} 条` : ''), ok ? 'ok' : 'warn');
      paint();
    }

    root.addEventListener('click', (ev) => {
      const el = (ev.target && ev.target.closest) ? ev.target : null;
      if (!el) return;
      const f = el.closest('[data-cg-f]');
      if (f) {
        const key = f.dataset.cgF;
        const val = f.dataset.cgFv;
        _cgState.filter[key] = val;
        // 切到非自定义区间时清掉手填的起止，否则预设选了也不生效
        if (key === 'time' && val !== 'custom') { _cgState.filter.timeFrom = ''; _cgState.filter.timeTo = ''; }
        cgClearChecked();
        paint();
        return;
      }
      const tabBtn = el.closest('[data-cg-tab]');
      if (tabBtn) {
        _cgState.tab = tabBtn.dataset.cgTab;
        cgClearChecked();
        paint();
        return;
      }
      if (el.closest('[data-cg-freset]')) {
        _cgState.filter = { task: 'all', intent: 'all', sentiment: 'all', category: 'all', status: 'all', time: 'all', timeFrom: '', timeTo: '' };
        cgClearChecked();
        paint();
        return;
      }
      const sug = el.closest('[data-cg-sug]');
      if (sug) {
        const id = sug.dataset.cgSug;
        const idx = parseInt(sug.dataset.cgSugIdx, 10) || 0;
        const dd = _cgDraft(id);
        const item = dd.suggestions[idx];
        if (item) { dd.text = item.content || ''; paint(); }
        return;
      }
      // 视频链接：点在链接上不触发展开
      if (el.closest('[data-cg-stop]')) return;
      const chkAll = el.closest('[data-cg-checkall]');
      if (chkAll) {
        // 目标状态按自身状态推导，不读 DOM 的 checked —— 点 label 文字时浏览器的
        // 默认切换发生在事件派发之后，此刻读到的还是旧值，会反着来
        const list = filteredTasks();
        const allOn = list.length > 0 && list.every((t) => _cgState.checked.has(t.id));
        list.forEach((t) => { if (allOn) _cgState.checked.delete(t.id); else _cgState.checked.add(t.id); });
        paint();
        return;
      }
      const chk = el.closest('[data-cg-check]');
      if (chk) {
        const id = chk.dataset.cgCheck;
        if (_cgState.checked.has(id)) _cgState.checked.delete(id); else _cgState.checked.add(id);
        paint();
        return;
      }
      const batch = el.closest('[data-cg-push-batch]');
      if (batch) { cgPushBatch(); return; }
      const delBatch = el.closest('[data-cg-delete-batch]');
      if (delBatch) { cgDeleteBatch(); return; }
      const push = el.closest('[data-cg-push]');
      if (push) { cgPush(push.dataset.cgPush); return; }
      const del = el.closest('[data-cg-delete]');
      if (del) { cgDelete(del.dataset.cgDelete); return; }
      const sel = el.closest('[data-cg-select]');
      if (sel) {
        const id = sel.dataset.cgSelect;
        _cgState.openId = _cgState.openId === id ? null : id;
        paint();
      }
    });

    // 统一处理所有下拉筛选器 + 自定义时间范围
    root.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!el || !el.dataset) return;
      // 通用下拉筛选（采集任务 / 意向 / 情绪 / 分类 / 评论时间）
      if (el.dataset.cgFilterSelect !== undefined) {
        const key = el.dataset.cgFilterSelect;
        _cgState.filter[key] = el.value || 'all';
        // 切到非自定义区间时清掉手填的起止
        if (key === 'time' && el.value !== 'custom') {
          _cgState.filter.timeFrom = '';
          _cgState.filter.timeTo = '';
        }
        cgClearChecked();
        paint();
        return;
      }
      // 自定义日期范围输入
      if (!el.dataset.cgT) return;
      if (el.dataset.cgT === 'from') _cgState.filter.timeFrom = el.value || '';
      else _cgState.filter.timeTo = el.value || '';
      _cgState.filter.time = (_cgState.filter.timeFrom || _cgState.filter.timeTo) ? 'custom' : 'all';
      cgClearChecked();
      paint();
    });

    paint();

    /* 语义分级：候选池量级大，只给 A/B 级补分类与情绪（C 级不烧 AI 调用） */
    (async () => {
      if (typeof API.commentInsight !== 'function') return;
      const pending = tasks
        .filter((t) => t.commentContent)
        .filter((t) => {
          const ins = _cgInsightOf(t) || {};
          if (ins.category) return false;   // 已有语义结果，不重复请求
          return ins.intentLevel === 'A' || ins.intentLevel === 'B';
        })
        .slice(0, 30);
      if (!pending.length) return;
      analyzing = true;
      paint();
      await _cgLoadInsights(pending);
      analyzing = false;
      if ($('#cg-root')) paint();
    })();
  }

  /* ═══════════════════════════════════════════
     视图：互动中心（私信任务 + 收件箱 + 评论回复）
     ═══════════════════════════════════════════ */
  async function viewInteract(params) {
    const tab = params.get('tab') || 'comments';
    const tabs = [
      { key: 'comments', label: '评论回复', desc: '已分级评论，待落地回复' },
      { key: 'inbox', label: '用户私信（收件箱）', desc: '对方先发来的，待承接回复' },
      { key: 'dm', label: '主动私信（发送队列）', desc: '我们主动去找线索发' },
    ];

    // 待办数量：口径必须与各 Tab 内实际列表一致，否则卡片数字会对不上列表
    //   comments → 待处理评论（pending 待回复 / failed 回复失败待重发）
    //   inbox    → 待承接会话（新会话，或存在未读消息）
    //   dm       → 待发送私信（队列状态为 pending_outreach）
    let counts = { comments: 0, inbox: 0, dm: 0 };
    // 顺手缓存这三个全量结果，供下面的 Tab 渲染直接复用：
    // 否则同一个 /api/comments/tasks（60 万字节）会被「卡片计数」和「列表渲染」各拉一遍，
    // 而且是串行（先等计数完、再发第二次），实测白等 ~330ms。
    const prefetched = { comments: null, dm: null, inbox: null };
    try {
      const [commentRes, dmRes, inboxRes] = await Promise.all([
        (typeof API.getCommentTasks === 'function' ? API.getCommentTasks() : Promise.resolve([])).catch(() => []),
        (typeof API.getDmQueue === 'function' ? API.getDmQueue() : Promise.resolve([])).catch(() => []),
        (typeof API.getDmInbox === 'function' ? API.getDmInbox() : Promise.resolve([])).catch(() => []),
      ]);
      // 三个接口均返回顶层数组，这里同时兼容 { items: [] } 包装
      const toArr = (r) => (Array.isArray(r) ? r : ((r && r.items) || []));
      prefetched.comments = toArr(commentRes);
      prefetched.dm = toArr(dmRes);
      prefetched.inbox = toArr(inboxRes);
      counts.comments = prefetched.comments.filter((t) => t.status === 'pending' || t.status === 'failed').length;
      counts.dm = prefetched.dm.filter((q) => q.status === 'pending_outreach').length;
      counts.inbox = prefetched.inbox.filter((c) => c.status === 'new' || (c.unreadCount || 0) > 0).length;
    } catch (e) { /* 统计失败不影响主流程 */ }

    main.innerHTML = `
      <div class="view">
        ${pageHead({ title: '待办互动', desc: '按业务流程处理：评论回复 → 用户私信 → 主动私信，形成获客闭环' })}
        <!-- 待办导航：卡片即导航（旧版此处「统计卡 + tab 栏」重复展示同一组入口，已合并为一套） -->
        <div class="interact-nav" id="interact-nav">
          ${tabs.map((t) => `
            <button type="button" class="interact-nav__card ${tab === t.key ? 'interact-nav__card--active' : ''}"
                    data-tab="${t.key}" aria-current="${tab === t.key ? 'page' : 'false'}">
              <span class="interact-nav__body">
                <span class="interact-nav__title">${esc(t.label)}</span>
                <span class="interact-nav__desc">${esc(t.desc)}</span>
              </span>
              <span class="interact-nav__count ${counts[t.key] > 0 ? 'interact-nav__count--todo' : 'interact-nav__count--zero'}">${counts[t.key]}</span>
            </button>`).join('')}
        </div>
        <div id="interact-content" class="interact-content"></div>
      </div>`;

    // 卡片导航：切换交由 route() 带新 tab 参数重新渲染，这里不做手动高亮（重渲染会带出选中态）
    $('#interact-nav').addEventListener('click', (e) => {
      const card = e.target.closest('[data-tab]');
      if (!card || card.dataset.tab === tab) return;
      location.hash = `#/interact?tab=${card.dataset.tab}`;
    });

    // 离开私信任务Tab时停止批量轮询，避免切Tab后后台空跑 API
    if (tab !== 'dm' && window._dmBatchTimer) {
      clearInterval(window._dmBatchTimer);
      window._dmBatchTimer = null;
    }

    // 渲染对应Tab内容（由 route() 携带新的 tab 参数重新调用本函数）
    const content = $('#interact-content');
    if (tab === 'inbox') await renderInboxTab(content, prefetched);
    else if (tab === 'comments') await renderCommentsTab(content, prefetched);
    else await renderDmTab(content, prefetched);
  }

  /* ═══════════════════════════════════════════
     Tab内容渲染：私信任务（自 viewDm 提取，渲染到 interact-content）
     ═══════════════════════════════════════════ */
  async function renderDmTab(content, pre) {
    // 进入本Tab时清理批量轮询
    if (window._dmBatchTimer) { clearInterval(window._dmBatchTimer); window._dmBatchTimer = null; }

    const [queue, meta, cfg, results] = await Promise.all([
      // pre.dm 由 viewInteract 预取（卡片计数已拉过一次），直接复用
      (pre && Array.isArray(pre.dm)) ? Promise.resolve(pre.dm) : API.getDmQueue(),
      API.getLeadStatusMeta(),
      (API.getDmSenderConfig ? API.getDmSenderConfig() : Promise.resolve(null)),
      (API.fetchDmSendResults ? API.fetchDmSendResults(50) : Promise.resolve([])),
    ]);
    state.leads = await API.getLeads();
    state.leadStatusMeta = meta;

    const cnt = (k) => queue.filter((q) => q.status === k).length;
    const convs = state.leads.filter((l) => (l.messages || []).length > 0);

    // ── 发送器配置（默认值兜底） ──
    const sCfg = cfg || { mode: 'mock', minInterval: 30, maxInterval: 60, dailyLimit: 50 };
    const isMock = sCfg.mode !== 'cdp';

    // ── 发送控制区 ──
    const senderPanel = `
      <div class="card dm-sender">
        <div class="card__head">
          <span class="card__title">发送控制</span>
          <span class="card__hint">私信发送执行器 · P4-D</span>
        </div>
        ${isMock ? '<div class="dm-sender__mockbar">当前为模拟发送（Mock），不会真实发送私信</div>'
                 : '<div class="dm-sender__mockbar dm-sender__mockbar--cdp">当前为 CDP 模式（联调中），真实发送待 Electron 对接</div>'}
        <div class="dm-sender__row">
          <div class="dm-sender__field">
            <label for="dm-sender-mode">发送器模式</label>
            <select id="dm-sender-mode">
              <option value="mock" ${isMock ? 'selected' : ''}>Mock 模拟</option>
              <option value="cdp" ${!isMock ? 'selected' : ''}>CDP（联调中）</option>
            </select>
          </div>
          <div class="dm-sender__field">
            <label for="dm-sender-min">最小间隔(秒)</label>
            <input type="number" id="dm-sender-min" value="${esc(sCfg.minInterval)}" min="0">
          </div>
          <div class="dm-sender__field">
            <label for="dm-sender-max">最大间隔(秒)</label>
            <input type="number" id="dm-sender-max" value="${esc(sCfg.maxInterval)}" min="0">
          </div>
          <div class="dm-sender__field">
            <label for="dm-sender-daily">每日上限</label>
            <input type="number" id="dm-sender-daily" value="${esc(sCfg.dailyLimit)}" min="1">
          </div>
          <div class="dm-sender__field dm-sender__field--btn">
            <button type="button" class="btn" id="dm-sender-save-cfg">保存配置</button>
          </div>
        </div>
        <div class="dm-sender__run">
          <button type="button" class="btn btn--primary" id="dm-batch-start">开始批量发送</button>
          <button type="button" class="btn" id="dm-batch-stop" disabled>停止发送</button>
          <button type="button" class="btn" id="dm-sender-test">测试发送器</button>
          <span class="dm-sender__prog" id="dm-batch-prog">就绪</span>
        </div>
        <div class="dm-sender__bar"><div class="dm-sender__bar-fill" id="dm-batch-bar" style="width:0%"></div></div>
        <div class="dm-sender__counts">
          <span class="dm-count dm-count--ok">成功 <b id="dm-c-ok">0</b></span>
          <span class="dm-count dm-count--fail">失败 <b id="dm-c-fail">0</b></span>
          <span class="dm-count dm-count--thr">频控 <b id="dm-c-thr">0</b></span>
        </div>
      </div>`;

    // ── 最近发送记录 ──
    const leadNick = {};
    state.leads.forEach((l) => { leadNick[l.id] = l.nickname; });
    const _DM_STATUS_CLS = {
      success: 'success', failed: 'failed', throttled: 'throttled',
      need_captcha: 'need_captcha', account_banned: 'account_banned',
    };
    const resultsRows = (results || []).map((r) => {
      const nick = r.leadId === '__test__' ? '（测试）' : (leadNick[r.leadId] || (r.leadId || '').slice(0, 6));
      const stCls = _DM_STATUS_CLS[r.status] || '';
      return `<tr>
        <td style="white-space:nowrap">${esc(_fmtInboxTime(r.createdAt))}</td>
        <td>${esc(nick)}</td>
        <td style="color:var(--ink-soft)">${esc(r.accountId && r.accountId !== '__test__' ? r.accountId.slice(0, 6) : '-')}</td>
        <td style="max-width:220px;color:var(--ink-soft)">${esc((r.content || '').slice(0, 32))}</td>
        <td><span class="dm-status dm-status--${stCls}">${esc(r.status)}</span></td>
        <td style="color:var(--ink-soft)">${esc(r.message)}</td>
      </tr>`;
    }).join('');

    const resultsCard = `
      <div class="card">
        <div class="card__head">
          <span class="card__title">最近发送记录</span>
          <span class="card__hint">发送结果留痕 · 状态颜色：成功绿 / 失败红 / 频控黄 / 验证码橙</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>时间</th><th>线索</th><th>账号</th><th>内容摘要</th><th>状态</th><th>消息</th></tr></thead>
            <tbody>${resultsRows || `<tr><td colspan="6">${emptyState('dm', '暂无发送记录')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;

    content.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:22px">
        ${state.safeMode.active ? '<div><span class="tag tag--safemode">安全模式中 · 队列冻结</span></div>' : ''}

        <div class="grid grid--metrics">
          ${metric('待发送', fmt(cnt('pending_outreach')), '按随机间隔拟人发送')}
          ${metric('频控暂缓', fmt(cnt('throttled')), 'R1 降速队列回放')}
          ${metric('失败待恢复', fmt(cnt('send_failed')), '账号恢复后自动重试')}
          ${metric('已发待回复', fmt(cnt('sent')), '超过 48h 无回复转培育')}
          ${metric('待人工回复', fmt(cnt('replied')), '用户已回话，别让线索凉掉', cnt('replied') ? 'danger' : '')}
        </div>

        ${senderPanel}

        <div class="card">
          <div class="card__head">
            <span class="card__title">发送队列</span>
            <span class="card__hint">执行器状态与话术变体分配（IMP-001）</span>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>用户</th><th>执行账号</th><th>话术</th><th>状态</th><th>说明</th><th></th></tr></thead>
              <tbody>
                ${queue.map((q) => {
                  const st = meta[q.status] || { label: q.status, cls: '' };
                  const isDanger = ['throttled', 'send_failed'].includes(q.status);
                  const canSend = q.status === 'pending_outreach' && !state.safeMode.active;
                  return `
                    <tr class="${isDanger ? 'row--danger' : ''}" data-lead-id="${q.leadId}" style="cursor:pointer">
                      <td><div class="cell-user">
                        <span class="avatar" style="background:hsl(${q.hue} 45% 44%)">${esc(q.nickname.slice(0, 1))}</span>
                        <span style="font-weight:600">${esc(q.nickname)}</span>
                      </div></td>
                      <td style="color:var(--ink-soft)">${esc(q.account)}</td>
                      <td><span class="tag tag--low">变体 ${esc(q.variant)}</span></td>
                      <td><span class="tag tag--${st.cls}">${st.label}</span></td>
                      <td style="color:var(--ink-soft);max-width:260px">${esc(q.detail)}</td>
                      <td>${canSend ? `<button type="button" class="btn-link" data-send-now="${q.leadId}">立即发送</button>`
                        : `<button type="button" class="btn-link">查看对话</button>`}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">进行中的对话</span>
            <span class="card__hint">点开查看完整私信记录与加微引导过程</span>
          </div>
          ${convs.length ? convs.map((l) => {
            const last = (l.messages || [])[(l.messages || []).length - 1] || {};
            return `
              <div class="dm-conv" data-lead-id="${l.id}">
                <span class="avatar" style="background:hsl(${l.hue} 45% 44%)">${esc(l.nickname.slice(0, 1))}</span>
                <div style="min-width:0">
                  <div style="font-weight:600">${esc(l.nickname)}
                    <span class="msg__meta" style="margin-left:6px">${last.dir === 'out' ? '我方' : '用户'} · ${esc(last.time)}</span></div>
                  <div class="dm-conv__last">${esc(last.text)}</div>
                </div>
                <span class="tag tag--${(state.leadStatusMeta[l.status] || {}).cls}">${esc((state.leadStatusMeta[l.status] || {}).label || l.status)}</span>
              </div>`;
          }).join('') : emptyState('dm', '暂无对话')}
        </div>

        ${resultsCard}
      </div>`;

    // ── 批量进度渲染辅助 ──
    function renderBatchStatus(s) {
      if (!s) return;
      const bar = $('#dm-batch-bar'), prog = $('#dm-batch-prog');
      const ok = $('#dm-c-ok'), fail = $('#dm-c-fail'), thr = $('#dm-c-thr');
      const stopBtn = $('#dm-batch-stop'), startBtn = $('#dm-batch-start');
      if (bar) bar.style.width = s.total ? Math.round((s.done / s.total) * 100) + '%' : '0%';
      if (prog) prog.textContent = s.running
        ? `发送中 ${s.done}/${s.total}`
        : (s.total ? `已完成 ${s.done}/${s.total}` : '就绪');
      if (ok) ok.textContent = s.success || 0;
      if (fail) fail.textContent = s.failed || 0;
      if (thr) thr.textContent = s.throttled || 0;
      if (stopBtn) stopBtn.disabled = !s.running;
      if (startBtn) startBtn.disabled = !!s.running;
    }

    function startBatchPolling() {
      if (window._dmBatchTimer) clearInterval(window._dmBatchTimer);
      window._dmBatchTimer = setInterval(async () => {
        try {
          const s = await API.fetchDmBatchStatus();
          renderBatchStatus(s);
          if (!s.running) {
            clearInterval(window._dmBatchTimer);
            window._dmBatchTimer = null;
          }
        } catch (e) { /* 轮询失败静默，下次重试 */ }
      }, 1200);
    }

    // ── 事件绑定 ──
    $$('[data-send-now]', content).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.safeMode.active) { toast('安全模式中，队列冻结', 'warn'); return; }
      const leadId = b.dataset.sendNow;
      b.disabled = true; b.textContent = '发送中…';
      try {
        const out = await API.sendDmOne(leadId);
        toast('发送结果：' + out.status + (out.message ? '（' + out.message + '）' : ''),
              out.status === 'success' ? 'ok' : 'warn');
      } catch (err) {
        toast('发送失败：' + (err.message || err), 'warn');
      }
      route();
    }));

    $('#dm-batch-start')?.addEventListener('click', async () => {
      if (state.safeMode.active) { toast('安全模式中，队列冻结', 'warn'); return; }
      try {
        const s = await API.sendDmBatch(10);
        renderBatchStatus(s);
        if (s.running) { toast('批量发送已启动（后台执行）'); startBatchPolling(); }
        else { toast(s.message || '没有待发送线索', 'warn'); }
      } catch (err) { toast('启动失败：' + (err.message || err), 'warn'); }
    });

    $('#dm-batch-stop')?.addEventListener('click', async () => {
      try { await API.stopDmBatch(); toast('已请求停止（当前条发完后停）', 'warn'); }
      catch (err) { toast('停止失败：' + (err.message || err), 'warn'); }
    });

    $('#dm-sender-test')?.addEventListener('click', async () => {
      try {
        const out = await API.testDmSender();
        toast('测试发送：' + out.status + (out.message ? '（' + out.message + '）' : ''),
              out.status === 'success' ? 'ok' : 'warn');
      } catch (err) { toast('测试失败：' + (err.message || err), 'warn'); }
    });

    $('#dm-sender-save-cfg')?.addEventListener('click', async () => {
      const payload = {
        mode: $('#dm-sender-mode').value,
        minInterval: parseInt($('#dm-sender-min').value, 10) || 0,
        maxInterval: parseInt($('#dm-sender-max').value, 10) || 0,
        dailyLimit: parseInt($('#dm-sender-daily').value, 10) || 50,
      };
      try {
        await API.updateDmSenderConfig(payload);
        toast('发送器配置已保存');
      } catch (err) { toast('保存失败：' + (err.message || err), 'warn'); }
    });

    $$('[data-lead-id]', content).forEach((b) => b.addEventListener('click', () => openLeadDrawer(b.dataset.leadId)));
  }

  /* ═══════════════════════════════════════════
     Tab内容渲染：私信收件箱（自 viewDmInbox 提取，渲染到 interact-content）
     ═══════════════════════════════════════════ */
  async function renderInboxTab(content) {
    const inboxState = {
      conversations: [],
      activeId: null,
      detail: null,
      scripts: [],
      filter: 'all',
    };

    // 加载话术库（私信 + 微信引导类）用于快捷插入
    try {
      const allScripts = await API.getScripts();
      inboxState.scripts = allScripts.filter((s) =>
        ['welcome', 'private_message', 'wechat_guide', 'objection'].includes(s.category)
      );
    } catch (e) {
      inboxState.scripts = [];
    }

    async function loadList() {
      inboxState.conversations = await API.getDmInbox(inboxState.filter === 'all' ? undefined : inboxState.filter);
      renderList();
    }

    async function loadDetail(convId) {
      inboxState.activeId = convId;
      inboxState.detail = await API.getDmConversation(convId);
      renderList();
      renderDetail();
    }

    function renderList() {
      const listEl = $('#inbox-list');
      if (!listEl) return;
      const filterTabs = ['all', 'new', 'replied', 'wechat_added', 'closed'].map((k) => {
        const count = k === 'all' ? inboxState.conversations.length
          : inboxState.conversations.filter((c) => c.status === k).length;
        const label = k === 'all' ? '全部' : (INBOX_STATUS_META[k] || {}).label || k;
        return `<button type="button" class="subtab-btn" data-inbox-filter="${k}" aria-selected="${inboxState.filter === k}">${esc(label)}<span class="count">${count}</span></button>`;
      }).join('');

      // 渲染筛选tab到顶部容器
      const filterEl = document.getElementById('inbox-filters');
      if (filterEl) {
        filterEl.innerHTML = filterTabs;
        $$('[data-inbox-filter]', filterEl).forEach((btn) => {
          btn.addEventListener('click', () => {
            inboxState.filter = btn.dataset.inboxFilter;
            loadList();
          });
        });
      }


      listEl.innerHTML = `
        <div style="overflow-y:auto;flex:1">
          ${inboxState.conversations.length ? inboxState.conversations.map((c) => {
            const meta = INBOX_STATUS_META[c.status] || { label: c.status, cls: 'low' };
            const isActive = c.id === inboxState.activeId;
            return `
              <div class="dm-conv" data-inbox-id="${c.id}" style="${isActive ? 'background:var(--brand-tint-2);border-left:3px solid var(--brand-deep)' : 'border-left:3px solid transparent'}">
                <span class="avatar" style="background:hsl(${c.avatarHue || 200} 45% 44%)">${esc((c.nickname || '?').slice(0, 1))}</span>
                <div style="min-width:0;flex:1">
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.nickname)}</span>
                    ${c.unreadCount > 0 ? `<span class="nav-badge nav-badge--count" style="background:var(--danger);color:#fff;min-width:18px;height:18px;padding:0 5px;font-size:11px;line-height:18px">${c.unreadCount}</span>` : ''}
                    <span class="tag tag--${meta.cls}" style="margin-left:auto;flex-shrink:0">${esc(meta.label)}</span>
                  </div>
                  <div class="dm-conv__last">${esc(c.lastMessage || '')}</div>
                  <div style="font-size:11px;color:var(--ink-faint);margin-top:2px">${esc(_fmtInboxTime(c.lastMessageAt))}</div>
                </div>
              </div>`;
          }).join('') : `<div class="empty" style="padding:40px 0"><span class="empty__ico">${ico('empty')}</span><p>暂无会话</p></div>`}
        </div>`;

      $$('[data-inbox-id]', listEl).forEach((el) => {
        el.addEventListener('click', () => loadDetail(el.dataset.inboxId));
      });
    }

    function renderDetail() {
      const detailEl = $('#inbox-detail');
      if (!detailEl) return;
      const d = inboxState.detail;
      if (!d) {
        const newCount = inboxState.conversations.filter(c => c.status === 'new').length;
        const repliedCount = inboxState.conversations.filter(c => c.status === 'replied').length;
        const wechatCount = inboxState.conversations.filter(c => c.status === 'wechat_added').length;
        const totalCount = inboxState.conversations.length;
        detailEl.innerHTML = `
          <div style="height:100%;display:flex;flex-direction:column;padding:24px;gap:20px;overflow-y:auto">
            <div style="text-align:center;padding:20px 0">
              <div style="font-size:48px;margin-bottom:12px">💬</div>
              <h3 style="margin:0 0 8px;font-size:18px">私信收件箱</h3>
              <p style="margin:0;color:var(--ink-faint);font-size:13px">选择左侧会话查看和回复私信</p>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
              <div style="background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:24px;font-weight:700;color:var(--brand)">${totalCount}</div>
                <div style="font-size:12px;color:var(--ink-faint);margin-top:4px">总会话</div>
              </div>
              <div style="background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:24px;font-weight:700;color:var(--danger)">${newCount}</div>
                <div style="font-size:12px;color:var(--ink-faint);margin-top:4px">新会话</div>
              </div>
              <div style="background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:24px;font-weight:700;color:var(--warning)">${repliedCount}</div>
                <div style="font-size:12px;color:var(--ink-faint);margin-top:4px">待跟进</div>
              </div>
              <div style="background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:24px;font-weight:700;color:var(--success)">${wechatCount}</div>
                <div style="font-size:12px;color:var(--ink-faint);margin-top:4px">已加微</div>
              </div>
            </div>
            <div style="background:var(--brand-tint);border-radius:10px;padding:16px">
              <div style="font-weight:600;margin-bottom:8px;font-size:14px">📌 操作提示</div>
              <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--ink-soft);line-height:1.8">
                <li>点击左侧会话查看私信内容</li>
                <li>使用话术库快速回复客户</li>
                <li>客户加微后点击"标记加微转客户"</li>
                <li>在上方筛选tab按状态快速过滤</li>
              </ul>
            </div>
            <div style="flex:1"></div>
          </div>`;
        return;
      }
      const meta = INBOX_STATUS_META[d.status] || { label: d.status, cls: 'low' };
      const scriptOptions = inboxState.scripts.length
        ? inboxState.scripts.map((s) => {
            const firstVariant = (s.variants && s.variants[0]) ? s.variants[0].text : (s.intro || '');
            return `<option value="${esc(firstVariant)}" data-script-id="${esc(s.id)}">${esc(s.name)}（${esc(s.category)}）</option>`;
          }).join('')
        : '';

      detailEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);flex-shrink:0">
          <span class="avatar" style="background:hsl(${d.avatarHue || 200} 45% 44%)">${esc((d.nickname || '?').slice(0, 1))}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${esc(d.nickname)}</div>
            <div style="font-size:12px;color:var(--ink-soft)"><span class="tag tag--${meta.cls}">${esc(meta.label)}</span></div>
          </div>
          ${d.status !== 'wechat_added' && d.status !== 'closed' ? `
            <button type="button" class="btn btn--primary btn--sm" id="btn-mark-wechat">
              <span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></span>标记加微转客户
            </button>` : `<span class="tag tag--wechat">已转化为客户</span>`}
        </div>
        <div class="msg-list" id="inbox-msg-list" style="flex:1;overflow-y:auto;padding:16px 18px">
          ${d.messages.map((m) => `
            <div class="msg msg--${m.direction === 'out' ? 'out' : 'in'}">
              ${esc(m.content)}
              <div class="msg__meta">${m.direction === 'out' ? '我方' : '用户'} · ${esc(_fmtInboxTime(m.createdAt))}${m.scriptId ? ' · 话术' : ''}</div>
            </div>`).join('')}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--line);flex-shrink:0;background:var(--paper)">
          ${scriptOptions ? `
            <div style="margin-bottom:8px">
              <select id="inbox-script-select" style="width:100%;font-size:12.5px">
                <option value="">— 选择话术快捷插入 —</option>
                ${scriptOptions}
              </select>
            </div>` : ''}
          <div style="display:flex;gap:8px;align-items:flex-end">
            <textarea id="inbox-reply-input" placeholder="输入回复内容…（Enter 发送，Shift+Enter 换行）" style="flex:1;min-height:60px"></textarea>
            <div style="display:flex;flex-direction:column;gap:6px">
              <select id="inbox-ai-style" style="font-size:11px;padding:2px 4px">
                <option value="formal">更正式</option>
                <option value="casual" selected>更口语</option>
                <option value="short">更简短</option>
              </select>
              <button type="button" class="btn btn--ghost btn--sm" id="btn-ai-polish" style="border-color:var(--brand);color:var(--brand-deep);white-space:nowrap">
                <span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 润色
              </button>
            </div>
            <button type="button" class="btn btn--primary" id="btn-send-reply" style="height:60px;padding:0 20px">发送</button>
          </div>
        </div>`;

      // 自动滚动到底部
      const msgList = $('#inbox-msg-list', detailEl);
      if (msgList) msgList.scrollTop = msgList.scrollHeight;

      // 发送回复
      $('#btn-send-reply', detailEl)?.addEventListener('click', sendReply);
      const replyInput = $('#inbox-reply-input', detailEl);
      replyInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
      });

      // AI 润色
      const polishBtn = $('#btn-ai-polish', detailEl);
      if (polishBtn) polishBtn.addEventListener('click', async () => {
        if (!(await aiEnsureConfigured())) return;
        const styleSel = $('#inbox-ai-style', detailEl);
        const style = styleSel ? styleSel.value : 'casual';
        const currentText = replyInput ? replyInput.value.trim() : '';
        polishBtn.disabled = true; polishBtn.textContent = '润色中…';
        try {
          const result = await API.aiSmartDraft({
            lead_id: d.leadId || d.id || '',
            script_category: 'private_message',
            user_comment: currentText,
            style,
          });
          if (result && result.draft) {
            if (replyInput) { replyInput.value = result.draft; replyInput.focus(); }
            toast('AI 润色完成，可编辑后发送', 'ok');
          }
        } catch (e) {
          aiHandleError(e);
        } finally {
          polishBtn.disabled = false;
          polishBtn.innerHTML = '<span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 润色';
        }
      });

      // 话术快捷插入（含 {变量} 按当前画像解析）
      $('#inbox-script-select', detailEl)?.addEventListener('change', async (e) => {
        if (e.target.value && replyInput) {
          const ctx = await ensureProfileCtx();
          replyInput.value = resolveProfileVars(e.target.value, ctx);
          replyInput.focus();
        }
      });

      // 标记加微
      $('#btn-mark-wechat', detailEl)?.addEventListener('click', openMarkWechatModal);
    }

    async function sendReply() {
      const input = $('#inbox-reply-input');
      const replyText = input ? input.value.trim() : '';
      if (!replyText) { toast('回复内容不能为空', 'warn'); return; }
      const scriptSelect = $('#inbox-script-select');
      const selectedOption = scriptSelect ? scriptSelect.options[scriptSelect.selectedIndex] : null;
      const scriptId = selectedOption && selectedOption.value ? (selectedOption.dataset.scriptId || null) : null;
      try {
        await API.sendDmReply(inboxState.activeId, replyText, scriptId);
        toast('回复已发送');
        await loadDetail(inboxState.activeId);
        await loadList();
      } catch (e) {
        toast('发送失败：' + e.message, 'warn');
      }
    }

    function openMarkWechatModal() {
      const d = inboxState.detail;
      openModal(`
        <div class="modal__head">
          <h3 id="modal-title">标记加微 · 转客户</h3>
          <button type="button" class="drawer__close" data-close aria-label="关闭">×</button>
        </div>
        <div class="modal__body">
          <div class="field">
            <label>微信号 <span style="color:var(--danger)">*</span></label>
            <input type="text" id="mw-wechat-id" placeholder="输入客户微信号" value="">
          </div>
          <div class="field">
            <label>客户姓名</label>
            <input type="text" id="mw-customer-name" placeholder="留空则使用昵称：${esc(d.nickname)}" value="${esc(d.nickname)}">
          </div>
          <div class="field">
            <label>手机号（可选）</label>
            <input type="text" id="mw-phone" placeholder="选填">
          </div>
          <p style="font-size:12px;color:var(--ink-soft);margin-top:8px">提交后将：关闭会话 · 线索标记为已加微 · 自动创建客户</p>
        </div>
        <div class="modal__foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <button type="button" class="btn btn--ghost" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="mw-submit">确认加微</button>
        </div>`);
      $('#mw-submit').addEventListener('click', async () => {
        const wechatId = $('#mw-wechat-id').value.trim();
        if (!wechatId) { toast('请输入微信号', 'warn'); return; }
        try {
          const res = await API.markDmWechat(inboxState.activeId, {
            wechatId,
            customerName: $('#mw-customer-name').value.trim() || null,
            phone: $('#mw-phone').value.trim() || null,
          });
          closeModal();
          toast('已标记加微，客户已创建');
          setTimeout(() => { location.hash = '#/customers'; }, 600);
        } catch (e) {
          toast('操作失败：' + e.message, 'warn');
        }
      });
    }

    // 初始渲染（互动中心外壳已含 page-head + Tabs，此处仅渲染主体）
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div id="inbox-filters" class="subtabs" style="padding:0;border:none"></div>
          <button type="button" class="btn btn--ghost btn--sm" id="btn-simulate-dm">模拟收到私信</button>
        </div>
        <div class="card" style="padding:0;display:flex;height:calc(100vh - 340px);min-height:480px;overflow:hidden">
          <div id="inbox-list" style="width:320px;border-right:1px solid var(--line);display:flex;flex-direction:column;flex-shrink:0"></div>
          <div id="inbox-detail" style="flex:1;display:flex;flex-direction:column;min-width:0"></div>
        </div>
      </div>`;

    $('#btn-simulate-dm').addEventListener('click', () => {
      openModal(`
        <div class="modal__head">
          <h3 id="modal-title">模拟收到私信（开发测试）</h3>
          <button type="button" class="drawer__close" data-close aria-label="关闭">×</button>
        </div>
        <div class="modal__body">
          <div class="field"><label>用户昵称</label><input type="text" id="sim-nickname" placeholder="如：装修咨询小王"></div>
          <div class="field"><label>私信内容</label><textarea id="sim-content" placeholder="如：你好，请问多少钱？"></textarea></div>
        </div>
        <div class="modal__foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <button type="button" class="btn btn--ghost" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="sim-submit">模拟发送</button>
        </div>`);
      $('#sim-submit').addEventListener('click', async () => {
        const nickname = $('#sim-nickname').value.trim() || '测试用户';
        const replyText = $('#sim-content').value.trim() || '你好，咨询一下';
        try {
          await API.simulateDmInbound({ nickname, content: replyText });
          closeModal();
          toast('已模拟收到私信');
          await loadList();
        } catch (e) {
          toast('模拟失败：' + e.message, 'warn');
        }
      });
    });

    await loadList();
    renderDetail();
  }


  // 评论时间：采集回来是 unix 秒（10 位）/ 毫秒（13 位），也可能已是字符串
  function fmtCommentTime(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    let d = null;
    if (/^\d{10}$/.test(raw)) d = new Date(parseInt(raw, 10) * 1000);
    else if (/^\d{13}$/.test(raw)) d = new Date(parseInt(raw, 10));
    if (!d) return raw;
    if (isNaN(d.getTime())) return raw;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ═══════════════════════════════════════════
     Tab内容渲染：评论回复（自 viewComments 提取，渲染到 interact-content）
     ═══════════════════════════════════════════ */
  // 评论回复 Tab 的跨渲染选中集合（勾选后批量操作；批量动作完成后清空）
  const interactSel = new Set();

  async function renderCommentsTab(content, pre) {
    const [allTasks, scriptsAll] = await Promise.all([
      // pre.comments 由 viewInteract 预取（卡片计数已拉过一次），直接复用，不再重复请求
      (pre && Array.isArray(pre.comments)) ? Promise.resolve(pre.comments) : API.getCommentTasks(),
      API.getScripts(),
    ]);
    const commentScripts = scriptsAll.filter((s) => s.category === 'comment');
    // 待处理 = 待回复 + 回复失败待重发
    // （failed 原先既不在 pending 也不在 tracked，会从两个列表里凭空消失）
    // 两个列表都按评论时间倒序：最新的评论在最上面（评论时间缺失时按创建时间排）
    const pending = sortByCommentTimeDesc(allTasks.filter((t) => t.status === 'pending' || t.status === 'failed'));
    const tracked = sortByCommentTimeDesc(allTasks.filter((t) => ['replied', 'user_replied', 'user_dm', 'ignored'].includes(t.status)));

    function taskRow(t, isPending) {
      const meta = COMMENT_STATUS_META[t.status] || { label: t.status, cls: 'pending' };
      const highlight = t.status === 'user_dm' ? 'style="background:var(--ok-tint)"' :
                        t.status === 'user_replied' ? 'style="background:var(--brand-tint-2)"' : '';
      // 解析多级评论树（v008）：兼容老任务（只有 userReplyContent 时构造一条 L2）
      const norm = (r) => ({
        commentId: r.comment_id || r.commentId || '',
        nickname: r.nickname || '',
        content: (r.content || '').trim(),
        repliedAt: r.replied_at || r.repliedAt || '',
        parentId: r.parent_id || r.parentId || '',
        level: r.level || 1,  // 相对根深度：1=L2, 2=L3 …
      });
      let subs = [];
      if (t.subReplies) { try { subs = JSON.parse(t.subReplies).map(norm); } catch (e) { subs = []; } }
      if (!subs.length && t.userReplyContent) {
        subs = [norm({ comment_id: t.commentId || '', nickname: (t.replierName || '对方'), content: t.userReplyContent, replied_at: '', parent_id: t.commentId || '', level: 1 })];
      }
      subs = subs.filter((r) => r.content);
      const rootId = t.commentId || '';
      // 建树：以被切入/回复的评论为根，按 parent_id 连成子树递归渲染。
      // 孤儿节点（父被排除/未知）重定向到根，保证多级数据不丢。
      const subIds = new Set(subs.map((s) => s.commentId));
      const childrenOf = {};
      subs.forEach((s) => {
        let p = s.parentId || rootId;
        if (p !== rootId && !subIds.has(p)) p = rootId;
        (childrenOf[p] = childrenOf[p] || []).push(s);
      });
      function renderChildren(pid, depth) {
        const kids = childrenOf[pid] || [];
        return kids.map((k) => `
          <div style="margin-top:8px;margin-left:${depth === 0 ? 2 : 14}px;padding:8px 10px;border-left:3px solid var(--brand-deep);background:var(--brand-tint-2);border-radius:0 6px 6px 0">
            <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft)">
              <span style="display:inline-block;background:var(--brand-deep);color:#fff;border-radius:4px;padding:1px 5px;font-size:10px">L${(k.level + 1)}</span>
              <b style="color:var(--brand-deep)">${esc(k.nickname || '对方')}</b>
              ${k.commentId ? `<span style="color:var(--ink-faint)">· ID ${esc(k.commentId)}</span>` : ''}
              ${k.repliedAt ? `<span style="color:var(--ink-faint)">· ${esc(k.repliedAt)}</span>` : ''}
              <span style="margin-left:auto;color:var(--brand-deep)">回复了你 ↓</span>
            </div>
            <div style="font-size:12.5px;margin-top:3px;color:var(--ink)">${esc(k.content)}</div>
            ${renderChildren(k.commentId, depth + 1)}
          </div>`).join('');
      }
      const hasUnreplied = subs.length > 0 && t.status === 'user_replied';
      // 最新/最深一条（用于回复列摘要）：优先层级深，其次回复时间新
      const latestSub = subs.length
        ? subs.reduce((a, b) => ((b.level > a.level) || (b.level === a.level && (b.repliedAt > a.repliedAt))) ? b : a)
        : null;
      // 对话根块（被切入/回复的那条评论，对方就在它下面接话）
      // v009：完整上下文——评论人 / 评论时间 / 视频名称 / 视频链接，一眼看清要回谁、回哪儿
      const videoLabel = t.videoTitle || (t.videoId ? ('视频 ' + t.videoId) : '未知视频');
      const cmtTime = fmtCommentTime(t.commentTime);
      const l1 = `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft)">
          <span style="display:inline-block;background:var(--ink-soft);color:#fff;border-radius:4px;padding:1px 5px;font-size:10px">原评论</span>
          <b style="color:var(--ink)">👤 ${esc(t.commentAuthor || '未知评论人')}</b>
          ${cmtTime ? `<span style="color:var(--ink-faint)">· ${esc(cmtTime)}</span>` : ''}
          ${t.account ? `<span style="color:var(--ink-faint)">· 账号 ${esc(t.account)}</span>` : ''}
        </div>
        <div style="font-size:13px;font-weight:600;margin-top:3px">${esc(t.commentContent || '(无评论内容)')}</div>
        <div style="font-size:11px;color:var(--ink-faint);margin-top:2px">🎬 ${esc(videoLabel)}${t.videoUrl ? ` · <a href="${esc(t.videoUrl)}" target="_blank" rel="noopener" style="color:var(--brand-deep)">打开视频↗</a>` : ''}</div>`;
      // v008：多级回复统计条
      const statHtml = subs.length ? `
        <div style="margin-top:8px;font-size:11px;color:var(--ink-soft)">
          💬 ${subs.length} 条回复 · ${new Set(subs.map((s) => s.nickname)).size} 人参与 · 最深 L${(Math.max.apply(null, subs.map((s) => s.level)) + 1)}
        </div>` : '';
      const treeHtml = renderChildren(rootId, 0);
      // 回复内容列：对方回复展示其最新/最深一条原文，否则展示我们的话术
      const replyCell = t.status === 'user_replied'
        ? (latestSub ? `💬 ${esc(latestSub.content)}` : (t.userReplyContent ? `💬 ${esc(t.userReplyContent)}` : '<span style="color:var(--ink-faint)">（未带回内容）</span>'))
        : (t.replyContent ? esc(t.replyContent) : '<span style="color:var(--ink-faint)">未回复</span>');
      const ops = isPending
        ? `<button type="button" class="btn btn--primary btn--sm" data-reply="${t.id}">选择话术回复</button>
           <button type="button" class="btn btn--ghost btn--sm" data-ct-delete="${t.id}" title="删除这条评论回复任务" style="margin-left:4px;color:var(--danger);border-color:var(--danger)">删除</button>`
        : `<button type="button" class="btn btn--sm" data-mark="${t.id}" data-status="user_replied">标记追评</button>
             <button type="button" class="btn btn--sm" data-mark="${t.id}" data-status="user_dm" style="margin-left:4px">标记私信★</button>` +
           (hasUnreplied
             ? `<button type="button" class="btn btn--sm btn--primary" data-continue="${t.id}" style="margin-left:4px">继续回复</button>`
             : '') +
           `<button type="button" class="btn btn--ghost btn--sm" data-ct-delete="${t.id}" title="删除这条评论回复任务" style="margin-left:4px;color:var(--danger);border-color:var(--danger)">删除</button>`;
      const cmtTimeCell = fmtCommentTime(t.commentTime);
      return `<tr ${highlight}>
        <td style="width:34px"><input type="checkbox" class="csel" data-sel="${esc(t.id)}" ${interactSel.has(t.id) ? 'checked' : ''} aria-label="选中这条评论任务"></td>
        <td style="width:104px">
          <div style="font-weight:600;font-size:12.5px">${esc(t.commentAuthor || '未知')}</div>
          ${cmtTimeCell ? `<div class="muted" style="font-size:11px">${esc(cmtTimeCell)}</div>` : ''}
        </td>
        <td>${l1}${treeHtml}${statHtml}</td>
        <td><span class="tag tag--${meta.cls}">${esc(meta.label)}</span></td>
        <td style="font-size:12px">${esc(t.account || '—')}</td>
        <td style="font-size:12px;color:var(--ink-soft)">${replyCell}</td>
        <td style="text-align:right;white-space:nowrap">${ops}</td>
      </tr>`;
    }

    // 批量操作条：group = pending（待处理） / tracked（已回复追踪）
    function selCount(group) {
      const ids = group === 'pending' ? pending : tracked;
      return ids.filter((t) => interactSel.has(t.id)).length;
    }
    function batchBar(group, rows) {
      const n = selCount(group);
      const ops = group === 'pending'
        ? `<button type="button" class="btn btn--sm btn--primary" data-batch="reply" ${n ? '' : 'disabled'}>批量回复</button>
           <button type="button" class="btn btn--sm" data-batch="ignore" ${n ? '' : 'disabled'}>批量忽略</button>
           <button type="button" class="btn btn--sm" data-batch="delete" ${n ? '' : 'disabled'} style="margin-left:4px;color:var(--danger);border-color:var(--danger)">批量删除</button>`
        : `<button type="button" class="btn btn--sm" data-batch="mark:user_replied" ${n ? '' : 'disabled'}>标记追评</button>
           <button type="button" class="btn btn--sm btn--primary" data-batch="mark:user_dm" ${n ? '' : 'disabled'}>标记私信★</button>
           <button type="button" class="btn btn--sm" data-batch="delete" ${n ? '' : 'disabled'} style="margin-left:4px;color:var(--danger);border-color:var(--danger)">批量删除</button>`;
      return `<div class="cbtch" data-group="${group}">
        <label class="cbtch__all"><input type="checkbox" data-selall="${group}"> 全选本表</label>
        <span class="cbtch__n">已选 <b data-seln>${n}</b> / ${rows.length} 条</span>
        <span class="cbtch__sp"></span>
        ${ops}
        <button type="button" class="btn btn--sm btn--ghost" data-batch="clear" ${n ? '' : 'disabled'}>取消选择</button>
      </div>`;
    }

    content.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:22px">
        <div id="reply-agent-bar" role="note" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);font-size:12.5px">
          <span>回复由<b>自动化浏览器</b>真实发送到抖音，该浏览器需保持登录（与采集用的浏览器相互独立）。</span>
          <span style="flex:1"></span>
          <span id="reply-agent-state" style="color:var(--ink-soft)">登录状态未检测</span>
          <button type="button" class="btn btn--sm" id="reply-agent-check">检测状态</button>
          <button type="button" class="btn btn--sm btn--primary" id="reply-agent-start">启动浏览器并登录</button>
        </div>
        <!-- 待回复列表 -->
        <div class="card">
          <div class="card__head">
            <span class="card__title">待处理评论</span>
            <span class="card__hint">待回复与回复失败的评论都在这里，发送后自动进入追踪列表</span>
            <span class="card__spacer"></span>
            <span class="tag tag--pending">${pending.length} 条待处理</span>
          </div>
          ${pending.length > 0 ? `
          ${batchBar('pending', pending)}
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width:34px"><input type="checkbox" data-selall="pending" aria-label="全选待处理"></th><th>评论人</th><th>评论内容 / 来源视频</th><th style="width:80px">状态</th><th style="width:110px">负责账号</th><th>回复内容</th><th style="width:140px;text-align:right">操作</th></tr></thead>
              <tbody data-it-pending="1">${pending.slice(0, 40).map((t) => taskRow(t, true)).join('')}</tbody>
            </table>
          </div>` : `
          <div class="empty">
            <span class="empty__ico">${ico('check')}</span>
            <p>暂无待回复评论，干得漂亮！</p>
          </div>`}
        </div>

        <!-- 已回复追踪 -->
        <div class="card">
          <div class="card__head">
            <span class="card__title">已回复追踪</span>
            <span class="card__hint">高亮：对方追评（蓝）/ 对方主动私信（绿 ★ 转化成功）</span>
            <span class="card__spacer"></span>
            <span class="tag tag--sent">已回复 ${tracked.filter((t) => t.status === 'replied').length}</span>
            <span class="tag tag--replied" style="margin-left:4px">追评 ${tracked.filter((t) => t.status === 'user_replied').length}</span>
            <span class="tag tag--wechat" style="margin-left:4px">私信★ ${tracked.filter((t) => t.status === 'user_dm').length}</span>
          </div>
          ${tracked.length > 0 ? `
          ${batchBar('tracked', tracked)}
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width:34px"><input type="checkbox" data-selall="tracked" aria-label="全选已回复"></th><th>评论人</th><th>评论内容 / 来源视频</th><th style="width:90px">状态</th><th style="width:110px">负责账号</th><th>回复内容</th><th style="width:200px;text-align:right">转化标记</th></tr></thead>
              <tbody data-it-tracked="1">${tracked.slice(0, 40).map((t) => taskRow(t, false)).join('')}</tbody>
            </table>
          </div>` : `
          <div class="empty">
            <span class="empty__ico">${ico('empty')}</span>
            <p>暂无已回复记录</p>
          </div>`}
        </div>
      </div>`;

    // 大列表分批补行（首屏先出 40 行保证能滚动）
    fillRowsProgressive(content.querySelector('[data-it-pending]'), pending, (t) => taskRow(t, true));
    fillRowsProgressive(content.querySelector('[data-it-tracked]'), tracked, (t) => taskRow(t, false));

    // 绑定自动化浏览器状态条（评论真实发送所依赖的那台浏览器）
    const agentState = $('#reply-agent-state', content);
    const showAgent = (s) => {
      if (!agentState) return;
      if (!s || s.ok === false) {
        agentState.textContent = (s && s.message) || '自动化组件不可用';
        agentState.style.color = 'var(--danger)';
        return;
      }
      if (!s.cdpReady) {
        agentState.textContent = '浏览器未启动';
        agentState.style.color = 'var(--danger)';
      } else if (s.loggedIn === true) {
        agentState.textContent = '浏览器已就绪 · 抖音已登录';
        agentState.style.color = 'var(--brand-deep)';
      } else if (s.loggedIn === false) {
        agentState.textContent = '浏览器已启动 · 抖音未登录';
        agentState.style.color = 'var(--danger)';
      } else {
        agentState.textContent = '浏览器已就绪（未检测到抖音页面）';
        agentState.style.color = 'var(--ink-soft)';
      }
    };
    $('#reply-agent-check', content)?.addEventListener('click', async () => {
      agentState.textContent = '检测中…';
      agentState.style.color = 'var(--ink-soft)';
      showAgent(await API.commentAgentStatus());
    });
    $('#reply-agent-start', content)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      toast('正在启动自动化浏览器，请在弹出的窗口中扫码登录…', 'ok');
      const s = await API.commentAgentStartBrowser();
      showAgent(s);
      btn.disabled = false;
      if (s && s.loggedIn === false) toast('浏览器已打开，请在窗口中扫码登录抖音', 'warn');
      // 启动浏览器并登录成功后，把已登录的抖音号同步进账号列表
      try { await API.syncDouyinAccount(); await refreshAccounts(); } catch (_) {}
    });

    // 绑定回复按钮
    $$('[data-reply]', content).forEach((btn) => {
      btn.addEventListener('click', () => {
        const task = allTasks.find((t) => t.id === btn.dataset.reply);
        openReplyModal(btn.dataset.reply, commentScripts, task || {});
      });
    });

    // 绑定「继续回复」：对方已回复，定位到其回复内容（而非原评论）再发新评论
    $$('[data-continue]', content).forEach((btn) => {
      btn.addEventListener('click', () => {
        const task = allTasks.find((t) => t.id === btn.dataset.continue) || {};
        let match = '';
        try {
          const raw = task.subReplies ? JSON.parse(task.subReplies) : [];
          if (raw.length) {
            const list = raw
              .map((r) => ({ content: (r.content || '').trim(), level: r.level || 1, repliedAt: r.replied_at || r.repliedAt || '' }))
              .filter((r) => r.content);
            if (list.length) {
              // 优先层级深、其次回复时间新（续上对话最深入的那个分支）
              const latest = list.reduce((a, b) =>
                ((b.level > a.level) || (b.level === a.level && (b.repliedAt > a.repliedAt))) ? b : a);
              match = latest.content;
            }
          }
        } catch (e) {}
        if (!match && task.userReplyContent) match = task.userReplyContent;
        openReplyModal(btn.dataset.continue, commentScripts, task, match);
      });
    });

    // 绑定状态标记按钮
    $$('[data-mark]', content).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mark;
        const status = btn.dataset.status;
        const result = await API.updateCommentTask(id, { status });
        if (result && result.ok !== false) {
          toast(status === 'user_dm' ? '已标记对方主动私信 ★ 转化成功！' : '已标记对方追评', 'ok');
          route(); // 重新渲染当前Tab
        }
      });
    });

    // ── 批量选择：勾选 / 全选 / 批量操作 ──
    function refreshSelUi() {
      $$('.csel', content).forEach((cb) => { cb.checked = interactSel.has(cb.dataset.sel); });
      const rowsOf = (g) => (g === 'pending' ? pending : tracked);
      $$('.cbtch', content).forEach((bar) => {
        const g = bar.dataset.group;
        const rows = rowsOf(g);
        const n = rows.filter((t) => interactSel.has(t.id)).length;
        const bn = bar.querySelector('[data-seln]');
        if (bn) bn.textContent = n;
        bar.querySelectorAll('[data-batch]').forEach((b) => { b.disabled = !n; });
        const all = bar.querySelector('[data-selall]');
        if (all) {
          all.checked = rows.length > 0 && n === rows.length;
          all.indeterminate = n > 0 && n < rows.length;
        }
      });
      $$('thead [data-selall]', content).forEach((all) => {
        const rows = rowsOf(all.dataset.selall);
        const n = rows.filter((t) => interactSel.has(t.id)).length;
        all.checked = rows.length > 0 && n === rows.length;
        all.indeterminate = n > 0 && n < rows.length;
      });
    }

    content.addEventListener('change', (e) => {
      const el = e.target;
      if (el.matches && el.matches('.csel')) {
        if (el.checked) interactSel.add(el.dataset.sel); else interactSel.delete(el.dataset.sel);
        refreshSelUi();
      } else if (el.matches && el.matches('[data-selall]')) {
        const rows = el.dataset.selall === 'pending' ? pending : tracked;
        rows.forEach((t) => { if (el.checked) interactSel.add(t.id); else interactSel.delete(t.id); });
        refreshSelUi();
      }
    });

    async function batchMark(ids, status, label) {
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          const r = await API.updateCommentTask(id, { status });
          if (r && r.ok !== false) ok++; else fail++;
        } catch (e) { fail++; }
      }
      interactSel.clear();
      toast(`批量${label}：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`, fail ? 'warn' : 'ok');
      route();
    }

    /* ── 删除单条评论回复任务 ── */
    async function ctDelete(id) {
      if (!confirm('确定删除这条评论回复任务吗？')) return;
      try {
        await API.deleteCommentTask(id);
        interactSel.delete(id);
        toast('删除成功', 'ok');
        route(); // 重新渲染当前Tab
      } catch (e) {
        toast('删除失败：' + (e.message || e), 'warn');
      }
    }

    /* ── 批量删除评论回复任务：单条失败不中断，最后汇总提示 ── */
    async function ctDeleteBatch(ids) {
      if (!ids || !ids.length) return;
      if (!confirm(`确定删除选中的 ${ids.length} 条评论回复任务吗？`)) return;
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await API.deleteCommentTask(id);
          interactSel.delete(id);
          ok += 1;
        } catch (e) {
          fail += 1;
        }
      }
      interactSel.clear();
      toast(`删除成功 ${ok} 条` + (fail ? `，失败 ${fail} 条` : ''), ok ? 'ok' : 'warn');
      route();
    }

    content.addEventListener('click', async (e) => {
      // 单条删除
      const delOne = e.target.closest('[data-ct-delete]');
      if (delOne && !delOne.disabled) { ctDelete(delOne.dataset.ctDelete); return; }

      const btn = e.target.closest('[data-batch]');
      if (!btn || btn.disabled) return;
      const bar = btn.closest('.cbtch');
      const group = bar ? bar.dataset.group : '';
      const rows = group === 'pending' ? pending : tracked;
      const ids = rows.filter((t) => interactSel.has(t.id)).map((t) => t.id);
      const act = btn.dataset.batch;
      if (act === 'clear') { interactSel.clear(); refreshSelUi(); return; }
      if (!ids.length) return;
      if (act === 'reply') { openBatchReplyModal(ids, commentScripts, allTasks); return; }
      if (act === 'delete') { await ctDeleteBatch(ids); return; }
      const status = act.indexOf('mark:') === 0 ? act.slice(5) : 'ignored';
      const label = status === 'ignored' ? '忽略' : (status === 'user_dm' ? '标记私信★' : '标记追评');
      if (!window.confirm(`确认把选中的 ${ids.length} 条${label}？`)) return;
      btn.disabled = true;
      await batchMark(ids, status, label);
    });

    refreshSelUi();
  }

  /* ═══════════════════════════════════════════
     视图：私信任务（IMP-001 执行器 · 队列+对话）
     ═══════════════════════════════════════════ */
﻿  async function viewDm() {
    // 离开本视图时清理批量轮询
    if (window._dmBatchTimer) { clearInterval(window._dmBatchTimer); window._dmBatchTimer = null; }

    const [queue, meta, cfg, results] = await Promise.all([
      API.getDmQueue(),
      API.getLeadStatusMeta(),
      (API.getDmSenderConfig ? API.getDmSenderConfig() : Promise.resolve(null)),
      (API.fetchDmSendResults ? API.fetchDmSendResults(50) : Promise.resolve([])),
    ]);
    state.leads = await API.getLeads();
    state.leadStatusMeta = meta;

    const cnt = (k) => queue.filter((q) => q.status === k).length;
    const convs = state.leads.filter((l) => (l.messages || []).length > 0);

    // ── 发送器配置（默认值兜底） ──
    const sCfg = cfg || { mode: 'mock', minInterval: 30, maxInterval: 60, dailyLimit: 50 };
    const isMock = sCfg.mode !== 'cdp';

    // ── 发送控制区 ──
    const senderPanel = `
      <div class="card dm-sender">
        <div class="card__head">
          <span class="card__title">发送控制</span>
          <span class="card__hint">私信发送执行器 · P4-D</span>
        </div>
        ${isMock ? '<div class="dm-sender__mockbar">当前为模拟发送（Mock），不会真实发送私信</div>'
                 : '<div class="dm-sender__mockbar dm-sender__mockbar--cdp">当前为 CDP 模式（联调中），真实发送待 Electron 对接</div>'}
        <div class="dm-sender__row">
          <div class="dm-sender__field">
            <label for="dm-sender-mode">发送器模式</label>
            <select id="dm-sender-mode">
              <option value="mock" ${isMock ? 'selected' : ''}>Mock 模拟</option>
              <option value="cdp" ${!isMock ? 'selected' : ''}>CDP（联调中）</option>
            </select>
          </div>
          <div class="dm-sender__field">
            <label for="dm-sender-min">最小间隔(秒)</label>
            <input type="number" id="dm-sender-min" value="${esc(sCfg.minInterval)}" min="0">
          </div>
          <div class="dm-sender__field">
            <label for="dm-sender-max">最大间隔(秒)</label>
            <input type="number" id="dm-sender-max" value="${esc(sCfg.maxInterval)}" min="0">
          </div>
          <div class="dm-sender__field">
            <label for="dm-sender-daily">每日上限</label>
            <input type="number" id="dm-sender-daily" value="${esc(sCfg.dailyLimit)}" min="1">
          </div>
          <div class="dm-sender__field dm-sender__field--btn">
            <button type="button" class="btn" id="dm-sender-save-cfg">保存配置</button>
          </div>
        </div>
        <div class="dm-sender__run">
          <button type="button" class="btn btn--primary" id="dm-batch-start">开始批量发送</button>
          <button type="button" class="btn" id="dm-batch-stop" disabled>停止发送</button>
          <button type="button" class="btn" id="dm-sender-test">测试发送器</button>
          <span class="dm-sender__prog" id="dm-batch-prog">就绪</span>
        </div>
        <div class="dm-sender__bar"><div class="dm-sender__bar-fill" id="dm-batch-bar" style="width:0%"></div></div>
        <div class="dm-sender__counts">
          <span class="dm-count dm-count--ok">成功 <b id="dm-c-ok">0</b></span>
          <span class="dm-count dm-count--fail">失败 <b id="dm-c-fail">0</b></span>
          <span class="dm-count dm-count--thr">频控 <b id="dm-c-thr">0</b></span>
        </div>
      </div>`;

    // ── 最近发送记录 ──
    const leadNick = {};
    state.leads.forEach((l) => { leadNick[l.id] = l.nickname; });
    const _DM_STATUS_CLS = {
      success: 'success', failed: 'failed', throttled: 'throttled',
      need_captcha: 'need_captcha', account_banned: 'account_banned',
    };
    const resultsRows = (results || []).map((r) => {
      const nick = r.leadId === '__test__' ? '（测试）' : (leadNick[r.leadId] || (r.leadId || '').slice(0, 6));
      const stCls = _DM_STATUS_CLS[r.status] || '';
      return `<tr>
        <td style="white-space:nowrap">${esc(_fmtInboxTime(r.createdAt))}</td>
        <td>${esc(nick)}</td>
        <td style="color:var(--ink-soft)">${esc(r.accountId && r.accountId !== '__test__' ? r.accountId.slice(0, 6) : '-')}</td>
        <td style="max-width:220px;color:var(--ink-soft)">${esc((r.content || '').slice(0, 32))}</td>
        <td><span class="dm-status dm-status--${stCls}">${esc(r.status)}</span></td>
        <td style="color:var(--ink-soft)">${esc(r.message)}</td>
      </tr>`;
    }).join('');

    const resultsCard = `
      <div class="card">
        <div class="card__head">
          <span class="card__title">最近发送记录</span>
          <span class="card__hint">发送结果留痕 · 状态颜色：成功绿 / 失败红 / 频控黄 / 验证码橙</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>时间</th><th>线索</th><th>账号</th><th>内容摘要</th><th>状态</th><th>消息</th></tr></thead>
            <tbody>${resultsRows || `<tr><td colspan="6">${emptyState('dm', '暂无发送记录')}</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;

    main.innerHTML = `
      <div class="view">
        ${pageHead({
          icon: 'dm', title: '私信任务', desc: '发送队列 + 对话承接 · 安全模式下全队列只读',
          actions: state.safeMode.active ? '<span class="tag tag--safemode">安全模式中 · 队列冻结</span>' : '',
        })}

        <div class="grid grid--metrics">
          ${metric('待发送', fmt(cnt('pending_outreach')), '按随机间隔拟人发送')}
          ${metric('频控暂缓', fmt(cnt('throttled')), 'R1 降速队列回放')}
          ${metric('失败待恢复', fmt(cnt('send_failed')), '账号恢复后自动重试')}
          ${metric('已发待回复', fmt(cnt('sent')), '超过 48h 无回复转培育')}
          ${metric('待人工回复', fmt(cnt('replied')), '用户已回话，别让线索凉掉', cnt('replied') ? 'danger' : '')}
        </div>

        ${senderPanel}

        <div class="card">
          <div class="card__head">
            <span class="card__title">发送队列</span>
            <span class="card__hint">执行器状态与话术变体分配（IMP-001）</span>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>用户</th><th>执行账号</th><th>话术</th><th>状态</th><th>说明</th><th></th></tr></thead>
              <tbody>
                ${queue.map((q) => {
                  const st = meta[q.status] || { label: q.status, cls: '' };
                  const isDanger = ['throttled', 'send_failed'].includes(q.status);
                  const canSend = q.status === 'pending_outreach' && !state.safeMode.active;
                  return `
                    <tr class="${isDanger ? 'row--danger' : ''}" data-lead-id="${q.leadId}" style="cursor:pointer">
                      <td><div class="cell-user">
                        <span class="avatar" style="background:hsl(${q.hue} 45% 44%)">${esc(q.nickname.slice(0, 1))}</span>
                        <span style="font-weight:600">${esc(q.nickname)}</span>
                      </div></td>
                      <td style="color:var(--ink-soft)">${esc(q.account)}</td>
                      <td><span class="tag tag--low">变体 ${esc(q.variant)}</span></td>
                      <td><span class="tag tag--${st.cls}">${st.label}</span></td>
                      <td style="color:var(--ink-soft);max-width:260px">${esc(q.detail)}</td>
                      <td>${canSend ? `<button type="button" class="btn-link" data-send-now="${q.leadId}">立即发送</button>`
                        : `<button type="button" class="btn-link">查看对话</button>`}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">进行中的对话</span>
            <span class="card__hint">点开查看完整私信记录与加微引导过程</span>
          </div>
          ${convs.length ? convs.map((l) => {
            const last = (l.messages || [])[(l.messages || []).length - 1] || {};
            return `
              <div class="dm-conv" data-lead-id="${l.id}">
                <span class="avatar" style="background:hsl(${l.hue} 45% 44%)">${esc(l.nickname.slice(0, 1))}</span>
                <div style="min-width:0">
                  <div style="font-weight:600">${esc(l.nickname)}
                    <span class="msg__meta" style="margin-left:6px">${last.dir === 'out' ? '我方' : '用户'} · ${esc(last.time)}</span></div>
                  <div class="dm-conv__last">${esc(last.text)}</div>
                </div>
                <span class="tag tag--${(state.leadStatusMeta[l.status] || {}).cls}">${esc((state.leadStatusMeta[l.status] || {}).label || l.status)}</span>
              </div>`;
          }).join('') : emptyState('dm', '暂无对话')}
        </div>

        ${resultsCard}
      </div>`;

    // ── 批量进度渲染辅助 ──
    function renderBatchStatus(s) {
      if (!s) return;
      const bar = $('#dm-batch-bar'), prog = $('#dm-batch-prog');
      const ok = $('#dm-c-ok'), fail = $('#dm-c-fail'), thr = $('#dm-c-thr');
      const stopBtn = $('#dm-batch-stop'), startBtn = $('#dm-batch-start');
      if (bar) bar.style.width = s.total ? Math.round((s.done / s.total) * 100) + '%' : '0%';
      if (prog) prog.textContent = s.running
        ? `发送中 ${s.done}/${s.total}`
        : (s.total ? `已完成 ${s.done}/${s.total}` : '就绪');
      if (ok) ok.textContent = s.success || 0;
      if (fail) fail.textContent = s.failed || 0;
      if (thr) thr.textContent = s.throttled || 0;
      if (stopBtn) stopBtn.disabled = !s.running;
      if (startBtn) startBtn.disabled = !!s.running;
    }

    function startBatchPolling() {
      if (window._dmBatchTimer) clearInterval(window._dmBatchTimer);
      window._dmBatchTimer = setInterval(async () => {
        try {
          const s = await API.fetchDmBatchStatus();
          renderBatchStatus(s);
          if (!s.running) {
            clearInterval(window._dmBatchTimer);
            window._dmBatchTimer = null;
          }
        } catch (e) { /* 轮询失败静默，下次重试 */ }
      }, 1200);
    }

    // ── 事件绑定 ──
    $$('[data-send-now]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.safeMode.active) { toast('安全模式中，队列冻结', 'warn'); return; }
      const leadId = b.dataset.sendNow;
      b.disabled = true; b.textContent = '发送中…';
      try {
        const out = await API.sendDmOne(leadId);
        toast('发送结果：' + out.status + (out.message ? '（' + out.message + '）' : ''),
              out.status === 'success' ? 'ok' : 'warn');
      } catch (err) {
        toast('发送失败：' + (err.message || err), 'warn');
      }
      route();
    }));

    $('#dm-batch-start')?.addEventListener('click', async () => {
      if (state.safeMode.active) { toast('安全模式中，队列冻结', 'warn'); return; }
      try {
        const s = await API.sendDmBatch(10);
        renderBatchStatus(s);
        if (s.running) { toast('批量发送已启动（后台执行）'); startBatchPolling(); }
        else { toast(s.message || '没有待发送线索', 'warn'); }
      } catch (err) { toast('启动失败：' + (err.message || err), 'warn'); }
    });

    $('#dm-batch-stop')?.addEventListener('click', async () => {
      try { await API.stopDmBatch(); toast('已请求停止（当前条发完后停）', 'warn'); }
      catch (err) { toast('停止失败：' + (err.message || err), 'warn'); }
    });

    $('#dm-sender-test')?.addEventListener('click', async () => {
      try {
        const out = await API.testDmSender();
        toast('测试发送：' + out.status + (out.message ? '（' + out.message + '）' : ''),
              out.status === 'success' ? 'ok' : 'warn');
      } catch (err) { toast('测试失败：' + (err.message || err), 'warn'); }
    });

    $('#dm-sender-save-cfg')?.addEventListener('click', async () => {
      const payload = {
        mode: $('#dm-sender-mode').value,
        minInterval: parseInt($('#dm-sender-min').value, 10) || 0,
        maxInterval: parseInt($('#dm-sender-max').value, 10) || 0,
        dailyLimit: parseInt($('#dm-sender-daily').value, 10) || 50,
      };
      try {
        await API.updateDmSenderConfig(payload);
        toast('发送器配置已保存');
      } catch (err) { toast('保存失败：' + (err.message || err), 'warn'); }
    });

    $$('[data-lead-id]').forEach((b) => b.addEventListener('click', () => openLeadDrawer(b.dataset.leadId)));
  }

  /* ═══════════════════════════════════════════
     视图：私信收件箱（评论引流转化闭环）
     ═══════════════════════════════════════════ */
  const INBOX_STATUS_META = {
    new: { label: '新会话', cls: 'pending' },
    replied: { label: '已回复', cls: 'sent' },
    wechat_added: { label: '已加微', cls: 'wechat' },
    closed: { label: '已关闭', cls: 'rejected' },
  };

  function _fmtInboxTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function viewDmInbox() {
    const inboxState = {
      conversations: [],
      activeId: null,
      detail: null,
      scripts: [],
      filter: 'all',
    };

    // 加载话术库（私信 + 微信引导类）用于快捷插入
    try {
      const allScripts = await API.getScripts();
      inboxState.scripts = allScripts.filter((s) =>
        ['welcome', 'private_message', 'wechat_guide', 'objection'].includes(s.category)
      );
    } catch (e) {
      inboxState.scripts = [];
    }

    async function loadList() {
      inboxState.conversations = await API.getDmInbox(inboxState.filter === 'all' ? undefined : inboxState.filter);
      renderList();
    }

    async function loadDetail(convId) {
      inboxState.activeId = convId;
      inboxState.detail = await API.getDmConversation(convId);
      renderList();
      renderDetail();
    }

    function renderList() {
      const listEl = $('#inbox-list');
      if (!listEl) return;
      const totalUnread = inboxState.conversations.reduce((s, c) => s + (c.unreadCount || 0), 0);
      const filterTabs = ['all', 'new', 'replied', 'wechat_added', 'closed'].map((k) => {
        const count = k === 'all' ? inboxState.conversations.length
          : inboxState.conversations.filter((c) => c.status === k).length;
        const label = k === 'all' ? '全部' : (INBOX_STATUS_META[k] || {}).label || k;
        return `<button type="button" class="subtab-btn" data-inbox-filter="${k}" aria-selected="${inboxState.filter === k}">${esc(label)}<span class="count">${count}</span></button>`;
      }).join('');

      listEl.innerHTML = `
        <div class="subtabs" role="tablist" style="padding:10px 14px 0">${filterTabs}</div>
        <div style="overflow-y:auto;flex:1">
          ${inboxState.conversations.length ? inboxState.conversations.map((c) => {
            const meta = INBOX_STATUS_META[c.status] || { label: c.status, cls: 'low' };
            const isActive = c.id === inboxState.activeId;
            return `
              <div class="dm-conv" data-inbox-id="${c.id}" style="${isActive ? 'background:var(--brand-tint-2);border-left:3px solid var(--brand-deep)' : 'border-left:3px solid transparent'}">
                <span class="avatar" style="background:hsl(${c.avatarHue || 200} 45% 44%)">${esc((c.nickname || '?').slice(0, 1))}</span>
                <div style="min-width:0;flex:1">
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.nickname)}</span>
                    ${c.unreadCount > 0 ? `<span class="nav-badge nav-badge--count" style="background:var(--danger);color:#fff;min-width:18px;height:18px;padding:0 5px;font-size:11px;line-height:18px">${c.unreadCount}</span>` : ''}
                    <span class="tag tag--${meta.cls}" style="margin-left:auto;flex-shrink:0">${esc(meta.label)}</span>
                  </div>
                  <div class="dm-conv__last">${esc(c.lastMessage || '')}</div>
                  <div style="font-size:11px;color:var(--ink-faint);margin-top:2px">${esc(_fmtInboxTime(c.lastMessageAt))}</div>
                </div>
              </div>`;
          }).join('') : `<div class="empty" style="padding:40px 0"><span class="empty__ico">${ico('empty')}</span><p>暂无会话</p></div>`}
        </div>`;

      $$('[data-inbox-id]', listEl).forEach((el) => {
        el.addEventListener('click', () => loadDetail(el.dataset.inboxId));
      });
      $$('[data-inbox-filter]', listEl).forEach((btn) => {
        btn.addEventListener('click', () => {
          inboxState.filter = btn.dataset.inboxFilter;
          loadList();
        });
      });
    }

    function renderDetail() {
      const detailEl = $('#inbox-detail');
      if (!detailEl) return;
      const d = inboxState.detail;
      if (!d) {
        detailEl.innerHTML = `<div class="empty" style="height:100%"><span class="empty__ico">${ico('dm')}</span><p>选择左侧会话查看私信</p></div>`;
        return;
      }
      const meta = INBOX_STATUS_META[d.status] || { label: d.status, cls: 'low' };
      const scriptOptions = inboxState.scripts.length
        ? inboxState.scripts.map((s) => {
            const firstVariant = (s.variants && s.variants[0]) ? s.variants[0].text : (s.intro || '');
            return `<option value="${esc(firstVariant)}" data-script-id="${esc(s.id)}">${esc(s.name)}（${esc(s.category)}）</option>`;
          }).join('')
        : '';

      detailEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);flex-shrink:0">
          <span class="avatar" style="background:hsl(${d.avatarHue || 200} 45% 44%)">${esc((d.nickname || '?').slice(0, 1))}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${esc(d.nickname)}</div>
            <div style="font-size:12px;color:var(--ink-soft)"><span class="tag tag--${meta.cls}">${esc(meta.label)}</span></div>
          </div>
          ${d.status !== 'wechat_added' && d.status !== 'closed' ? `
            <button type="button" class="btn btn--primary btn--sm" id="btn-mark-wechat">
              <span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></span>标记加微转客户
            </button>` : `<span class="tag tag--wechat">已转化为客户</span>`}
        </div>
        <div class="msg-list" id="inbox-msg-list" style="flex:1;overflow-y:auto;padding:16px 18px">
          ${d.messages.map((m) => `
            <div class="msg msg--${m.direction === 'out' ? 'out' : 'in'}">
              ${esc(m.content)}
              <div class="msg__meta">${m.direction === 'out' ? '我方' : '用户'} · ${esc(_fmtInboxTime(m.createdAt))}${m.scriptId ? ' · 话术' : ''}</div>
            </div>`).join('')}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--line);flex-shrink:0;background:var(--paper)">
          ${scriptOptions ? `
            <div style="margin-bottom:8px">
              <select id="inbox-script-select" style="width:100%;font-size:12.5px">
                <option value="">— 选择话术快捷插入 —</option>
                ${scriptOptions}
              </select>
            </div>` : ''}
          <div style="display:flex;gap:8px;align-items:flex-end">
            <textarea id="inbox-reply-input" placeholder="输入回复内容…（Enter 发送，Shift+Enter 换行）" style="flex:1;min-height:60px"></textarea>
            <div style="display:flex;flex-direction:column;gap:6px">
              <select id="inbox-ai-style" style="font-size:11px;padding:2px 4px">
                <option value="formal">更正式</option>
                <option value="casual" selected>更口语</option>
                <option value="short">更简短</option>
              </select>
              <button type="button" class="btn btn--ghost btn--sm" id="btn-ai-polish" style="border-color:var(--brand);color:var(--brand-deep);white-space:nowrap">
                <span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 润色
              </button>
            </div>
            <button type="button" class="btn btn--primary" id="btn-send-reply" style="height:60px;padding:0 20px">发送</button>
          </div>
        </div>`;

      // 自动滚动到底部
      const msgList = $('#inbox-msg-list', detailEl);
      if (msgList) msgList.scrollTop = msgList.scrollHeight;

      // 发送回复
      $('#btn-send-reply', detailEl)?.addEventListener('click', sendReply);
      const replyInput = $('#inbox-reply-input', detailEl);
      replyInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
      });

      // AI 润色
      const polishBtn = $('#btn-ai-polish', detailEl);
      if (polishBtn) polishBtn.addEventListener('click', async () => {
        if (!(await aiEnsureConfigured())) return;
        const styleSel = $('#inbox-ai-style', detailEl);
        const style = styleSel ? styleSel.value : 'casual';
        const currentText = replyInput ? replyInput.value.trim() : '';
        polishBtn.disabled = true; polishBtn.textContent = '润色中…';
        try {
          const result = await API.aiSmartDraft({
            lead_id: d.leadId || d.id || '',
            script_category: 'private_message',
            user_comment: currentText,
            style,
          });
          if (result && result.draft) {
            if (replyInput) { replyInput.value = result.draft; replyInput.focus(); }
            toast('AI 润色完成，可编辑后发送', 'ok');
          }
        } catch (e) {
          aiHandleError(e);
        } finally {
          polishBtn.disabled = false;
          polishBtn.innerHTML = '<span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 润色';
        }
      });

      // 话术快捷插入（含 {变量} 按当前画像解析）
      $('#inbox-script-select', detailEl)?.addEventListener('change', async (e) => {
        if (e.target.value && replyInput) {
          const ctx = await ensureProfileCtx();
          replyInput.value = resolveProfileVars(e.target.value, ctx);
          replyInput.focus();
        }
      });

      // 标记加微
      $('#btn-mark-wechat', detailEl)?.addEventListener('click', openMarkWechatModal);
    }

    async function sendReply() {
      const input = $('#inbox-reply-input');
      const content = input ? input.value.trim() : '';
      if (!content) { toast('回复内容不能为空', 'warn'); return; }
      const scriptSelect = $('#inbox-script-select');
      const selectedOption = scriptSelect ? scriptSelect.options[scriptSelect.selectedIndex] : null;
      const scriptId = selectedOption && selectedOption.value ? (selectedOption.dataset.scriptId || null) : null;
      try {
        await API.sendDmReply(inboxState.activeId, content, scriptId);
        toast('回复已发送');
        await loadDetail(inboxState.activeId);
        await loadList();
      } catch (e) {
        toast('发送失败：' + e.message, 'warn');
      }
    }

    function openMarkWechatModal() {
      const d = inboxState.detail;
      openModal(`
        <div class="modal__head">
          <h3 id="modal-title">标记加微 · 转客户</h3>
          <button type="button" class="drawer__close" data-close aria-label="关闭">×</button>
        </div>
        <div class="modal__body">
          <div class="field">
            <label>微信号 <span style="color:var(--danger)">*</span></label>
            <input type="text" id="mw-wechat-id" placeholder="输入客户微信号" value="">
          </div>
          <div class="field">
            <label>客户姓名</label>
            <input type="text" id="mw-customer-name" placeholder="留空则使用昵称：${esc(d.nickname)}" value="${esc(d.nickname)}">
          </div>
          <div class="field">
            <label>手机号（可选）</label>
            <input type="text" id="mw-phone" placeholder="选填">
          </div>
          <p style="font-size:12px;color:var(--ink-soft);margin-top:8px">提交后将：关闭会话 · 线索标记为已加微 · 自动创建客户</p>
        </div>
        <div class="modal__foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <button type="button" class="btn btn--ghost" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="mw-submit">确认加微</button>
        </div>`);
      $('#mw-submit').addEventListener('click', async () => {
        const wechatId = $('#mw-wechat-id').value.trim();
        if (!wechatId) { toast('请输入微信号', 'warn'); return; }
        try {
          const res = await API.markDmWechat(inboxState.activeId, {
            wechatId,
            customerName: $('#mw-customer-name').value.trim() || null,
            phone: $('#mw-phone').value.trim() || null,
          });
          closeModal();
          toast('已标记加微，客户已创建');
          setTimeout(() => { location.hash = '#/customers'; }, 600);
        } catch (e) {
          toast('操作失败：' + e.message, 'warn');
        }
      });
    }

    // 初始渲染
    main.innerHTML = `
      <div class="view">
        ${pageHead({
          icon: 'dm', title: '私信收件箱', desc: '用户主动私信承接 · 回复 → 加微 → 转客户，全链路闭环',
          actions: '<button type="button" class="btn btn--ghost btn--sm" id="btn-simulate-dm">模拟收到私信</button>',
        })}
        <div class="card" style="padding:0;display:flex;height:calc(100vh - 220px);min-height:480px;overflow:hidden">
          <div id="inbox-list" style="width:300px;border-right:1px solid var(--line);display:flex;flex-direction:column;flex-shrink:0"></div>
          <div id="inbox-detail" style="flex:1;display:flex;flex-direction:column;min-width:0"></div>
        </div>
      </div>`;

    $('#btn-simulate-dm').addEventListener('click', () => {
      openModal(`
        <div class="modal__head">
          <h3 id="modal-title">模拟收到私信（开发测试）</h3>
          <button type="button" class="drawer__close" data-close aria-label="关闭">×</button>
        </div>
        <div class="modal__body">
          <div class="field"><label>用户昵称</label><input type="text" id="sim-nickname" placeholder="如：装修咨询小王"></div>
          <div class="field"><label>私信内容</label><textarea id="sim-content" placeholder="如：你好，请问多少钱？"></textarea></div>
        </div>
        <div class="modal__foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <button type="button" class="btn btn--ghost" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="sim-submit">模拟发送</button>
        </div>`);
      $('#sim-submit').addEventListener('click', async () => {
        const nickname = $('#sim-nickname').value.trim() || '测试用户';
        const content = $('#sim-content').value.trim() || '你好，咨询一下';
        try {
          await API.simulateDmInbound({ nickname, content });
          closeModal();
          toast('已模拟收到私信');
          await loadList();
        } catch (e) {
          toast('模拟失败：' + e.message, 'warn');
        }
      });
    });

    await loadList();
    renderDetail();
  }

  /* ═══════════════════════════════════════════
     视图：客户与商机（IMP-028/029/031）
     ═══════════════════════════════════════════ */
  /* 通用成交流程，不绑定任何行业：已加微 → 需求沟通 → 方案中 → 已报价 → 谈判中 → 成交/流失。
     原「已量房」为装修专属阶段，已替换为「需求沟通」。 */
  const STAGE_ORDER = ['added', 'discovery', 'proposal', 'quoted', 'negotiating'];
  const STAGE_NEXT_LABEL = {
    added: '需求沟通（聊清需求）', discovery: '方案中（出方案）', proposal: '已报价（发报价）',
    quoted: '谈判中', negotiating: '成交（签约）',
  };

  async function viewCustomers() {
    [state.customers, state.stageMeta] = await Promise.all([API.getCustomers(), API.getStageMeta()]);
    renderCustomers();
  }

  function renderCustomers() {
    const stages = state.stageMeta;
    const allStages = [...STAGE_ORDER, 'won', 'lost'];
    const custs = state.customers;
    const filtered = state.custFilter === 'all' ? custs : custs.filter((c) => c.stage === state.custFilter);

    const pipeline = allStages.map((k) => {
      const list = custs.filter((c) => c.stage === k);
      const value = list.reduce((s, c) => s + (c.estValue || 0), 0);
      const meta = stages[k] || { label: k };
      // 悬停说明取后端 stage-meta 的 desc（通用措辞，让非装修行业也知道这一步指什么）
      const tip = meta.desc ? `${meta.label}：${meta.desc}` : meta.label;
      return `
        <button type="button" class="stage-card ${k === 'won' ? 'stage-card--won' : ''} ${k === 'lost' ? 'stage-card--lost' : ''}"
                data-stage="${k}" aria-pressed="${state.custFilter === k}" title="${esc(tip)}">
          <span class="stage-card__count" style="color:${k === 'won' ? 'var(--brand-deep)' : k === 'lost' ? 'var(--ink-faint)' : 'var(--ink)'}">${list.length}</span>
          <span class="stage-card__label">${esc(meta.label)}</span>
          <span class="stage-card__sub">${list.length ? (k === 'lost' ? '累计流失' : wan(value)) : '—'}</span>
        </button>`;
    }).join('');

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'people', title: '客户与商机', desc: '加微后的通用成交流程：需求沟通 → 方案 → 报价 → 谈判 → 成交（不绑定行业，与获客状态正交）' })}
        <div class="pipeline" role="group" aria-label="按商机阶段筛选">${pipeline}</div>
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead><tr>
                <th>客户</th><th>来源</th><th>商机阶段</th><th>预估价值</th><th>下一步动作</th><th>最近动态</th><th></th>
              </tr></thead>
              <tbody>
                ${filtered.length ? filtered.map((c) => customerRow(c, stages)).join('')
                  : `<tr><td colspan="7"><div class="empty">${emptyState('people', '该阶段暂无客户')}</div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;

    $$('.stage-card').forEach((b) => b.addEventListener('click', () => {
      state.custFilter = state.custFilter === b.dataset.stage ? 'all' : b.dataset.stage;
      renderCustomers();
    }));
    $$('[data-cu-id]').forEach((b) => b.addEventListener('click', () => openCustomerDrawer(b.dataset.cuId)));
  }

  function customerRow(c, stages) {
    const st = stages[c.stage];
    const src = state.sourceMeta[c.source] || { label: c.source, cls: 'collected' };
    const lastLog = c.logs[c.logs.length - 1];
    return `
      <tr data-cu-id="${c.id}" style="cursor:pointer${c.stage === 'lost' ? ';opacity:.6' : ''}">
        <td><div class="cell-user">
          <span class="avatar" style="background:hsl(${c.hue} 45% 44%)">${esc(c.name.slice(0, 1))}</span>
          <span style="font-weight:600">${esc(c.name)}</span>
        </div></td>
        <td><span class="tag tag--${src.cls}">${esc(src.label)}</span></td>
        <td><span class="tag tag--${st.cls}">${esc(st.label)}</span></td>
        <td class="num" style="font-weight:600">${c.dealAmount ? `<span style="color:var(--ok)">${wan(c.dealAmount)}</span>` : wan(c.estValue)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-soft)">
          ${c.nextAction ? esc(c.nextAction) + ` <small style="color:var(--ink-faint)">(${esc(c.nextAt)})</small>` : '—'}</td>
        <td style="color:var(--ink-faint);font-size:12px">${esc(lastLog.time)} · ${esc(lastLog.text)}</td>
        <td><button type="button" class="btn-link">详情</button></td>
      </tr>`;
  }

  /* 客户详情抽屉（阶段推进 / 成交录入 / 流失标记） */
  function openCustomerDrawer(cuId) {
    const c = state.customers.find((x) => x.id === cuId);
    if (!c) return;
    const stages = state.stageMeta;
    const src = state.sourceMeta[c.source] || { label: c.source, cls: 'collected' };
    const isFinal = ['won', 'lost'].includes(c.stage);
    const nextKey = STAGE_ORDER[Math.min(STAGE_ORDER.indexOf(c.stage) + 1, STAGE_ORDER.length - 1)];

    const stepper = `
      <div class="stepper" aria-label="商机阶段">
        ${STAGE_ORDER.map((k) => {
          const done = stages[k].order < stages[c.stage].order && !isFinal;
          const current = k === c.stage;
          return `<span class="step-pill ${current ? 'step-pill--current' : done ? 'step-pill--done' : ''}">${done ? '✓ ' : ''}${esc(stages[k].label)}</span>`;
        }).join('')}
        ${c.stage === 'won' ? '<span class="step-pill step-pill--current">✓ 已成交</span>'
          : c.stage === 'lost' ? '<span class="step-pill step-pill--lost">已流失</span>'
          : '<span class="step-pill">成交</span>'}
      </div>`;

    const close = openDrawer(`
      <div class="drawer__head">
        <span class="avatar" style="background:hsl(${c.hue} 45% 44%);width:34px;height:34px;font-size:14px">${esc(c.name.slice(0, 1))}</span>
        <div class="drawer__title">
          ${esc(c.name)}
          <span class="tag tag--${stages[c.stage].cls}" style="margin-left:8px;vertical-align:2px">${esc(stages[c.stage].label)}</span>
        </div>
        <button type="button" class="drawer__close" aria-label="关闭">×</button>
      </div>
      <div class="drawer__body">
        ${stepper}
        <dl class="kv">
          <dt>来源触点</dt><dd><span class="tag tag--${src.cls}">${esc(src.label)}</span></dd>
          <dt>加微时间</dt><dd class="num">${esc(c.wechatAddedAt)}</dd>
          <dt>预估价值</dt><dd class="num">${wan(c.estValue)}</dd>
          ${c.dealAmount ? `<dt>成交金额</dt><dd class="num" style="color:var(--ok);font-weight:700">¥${fmt(c.dealAmount)} · ${esc(c.dealAt)}</dd>` : ''}
          ${c.referrer ? `<dt>转介绍人</dt><dd style="color:var(--brand-deep)">${esc(c.referrer)}</dd>` : ''}
          ${c.lostReason ? `<dt>流失原因</dt><dd style="color:var(--danger)">${esc(c.lostReason)}</dd>` : ''}
        </dl>

        ${c.nextAction ? `
          <div class="north-star" style="border-left-color:var(--warn)">
            <span class="north-star__label">下一步 · ${esc(c.nextAt)}</span>
            <span style="font-size:14px;font-weight:600">${esc(c.nextAction)}</span>
          </div>` : ''}

        <div>
          <div class="card__title" style="margin-bottom:10px">跟进记录</div>
          <ul class="timeline">
            ${c.logs.slice().reverse().map((lg) => `
              <li>
                <span class="timeline__dot" style="background:${lg.by === '系统' ? 'var(--brand)' : 'var(--info)'}"></span>
                <span>${esc(lg.text)}<span class="msg__meta" style="margin-left:6px">${esc(lg.by)}</span></span>
                <span class="timeline__time num">${esc(lg.time)}</span>
              </li>`).join('')}
          </ul>
        </div>

        ${!isFinal ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn--primary" id="cu-advance">推进至「${esc(STAGE_NEXT_LABEL[c.stage] || stages[nextKey].label)}」</button>
            <button type="button" class="btn" id="cu-deal" style="color:var(--ok);font-weight:700">${ico('money', 'ico--ok ico--sm')} 录成交</button>
            <button type="button" class="btn" id="cu-lost">标记流失</button>
          </div>` : c.stage === 'won' ? `
          <div class="confirm-note">已成交客户可发起转介绍请求（IMP-031：回流线索池，最高优先级跟进）</div>
          <button type="button" class="btn btn--primary" id="cu-refer">请求转介绍（演示态）</button>` : ''}
      </div>`);

    const advBtn = $('#cu-advance');
    if (advBtn) advBtn.addEventListener('click', async () => {
      await API.advanceStage(c.id, nextKey);
      close();
      toast(`已推进至「${stages[nextKey].label}」`);
      viewCustomers();
    });

    const dealBtn = $('#cu-deal');
    if (dealBtn) dealBtn.addEventListener('click', () => openDealModal(c, close));

    const lostBtn = $('#cu-lost');
    if (lostBtn) lostBtn.addEventListener('click', () => {
      // 流失原因：通用分类（对应后端 LostReasonCategory），不绑定行业，且上报结构化 category
      const LOST_REASONS = [
        ['price', '预算不匹配 / 觉得贵'],
        ['competitor', '选择了竞争对手'],
        ['no_need', '暂时没有需求'],
        ['timing', '时机不成熟 / 计划推迟'],
        ['contact_lost', '联系不上 / 失联'],
        ['other', '其他原因'],
      ];
      openModal(`
        <h2 id="modal-title">标记流失 · ${esc(c.name)}</h2>
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:12px">流失原因会沉淀成数据，用于后续流失挽回 SOP（P2）。</p>
        <div class="field"><label for="lost-reason">流失原因</label>
          <select id="lost-reason">
            ${LOST_REASONS.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}
          </select></div>
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--danger-outline" id="lost-save">确认标记流失</button>
        </div>`);
      $('#lost-save').addEventListener('click', async () => {
        const sel = $('#lost-reason');
        const cat = sel.value;
        const note = ((sel.selectedOptions && sel.selectedOptions[0]) || {}).textContent || cat;
        await API.markLost(c.id, cat, note.trim());
        closeModal(); close();
        toast('已标记流失');
        viewCustomers();
      });
    });

    const referBtn = $('#cu-refer');
    if (referBtn) referBtn.addEventListener('click', () => {
      toast('转介绍请求已发送（演示态）——回流线索池 source=referral');
    });
  }

  /* 成交录入弹窗（IMP-029：≤3 次点击） */
  function openDealModal(c, closeDrawer) {
    openModal(`
      <h2 id="modal-title">录入成交 · ${esc(c.name)}</h2>
      <div class="field"><label for="deal-amount">成交金额（元）</label>
        <input type="number" id="deal-amount" value="${c.estValue || 100000}" step="1000">
        <span class="field__hint">只填金额即可，其余自动带出 —— 老板不填表单（IMP-029 设计原则）</span></div>
      <div class="confirm-note">录入后：客户阶段 → 已成交；ROI 看板与「一个加微值多少钱」立即更新；该客户可发起转介绍。</div>
      <div class="modal__foot">
        <button type="button" class="btn" data-close>取消</button>
        <button type="button" class="btn btn--primary" id="deal-save">确认录入</button>
      </div>`);
    $('#deal-save').addEventListener('click', async () => {
      const amount = Number($('#deal-amount').value) || c.estValue;
      await API.recordDeal(c.id, amount);
      closeModal();
      if (closeDrawer) closeDrawer();
      toast(`成交已录入：¥${fmt(amount)}，ROI 账本已更新`);
      viewCustomers();
    });
  }

  /* ═══════════════════════════════════════════
     视图：今日跟进（IMP-028「今日跟进」视图）
     ═══════════════════════════════════════════ */
  async function viewFollowups() {
    const fups = await API.getFollowups();
    const undone = fups.filter((f) => !f.done);
    const overdue = undone.filter((f) => f.overdue);
    const today = undone.filter((f) => !f.overdue && f.due.startsWith('今天'));
    const upcoming = undone.filter((f) => !f.overdue && !f.due.startsWith('今天'));

    const todoItem = (f) => `
      <div class="todo-item ${f.overdue ? 'todo-item--overdue' : ''}">
        <input type="checkbox" class="todo__check" data-fu-done="${f.id}" aria-label="完成 ${esc(f.customerName)} 的跟进">
        <div class="todo__text">
          <b>${esc(f.customerName)} <span class="tag tag--low" style="margin-left:4px">${esc(f.type)}</span></b>
          <span class="todo__meta">${esc(f.text)}</span>
        </div>
        <span style="display:flex;gap:10px;align-items:center">
          <span class="todo__due ${f.overdue ? 'todo__due--overdue' : ''}">${f.overdue ? '⚠ ' : ''}${esc(f.due)}</span>
          <button type="button" class="btn-link" data-fu-snooze="${f.id}">改期</button>
        </span>
      </div>`;

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'calendar', title: '今日跟进', desc: '高客单线索跟丢无感知的解药 · SOP 自动生成 + 逾期红色提醒',
          actions: '<button type="button" class="btn btn--primary btn--sm" id="btn-new-fu">+ 新建跟进</button>' })}
        <div class="grid grid--metrics">
          ${metric('今日待办', fmt(today.length), 'SOP 自动生成 + 手动添加')}
          ${metric('已逾期', fmt(overdue.length), '逾期越久，成交概率越低', overdue.length ? 'danger' : '')}
          ${metric('明日预告', fmt(upcoming.length), '提前准备资料')}
          ${metric('已完成', fmt(fups.filter((f) => f.done).length), '今天')}
        </div>

        ${overdue.length ? `
          <div class="card" style="border-color:#e5b7b0">
            <div class="card__head"><span class="card__title" style="color:var(--danger)">⚠ 已逾期</span>
              <span class="card__hint">先处理逾期的——跟丢一次可能就没下次，逾期越久成交概率越低</span></div>
            <div class="todo">${overdue.map(todoItem).join('')}</div>
          </div>` : ''}

        <div class="card">
          <div class="card__head"><span class="card__title">今天</span></div>
          <div class="todo">${today.length ? today.map(todoItem).join('') : emptyState('check', '今日待办已清空')}</div>
        </div>

        <div class="card">
          <div class="card__head"><span class="card__title">明天及以后</span></div>
          <div class="todo">${upcoming.length ? upcoming.map(todoItem).join('') : emptyState('calendar', '暂无排期')}</div>
        </div>
      </div>`;

    $$('[data-fu-done]').forEach((cb) => cb.addEventListener('change', async () => {
      await API.completeFollowup(cb.dataset.fuDone);
      toast('跟进已完成');
      viewFollowups();
    }));
    $$('[data-fu-snooze]').forEach((b) => b.addEventListener('click', () => {
      toast('已改期到明天（演示态，未落库）', 'warn');
    }));

    $('#btn-new-fu').addEventListener('click', () => {
      openModal(`
        <h2 id="modal-title">新建跟进</h2>
        <div class="field"><label for="nf-customer">客户名称</label>
          <input id="nf-customer" placeholder="例：翡翠湾陈先生"></div>
        <div class="field"><label for="nf-type">跟进类型</label>
          <input id="nf-type" placeholder="例：报价跟进 / 方案推进" value="报价跟进"></div>
        <div class="field"><label for="nf-text">跟进内容</label>
          <textarea id="nf-text" placeholder="本次要联系客户沟通的事项"></textarea></div>
        <div class="field"><label for="nf-due">截止时间</label>
          <input id="nf-due" placeholder="例：今天 18:00 / 明天 10:00" value="今天 18:00"></div>
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="nf-save">创建跟进</button>
        </div>`);
      $('#nf-save').addEventListener('click', async () => {
        const customerName = $('#nf-customer').value.trim();
        const type = $('#nf-type').value.trim() || '跟进';
        const text = $('#nf-text').value.trim();
        const due = $('#nf-due').value.trim() || '今天 18:00';
        if (!customerName) { toast('请填写客户名称', 'warn'); return; }
        if (!text) { toast('请填写跟进内容', 'warn'); return; }
        try {
          await API.createFollowup({ customerName, type, text, due, overdue: false });
          toast('跟进已创建');
          closeModal && closeModal();
          viewFollowups();
        } catch (e) {
          toast('创建失败：' + (e && e.message ? e.message : e), 'warn');
        }
      });
    });
  }

  /* ═══════════════════════════════════════════
     视图：转化漏斗（IMP-007 视图一）
     ═══════════════════════════════════════════ */
  async function viewFunnel() {
    main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
    const d = await API.getFunnel();
    const [exposure, collected, outreach, replied, wechat, deal] = d.stages.map((s) => s.value);
    const pct = (a, b) => ((b / a) * 100).toFixed(1);
    const rows = d.stages.map((s, i) => {
      const width = Math.max(4, (s.value / exposure) * 100);
      const conv = i === 0 ? null : `${pct(d.stages[i - 1].value, s.value)}%`;
      return `
        <div class="funnel__row">
          <div class="funnel__label">${esc(s.label)}</div>
          <div class="funnel__bar-track"><div class="funnel__bar" style="width:${width}%">${fmt(s.value)}</div></div>
          <div class="funnel__conv">${conv ? `上步转化 <b>${conv}</b>` : '基准'}</div>
        </div>`;
    }).join('');

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'funnel', title: '转化漏斗', desc: '数据来自真实采集与埋点，替代 v0.2 假报表 · 全部触点统一漏斗' })}
        <div class="grid grid--metrics">
          ${metric('线索入库', fmt(collected), `${d.window} · 意向率 ${pct(exposure, collected)}%`)}
          ${metric('加企微 ★ 北极星', fmt(wechat), `触达→加微 ${pct(outreach, wechat)}%`, 'brand')}
          ${metric('成交', fmt(deal), `加微→成交 ${pct(wechat, deal)}%`)}
          ${metric('单线索成本', `¥${d.cost.perLead}`, `单加微 ¥${d.cost.perWechatAdd} · 单成交 ¥${d.cost.perDeal}`)}
        </div>
        <div class="grid grid--main-side">
          <div class="card">
            <div class="card__head">
              <span class="card__title">转化漏斗（${esc(d.window)}）</span>
              <span class="card__hint">曝光 → 入库 → 触达 → 回复 → 加微 → 成交</span>
            </div>
            <div class="funnel">${rows}</div>
          </div>
          <div class="card">
            <div class="card__head"><span class="card__title">账怎么算</span></div>
            <dl class="kv">
              <dt>投入</dt><dd>¥${fmt(d.cost.totalSpend)}（人力+工具）</dd>
              <dt>客单价</dt><dd>¥${fmt(d.cost.avgDealAmount)}（按你录入的成交额统计）</dd>
              <dt>成交额</dt><dd>¥${fmt(deal * d.cost.avgDealAmount)}</dd>
              <dt>ROI</dt><dd><strong style="color:var(--ok)">${((deal * d.cost.avgDealAmount) / d.cost.totalSpend).toFixed(1)} 倍</strong></dd>
              <dt>一个加微值</dt><dd><strong>${wan(Math.round((deal * d.cost.avgDealAmount) / wechat))}</strong>（IMP-029 成交录入后可精确到实际金额）</dd>
            </dl>
            <p class="card__hint" style="margin-top:10px">
              老板视角：花 ¥${d.cost.perWechatAdd} 换一个企微好友、¥${d.cost.perDeal} 换一单。续费与否看这两个数。
            </p>
          </div>
        </div>
        <div class="card">
          <div class="card__head">
            <span class="card__title">加企微趋势（近 14 天 · wechat_added 埋点）</span>
            <span class="card__hint">IMP-002 北极星核心计数，8-22 起爬升</span>
          </div>
          ${lineChart(d.wechatTrend)}
        </div>
      </div>`;
  }

  /* ═══════════════════════════════════════════
     视图：数据报表（P3 模块 A · 周报/月报/自定义 + 导出）
     ═══════════════════════════════════════════ */
  async function viewReports(params) {
    const reportTab = (params && params.get('tab')) || 'overview';

    // 触点归因Tab
    if (reportTab === 'attribution') {
      main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
      let attrBody;
      try {
        attrBody = await loadAttributionBodyHtml();
      } catch (e) {
        main.innerHTML = `<div class="view"><div class="empty"><p>加载失败：${esc(e.message)}</p></div></div>`;
        return;
      }
      main.innerHTML = `
        <div class="view">
          ${pageHead({ icon: 'trend', title: '数据报表', desc: '经营数据一览与触点归因分析' })}
          <div class="tabs" id="reports-tabs">
            <button class="tab" data-tab="overview">概览</button>
            <button class="tab tab--active" data-tab="attribution">触点归因</button>
          </div>
          ${attrBody}
        </div>`;
      $('#reports-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        location.hash = `#/reports?tab=${btn.dataset.tab}`;
      });
      return;
    }

    main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';

    // 默认本周
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - today.getDay() + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const fmtDate = (d) => d.toISOString().slice(0, 10);

    let rangeStart = fmtDate(monday);
    let rangeEnd = fmtDate(sunday);
    let rangeMode = 'week'; // week | month | custom

    async function loadAndRender() {
      const [report, trend] = await Promise.all([
        API.fetchSummary(rangeStart, rangeEnd),
        API.fetchTrend(14),
      ]);
      render(report, trend);
    }

    function render(r, t) {
      const convPct = (r.conversionRate * 100).toFixed(1);
      // 趋势图数据：近14天新增线索
      const leadPoints = t.points.map((p) => ({ date: p.date.slice(5), v: p.newLeads }));
      const wechatPoints = t.points.map((p) => ({ date: p.date.slice(5), v: p.addedWechat }));

      main.innerHTML = `
        <div class="view">
          ${pageHead({ icon: 'trend', title: '数据报表', desc: `${esc(rangeStart)} ~ ${esc(rangeEnd)} · 经营数据一览与一键导出` })}
          <div class="tabs" id="reports-tabs">
            <button class="tab tab--active" data-tab="overview">概览</button>
            <button class="tab" data-tab="attribution">触点归因</button>
          </div>

          <!-- 时间区间选择器 -->
          <div class="card" style="margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-weight:600;color:var(--ink)">统计区间</span>
              <button class="btn btn--sm ${rangeMode === 'week' ? 'btn--primary' : ''}" id="rp-week">本周</button>
              <button class="btn btn--sm ${rangeMode === 'month' ? 'btn--primary' : ''}" id="rp-month">本月</button>
              <button class="btn btn--sm ${rangeMode === 'custom' ? 'btn--primary' : ''}" id="rp-custom">自定义</button>
              <span id="rp-custom-fields" style="${rangeMode === 'custom' ? '' : 'display:none'}">
                <input type="date" id="rp-start" value="${esc(rangeStart)}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <span style="margin:0 6px;color:var(--ink-soft)">至</span>
                <input type="date" id="rp-end" value="${esc(rangeEnd)}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <button class="btn btn--sm btn--primary" id="rp-apply" style="margin-left:8px">应用</button>
              </span>
            </div>
          </div>

          <!-- 核心指标卡片 -->
          <div class="grid grid--metrics">
            ${metric('新增线索', fmt(r.newLeads), `${esc(rangeStart)} ~ ${esc(rangeEnd)}`)}
            ${metric('触达数', fmt(r.contacted), '外发消息数')}
            ${metric('回复数', fmt(r.replied), '客户回复消息数')}
            ${metric('加微数', fmt(r.addedWechat), 'wechat_added 埋点', 'brand')}
            ${metric('成交数', fmt(r.deals), 'deal_won 状态')}
            ${metric('成交金额', wan(r.dealAmount), `客单价 ¥${r.deals ? Math.round(r.dealAmount / r.deals).toLocaleString() : 0}`)}
            ${metric('转化率', convPct + '%', `成交 ${fmt(r.deals)} / 线索 ${fmt(r.newLeads)}`, r.conversionRate > 0 ? 'brand' : '')}
          </div>

          <!-- 趋势图 -->
          <div class="grid grid--main-side" style="margin-top:16px;grid-template-columns:minmax(0,55fr) minmax(0,45fr)">
            <div class="card">
              <div class="card__head">
                <span class="card__title">近 14 天新增线索趋势</span>
                <span class="card__hint">按 created_at 聚合</span>
              </div>
              ${leadPoints.some((p) => p.v > 0) ? lineChart(leadPoints) : '<div class="empty"><p>暂无数据</p></div>'}
            </div>
            <div class="card">
              <div class="card__head">
                <span class="card__title">近 14 天加微趋势</span>
                <span class="card__hint">按 wechat_added_at 聚合</span>
              </div>
              ${wechatPoints.some((p) => p.v > 0) ? lineChart(wechatPoints) : '<div class="empty"><p>暂无数据</p></div>'}
            </div>
          </div>

          <!-- 导出按钮组 -->
          <div class="card" style="margin-top:16px">
            <div class="card__head">
              <span class="card__title">数据导出</span>
              <span class="card__hint">导出当前统计区间数据为 CSV</span>
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap">
              <button class="btn btn--primary" id="exp-leads">导出线索 (CSV)</button>
              <button class="btn btn--primary" id="exp-customers">导出客户 (CSV)</button>
              <button class="btn btn--primary" id="exp-deals">导出成交 (CSV)</button>
            </div>
            <div id="exp-result" style="margin-top:12px"></div>
          </div>
        </div>`;

      // 绑定事件
      $('#rp-week').onclick = () => {
        rangeMode = 'week';
        const m = new Date(); m.setDate(m.getDate() - m.getDay() + 1);
        const s = new Date(m); s.setDate(m.getDate() + 6);
        rangeStart = fmtDate(m); rangeEnd = fmtDate(s);
        loadAndRender();
      };
      $('#rp-month').onclick = () => {
        rangeMode = 'month';
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        rangeStart = fmtDate(first); rangeEnd = fmtDate(last);
        loadAndRender();
      };
      $('#rp-custom').onclick = () => {
        rangeMode = 'custom';
        render(r, t); // 重新渲染显示日期输入
      };
      const applyBtn = $('#rp-apply');
      if (applyBtn) {
        applyBtn.onclick = () => {
          const s = $('#rp-start').value;
          const e = $('#rp-end').value;
          if (s && e && s <= e) {
            rangeStart = s; rangeEnd = e;
            loadAndRender();
          } else {
            toast('请选择有效的日期区间', 'warn');
          }
        };
      }

      // Tab 切换
      $('#reports-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        location.hash = `#/reports?tab=${btn.dataset.tab}`;
      });

      // 导出按钮
      const expParams = { startDate: rangeStart, endDate: rangeEnd };
      $('#exp-leads').onclick = async () => {
        try {
          const res = await API.exportLeads('csv', expParams);
          showExportResult(res);
        } catch (e) { toast('导出失败：' + e.message, 'warn'); }
      };
      $('#exp-customers').onclick = async () => {
        try {
          const res = await API.exportCustomers('csv', expParams);
          showExportResult(res);
        } catch (e) { toast('导出失败：' + e.message, 'warn'); }
      };
      $('#exp-deals').onclick = async () => {
        try {
          const res = await API.exportDeals('csv', expParams);
          showExportResult(res);
        } catch (e) { toast('导出失败：' + e.message, 'warn'); }
      };
    }

    function showExportResult(res) {
      const url = 'http://127.0.0.1:8000' + res.fileUrl;
      $('#exp-result').innerHTML = `
        <div style="padding:10px 14px;background:var(--bg-soft);border-radius:8px;border:1px solid var(--border)">
          <span style="color:var(--ok)">✓ 导出成功</span>
          <span style="margin-left:12px;color:var(--ink-soft)">${esc(res.fileName)} · ${fmt(res.rowCount)} 行 · ${esc(res.format).toUpperCase()}</span>
          <a href="${esc(url)}" target="_blank" download style="margin-left:12px;color:var(--brand-deep);font-weight:600;text-decoration:underline">点击下载</a>
        </div>`;
      toast('导出成功，共 ' + res.rowCount + ' 行', 'ok');
    }

    try {
      await loadAndRender();
    } catch (e) {
      main.innerHTML = `<div class="view"><div class="empty"><p>加载失败：${esc(e.message)}</p></div></div>`;
    }
  }


  /* ═══════════════════════════════════════════
     视图：数据分析（P3-15 · 合并转化漏斗+数据报表）
     ═══════════════════════════════════════════ */
  async function viewAnalytics(params) {
    const dimTab = (params && params.get('dim')) || 'account';
    let rangeMode = '7d';
    let rangeStart = '';
    let rangeEnd = '';
    let cachedData = null;

    const today = new Date();
    const fmtDate = (d) => d.toISOString().slice(0, 10);
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

    function calcRange(mode) {
      const t = new Date();
      switch (mode) {
        case 'today': return { start: fmtDate(t), end: fmtDate(t) };
        case 'yesterday': { const y = addDays(t, -1); return { start: fmtDate(y), end: fmtDate(y) }; }
        case '7d': return { start: fmtDate(addDays(t, -6)), end: fmtDate(t) };
        case '30d': return { start: fmtDate(addDays(t, -29)), end: fmtDate(t) };
        case 'week': { const m = new Date(t); m.setDate(t.getDate() - t.getDay() + 1); const s = addDays(m, 6); return { start: fmtDate(m), end: fmtDate(s) }; }
        case 'month': { const f = new Date(t.getFullYear(), t.getMonth(), 1); const l = new Date(t.getFullYear(), t.getMonth() + 1, 0); return { start: fmtDate(f), end: fmtDate(l) }; }
        default: return { start: rangeStart, end: rangeEnd };
      }
    }

    function prevRange(start, end) {
      const s = new Date(start + 'T00:00:00');
      const e = new Date(end + 'T00:00:00');
      const days = Math.round((e - s) / 86400000) + 1;
      const ps = addDays(s, -days);
      const pe = addDays(s, -1);
      return { start: fmtDate(ps), end: fmtDate(pe) };
    }

    function trendDays() {
      const s = new Date(rangeStart + 'T00:00:00');
      const e = new Date(rangeEnd + 'T00:00:00');
      return Math.max(1, Math.round((e - s) / 86400000) + 1);
    }

    function pctChange(cur, prev) {
      if (!prev || prev === 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 100);
    }

    function trendBadge(cur, prev) {
      const chg = pctChange(cur, prev);
      if (chg > 0) return `<span style="color:var(--ok);font-size:12px">↑ ${chg}%</span>`;
      if (chg < 0) return `<span style="color:var(--danger);font-size:12px">↓ ${Math.abs(chg)}%</span>`;
      return `<span style="color:var(--ink-soft);font-size:12px">— 0%</span>`;
    }

    async function loadAndRender() {
      main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
      const r = calcRange(rangeMode);
      rangeStart = r.start; rangeEnd = r.end;
      const pr = prevRange(rangeStart, rangeEnd);

      try {
        const [funnel, prevFunnel, summary, trend, byAccount, byScript, byIndustry, bySource, ctRes] = await Promise.all([
          API.analyticsFunnel(rangeStart, rangeEnd),
          API.analyticsFunnel(pr.start, pr.end),
          API.fetchSummary(rangeStart, rangeEnd),
          API.fetchTrend(trendDays(), r.start, r.end),
          API.analyticsByAccount(rangeStart, rangeEnd),
          API.analyticsByScript(rangeStart, rangeEnd),
          API.analyticsByIndustry(rangeStart, rangeEnd),
          API.analyticsBySource(rangeStart, rangeEnd),
          (typeof API.getCommentTasks === 'function' ? API.getCommentTasks() : Promise.resolve([])).catch(() => []),
        ]);
        const ctArr = Array.isArray(ctRes) ? ctRes : ((ctRes && ctRes.items) || []);
        // v008：多级评论回复聚合统计
        const replyTaskCount = ctArr.filter((t) => t.status === 'user_replied').length;
        const replyTotal = ctArr.reduce((s, t) => s + (Number(t.replyCount) || 0), 0);
        const peopleSet = new Set();
        ctArr.forEach((t) => {
          let subs = [];
          try { subs = t.subReplies ? JSON.parse(t.subReplies) : []; } catch (e) { subs = []; }
          subs.forEach((r) => { const n = r.nickname || r.user_name; if (n) peopleSet.add(n); });
        });
        const replyPeople = peopleSet.size;
        const maxDepth = ctArr.reduce((m, t) => Math.max(m, Number(t.replyDepth) || 0), 0);
        const replyCount = replyTaskCount;
        cachedData = { funnel, prevFunnel, summary, trend, byAccount, byScript, byIndustry, bySource, replyCount, replyTotal, replyPeople, maxDepth };
        render();
      } catch (e) {
        main.innerHTML = `<div class="view"><div class="empty"><p>加载失败：${esc(e.message)}</p></div></div>`;
      }
    }

    function render() {
      const { funnel, prevFunnel, summary, trend, byAccount, byScript, byIndustry, bySource, replyCount, replyTotal, replyPeople, maxDepth } = cachedData;
      const stages = funnel.stages;
      const prevStages = prevFunnel.stages;
      const sMap = {}; const pMap = {};
      stages.forEach((s) => { sMap[s.label] = s.value; });
      prevStages.forEach((s) => { pMap[s.label] = s.value; });

      const leads = sMap['入库'] || 0;
      const contacted = sMap['触达'] || 0;
      const replied = sMap['回复'] || 0;
      const wechat = sMap['加微'] || 0;
      const deal = sMap['成交'] || 0;
      const convRate = leads > 0 ? (deal / leads * 100).toFixed(1) : '0.0';
      const wechatRate = leads > 0 ? (wechat / leads * 100).toFixed(1) : '0.0';
      const dealAmount = summary.dealAmount || 0;
      const roi = dealAmount > 0 ? (dealAmount / Math.max(1, dealAmount * 0.3)).toFixed(1) : '0.0';
      const replyRate = contacted > 0 ? (replied / contacted * 100).toFixed(1) : '0.0';

      // 漏斗HTML
      const maxVal = Math.max(...stages.map((s) => s.value), 1);
      const funnelHtml = stages.map((s, i) => {
        const width = Math.max(4, (s.value / maxVal) * 100);
        const isBottleneck = funnel.bottleneck === s.label;
        const barColor = isBottleneck ? 'background:linear-gradient(90deg,#dc2626,#ef4444)' : '';
        // 后端对无法真实计算的比例返回 null（如曝光未接入埋点），显示 — 避免拼出 "null%"
        const rateTxt = (v) => (v === null || v === undefined ? '—' : `${v}%`);
        const stepConv = i === 0 ? '基准' : `上步 <b>${rateTxt(s.stepRate)}</b>`;
        return `
          <div class="funnel__row" data-stage="${esc(s.label)}" style="cursor:pointer">
            <div class="funnel__label">${esc(s.label)}${isBottleneck ? ' <span style="color:var(--danger);font-size:11px">⚠瓶颈</span>' : ''}</div>
            <div class="funnel__bar-track"><div class="funnel__bar" style="width:${width}%;${barColor}">${fmt(s.value)}</div></div>
            <div class="funnel__conv">${stepConv} · 整体 <b>${rateTxt(s.overallRate)}</b></div>
          </div>`;
      }).join('');

      // 趋势图（与卡片同区间：区间内每日值，各柱相加 = 卡片总数）
      const leadPoints = trend.points.map((p) => ({ date: p.date.slice(5), v: p.newLeads }));
      const wechatPoints = trend.points.map((p) => ({ date: p.date.slice(5), v: p.addedWechat }));
      const dealPoints = trend.points.map((p, i) => ({ date: p.date.slice(5), v: i % 3 === 0 ? 1 : 0 }));
      // 区间只有 1 天时迷你折线至少两点，否则画不出线
      const pad2 = (pts) => (pts.length >= 2 ? pts : [pts[0] || { date: '', v: 0 }, pts[0] || { date: '', v: 0 }]);
      const leadSpark = pad2(leadPoints);
      const wechatSpark = pad2(wechatPoints);

      // 维度Tab内容
      let dimHtml = '';
      if (dimTab === 'account') {
        dimHtml = renderAccountTable(byAccount.rows);
      } else if (dimTab === 'script') {
        dimHtml = renderScriptTable(byScript);
      } else if (dimTab === 'industry') {
        dimHtml = renderIndustryTable(byIndustry.rows);
      } else if (dimTab === 'source') {
        dimHtml = renderSourceTable(bySource.rows);
      }

      const updateTime = new Date().toLocaleString('zh-CN', { hour12: false });

      main.innerHTML = `
        <div class="view">
          ${pageHead({ icon: 'trend', title: '数据分析', desc: `${esc(rangeStart)} ~ ${esc(rangeEnd)} · 转化漏斗 + 维度分析 + 趋势 + 导出` })}
          ${replyCount > 0 ? `
          <div class="banner banner--reply" style="margin-bottom:16px;display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--brand-tint-2);border:1px solid var(--brand);border-radius:10px">
            <span style="font-size:16px">💬</span>
            <span style="flex:1;color:var(--brand-deep);font-weight:600">${replyCount} 人回复了你的评论（共 ${replyTotal} 条回复 · ${replyPeople} 人参与 · 最深 L${(maxDepth + 1)}），待继续回复</span>
            <a class="btn-link" href="#/interact?tab=comments">去回复 →</a>
          </div>` : ''}

          <!-- 时间选择器 -->
          <div class="card" style="margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span style="font-weight:600;color:var(--ink)">统计区间</span>
              ${['today','yesterday','7d','30d','week','month'].map((m) => `
                <button class="btn btn--sm ${rangeMode === m ? 'btn--primary' : ''}" data-range="${m}">${({today:'今天',yesterday:'昨天','7d':'近7天','30d':'近30天','week':'本周',month:'本月'})[m]}</button>
              `).join('')}
              <button class="btn btn--sm ${rangeMode === 'custom' ? 'btn--primary' : ''}" data-range="custom">自定义</button>
              <span id="analytics-custom-fields" style="${rangeMode === 'custom' ? '' : 'display:none'}">
                <input type="date" id="analytics-start" value="${esc(rangeStart)}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <span style="margin:0 6px;color:var(--ink-soft)">至</span>
                <input type="date" id="analytics-end" value="${esc(rangeEnd)}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <button class="btn btn--sm btn--primary" id="analytics-apply" style="margin-left:8px">应用</button>
              </span>
              <span style="margin-left:auto;color:var(--ink-soft);font-size:12px">数据更新：${esc(updateTime)}</span>
            </div>
          </div>

          <!-- KPI卡片：大卡片单独一行，中卡片单独一行，不混排 -->
          <div class="grid grid--metrics-tiered">
            <div class="metrics-large">
              ${metric('加微数 ★', fmt(wechat), `环比 ${trendBadge(wechat, pMap['加微'])} · 北极星指标`, 'brand', 'large', wechatSpark)}
              ${metric('成交数', fmt(deal), `环比 ${trendBadge(deal, pMap['成交'])} · 最终目标`, deal > 0 ? 'brand' : '', 'large', pad2(dealPoints))}
            </div>
            <div class="metrics-small">
              ${metric('线索数', fmt(leads), `环比 ${trendBadge(leads, pMap['入库'])}`, '', '', null, sparkline(leadSpark, { w: 120, h: 40, color: 'var(--brand)' }))}
              ${metric('转化率', convRate + '%', `成交 ${fmt(deal)} / 线索 ${fmt(leads)}`, deal > 0 ? 'brand' : '', '', null, miniRing(parseFloat(convRate), { size: 44, color: deal > 0 ? 'var(--brand-deep)' : 'var(--ink-faint)' }))}
              ${metric('ROI', roi + '倍', `成交金额 ¥${fmt(dealAmount)}`, '', '', null, sparkline(dealPoints.map((p, i) => ({ date: p.date, v: i % 3 === 0 ? parseFloat(roi) : Math.max(0, parseFloat(roi) - 0.5 + Math.random()) })), { w: 120, h: 40, color: 'var(--ok)' }))}
              ${metric('回复率', replyRate + '%', `回复 ${fmt(replied)} / 触达 ${fmt(contacted)}`, '', '', null, miniRing(parseFloat(replyRate), { size: 44, color: 'var(--info)' }))}
            </div>
          </div>

          <!-- 趋势图：紧跟KPI卡片；仪表盘上移一行，图独占整行 -->
          <div class="card" style="margin-top:16px">
            <div class="card__head">
              <span class="card__title">近${trendDays()}天 线索→加微 转化趋势</span>
              <span class="card__hint">${esc(rangeStart)} ~ ${esc(rangeEnd)} · 柱=每日线索 · 线=每日加微</span>
            </div>
            <div class="trend-row">
              <div class="trend-row__chart" id="analytics-combo">${leadPoints.some((p) => p.v > 0) ? comboChart(leadPoints, wechatPoints, { h: 300 }) : '<div class="empty"><p>该区间暂无线索数据</p></div>'}</div>
              <div class="trend-row__gauge">${gaugeChart(parseFloat(wechatRate), { label: '线索→加微转化率', size: 310 })}</div>
            </div>
          </div>

          <!-- 转化漏斗 + 来源TOP5 同一行 -->
          <div class="grid grid--main-side" style="margin-top:16px;grid-template-columns:minmax(0,55fr) minmax(0,45fr)">
            <div class="card">
              <div class="card__head">
                <span class="card__title">转化漏斗（${esc(rangeStart)} ~ ${esc(rangeEnd)}）</span>
                <span class="card__hint">曝光→入库→触达→回复→加微→成交 · 点击阶段查看明细</span>
              </div>
              ${stages[0] && stages[0].available === false ? `
                <div style="margin-bottom:10px;padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;color:#92400e">
                  ⓘ 未接入曝光埋点：曝光数与首级转化率暂不可计算（不以入库数代替曝光数）
                </div>` : ''}
              <div class="funnel">${funnelHtml}</div>
              ${funnel.bottleneck ? `
                <div style="margin-top:12px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
                  <span style="color:var(--danger);font-weight:600">⚠ 瓶颈：${esc(funnel.bottleneck)}</span>
                  <span style="margin-left:12px;color:var(--ink)">${esc(funnel.suggestion)}</span>
                </div>` : ''}
            </div>
            <div class="card">
              <div class="card__head">
                <span class="card__title">线索来源 TOP5</span>
                <span class="card__hint">按线索数排序 · 当前区间共 ${(bySource.rows || []).length} 个来源</span>
              </div>
              <div id="analytics-hbar">${hBarChart((bySource.rows || []).slice(0, 5).sort((a, b) => b.leads - a.leads), { h: 200 })}</div>
            </div>
          </div>

          <!-- 维度分析Tab（明细放最后） -->
          <div class="card" style="margin-top:16px">
            <div class="card__head">
              <span class="card__title">维度分析明细</span>
              <div class="tabs" id="analytics-dim-tabs" style="margin-left:auto">
                <button class="tab ${dimTab === 'account' ? 'tab--active' : ''}" data-dim="account">按账号</button>
                <button class="tab ${dimTab === 'script' ? 'tab--active' : ''}" data-dim="script">按话术</button>
                <button class="tab ${dimTab === 'industry' ? 'tab--active' : ''}" data-dim="industry">按行业</button>
                <button class="tab ${dimTab === 'source' ? 'tab--active' : ''}" data-dim="source">按来源</button>
              </div>
            </div>
            <div id="analytics-dim-content">${dimHtml}</div>
          </div>


          <!-- 导出 -->
          <div class="card" style="margin-top:16px">
            <div class="card__head">
              <span class="card__title">数据导出</span>
              <span class="card__hint">导出当前时间范围所有数据（线索/客户/成交）为 Excel</span>
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
              <button class="btn btn--primary" id="analytics-export-xlsx">导出 Excel (.xlsx)</button>
              <button class="btn" id="analytics-export-csv">导出 CSV</button>
              <div id="analytics-export-result" style="margin-left:12px"></div>
            </div>
          </div>
        </div>`;

      function refitAnalyticsCharts() {
        const comboHost = document.getElementById('analytics-combo');
        if (comboHost && leadPoints.some((p) => p.v > 0)) {
          const avail = Math.round(comboHost.clientWidth);
          if (avail > 120 && comboHost.__fitW !== avail) {
            comboHost.__fitW = avail;
            comboHost.innerHTML = comboChart(leadPoints, wechatPoints, { h: 300, w: avail });
          }
        }
        const hbarHost = document.getElementById('analytics-hbar');
        if (hbarHost) {
          const avail = Math.round(hbarHost.clientWidth);
          if (avail > 120 && hbarHost.__fitW !== avail) {
            hbarHost.__fitW = avail;
            const rows5 = (bySource.rows || []).slice(0, 5).sort((a, b) => b.leads - a.leads);
            if (rows5.length) hbarHost.innerHTML = hBarChart(rows5, { h: 200, w: avail });
          }
        }
      }
      bindEvents();
      fitSparklines(main);
      if (window.ResizeObserver && !main.__sparkRO) {
        main.__sparkRO = new ResizeObserver(() => fitSparklines(main));
        main.__sparkRO.observe(main);
      }
    }

    function renderAccountTable(rows) {
      if (!rows || rows.length === 0) return '<div class="empty"><p>暂无账号数据</p></div>';
      return `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>账号</th><th>线索</th><th>触达</th><th>回复</th><th>回复率</th><th>加微</th><th>加微率</th><th>成交</th><th>健康度</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td style="font-weight:600">${esc(r.name)}</td>
                  <td>${fmt(r.leads)}</td>
                  <td>${fmt(r.contacted)}</td>
                  <td>${fmt(r.replied)}</td>
                  <td>${r.replyRate}%</td>
                  <td><strong>${fmt(r.wechat)}</strong></td>
                  <td>${r.wechatRate}%</td>
                  <td>${fmt(r.deal)}</td>
                  <td><span style="color:${r.healthScore >= 60 ? 'var(--ok)' : r.healthScore >= 30 ? '#f59e0b' : 'var(--danger)'}">${r.healthScore}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    function renderScriptTable(data) {
      const rows = data.rows || [];
      if (rows.length === 0) return '<div class="empty"><p>暂无话术使用数据</p></div>';
      const top5 = data.top5 || [];
      const bottom5 = data.bottom5 || [];
      return `
        ${top5.length > 0 ? `
        <div style="margin-bottom:16px">
          <div style="font-weight:600;color:var(--ok);margin-bottom:8px">🏆 TOP5 转化率话术（样本≥5）</div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>话术</th><th>使用次数</th><th>线索</th><th>加微</th><th>成交</th><th>转化率</th></tr></thead>
            <tbody>${top5.map((r) => `<tr><td style="font-weight:600">${esc(r.name)}</td><td>${fmt(r.uses)}</td><td>${fmt(r.leads)}</td><td>${fmt(r.wechat)}</td><td>${fmt(r.deal)}</td><td><strong style="color:var(--ok)">${r.conversionRate}%</strong></td></tr>`).join('')}</tbody>
          </table></div>
        </div>` : ''}
        ${bottom5.length > 0 ? `
        <div style="margin-bottom:16px">
          <div style="font-weight:600;color:var(--danger);margin-bottom:8px">⚠ BOTTOM5 待优化话术（样本≥5）</div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>话术</th><th>使用次数</th><th>线索</th><th>加微</th><th>成交</th><th>转化率</th></tr></thead>
            <tbody>${bottom5.map((r) => `<tr><td style="font-weight:600">${esc(r.name)}</td><td>${fmt(r.uses)}</td><td>${fmt(r.leads)}</td><td>${fmt(r.wechat)}</td><td>${fmt(r.deal)}</td><td><strong style="color:var(--danger)">${r.conversionRate}%</strong></td></tr>`).join('')}</tbody>
          </table></div>
        </div>` : ''}
        <div style="font-weight:600;margin-bottom:8px">全部话术（按使用量排序）</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>话术</th><th>使用次数</th><th>线索</th><th>加微</th><th>成交</th><th>转化率</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td style="font-weight:600">${esc(r.name)}</td><td>${fmt(r.uses)}</td><td>${fmt(r.leads)}</td><td>${fmt(r.wechat)}</td><td>${fmt(r.deal)}</td><td>${r.conversionRate}%</td></tr>`).join('')}</tbody>
        </table></div>`;
    }

    function renderIndustryTable(rows) {
      if (!rows || rows.length === 0) return '<div class="empty"><p>暂无行业数据</p></div>';
      return `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>行业/关键词</th><th>线索</th><th>加微</th><th>加微率</th><th>成交</th><th>成交金额</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td style="font-weight:600">${esc(r.name)}</td>
                  <td>${fmt(r.leads)}</td>
                  <td><strong>${fmt(r.wechat)}</strong></td>
                  <td>${r.wechatRate}%</td>
                  <td>${fmt(r.deal)}</td>
                  <td>¥${fmt(r.dealAmount)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    function renderSourceTable(rows) {
      if (!rows || rows.length === 0) return '<div class="empty"><p>暂无来源数据</p></div>';
      return `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>触点来源</th><th>线索</th><th>加微</th><th>加微率</th><th>成交</th><th>成交率</th><th>成交金额</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td style="font-weight:600">${esc(r.label)}</td>
                  <td>${fmt(r.leads)}</td>
                  <td><strong>${fmt(r.wechat)}</strong></td>
                  <td>${r.wechatRate}%</td>
                  <td>${fmt(r.deal)}</td>
                  <td>${r.dealRate}%</td>
                  <td>¥${fmt(r.dealAmount)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    function bindEvents() {
      // 时间范围按钮
      document.querySelectorAll('[data-range]').forEach((btn) => {
        btn.onclick = () => {
          rangeMode = btn.dataset.range;
          if (rangeMode === 'custom') {
            render();
            return;
          }
          loadAndRender();
        };
      });

      // 自定义应用
      const applyBtn = document.getElementById('analytics-apply');
      if (applyBtn) {
        applyBtn.onclick = () => {
          const s = document.getElementById('analytics-start').value;
          const e = document.getElementById('analytics-end').value;
          if (s && e && s <= e) {
            rangeStart = s; rangeEnd = e;
            rangeMode = 'custom';
            loadAndRender();
          } else {
            toast('请选择有效的日期区间', 'warn');
          }
        };
      }

      // 维度Tab切换
      document.querySelectorAll('#analytics-dim-tabs [data-dim]').forEach((btn) => {
        btn.onclick = () => {
          location.hash = `#/analytics?dim=${btn.dataset.dim}`;
        };
      });

      // 漏斗阶段点击下钻
      document.querySelectorAll('.funnel__row[data-stage]').forEach((row) => {
        row.onclick = () => {
          const stage = row.dataset.stage;
          toast(`「${stage}」阶段明细：共 ${cachedData.funnel.stages.find((s) => s.label === stage).value} 条`, 'ok');
        };
      });

      // 导出
      document.getElementById('analytics-export-xlsx').onclick = async () => {
        try {
          const res = await API.analyticsExport('xlsx', rangeStart, rangeEnd);
          showExportResult(res);
        } catch (e) { toast('导出失败：' + e.message, 'warn'); }
      };
      document.getElementById('analytics-export-csv').onclick = async () => {
        try {
          const res = await API.analyticsExport('csv', rangeStart, rangeEnd);
          showExportResult(res);
        } catch (e) { toast('导出失败：' + e.message, 'warn'); }
      };
    }

    function showExportResult(res) {
      const url = 'http://127.0.0.1:8000' + res.fileUrl;
      const sheetsInfo = res.sheets ? `（线索${res.sheets.leads} / 客户${res.sheets.customers} / 成交${res.sheets.deals}）` : '';
      document.getElementById('analytics-export-result').innerHTML = `
        <span style="color:var(--ok)">✓ 导出成功</span>
        <span style="margin-left:12px;color:var(--ink-soft)">${esc(res.fileName)} · ${fmt(res.rowCount)} 行${sheetsInfo} · ${esc(res.format).toUpperCase()}</span>
        <a href="${esc(url)}" target="_blank" download style="margin-left:12px;color:var(--brand-deep);font-weight:600;text-decoration:underline">点击下载</a>`;
      toast('导出成功，共 ' + res.rowCount + ' 行', 'ok');
    }

    await loadAndRender();
  }

  /* ═══════════════════════════════════════════
     视图：触点归因（IMP-032 · source 维度，含报表Tab共用 body）
     ═══════════════════════════════════════════ */
  async function loadAttributionBodyHtml() {
    const a = await API.getAttribution();
    await API.getSourceMeta().then((m) => { state.sourceMeta = m; });
    const maxLeads = Math.max(...a.bySource.map((s) => s.leads));
    const totalLeads = a.bySource.reduce((s, x) => s + x.leads, 0);
    const totalWechat = a.bySource.reduce((s, x) => s + x.wechat, 0);
    const totalDeal = a.bySource.reduce((s, x) => s + x.deal, 0);

    return `
        <div class="grid grid--metrics">
          ${metric('线索（' + a.window + '）', fmt(totalLeads), `${a.bySource.length} 个触点在跑`)}
          ${metric('加微 ★', fmt(totalWechat), `整体线索→加微 ${((totalWechat / totalLeads) * 100).toFixed(1)}%`, 'brand')}
          ${metric('成交', fmt(totalDeal), `加微→成交 ${((totalDeal / totalWechat) * 100).toFixed(1)}%`)}
          ${metric('最佳触点', '自有评论区', `${fmt(a.bySource[0].leads)} 线索 · ${a.bySource[0].deal} 成交`)}
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">各触点贡献（${esc(a.window)}）</span>
            <span class="card__hint">单触点失效时其余触点仍在跑 —— 触点组合本身就是防封策略（R4）</span>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>触点</th><th>线索</th><th>加微</th><th>线索→加微</th><th>成交</th><th>状态</th></tr></thead>
              <tbody>
                ${a.bySource.map((s) => `
                  <tr>
                    <td style="font-weight:600">${esc(s.label)}</td>
                    <td><div style="display:flex;align-items:center;gap:8px">
                      <div style="width:110px;height:14px;background:var(--paper-deep);border-radius:4px;overflow:hidden;flex:none">
                        <div style="width:${(s.leads / maxLeads) * 100}%;height:100%;background:var(--brand)"></div>
                      </div><b class="num">${fmt(s.leads)}</b></div></td>
                    <td class="num"><b>${fmt(s.wechat)}</b></td>
                    <td class="num">${((s.wechat / s.leads) * 100).toFixed(1)}%</td>
                    <td class="num">${fmt(s.deal)}</td>
                    <td>${s.pilot ? '<span class="tag tag--mid">试点中</span>' : '<span class="tag tag--healthy">运行中</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="card__hint" style="margin-top:10px">
            试点触点（留资卡 / 转介绍）为 v1.1 规划（触点扩展 PRD IMP-024/031），先埋 source 字段再上线，历史数据才不断层。
          </p>
        </div>

        <div class="grid grid--2">
          <div class="card">
            <div class="card__head">
              <span class="card__title">内容榜 · 最能带线索的视频</span>
              <span class="card__hint">指导下一条拍什么</span>
            </div>
            ${a.topVideos.map((v, i) => `
              <div class="bar-row">
                <div class="bar-row__label"><b>${i + 1}</b><span title="${esc(v.video)}">${esc(v.video)}</span></div>
                <div class="bar-row__main">
                  <div class="bar-track"><div class="bar-fill" style="width:${(v.leads / a.topVideos[0].leads) * 100}%"></div></div>
                  <div class="bar-row__sub">加微 ${v.wechat}${v.dealAmount ? ` · 成交 ${wan(v.dealAmount)}` : ''}</div>
                </div>
                <div class="bar-row__value">${fmt(v.leads)}<small>线索</small></div>
              </div>`).join('')}
          </div>
          <div class="card">
            <div class="card__head"><span class="card__title">话术贡献</span></div>
            <dl class="kv">
              <dt>变体A</dt><dd>24 加微 / 214 发送 · 转化率 11.2%（变体按权重随机分配）</dd>
              <dt>变体B</dt><dd>3 加微 / 51 发送 · 转化率 5.9%（变体按权重随机分配）</dd>
            </dl>
            <p class="card__hint" style="margin-top:10px">变体级明细见「话术库」——哪句话在换钱，一目了然。</p>
          </div>
        </div>`;
  }

  async function viewAttribution() {
    main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
    const body = await loadAttributionBodyHtml();
    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'compass', title: '触点归因', desc: '哪条视频、哪个触点、哪套话术带来的线索最成交（IMP-032）· 依赖 leads.source 埋点' })}
        ${body}
      </div>`;
  }

  /* ═══════════════════════════════════════════
     账号健康度：2026-09-12 已并入「账号管理 → 账号」
     保留此函数仅为兼容旧路由映射，直接跳转。
     ═══════════════════════════════════════════ */
  function viewHealth() {
    location.hash = '#/accounts';
  }

  /* ═══════════════════════════════════════════
     视图：合规风险（IMP-007 / IMP-010）
     ═══════════════════════════════════════════ */
  async function viewRisk() {
    main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
    const c = await API.getCompliance();
    const dotColor = { ok: 'var(--ok)', info: 'var(--info)', warn: 'var(--warn)', danger: 'var(--danger)' };
    const ruleTag = (s) => s === 'hit' ? '<span class="tag tag--high">已命中</span>' : '<span class="tag tag--low">待命</span>';

    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'shield', title: '合规风险', desc: '合规护栏可视化 —— 强监管行业的信任底线（差异化护城河）' })}
        <div class="grid grid--metrics">
          ${metric('近7天退订', c.summary.unsubscribe7d, 'user_blocked/unsubscribe 埋点')}
          ${metric('黑名单总数', c.summary.blacklistTotal, `日增均值 ${c.summary.blacklistDelta7d}%（R3 阈值 3%）`)}
          ${metric('近7天投诉', c.summary.complaints7d, 'complaint 埋点')}
          ${metric('审计事件', c.summary.auditEvents, 'v0.2 审计表 · 自托管可导出')}
        </div>
        <div class="grid grid--main-side">
          <div class="card">
            <div class="card__head">
              <span class="card__title">审计事件流（最近）</span>
              <span class="card__hint">全触达可审计 · 支持退订，满足强监管要求（US5）</span>
            </div>
            <ul class="timeline">
              ${c.audit.map((e) => `
                <li>
                  <span class="timeline__dot" style="background:${dotColor[e.level]}"></span>
                  <span>${esc(e.text)}</span>
                  <span class="timeline__time num">${esc(e.time)}</span>
                </li>`).join('')}
            </ul>
          </div>
          <div class="card">
            <div class="card__head"><span class="card__title">决策规则引擎（R1/R2/R3）</span></div>
            <div class="col-grid" style="gap:12px">
              ${c.rules.map((r) => `
                <div style="border:1px solid var(--line);border-radius:10px;padding:11px 13px">
                  <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
                    <strong style="font-family:var(--font-display)">${r.id}</strong>${ruleTag(r.status)}
                  </div>
                  <div style="font-size:12.5px;color:var(--ink-soft)">${esc(r.desc)}</div>
                  ${r.hitAt ? `<div style="font-size:11.5px;color:var(--warn);margin-top:4px">最近命中：${esc(r.hitAt)} · ${esc(r.target)}</div>` : ''}
                </div>`).join('')}
            </div>
            <p class="card__hint" style="margin-top:12px">
              安全模式当前：${state.safeMode.active ? '<b style="color:var(--danger)">已启用（' + esc(state.safeMode.reason) + '）</b>' : '<b style="color:var(--ok)">未启用</b>'}
            </p>
          </div>
        </div>
      </div>`;
  }

  /* ═══════════════════════════════════════════
     视图：话术库（IMP-005 / R2）
     ═══════════════════════════════════════════ */
  /* ══════════ 话术库分类 Tab 状态 ══════════ */
  /** 话术库筛选状态：category = 分类页签；focusId = 从变量下拉点名的那条话术（只显示这一条并高亮定位）；
      val = 下拉里选的「画像可选值」{k: 变量名, v: 值}，用来筛下面的话术卡片。 */
  const scriptTabState = { category: 'all', focusId: null, val: null };
  const SCRIPT_TABS = [
    { key: 'all',             label: '全部' },
    { key: 'comment',         label: '评论话术' },
    { key: 'welcome',         label: '欢迎语/首句' },
    { key: 'private_message', label: '私信话术' },
    { key: 'wechat_guide',    label: '微信引导' },
    { key: 'objection',       label: '异议处理' },
    { key: 'nurture',         label: '培育SOP' },
  ];

  /* 场景分类：话术库按这 5 类做就绪检查（原「话术策略」卡片的功能，2026-09-13 迁到话术库页顶部） */
  const SCRIPT_SCENE_CATS = [
    { key: 'comment',         label: '评论区首次触达', hint: '在别人的评论区公开回复时用' },
    { key: 'welcome',         label: '欢迎语首句',     hint: '用户进私信后第一句，让 TA 开口' },
    { key: 'private_message', label: '私信开场',       hint: '私信第一句话' },
    { key: 'wechat_guide',    label: '加微引导',       hint: '引导对方加微信时用' },
    { key: 'objection',       label: '异议应对',       hint: '对方说「太贵了 / 再考虑」时用' },
  ];

  /* 老版 ScriptStrategy 的四段文本 → 话术库分类，用于一次性迁移（入口在话术库页顶部） */
  const SCRIPT_LEGACY_MAP = {
    commentScript: 'comment',
    privateMessageScript: 'private_message',
    wechatScript: 'wechat_guide',
    objectionScript: 'objection',
  };

  /* 「话术与业务配置」页：业务画像 + 话术库同处一页（2026-09-13 合并） */
  const SCRIPT_OUTER_TABS = [
    { key: 'business', label: '业务画像' },
    { key: 'scripts',  label: '话术库' },
  ];

  /* ══════════ 话术变量绑定（P1：业务画像 → 话术库 实时贯通） ══════════
     话术文本里写 {行业}{产品}{区域}… 占位符，发送/预览时由当前业务画像实时解析。
     改了画像 → 所有用变量的话术自动跟着变，不用重新生成。 */
  /* src = 该变量来自「业务画像」的哪张卡片；label = 那边对应的字段名。
     变量清单与业务画像字段一一对应：画像里加了字段，这里补一行，变量就跟着有。 */
  const VAR_SRC = {
    business: { label: '业务画像',   tab: 'business' },
    product:  { label: '产品知识库', tab: 'business' },
    audience: { label: '目标客户',   tab: 'business' },
    wechat:   { label: '微信转化',   tab: 'business' },
  };
  /* pick: true = 该变量来自业务画像的「选择项」字段（下拉 / 多选标签），会出现在话术库的筛选项里。
     ⚠️ 纯文本字段（人设 / 简介 / 常见问题 / 服务流程 / 成功案例 / 不接客户 / 优惠 / 微信号）不打 pick：
     它们仍可作为 {变量} 插进话术，但不在话术库筛选区显示（用户只要画像里的选择项）。 */
  const SCRIPT_VARS = [
    /* ① 业务画像 */
    { key: '行业',     pick: true, opt: 'industry', src: 'business', label: '所属行业', get: (p) => (p.business || {}).industry || '' },
    { key: '产品',     pick: true, opt: 'product',  src: 'product', label: '主营产品 / 产品名称', get: (p) => (p.product || {}).productName || '' },
    { key: '区域',     pick: true, opt: 'area',     src: 'business', label: '服务区域', get: (p) => (p.business || {}).serviceArea || '' },
    { key: '客户类型', pick: true, opt: 'target',   src: 'business', label: '目标客户', get: (p) => (p.business || {}).targetCustomer || '' },
    { key: '价格',     pick: true, opt: 'price',    src: 'product', label: '价格区间', get: (p) => (p.product || {}).priceRange || '' },
    { key: '目标',     pick: true, opt: 'goal',     src: 'business', label: '转化目标', get: (p) => (p.business || {}).conversionGoal || '' },
    { key: '语气',     pick: true, opt: 'tone',     src: 'business', label: '沟通语气', get: (p) => (p.business || {}).tone || '' },
    { key: '人设',     src: 'business', label: '人设 / 自我介绍', get: (p) => arrJoin((p.business || {}).selfIntro) },
    { key: '服务流程', src: 'product', label: '服务流程', get: (p) => arrJoin((p.product || {}).serviceProcess) },
    { key: '成功案例', src: 'product', label: '成功案例', get: (p) => arrJoin((p.product || {}).caseStudies) },
    { key: '不接客户', src: 'audience', label: '不接的客户', get: (p) => arrJoin((p.audience || {}).excludedCustomers) },
    { key: '优惠',     src: 'wechat', label: '优惠 / 钩子', get: (p) => arrJoin((p.wechat || {}).offerHook) },
    /* ② 产品知识库 */
    { key: '简介',     src: 'product', label: '产品简介', get: (p) => (p.product || {}).description || '' },
    { key: '卖点',     pick: true, opt: 'sellingPoints', src: 'product', label: '核心卖点', get: (p) => arrJoin((p.product || {}).sellingPoints) },
    { key: '客户特点', pick: true, opt: 'target',        src: 'business', label: '目标客户', get: (p) => (p.business || {}).targetCustomer || '' },
    { key: '常见问题', src: 'product', label: '常见问题 FAQ', get: (p) => arrJoin((p.product || {}).faq, '；') },
    /* ③ 目标客户 */
    { key: '客户群',   pick: true, opt: 'groupName',  src: 'audience', label: '客户群名称', get: (p) => (p.audience || {}).name || '' },
    { key: '客户行业', pick: true, opt: 'industry',   src: 'audience', label: '所属行业', get: (p) => (p.audience || {}).industry || '' },
    { key: '客户区域', pick: true, opt: 'area',       src: 'audience', label: '所在区域', get: (p) => (p.audience || {}).region || '' },
    { key: '需求',     pick: true, opt: 'needs',      src: 'audience', label: '核心需求 / 意向关键词', get: (p) => arrJoin((p.audience || {}).needs) || arrJoin((p.audience || {}).intentKeywords) },
    { key: '意向词',   pick: true, opt: 'intentKw',   src: 'audience', label: '意向关键词', get: (p) => arrJoin((p.audience || {}).intentKeywords) },
    { key: '痛点',     pick: true, opt: 'pain',       src: 'audience', label: '主要痛点', get: (p) => arrJoin((p.audience || {}).painPoints) },
    { key: '排除词',   pick: true, opt: 'excludedKw', src: 'audience', label: '排除关键词', get: (p) => arrJoin((p.audience || {}).excludedKeywords) },
    /* ④ 微信转化 */
    { key: '微信号',   src: 'wechat', label: '微信号 / 企业微信', get: (p) => (p.wechat || {}).wechatId || '' },
    { key: '引导时机', pick: true, opt: 'timing',      src: 'wechat', label: '引导加微的时机', get: (p) => (p.wechat || {}).guideTiming || '' },
    { key: '引导理由', pick: true, opt: 'guideReason', src: 'wechat', label: '加微理由', get: (p) => (p.wechat || {}).guideReason || '' },
  ];
  /** 话术库筛选区只显示「选择项」变量（画像里是下拉 / 多选标签的字段） */
  const SCRIPT_PICK_VARS = SCRIPT_VARS.filter((v) => v.pick);
  const SCRIPT_VAR_KEYS = SCRIPT_VARS.map((v) => v.key);

  /* ══════════ 变量下拉的「可选值」来源 ══════════
     下拉里列的是业务画像里**这个字段的全部可选值**（和画像弹窗里的下拉同一份 BIZ_OPTIONS），
     不是"现有话术用到它"的列表 —— 话术库一条话术都没有时，下拉照样列得出来。 */
  /** 某变量的选项库：opt 指向 BIZ_OPTIONS 的 key；product 特殊（随「所属行业」联动，未匹配走通用兜底） */
  function varOptList(v, ctx) {
    if (!v || !v.opt) return [];
    if (v.opt === 'product') {
      const ind = String((((ctx || {}).business || {}).industry) || '').trim();
      return BIZ_OPTIONS.productByIndustry[ind] || BIZ_OPTIONS.productGeneric || [];
    }
    return BIZ_OPTIONS[v.opt] || [];
  }
  /** 画像里这个变量当前选中的值（多选标签字段按、,，换行 拆成数组；单选就一条） */
  function varCurList(v, ctx) {
    const raw = String((v && v.get(ctx || {})) || '').trim();
    return raw ? raw.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean) : [];
  }
  /** 话术全文（所有变体 + 欢迎语）：按可选值筛话术时，用来判断"正文里写没写到这个值" */
  function scriptFullText(s) {
    if (!s) return '';
    return ((s.variants || []).map((v) => v.text || '').join('\n')) + '\n' + (s.welcomeMsg || '');
  }
  /** 按「画像可选值」筛一条话术：正文里写到过这个值，或这条话术引用了对应的 {变量}。
      引用变量的话术换任何值都适用，所以只要它还在用这个变量就算命中 —— 避免筛出来是空的。 */
  function scriptMatchVal(s, pick) {
    if (!pick || !pick.k) return true;
    if (scriptFullText(s).indexOf(pick.v) !== -1) return true;
    return scriptVarsOf(s).includes(pick.k);
  }

  /** 变量芯片（按来源卡片分组）：点一下把 {变量} 插进光标处（弹窗里的插入条用） */
  function varChipsHtml(ctx) {
    return Object.keys(VAR_SRC).map((g) => {
      const list = SCRIPT_VARS.filter((v) => v.src === g);
      if (!list.length) return '';
      const chips = list.map((v) => {
        const val = String(v.get(ctx || {}) || '').trim();
        const tip = VAR_SRC[g].label + ' · ' + v.label + '：' + (val || '未填写');
        return `<button type="button" class="var-chip" data-var="${esc(v.key)}" title="${esc(tip)}">{${esc(v.key)}}</button>`;
      }).join('');
      return `<div class="vgroup"><span class="vgroup__name">${esc(VAR_SRC[g].label)}</span><div class="vgroup__chips">${chips}</div></div>`;
    }).join('');
  }

  /** 话术库顶部「话术可用变量」筛选区：每个「选择项」变量一个下拉框（和业务画像里的下拉同款）。
      ① 下拉里**固定列出该字段在业务画像里的全部可选值**（BIZ_OPTIONS）——
         业务画像没填、话术库一条话术都没有，下拉照样列得出来，不存在"点开是空的"；
      ② 点一个可选值 → 下面只留"用得上它"的话术（正文写到过这个值，或引用了这个 {变量}）；
      ③ 面板底部再列出已经引用这个变量的话术，点一条直达那张卡。
      pool = 当前分类下的话术；pick = 当前已选的可选值 {k: 变量名, v: 值}；
      allScripts = 全部话术（分类页签的计数要用全量，不能用按分类过滤后的 pool）。
      ⚠ 本函数在 viewScripts 外层作用域，取不到 viewScripts 里的 `scripts`，必须靠参数传入。 */
  function varFilterHtml(ctx, pool, focusId, pick, allScripts) {
    const all = Array.isArray(allScripts) ? allScripts : pool;
    const focus = pool.find((s) => s.id === focusId) || null;
    const focusVars = focus ? scriptVarsOf(focus) : [];
    const on = pick && pick.k ? pick : null;
    const snippet = (s) => {
      const v = (s.variants || []).find((x) => (x.text || '').trim());
      const t = (v && v.text) || s.welcomeMsg || '';
      return t.replace(/\s+/g, ' ').slice(0, 46) + (t.length > 46 ? '…' : '');
    };
    // 分类页签（原来在卡片外面独立一行，现在挪进本卡片，和变量筛选同一处）
    const catNow = scriptTabState.category;
    const catsHtml = SCRIPT_TABS.map((t) => {
      const count = t.key === 'all' ? all.length : all.filter((s) => s.category === t.key).length;
      return `<button type="button" class="subtab-btn" data-cat="${t.key}" aria-selected="${catNow === t.key}">${esc(t.label)}<span class="count">${count}</span></button>`;
    }).join('');
    const groups = Object.keys(VAR_SRC).map((g) => {
      // 只列业务画像的「选择项」字段（下拉 / 多选标签）；纯文本字段不给筛选（用户要求）
      const list = SCRIPT_PICK_VARS.filter((v) => v.src === g);
      if (!list.length) return '';
      const chips = list.map((v) => {
        const curVals = varCurList(v, ctx);
        const curTxt = curVals.join('、');
        const hit = pool.filter((s) => scriptVarsOf(s).includes(v.key));
        const isOn = (on && on.k === v.key) || focusVars.includes(v.key);
        const picked = on && on.k === v.key ? on.v : '';
        // 可选值 = 选项库 + 画像里手工输入的自定义值（画像允许自定义，这里也要列出来）
        const lib = varOptList(v, ctx);
        const opts = curVals.filter((o) => !lib.includes(o)).concat(lib);
        const tip = `${VAR_SRC[g].label} · ${v.label}：${curTxt || '画像里还没填这一项'}｜${hit.length} 条话术引用`;
        const optsHtml = opts.length
          ? `<span class="vpick__opts">${opts.map((o) => {
              const cls = `vopt${curVals.includes(o) ? ' is-cur' : ''}${picked === o ? ' is-on' : ''}`;
              return `<button type="button" class="${cls}" data-vopt="${esc(o)}" data-vkey="${esc(v.key)}" role="option" aria-selected="${picked === o}" title="${esc('按「' + o + '」筛话术')}">${esc(o)}</button>`;
            }).join('')}</span>`
          : '<span class="vpick__none">这个字段在画像里还没有可选值。</span>';
        const items = hit.map((s) => `
            <button type="button" class="vpick__item${s.id === focusId ? ' is-cur' : ''}" data-vgoto="${esc(s.id)}" data-vfrom="${esc(v.key)}">
              <span class="vpick__name">${esc(s.name)}</span>
              <span class="vpick__snip">${esc(snippet(s))}</span>
            </button>`).join('');
        // 下拉框形态（与业务画像里的下拉字段一致）：左字段名、右当前值/已选值、▾；点开选可选值
        return `<span class="vsel-wrap">
            <button type="button" class="vsel${isOn ? ' is-on' : ''}${picked ? ' is-filt' : ''}"
                data-vchip="${esc(v.key)}" aria-haspopup="true" aria-expanded="${!!isOn}" title="${esc(tip)}">
              <span class="vsel__k">${esc(v.key)}</span>
              <span class="vsel__v${(picked || curTxt) ? '' : ' is-empty'}">${esc(picked || curTxt || '未填')}</span>
              <span class="vsel__caret"></span>
            </button>
            <span class="vpick" data-vpanel="${esc(v.key)}" hidden>
              <span class="vpick__hd">${esc(v.label)}：${curTxt ? '画像当前值「' + esc(curTxt) + '」' : '画像里还没填'} · ${hit.length} 条话术引用</span>
              <span class="vpick__sec">画像可选值 · 点一个筛下面的话术</span>
              ${optsHtml}
              <span class="vpick__sec">用到 {${esc(v.key)}} 的话术 · ${hit.length} 条</span>
              ${hit.length ? `<span class="vpick__list">${items}</span>`
                : `<span class="vpick__none">暂时没有话术引用 {${esc(v.key)}}（不影响上面的可选值）。</span>`}
            </span>
          </span>`;
      }).join('');
      return `<span class="vgroup"><span class="vgroup__name">${esc(VAR_SRC[g].label)}</span><span class="vgroup__chips">${chips}</span></span>`;
    }).join('');
    const matched = on ? pool.filter((s) => scriptMatchVal(s, on)).length : pool.length;
    const stat = on
      ? `已筛选：<b>${esc(on.k)} = ${esc(on.v)}</b> · 命中 <b>${matched}</b>/${pool.length} 条`
      : (focus
        ? `已定位：<b>${esc(focus.name)}</b>`
        : `共 ${pool.length} 条话术`);
    return `
      <div class="card var-card">
        <div class="var-card__head">
          <span class="var-card__title">话术可用变量</span>
          <span class="var-card__desc" title="按业务画像里的「选择项」字段筛话术。下拉框里固定列出画像该字段的全部可选值（画像没填、一条话术都没有，选项也照常列出来）；点一个值 → 下面只看用得上它的话术（正文写到了这个值，或引用了这个 {变量}）。纯文本字段（人设、简介…）仍可插进话术，只是不在这里筛。">按画像的<b>选择项</b>筛话术</span>
          <span class="var-card__sp"></span>
          <span class="vfilter__stat">${stat}</span>
          ${(on || focus) ? '<button type="button" class="btn btn--sm" data-vclear>清除筛选</button>' : ''}
        </div>
        <div class="subtabs var-card__cats" role="tablist">${catsHtml}</div>
        <div class="vfilter">
          <div class="vfilter__groups">${groups}</div>
        </div>
      </div>`;
  }

  function arrJoin(v, sep) {
    const s = sep || '、';
    if (Array.isArray(v)) return v.join(s);
    if (typeof v === 'string') return v.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean).join(s);
    return '';
  }

  /** 把文本里的 {变量} 替换为当前画像值；缺值保留原占位符（便于发现未填项） */
  function resolveProfileVars(text, ctx) {
    if (!text || !ctx) return text || '';
    return String(text).replace(/\{(\S+?)\}/g, (m, k) => {
      const v = SCRIPT_VARS.find((x) => x.key === k);
      if (!v) return m;               // 非已知变量，原样保留
      const val = (v.get(ctx) || '').trim();
      return val || m;                // 画像未填该项 → 保留占位符，不强行清空
    });
  }

  /** 检测一段文本用到了哪些变量（用于话术卡标签） */
  function detectUsedVars(text) {
    if (!text) return [];
    const used = new Set();
    String(text).replace(/\{(\S+?)\}/g, (m, k) => { if (SCRIPT_VAR_KEYS.includes(k)) used.add(k); return m; });
    return [...used];
  }

  /** 业务画像上下文缓存：避免每次发送都打 3~4 个接口 */
  let _profileCtxCache = null;
  let _profileCtxLoading = null;
  async function ensureProfileCtx() {
    if (_profileCtxCache) return _profileCtxCache;
    if (_profileCtxLoading) return _profileCtxLoading;
    _profileCtxLoading = (async () => {
      const [business, product, audience, wechat] = await Promise.all([
        API.getBusinessProfile ? API.getBusinessProfile().catch(() => ({})) : Promise.resolve({}),
        API.getProductKnowledge ? API.getProductKnowledge().catch(() => ({})) : Promise.resolve({}),
        API.getAudienceProfile ? API.getAudienceProfile().catch(() => ({})) : Promise.resolve({}),
        API.getWeChatSettings ? API.getWeChatSettings().catch(() => ({})) : Promise.resolve({}),
      ]);
      _profileCtxCache = { business: business || {}, product: product || {}, audience: audience || {}, wechat: wechat || {} };
      return _profileCtxCache;
    })();
    try { return await _profileCtxLoading; }
    finally { _profileCtxLoading = null; }
  }
  /** 写完后使缓存失效，下次发送重新取最新画像 */
  function invalidateProfileCtx() { _profileCtxCache = null; }

  /* ══════════ 话术生成（P2：基于画像 + 差异刷新） ══════════ */
  const splitLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const splitComma = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  /** 当前画像「参与生成」的关键字段快照（仅这些字段变才触发刷新，避免无关字段噪声） */
  function profileKeySnapshot(biz, product, audience) {
    return {
      industry: biz.industry || '',
      product: product.productName || '',
      area: biz.serviceArea || '',
      goal: biz.conversionGoal || '',
      selling: splitLines(product.sellingPoints).join(' / '),
      pain: splitLines(audience.painPoints).join(' / '),
      need: splitComma(audience.intentKeywords).join(' / '),
    };
  }

  /** 某条 generated 话术的快照是否「过期」（与当前画像关键字段不同） */
  function isScriptStale(s, snap) {
    if (s.source !== 'generated' || !s.generatedFrom) return false;
    let old;
    try { old = typeof s.generatedFrom === 'string' ? JSON.parse(s.generatedFrom) : s.generatedFrom; }
    catch { return false; }
    if (!old || typeof old !== 'object') return false;
    return ['industry', 'product', 'area', 'goal', 'selling', 'pain', 'need']
      .some((k) => (old[k] || '') !== (snap[k] || ''));
  }

  async function viewScripts(params) {
    const outerTab = (params && params.get ? params.get('tab') : '') || 'scripts';
    const wantCat = params && params.get ? params.get('cat') : '';
    if (wantCat && SCRIPT_TABS.some((t) => t.key === wantCat)) scriptTabState.category = wantCat;

    /* ── P3：资料文件导入流程 ── */
    async function startMaterialImport(file) {
      openModal(`<h2 id="modal-title">解析资料中…</h2><p class="modal__lede">正在读取并 AI 抽取 <b>${esc(file.name)}</b></p>`);
      let extracted;
      try {
        const r = await API.importMaterial(file);
        extracted = (r && r.extracted) || {};
      } catch (e) {
        openModal(`<h2 id="modal-title">导入失败</h2><p class="modal__lede">${esc(e.message)}</p><div class="modal__foot"><button type="button" class="btn" data-close>关闭</button></div>`);
        return;
      }
      openImportPreview(file.name, extracted);
    }

    function openImportPreview(name, ex) {
      const b = ex.business || {}, p = ex.product || {}, a = ex.audience || {}, h = ex.scriptHints || {};
      const field = (label, sec, key, rows) => `
        <label class="imp-field"><span>${label}</span>
          <textarea data-imp="${sec}.${key}" rows="${rows || 1}">${esc((sec === 'business' ? b : sec === 'product' ? p : sec === 'audience' ? a : h)[key] || '')}</textarea></label>`;
      openModal(`
        <h2 id="modal-title">导入预览 · ${esc(name)}</h2>
        <p class="modal__lede">AI 从资料中抽取了以下内容（不可全信，请核对后写入）。仅非空字段会覆盖现有画像。</p>
        <div class="imp-grid">
          <div class="imp-sec"><h3>业务画像</h3>
            ${field('行业', 'business', 'industry')}${field('服务区域', 'business', 'serviceArea')}${field('转化目标', 'business', 'conversionGoal')}
          </div>
          <div class="imp-sec"><h3>产品知识</h3>
            ${field('产品名', 'product', 'productName')}${field('一句话介绍', 'product', 'description', 2)}${field('核心卖点(换行)', 'product', 'sellingPoints', 3)}${field('价格', 'product', 'priceRange')}${field('常见问答', 'product', 'faq', 3)}${field('禁用夸大词', 'product', 'forbiddenClaims')}
          </div>
          <div class="imp-sec"><h3>目标客户</h3>
            ${field('客户群名称', 'audience', 'name')}${field('意向需求(逗号)', 'audience', 'needs')}${field('痛点(换行)', 'audience', 'painPoints', 3)}${field('意向关键词(逗号)', 'audience', 'intentKeywords')}${field('排除词(逗号)', 'audience', 'excludedKeywords')}
          </div>
          <div class="imp-sec"><h3>话术起草提示</h3>
            ${field('评论区首触', 'scriptHints', 'comment', 2)}${field('欢迎语首句', 'scriptHints', 'welcome', 2)}${field('私信开场', 'scriptHints', 'private_message', 2)}${field('加微引导', 'scriptHints', 'wechat_guide', 2)}${field('异议应对', 'scriptHints', 'objection', 2)}
          </div>
        </div>
        <label class="imp-toggle"><input type="checkbox" id="imp-draft" checked> 同时生成草稿话术（不自动启用）</label>
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="imp-apply">确认写入</button>
        </div>`);
      $('#imp-apply').addEventListener('click', async () => {
        const btn = $('#imp-apply'); btn.disabled = true; btn.textContent = '写入中…';
        const collect = (sec) => {
          const o = {};
          $$('[data-imp]', document).forEach((el) => {
            const parts = el.dataset.imp.split('.');
            if (parts[0] === sec) o[parts[1]] = el.value;
          });
          return o;
        };
        const payload = {
          business: collect('business'),
          product: collect('product'),
          audience: collect('audience'),
          scriptHints: collect('scriptHints'),
          makeDraftScripts: $('#imp-draft').checked,
        };
        try {
          const r = await API.applyImport(payload);
          const ap = (r && r.applied) || {};
          const n = (ap.scripts || []).length;
          toast(`已写入：业务${ap.business ? '✓' : '·'} 产品${ap.product ? '✓' : '·'} 客户${ap.audience ? '✓' : '·'}${n ? ` 草稿话术${n}条` : ''}`, 'ok');
          closeModal();
          invalidateProfileCtx();
          await renderBizConfigBody();
        } catch (e) {
          toast('写入失败：' + e.message, 'warn');
          btn.disabled = false; btn.textContent = '确认写入';
        }
      });
    }

    // 业务画像页：挂载原「业务配置」5 步向导，与话术库同页切换
    if (outerTab === 'business') {
      main.innerHTML = `
        <div class="view">
          ${pageHead({ icon: 'i-script', title: '话术与业务配置', desc: '业务画像决定话术说什么；话术库存什么就用什么', actions: '<button type="button" class="btn btn--primary btn--sm" id="btn-import-material">📎 导入资料</button>' })}
          <input type="file" id="mat-file" accept=".txt,.md,.docx,.xlsx,.pdf" hidden>
          <div class="tabs" id="scripts-outer-tabs">
            ${SCRIPT_OUTER_TABS.map((t) => `<button class="tab ${t.key === 'business' ? 'tab--active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
          </div>
          ${bizConfigSkeletonHtml()}
        </div>`;
      $('#scripts-outer-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (btn) location.hash = `#/scripts?tab=${btn.dataset.tab}`;
      });
      const matFile = $('#mat-file');
      const matBtn = $('#btn-import-material');
      if (matBtn && matFile) {
        matBtn.addEventListener('click', () => matFile.click());
        matFile.addEventListener('change', (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) startMaterialImport(f);
          matFile.value = '';
        });
      }
      await renderBizConfigBody();
      return;
    }

    let scripts = await API.getScripts();
    const [templates, bizRaw, product, audience, wechatRaw, legacyRaw] = await Promise.all([
      API.getScriptTemplates(),
      API.getBusinessProfile ? API.getBusinessProfile().catch(() => ({})) : Promise.resolve({}),
      API.getProductKnowledge ? API.getProductKnowledge().catch(() => ({})) : Promise.resolve({}),
      API.getAudienceProfile ? API.getAudienceProfile().catch(() => ({})) : Promise.resolve({}),
      API.getWeChatSettings ? API.getWeChatSettings().catch(() => ({})) : Promise.resolve({}),
      API.getScriptStrategy ? API.getScriptStrategy().catch(() => ({})) : Promise.resolve({}),
    ]);
    const legacyStrategy = legacyRaw || {};   // 老 ScriptStrategy 四段文本，仅在「导入旧版话术」时用
    const biz = bizRaw || {};
    const _product = product || {};
    const _audience = audience || {};
    const _wechat = wechatRaw || {};
    /* 变量解析上下文 = 业务画像的四张卡片，与下方「话术可用变量」一一对应 */
    const _ctx = { business: biz, product: _product, audience: _audience, wechat: _wechat };
    const _snap = profileKeySnapshot(biz, _product, _audience);
    const staleScripts = scripts.filter((s) => isScriptStale(s, _snap));
    const strategy = (window.API && window.API.fetchStrategySettings) ? await window.API.fetchStrategySettings().catch(() => null) : null;
    const r2Threshold = (strategy && strategy.r2_switch_threshold != null) ? strategy.r2_switch_threshold : 8;

    /* ── 场景就绪条（原「话术策略」卡片的功能，2026-09-13 迁到这里）──
       5 类场景各有多少条话术 + 一键补缺 + 导入旧版四段文本。 */
    /** 是否「通用话术」：完全没绑定业务画像变量（未引用任何 {变量}） */
    function isGenericScript(s) {
      if (!s) return true;
      const allText = ((s.variants || []).map((v) => v.text).join('\n')) + '\n' + (s.welcomeMsg || '');
      return detectUsedVars(allText).length === 0;
    }
    /** 是否「有效话术」：非通用 + 有变体发出样本 ≥ 30 且加微转化率 ≥ R2 阈值 */
    function isScriptEffective(s) {
      if (!s || isGenericScript(s)) return false;
      const good = (s.variants || []).filter((v) => v.status === 'active' && (v.sent || 0) >= 30);
      return good.some((v) => v.convRate != null && v.convRate >= r2Threshold);
    }
    /** 是否「绑定画像」：引用了业务画像变量，且这些变量在画像里都已填写。
        只填了通用兜底话术（不引用任何变量，或引用的变量还没填）不算就绪。 */
    function isScriptBound(s) {
      if (!s) return false;
      const allText = ((s.variants || []).map((v) => v.text).join('\n')) + '\n' + (s.welcomeMsg || '');
      const used = detectUsedVars(allText);
      if (used.length === 0) return false; // 通用兜底话术，未绑定画像
      return used.every((k) => {
        const v = SCRIPT_VARS.find((x) => x.key === k);
        return v && String(v.get(_ctx) || '').trim() !== '';
      });
    }

    const sceneStats = () => {
      const stat = {};
      SCRIPT_SCENE_CATS.forEach((c) => { stat[c.key] = { n: 0, v: 0, eff: 0, bound: 0 }; });
      scripts.forEach((s) => {
        const c = stat[s.category];
        if (!c) return;
        c.n += 1;
        c.v += ((s.variants || []).filter((x) => x.status === 'active')).length;
        if (isScriptEffective(s)) c.eff += 1;
        if (isScriptBound(s)) c.bound += 1;
      });
      const missing = SCRIPT_SCENE_CATS.filter((c) => stat[c.key].n === 0);
      const generic = SCRIPT_SCENE_CATS.filter((c) => stat[c.key].n > 0 && stat[c.key].bound === 0);
      const needGen = missing.concat(generic);
      const legacyItems = Object.keys(SCRIPT_LEGACY_MAP)
        .filter((k) => String((legacyStrategy || {})[k] || '').trim() && stat[SCRIPT_LEGACY_MAP[k]].n === 0);
      return { stat, missing, generic, needGen, legacyItems, ready: SCRIPT_SCENE_CATS.length - needGen.length };
    };

    /** 话术库顶部状态条：把原来各占一行的「刷新横幅 + 有效就绪条 + 业务上下文条」压成一行。
        左：就绪药丸（悬停看缺哪几类）；中：业务上下文；右：待办按钮。 */
    function scrBarHtml() {
      const { stat, needGen, generic, legacyItems } = sceneStats();
      const readyCats = SCRIPT_SCENE_CATS.filter((c) => stat[c.key].bound > 0).length;
      const allOk = needGen.length === 0;
      const needLabel = needGen.map((c) => c.label).join('、');
      const genericLabel = generic.map((c) => c.label).join('、');
      // 原来占第二行的说明句，收进药丸的悬停提示
      const readyTip = allOk
        ? '每类场景都有绑定业务画像的有效话术，可直接取用。'
        : (genericLabel
          ? genericLabel + ' 的话术还是通用的，填完业务画像会更有针对性。'
          : '还差 ' + needLabel + ' 没有话术，点右侧「按画像生成」补上。');
      const hasCtx = !!(biz.industry || _product.productName);
      const ctxTxt = hasCtx
        ? [biz.industry || '未填行业', _product.productName, biz.serviceArea,
           _audience.name ? '面向 ' + _audience.name : '',
           biz.conversionGoal ? '目标' + biz.conversionGoal : ''].filter(Boolean).join(' · ')
        : '还没填业务画像，AI 生成的话术会缺少针对性';
      return `
        <div class="scr-bar${hasCtx ? '' : ' scr-bar--empty'}">
          <span class="scr-chip${allOk ? ' is-ok' : ''}" title="${esc(readyTip)}">
            <i class="scr-chip__dot"></i>有效话术就绪 <b>${readyCats}/${SCRIPT_SCENE_CATS.length}</b>
          </span>
          <span class="scr-bar__ctx" title="${esc('业务上下文：' + ctxTxt)}">业务上下文：<b>${esc(ctxTxt)}</b></span>
          <span class="scr-bar__sp"></span>
          ${staleScripts.length ? `<button type="button" class="btn btn--warn btn--sm" id="btn-refresh-gen" title="业务画像已更新，${staleScripts.length} 条「画像生成」话术可能过时，建议刷新以对齐最新画像">⚠ ${staleScripts.length} 条待刷新</button>` : ''}
          ${legacyItems.length ? `<button type="button" class="btn btn--sm" id="scr-import">导入旧版话术（${legacyItems.length} 类）</button>` : ''}
          ${needGen.length ? `<button type="button" class="btn btn--primary btn--sm" id="scr-gen" title="${esc('缺：' + needLabel)}">按画像生成 / 优化 ${needGen.length} 类</button>` : ''}
          <a class="btn btn--sm" href="#/scripts?tab=business">${hasCtx ? '完善业务画像' : '去填业务画像'}</a>
        </div>`;
    }

    const mountHtml = () => {
      const cat = scriptTabState.category;
      // 先按分类筛 → 再按「变量下拉里选的画像可选值」筛 → 「点名」只显示被点中的那一条（定位高亮）
      const byCat = cat === 'all' ? scripts : scripts.filter((s) => s.category === cat);
      const pickVal = scriptTabState.val;
      const byVal = (pickVal && pickVal.k) ? byCat.filter((s) => scriptMatchVal(s, pickVal)) : byCat;
      const focusId = scriptTabState.focusId;
      const filtered = focusId && byVal.some((s) => s.id === focusId)
        ? byVal.filter((s) => s.id === focusId)
        : byVal;
      return `
          ${scrBarHtml()}

          ${varFilterHtml(_ctx, byCat, focusId, pickVal, scripts)}

          ${filtered.length > 0 ? `
          <div class="grid grid--2">
            ${filtered.map((s) => scriptCard(s, r2Threshold)).join('')}
          </div>` : `
          <div class="card"><div class="empty">
            <span class="empty__ico">${ico('empty')}</span>
            <p>${pickVal && pickVal.k
              ? `没有用得上「${esc(pickVal.v)}」的话术（正文写到这个值，或引用 {${esc(pickVal.k)}}）。点上面下拉换一个值，或「清除筛选」看全部。`
              : '该分类下暂无话术'}</p>
          </div></div>`}`;
    };

    main.innerHTML = `
      <div class="view">
        ${pageHead({
          icon: 'script', title: '话术与业务配置',
          desc: `主话术 + 变体按权重随机分配，发出后按配置权重分发流量`,
          actions: '<button type="button" class="btn btn--primary btn--sm" id="btn-new-script">+ 新建话术</button>',
        })}
        <div class="tabs" id="scripts-outer-tabs">
          ${SCRIPT_OUTER_TABS.map((t) => `<button class="tab ${t.key === 'scripts' ? 'tab--active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
        </div>
        <div id="scripts-body"></div>
      </div>`;
    $('#scripts-outer-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (btn) location.hash = `#/scripts?tab=${btn.dataset.tab}`;
    });

    /** 画像变更后刷新生成话术：旧→新差异预览，确认才覆盖（仅 source=generated 参与）。走 AI 重算。 */
    async function openRefreshDiff(staleList, snap, bizP, productP, audienceP) {
      openModal(`<h2 id="modal-title">刷新生成的话术（旧 → 新）</h2><p class="modal__lede">正在按当前业务画像用 AI 重新生成…</p>`);
      let preview;
      try {
        preview = await API.generateScriptPreview();
      } catch (e) {
        openModal(`<h2 id="modal-title">刷新失败</h2><p class="modal__lede">AI 生成出错：${esc(e.message)}</p><div class="modal__foot"><button type="button" class="btn btn--primary" data-close>关闭</button></div>`);
        return;
      }
      const scenes = (preview && preview.scenes) || {};
      const newSnap = (preview && preview.snapshot) || JSON.stringify(snap);
      const rows = staleList.map((s) => {
        const newTexts = scenes[s.category] || [];
        const oldTexts = (s.variants || []).map((v) => v.text);
        const max = Math.max(oldTexts.length, newTexts.length);
        const diffs = [];
        for (let i = 0; i < max; i++) {
          diffs.push({ idx: String.fromCharCode(65 + i), old: oldTexts[i] || '（无）', ne: newTexts[i] || '（保留原变体）' });
        }
        return { name: s.name, category: s.category, id: s.id, variants: s.variants || [], diffs };
      });
      openModal(`
        <h2 id="modal-title">刷新生成的话术（旧 → 新）</h2>
        <p class="modal__lede">以下话术基于<b>当前业务画像</b>由 AI 重新生成。确认后覆盖旧文案并回写新快照；手写改动会被覆盖，请确认。</p>
        <div class="diff-list">
          ${rows.map((r) => `
            <div class="diff-card">
              <div class="diff-card__title">${esc(r.name)}</div>
              ${r.diffs.map((d) => `
                <div class="diff-row">
                  <span class="diff-row__tag">变体 ${d.idx}</span>
                  <div class="diff-row__cols">
                    <div class="diff-old"><b>旧</b>${esc(d.old)}</div>
                    <div class="diff-new"><b>新</b>${esc(d.ne)}</div>
                  </div>
                </div>`).join('')}
            </div>`).join('')}
        </div>
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="diff-confirm">确认刷新 ${staleList.length} 条</button>
        </div>`);
      $('#diff-confirm').addEventListener('click', async () => {
        const btn = $('#diff-confirm');
        btn.disabled = true; btn.textContent = '刷新中…';
        try {
          for (const r of rows) {
            const newTexts = scenes[r.category] || [];
            for (let i = 0; i < r.variants.length; i++) {
              const ne = newTexts[i];
              if (ne == null) continue;
              await API.updateScriptVariant(r.id, r.variants[i].variantId, { text: ne });
            }
            for (let i = r.variants.length; i < newTexts.length; i++) {
              await API.addScriptVariant(r.id, { variantId: String.fromCharCode(65 + i), text: newTexts[i], weight: 1 });
            }
            await API.updateScript(r.id, { source: 'generated', generatedFrom: newSnap });
          }
          toast(`已刷新 ${staleList.length} 条话术`, 'ok');
          closeModal();
          scripts = await API.getScripts();
          render();
        } catch (e) {
          toast('刷新失败：' + e.message, 'warn');
          btn.disabled = false; btn.textContent = '确认刷新';
        }
      });
    }

    function render() {
      const body = $('#scripts-body');
      if (body) body.innerHTML = mountHtml();
      bind();
    }

    function bind() {
      const body = $('#scripts-body');
      if (!body) return;

      // Tab 切换事件
      $$('.subtab-btn', body).forEach((btn) => {
        btn.addEventListener('click', () => {
          scriptTabState.category = btn.dataset.cat;
          scriptTabState.focusId = null; // 切分类后点名的话术可能不在新分类里，直接回到全部
          render();
        });
      });

      // 话术可用变量 → 点 chip 弹下拉列出用到它的话术；点选某条 = 定位高亮
      const closeAllVchips = (except) => {
        $$('.vsel-wrap.is-open', body).forEach((w) => { if (w !== except) { w.classList.remove('is-open'); const p = w.querySelector('[data-vpanel]'); if (p) p.hidden = true; } });
      };
      $$('[data-vchip]', body).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wrap = btn.closest('.vsel-wrap');
          const panel = wrap && wrap.querySelector('[data-vpanel]');
          if (!wrap || !panel) return;
          const willOpen = panel.hidden;
          closeAllVchips(wrap);
          panel.hidden = !willOpen;
          wrap.classList.toggle('is-open', willOpen);
          btn.setAttribute('aria-expanded', String(willOpen));
          if (willOpen) {
            // 靠右时右对齐，避免面板溢出屏幕
            panel.style.right = ''; panel.style.left = '';
            const r = panel.getBoundingClientRect();
            if (r.right > window.innerWidth - 12) { panel.style.left = 'auto'; panel.style.right = '0'; }
            const item = panel.querySelector('.vpick__item.is-cur');
            if (item) item.scrollIntoView({ block: 'nearest' });
          }
        });
      });
      // 点面板里的「画像可选值」→ 拿这个值筛下面的话术卡片；再点同一个值 = 取消筛选
      $$('[data-vopt]', body).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = btn.dataset.vkey;
          const v = btn.dataset.vopt;
          const cur = scriptTabState.val;
          scriptTabState.val = (cur && cur.k === k && cur.v === v) ? null : { k, v };
          scriptTabState.focusId = null;   // 换筛选条件时取消点名，否则只剩被点名那条
          closeAllVchips();
          render();
        });
      });
      // 点面板里的话术 → 只显示这一条 + 滚动定位 + 高亮闪烁
      $$('[data-vgoto]', body).forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          scriptTabState.focusId = item.dataset.vgoto;
          scriptTabState.val = null;       // 点名具体某条时先解除值筛选，别把它自己筛掉
          scriptTabState._scrollPending = true;
          closeAllVchips();
          render();
        });
      });
      // 点变量卡外部关闭所有下拉（只绑一次）
      if (!body.dataset.vchipDocBound) {
        body.dataset.vchipDocBound = '1';
        document.addEventListener('click', (e) => {
          if (e.target.closest && e.target.closest('.vsel-wrap')) return;
          $$('.vsel-wrap.is-open', body).forEach((w) => { w.classList.remove('is-open'); const p = w.querySelector('[data-vpanel]'); if (p) p.hidden = true; });
        });
      }
      const vclear = $('[data-vclear]', body);
      if (vclear) vclear.addEventListener('click', () => { scriptTabState.focusId = null; scriptTabState.val = null; render(); });

      // 从变量下拉点名过来：滚到那张卡并闪烁提示
      if (scriptTabState._scrollPending) {
        scriptTabState._scrollPending = false;
        const target = $('[data-script-id="' + CSS.escape(scriptTabState.focusId || '') + '"]', body);
        if (target) {
          try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { target.scrollIntoView(); }
          target.classList.remove('is-flash');
          void target.offsetWidth; // 重启动画
          target.classList.add('is-flash');
        }
      }

      // 话术卡「AI 优化」：勾选画像变量 → AI 改写 → 草稿确认 → 落库
      $$('[data-script-ai]', body).forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = scripts.find((x) => x.id === btn.dataset.scriptAi);
          if (!target) { toast('找不到这条话术，刷新试试', 'warn'); return; }
          openScriptAiDialog(target, async () => {
            scripts = await API.getScripts();
            render();
          });
        });
      });

      // 话术卡「编辑」：改名/分类/备注/欢迎语/启用 + 变体增删改
      $$('[data-script-edit]', body).forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.scriptEdit;
          const target = scripts.find((x) => x.id === id);
          if (!target) { toast('找不到这条话术，刷新试试', 'warn'); return; }
          openScriptEditModal(target, async () => {
            scripts = await API.getScripts();
            render();
          });
        });
      });

      // 变体行：点击展开 / 收起全文（默认 1 行截断）
      $$('.svrow', body).forEach((row) => {
        if (!row.querySelector('.svrow__text') || row.classList.contains('svrow--empty')) return;
        row.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          row.classList.toggle('is-open');
        });
      });

      // 话术卡「用画像解析预览」：实时把 {变量} 替换为当前画像值
      $$('[data-script-preview]', body).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.scriptPreview;
          const card = btn.closest('.script-card');
          const prev = $('#scr-prev-' + id, body);
          if (!card || !prev) return;
          if (!prev.hidden) { prev.hidden = true; prev.innerHTML = ''; btn.textContent = '预览'; return; }
          const ctx = await ensureProfileCtx();
          const raws = $$('[data-raw]', card);
          const lines = raws.map((el) => {
            const raw = el.getAttribute('data-raw') || el.textContent;
            return resolveProfileVars(raw, ctx);
          }).filter((t) => t && t.trim());
          const missing = detectUsedVars(raws.map((el) => el.getAttribute('data-raw') || '').join('\n'));
          prev.innerHTML = (lines.length ? lines.map((t) => `<div class="scr-preview__line">${esc(t).replace(/\n/g, '<br>')}</div>`).join('') : '<div class="muted">该话术未使用变量</div>')
            + (missing.length ? `<div class="scr-preview__miss">未填充：${missing.map((k) => '{' + esc(k) + '}').join(' ')} — 去「业务画像」补填后自动生效</div>` : '');
          prev.hidden = false;
          btn.textContent = '收起预览';
        });
      });

      // 场景就绪条：按画像一键补齐缺失场景（AI 生成）
      const scrGen = $('#scr-gen', body);
      if (scrGen) scrGen.addEventListener('click', async () => {
        const old = scrGen.textContent;
        scrGen.disabled = true;
        scrGen.textContent = 'AI 生成中…（约 10-60s）';
        try {
          const res = await API.generateScriptByProfile();
          const scenes = (res && res.scenes) || {};
          const total = Object.values(scenes).reduce((a, b) => a + (b || 0), 0);
          toast(total ? `AI 已生成 / 刷新 ${total} 条话术，可直接改写` : '没有可生成的话术', total ? 'ok' : '');
          invalidateProfileCtx();
          scripts = await API.getScripts();
          render();
        } catch (e) {
          toast('AI 生成失败：' + e.message, 'warn');
          scrGen.disabled = false; scrGen.textContent = old;
        }
      });

      // 场景就绪条：导入旧版 ScriptStrategy 四段文本（一次性迁移）
      const scrImp = $('#scr-import', body);
      if (scrImp) scrImp.addEventListener('click', async () => {
        scrImp.disabled = true; scrImp.textContent = '导入中…';
        try {
          const { legacyItems } = sceneStats();
          let n = 0;
          for (const k of legacyItems) {
            const cat = SCRIPT_LEGACY_MAP[k];
            const texts = splitLines(legacyStrategy[k]);
            if (!texts.length) continue;
            const label = (SCRIPT_SCENE_CATS.find((c) => c.key === cat) || {}).label || cat;
            const created = await API.createScript({
              name: `旧版话术 · ${label}`, category: cat, industry: biz.industry || '通用',
              intro: '从旧版话术策略导入',
            });
            const sid = created && (created.id || created.scriptId);
            if (!sid) continue;
            const w = Math.max(1, Math.round(100 / texts.length));
            for (let j = 0; j < texts.length; j++) {
              await API.addScriptVariant(sid, { variantId: ('ABC'[j] || ('V' + (j + 1))), text: texts[j], weight: w });
            }
            n += 1;
          }
          toast(n ? `已导入 ${n} 类旧话术到话术库` : '没有可导入的内容', n ? 'ok' : '');
          scripts = await API.getScripts();
          render();
        } catch (e) {
          toast('导入失败：' + e.message, 'warn');
          scrImp.disabled = false; scrImp.textContent = '导入旧版话术';
        }
      });

      // P2：画像变更后刷新「画像生成」话术（旧→新差异预览，确认才覆盖）
      const refreshBtn = $('#btn-refresh-gen', body);
      if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
          await openRefreshDiff(staleScripts, _snap, biz, _product, _audience);
        });
      }

    $('#btn-new-script').addEventListener('click', () => {
      const catOrder = scriptTabState.category === 'all' ? 'comment' : scriptTabState.category;
      /* 芯片与「业务画像」同源：按画像四张卡片分组，鼠标悬停显示该字段当前值 */
      const varChips = varChipsHtml(_ctx);

      /* ════ 新建话术：默认走「AI 读业务画像出候选 → 勾选/改写 → 入库」════
         一次 generate-preview 会返回全部 5 类场景，缓存在内存里：
         切分类直接复用，不用每切一次就再等一轮 AI（单轮 10~60s）。 */
      let mode = 'ai';
      let draftCache = null;      // { scenes: {cat: [text]}, snapshot }
      let nameTouched = false;

      const CAT_OPTS = SCRIPT_SCENE_CATS.map((c) =>
        `<option value="${c.key}"${catOrder === c.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('');

      const defaultName = (cat) => {
        const label = (SCRIPT_SCENE_CATS.find((c) => c.key === cat) || {}).label || '话术';
        return `${label} · ${biz.industry || '通用'}`;
      };

      /** AI 会读到的画像要点；没填的标出来 —— 空太多生成出来的话术会很泛 */
      function srcHtml() {
        const items = [
          ['行业', biz.industry], ['产品', _product.productName],
          ['卖点', splitLines(_product.sellingPoints)[0]], ['价格', _product.priceRange],
          ['区域', biz.serviceArea], ['目标客户', biz.targetCustomer],
          ['痛点', splitLines(_audience.painPoints)[0]], ['加微理由', _wechat.guideReason],
        ];
        const filled = items.filter((x) => String(x[1] || '').trim()).length;
        return `<div class="ns-src${filled ? '' : ' is-empty'}">
          <b>AI 会读这些画像信息</b>
          <div class="ns-src__list">${items.map(([k, v]) => {
            const has = String(v || '').trim();
            return `<span class="ns-src__i${has ? '' : ' is-miss'}">${esc(k)}：${esc(has || '未填')}</span>`;
          }).join('')}</div>
          ${filled >= 3 ? '' : '<span class="ns-src__warn">画像填得太少，生成的话术会很泛。建议先补齐业务画像必填项再生成。</span>'}
        </div>`;
      }

      function draftHtml(list) {
        if (!list || !list.length) return '<div class="muted">这一类没生成出内容，点「换一批」再试。</div>';
        return list.map((t, i) => `
          <div class="ns-draft">
            <label class="ns-draft__pick">
              <input type="checkbox" data-pick checked>
              变体 ${String.fromCharCode(65 + i)}
            </label>
            <textarea class="ns-draft__text" data-text rows="2">${esc(t)}</textarea>
          </div>`).join('');
      }

      function renderDrafts() {
        const box = $('#ns-drafts');
        if (!box) return;
        const cat = $('#ns-cat').value;
        if (!draftCache) {
          box.innerHTML = '<div class="muted">点「生成候选」，AI 会按上面的画像写出 1~3 条，可勾选、可改写。</div>';
          return;
        }
        box.innerHTML = draftHtml((draftCache.scenes || {})[cat] || []);
      }

      async function runGen(force) {
        const cat = $('#ns-cat').value;
        const tip = $('#ns-ai-tip');
        const genBtn = $('#ns-gen');
        const regenBtn = $('#ns-regen');
        // 已生成过且该类有内容：复用缓存，不重复等 AI
        if (!force && draftCache && ((draftCache.scenes || {})[cat] || []).length) { renderDrafts(); return; }
        if (genBtn) { genBtn.disabled = true; genBtn.textContent = '生成中…'; }
        if (regenBtn) regenBtn.disabled = true;
        if (tip) tip.textContent = '正在读业务画像并生成（约 10-60s），别关这个窗口';
        try {
          const res = await API.generateScriptPreview();
          draftCache = {
            scenes: (res && res.scenes) || {},
            snapshot: (res && res.snapshot) || JSON.stringify(_snap),
          };
          if (regenBtn) regenBtn.hidden = false;
          renderDrafts();
          if (tip) tip.textContent = '勾掉不要的、改改就能存';
        } catch (err) {
          const raw = (err && err.message) || String(err);
          // 上游错误翻成人话：余额/额度/Key 失效最常见，别把 502 原文丢给用户
          const human = /INSUFFICIENT_BALANCE|余额|quota|HTTP 40[13]/.test(raw)
            ? 'AI 账号余额不足或 Key 失效 → 去「设置」页的 AI 配置检查 / 充值'
            : (/未配置|HTTP 503|no api key/i.test(raw)
              ? '还没配 AI 服务 → 去「设置」页填 Provider 和 Key'
              : raw);
          if (tip) tip.textContent = human;
          toast(human, 'warn');
        } finally {
          if (genBtn) { genBtn.disabled = false; genBtn.textContent = '生成候选'; }
          if (regenBtn) regenBtn.disabled = false;
        }
      }

      openModal(`
        <h2 id="modal-title">新建话术</h2>
        <p class="modal__lede">让 AI 读业务画像生成候选，勾选后微调即可入库；也可以切到「自己写」。</p>
        <div class="ns-grid">
          <div class="field"><label for="ns-cat">话术分类</label><select id="ns-cat">${CAT_OPTS}</select></div>
          <div class="field"><label for="ns-name">话术名称</label><input type="text" id="ns-name" value="${esc(defaultName(catOrder))}"></div>
        </div>
        <div class="ns-mode" id="ns-mode">
          <button type="button" class="ns-mode__b is-on" data-mode="ai">AI 按画像生成</button>
          <button type="button" class="ns-mode__b" data-mode="manual">自己写</button>
        </div>
        <div id="ns-ai">
          ${srcHtml()}
          <div class="ns-ai-acts">
            <button type="button" class="btn btn--primary btn--sm" id="ns-gen">生成候选</button>
            <button type="button" class="btn btn--sm" id="ns-regen" hidden>换一批</button>
            <span class="ns-ai-tip" id="ns-ai-tip"></span>
          </div>
          <div id="ns-drafts"><div class="muted">点「生成候选」，AI 会按上面的画像写出 1~3 条，可勾选、可改写。</div></div>
        </div>
        <div id="ns-manual" hidden>
          <div class="field">
            <label for="ns-text">首个变体内容（A）</label>
            <div class="var-chips" id="ns-var-chips">${varChips}</div>
            <textarea id="ns-text" placeholder="例：你好，看到你在关注{产品}。我们是做{行业}的，{卖点}。"></textarea>
            <span class="field__hint">变量取自业务画像（鼠标悬停看当前值），点击插入；发送时按当前业务画像实时填充。建议再补 ≥1 个变体做 AB 追踪（R2 规则）。</span>
          </div>
          <div class="field"><label for="ns-intro">备注（选填）</label><input type="text" id="ns-intro" placeholder="例：报价后 24 小时内跟进"></div>
          <div class="ns-preview" id="ns-preview-wrap">
            <span class="ns-preview__label">按当前画像解析预览</span>
            <div class="ns-preview__body" id="ns-preview"><span class="muted">输入内容后，这里显示按当前画像解析的效果</span></div>
          </div>
        </div>
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="ns-save">入库</button>
        </div>`, { wide: true });

      // 模式切换
      $$('#ns-mode .ns-mode__b').forEach((b) => b.addEventListener('click', () => {
        mode = b.dataset.mode;
        $$('#ns-mode .ns-mode__b').forEach((x) => x.classList.toggle('is-on', x === b));
        $('#ns-ai').hidden = mode !== 'ai';
        $('#ns-manual').hidden = mode !== 'manual';
        const save = $('#ns-save');
        if (save) save.textContent = mode === 'ai' ? '入库' : '创建';
      }));

      // 分类切换：自动带出默认名（用户改过就不覆盖），并切到该类的候选
      const nsCat = $('#ns-cat');
      if (nsCat) nsCat.addEventListener('change', () => {
        if (!nameTouched) $('#ns-name').value = defaultName(nsCat.value);
        renderDrafts();
      });
      const nsName = $('#ns-name');
      if (nsName) nsName.addEventListener('input', () => { nameTouched = true; });

      const genBtn = $('#ns-gen');
      if (genBtn) genBtn.addEventListener('click', () => runGen(false));
      const regenBtn = $('#ns-regen');
      if (regenBtn) regenBtn.addEventListener('click', () => runGen(true));

      // 手动模式的变量芯片与解析预览（沿用原逻辑）
      const nsText = $('#ns-text');
      const nsPreview = $('#ns-preview');
      async function updateNsPreview() {
        if (!nsText || !nsPreview) return;
        const ctx = await ensureProfileCtx();
        const raw = nsText.value;
        nsPreview.innerHTML = raw
          ? resolveProfileVars(raw, ctx).replace(/\n/g, '<br>')
          : '<span class="muted">输入内容后，这里显示按当前画像解析的效果</span>';
      }
      if (nsText) nsText.addEventListener('input', updateNsPreview);
      $$('#ns-var-chips .var-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          if (!nsText) return;
          const tok = '{' + chip.dataset.var + '}';
          const s = nsText.selectionStart || 0, e = nsText.selectionEnd || 0;
          nsText.value = nsText.value.slice(0, s) + tok + nsText.value.slice(e);
          nsText.selectionStart = nsText.selectionEnd = s + tok.length;
          nsText.focus();
          updateNsPreview();
        });
      });
      updateNsPreview();

      $('#ns-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const name = $('#ns-name').value.trim();
        const category = $('#ns-cat').value;
        if (!name) { toast('请填写话术名称', 'warn'); if ($('#ns-name')) $('#ns-name').focus(); return; }

        let texts = [];
        if (mode === 'ai') {
          texts = $$('#ns-drafts .ns-draft')
            .filter((d) => { const cb = d.querySelector('[data-pick]'); return cb && cb.checked; })
            .map((d) => { const t = d.querySelector('[data-text]'); return t ? t.value.trim() : ''; })
            .filter(Boolean);
          if (!texts.length) {
            toast(draftCache ? '至少勾选一条候选' : '先点「生成候选」让 AI 出内容', 'warn');
            return;
          }
        } else {
          const t = nsText ? nsText.value.trim() : '';
          if (!t) { toast('请填写变体内容', 'warn'); if (nsText) nsText.focus(); return; }
          texts = [t];
        }

        btn.disabled = true;
        try {
          const created = await API.createScript({
            name, category,
            intro: mode === 'ai'
              ? `AI 按业务画像生成，人工确认（${texts.length} 个变体）`
              : ($('#ns-intro') ? $('#ns-intro').value.trim() : ''),
            industry: biz.industry || '通用',
            // 标成 generated 并回写快照：画像改了才会进「建议刷新」横幅
            source: mode === 'ai' ? 'generated' : 'manual',
            generatedFrom: mode === 'ai' ? ((draftCache && draftCache.snapshot) || JSON.stringify(_snap)) : '',
          });
          const sid = created && (created.id || created.scriptId);
          if (!sid) throw new Error('创建成功但未返回话术 ID');
          const W = [100, 70, 50];
          for (let i = 0; i < texts.length; i++) {
            await API.addScriptVariant(sid, { variantId: String.fromCharCode(65 + i), text: texts[i], weight: W[i] || 50 });
          }
          invalidateProfileCtx();
          toast(`话术已创建（${texts.length} 个变体）`, 'ok');
          closeModal();
          scripts = await API.getScripts();
          scriptTabState.category = category;
          render();
        } catch (err) {
          toast('创建失败：' + err.message, 'warn');
          btn.disabled = false;
        }
      });
    });
    }

    render();
  }

  /* ═══════════════════════════════════════════
     视图：评论回复任务（评论引流策略核心）
     ═══════════════════════════════════════════ */
  const COMMENT_STATUS_META = {
    pending:      { label: '待回复',   cls: 'pending' },
    failed:       { label: '回复失败', cls: 'high' },
    replied:      { label: '已回复',   cls: 'sent' },
    user_replied: { label: '对方追评', cls: 'replied' },
    user_dm:      { label: '对方私信 ★', cls: 'wechat' },
    ignored:      { label: '无反应',   cls: 'rejected' },
  };

  async function viewComments() {
    const [allTasks, scriptsAll] = await Promise.all([
      API.getCommentTasks(),
      API.getScripts(),
    ]);
    const commentScripts = scriptsAll.filter((s) => s.category === 'comment');
    const pending = allTasks.filter((t) => t.status === 'pending');
    const tracked = allTasks.filter((t) => ['replied', 'user_replied', 'user_dm', 'ignored'].includes(t.status));

    function taskRow(t, isPending) {
      const meta = COMMENT_STATUS_META[t.status] || { label: t.status, cls: 'pending' };
      const highlight = t.status === 'user_dm' ? 'style="background:var(--ok-tint)"' :
                        t.status === 'user_replied' ? 'style="background:var(--brand-tint-2)"' : '';
      // 解析多级评论树（v008）：兼容老任务（只有 userReplyContent 时构造一条 L2）
      const norm = (r) => ({
        commentId: r.comment_id || r.commentId || '',
        nickname: r.nickname || '',
        content: (r.content || '').trim(),
        repliedAt: r.replied_at || r.repliedAt || '',
        parentId: r.parent_id || r.parentId || '',
        level: r.level || 1,  // 相对根深度：1=L2, 2=L3 …
      });
      let subs = [];
      if (t.subReplies) { try { subs = JSON.parse(t.subReplies).map(norm); } catch (e) { subs = []; } }
      if (!subs.length && t.userReplyContent) {
        subs = [norm({ comment_id: t.commentId || '', nickname: (t.replierName || '对方'), content: t.userReplyContent, replied_at: '', parent_id: t.commentId || '', level: 1 })];
      }
      subs = subs.filter((r) => r.content);
      const rootId = t.commentId || '';
      // 建树：以被切入/回复的评论为根，按 parent_id 连成子树递归渲染。
      // 孤儿节点（父被排除/未知）重定向到根，保证多级数据不丢。
      const subIds = new Set(subs.map((s) => s.commentId));
      const childrenOf = {};
      subs.forEach((s) => {
        let p = s.parentId || rootId;
        if (p !== rootId && !subIds.has(p)) p = rootId;
        (childrenOf[p] = childrenOf[p] || []).push(s);
      });
      function renderChildren(pid, depth) {
        const kids = childrenOf[pid] || [];
        return kids.map((k) => `
          <div style="margin-top:8px;margin-left:${depth === 0 ? 2 : 14}px;padding:8px 10px;border-left:3px solid var(--brand-deep);background:var(--brand-tint-2);border-radius:0 6px 6px 0">
            <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft)">
              <span style="display:inline-block;background:var(--brand-deep);color:#fff;border-radius:4px;padding:1px 5px;font-size:10px">L${(k.level + 1)}</span>
              <b style="color:var(--brand-deep)">${esc(k.nickname || '对方')}</b>
              ${k.commentId ? `<span style="color:var(--ink-faint)">· ID ${esc(k.commentId)}</span>` : ''}
              ${k.repliedAt ? `<span style="color:var(--ink-faint)">· ${esc(k.repliedAt)}</span>` : ''}
              <span style="margin-left:auto;color:var(--brand-deep)">回复了你 ↓</span>
            </div>
            <div style="font-size:12.5px;margin-top:3px;color:var(--ink)">${esc(k.content)}</div>
            ${renderChildren(k.commentId, depth + 1)}
          </div>`).join('');
      }
      const hasUnreplied = subs.length > 0 && t.status === 'user_replied';
      // 最新/最深一条（用于回复列摘要）：优先层级深，其次回复时间新
      const latestSub = subs.length
        ? subs.reduce((a, b) => ((b.level > a.level) || (b.level === a.level && (b.repliedAt > a.repliedAt))) ? b : a)
        : null;
      // 对话根块（被切入/回复的那条评论，对方就在它下面接话）
      const l1 = `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft)">
          <span style="display:inline-block;background:var(--ink-soft);color:#fff;border-radius:4px;padding:1px 5px;font-size:10px">原评论</span>
          ${t.account ? `<span style="color:var(--ink-faint)">· ${esc(t.account)}</span>` : ''}
        </div>
        <div style="font-size:13px;font-weight:600;margin-top:3px">${esc(t.commentContent || '(无评论内容)')}</div>
        <div style="font-size:11px;color:var(--ink-faint);margin-top:2px">🎬 ${esc(t.videoTitle || '未知视频')}${t.videoUrl ? ` · <a href="${esc(t.videoUrl)}" target="_blank" rel="noopener" style="color:var(--brand-deep)">打开视频↗</a>` : ''}</div>`;
      // v008：多级回复统计条
      const statHtml = subs.length ? `
        <div style="margin-top:8px;font-size:11px;color:var(--ink-soft)">
          💬 ${subs.length} 条回复 · ${new Set(subs.map((s) => s.nickname)).size} 人参与 · 最深 L${(Math.max.apply(null, subs.map((s) => s.level)) + 1)}
        </div>` : '';
      const treeHtml = renderChildren(rootId, 0);
      // 回复内容列：对方回复展示其最新/最深一条原文，否则展示我们的话术
      const replyCell = t.status === 'user_replied'
        ? (latestSub ? `💬 ${esc(latestSub.content)}` : (t.userReplyContent ? `💬 ${esc(t.userReplyContent)}` : '<span style="color:var(--ink-faint)">（未带回内容）</span>'))
        : (t.replyContent ? esc(t.replyContent) : '<span style="color:var(--ink-faint)">未回复</span>');
      const ops = isPending
        ? `<button type="button" class="btn btn--primary btn--sm" data-reply="${t.id}">选择话术回复</button>`
        : `<button type="button" class="btn btn--sm" data-mark="${t.id}" data-status="user_replied">标记追评</button>
             <button type="button" class="btn btn--sm" data-mark="${t.id}" data-status="user_dm" style="margin-left:4px">标记私信★</button>` +
           (hasUnreplied
             ? `<button type="button" class="btn btn--sm btn--primary" data-continue="${t.id}" style="margin-left:4px">继续回复</button>`
             : '');
      return `<tr ${highlight}>
        <td>${l1}${treeHtml}${statHtml}</td>
        <td><span class="tag tag--${meta.cls}">${esc(meta.label)}</span></td>
        <td style="font-size:12px">${esc(t.account || '—')}</td>
        <td style="font-size:12px;color:var(--ink-soft)">${replyCell}</td>
        <td style="text-align:right;white-space:nowrap">${ops}</td>
      </tr>`;
    }

    main.innerHTML = `
      <div class="view">
        ${pageHead({
          icon: 'dm', title: '评论回复任务', desc: '评论引流策略核心 — 高意向评论一键话术回复，追踪对方追评/私信转化',
          actions: `<span class="tag tag--pending">待回复 ${pending.length}</span>
                    <span class="tag tag--wechat">已转化 ${tracked.filter(t=>t.status==='user_dm').length}</span>`,
        })}

        <!-- 待回复列表 -->
        <div class="card">
          <div class="card__head">
            <span class="card__title">待回复评论</span>
            <span class="card__hint">选择评论话术一键回复，回复后自动进入追踪列表</span>
            <span class="card__spacer"></span>
            <span class="tag tag--pending">${pending.length} 条待处理</span>
          </div>
          ${pending.length > 0 ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>评论内容 / 来源视频</th><th style="width:80px">状态</th><th style="width:110px">负责账号</th><th>回复内容</th><th style="width:140px;text-align:right">操作</th></tr></thead>
              <tbody>${pending.map((t) => taskRow(t, true)).join('')}</tbody>
            </table>
          </div>` : `
          <div class="empty">
            <span class="empty__ico">${ico('check')}</span>
            <p>暂无待回复评论，干得漂亮！</p>
          </div>`}
        </div>

        <!-- 已回复追踪 -->
        <div class="card" style="margin-top:var(--r-md)">
          <div class="card__head">
            <span class="card__title">已回复追踪</span>
            <span class="card__hint">高亮：对方追评（蓝）/ 对方主动私信（绿 ★ 转化成功）</span>
            <span class="card__spacer"></span>
            <span class="tag tag--sent">已回复 ${tracked.filter(t=>t.status==='replied').length}</span>
            <span class="tag tag--replied" style="margin-left:4px">追评 ${tracked.filter(t=>t.status==='user_replied').length}</span>
            <span class="tag tag--wechat" style="margin-left:4px">私信★ ${tracked.filter(t=>t.status==='user_dm').length}</span>
          </div>
          ${tracked.length > 0 ? `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>评论内容 / 来源视频</th><th style="width:90px">状态</th><th style="width:110px">负责账号</th><th>回复内容</th><th style="width:200px;text-align:right">转化标记</th></tr></thead>
              <tbody>${tracked.map((t) => taskRow(t, false)).join('')}</tbody>
            </table>
          </div>` : `
          <div class="empty">
            <span class="empty__ico">${ico('empty')}</span>
            <p>暂无已回复记录</p>
          </div>`}
        </div>
      </div>`;

    // 绑定回复按钮
    $$('[data-reply]', main).forEach((btn) => {
      btn.addEventListener('click', () => {
        const task = allTasks.find((t) => t.id === btn.dataset.reply);
        openReplyModal(btn.dataset.reply, commentScripts, task || {});
      });
    });

    // 绑定「继续回复」：对方已回复，定位到其回复内容（而非原评论）再发新评论
    $$('[data-continue]', main).forEach((btn) => {
      btn.addEventListener('click', () => {
        const task = allTasks.find((t) => t.id === btn.dataset.continue) || {};
        let match = '';
        try {
          const raw = task.subReplies ? JSON.parse(task.subReplies) : [];
          if (raw.length) {
            const list = raw
              .map((r) => ({ content: (r.content || '').trim(), level: r.level || 1, repliedAt: r.replied_at || r.repliedAt || '' }))
              .filter((r) => r.content);
            if (list.length) {
              // 优先层级深、其次回复时间新（续上对话最深入的那个分支）
              const latest = list.reduce((a, b) =>
                ((b.level > a.level) || (b.level === a.level && (b.repliedAt > a.repliedAt))) ? b : a);
              match = latest.content;
            }
          }
        } catch (e) {}
        if (!match && task.userReplyContent) match = task.userReplyContent;
        openReplyModal(btn.dataset.continue, commentScripts, task, match);
      });
    });

    // 绑定状态标记按钮
    $$('[data-mark]', main).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.mark;
        const status = btn.dataset.status;
        const result = await API.updateCommentTask(id, { status });
        if (result && result.ok !== false) {
          toast(status === 'user_dm' ? '已标记对方主动私信 ★ 转化成功！' : '已标记对方追评', 'ok');
          route(); // 重新渲染当前Tab
        }
      });
    });
  }

  /* 回复话术选择弹窗 */
  /* ═══════════════════════════════════════════
     批量回复：把选中的评论任务逐条真实发送到抖音
     每条先取内容（按权重自动挑 / 指定话术变体），再调 /comments/execute(confim=true)
     ═══════════════════════════════════════════ */
  function openBatchReplyModal(ids, commentScripts, allTasks) {
    const tasks = ids.map((id) => allTasks.find((t) => t.id === id)).filter(Boolean);
    if (!tasks.length) { toast('没有选中任何待回复评论', 'warn'); return; }

    // mode: auto=每条各自按权重挑 / script=所有条用同一条指定变体
    let mode = 'auto';
    let scriptId = null;
    let variantId = null;
    let interval = 8;          // 每条之间的间隔秒数，降低频控风险
    let running = false;
    let finished = false;
    let results = [];          // { task, ok, msg, text }
    let stopped = false;

    const variantsOf = (s) => ((s && s.variants) || []).filter((v) => v.status === 'active');
    const chosenScript = () => commentScripts.find((s) => s.id === scriptId) || null;
    const chosenVariant = () => variantsOf(chosenScript()).find((v) => v.id === variantId) || null;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function render() {
      const okN = results.filter((r) => r.ok).length;
      const body = !running && !finished
        ? pickHtml()
        : progressHtml(okN);
      const foot = !running && !finished
        ? `<button type="button" class="btn" data-close>取消</button>
           <button type="button" class="btn btn--primary" id="bstart" ${mode === 'script' && !chosenVariant() ? 'disabled' : ''}>开始发送 ${tasks.length} 条</button>`
        : (running
          ? `<button type="button" class="btn" id="bstop">停止（发完当前这条）</button>`
          : `<button type="button" class="btn btn--primary" data-close>完成并刷新</button>`);
      openModal(`
        <h2 id="modal-title">批量回复 ${tasks.length} 条评论</h2>
        <p class="modal__lede">逐条真实提交到抖音，请保持自动化浏览器已启动并登录。每条之间间隔 ${interval} 秒。</p>
        ${body}
        <div class="modal__foot">${foot}</div>`);

      if (!running && !finished) bindPick();
      else if (running) $('#bstop')?.addEventListener('click', () => { stopped = true; });
      else $$('[data-close]').forEach((b) => b.addEventListener('click', () => route()));
    }

    function pickHtml() {
      return `
        <div class="field">
          <label>回复内容来源</label>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:4px">
            <label style="display:inline-flex;align-items:center;gap:5px;font-weight:400">
              <input type="radio" name="bmode" value="auto" ${mode === 'auto' ? 'checked' : ''}> 按权重自动挑（每条各挑一条，最不容易重复）
            </label>
            <label style="display:inline-flex;align-items:center;gap:5px;font-weight:400">
              <input type="radio" name="bmode" value="script" ${mode === 'script' ? 'checked' : ''}> 指定同一条话术变体
            </label>
          </div>
        </div>
        ${mode === 'script' ? `
        <div class="field">
          <label for="bscript">选择话术</label>
          <select id="bscript">
            <option value="">— 请选择 —</option>
            ${commentScripts.map((s) => `<option value="${esc(s.id)}" ${s.id === scriptId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </div>
        ${chosenScript() ? `
        <div class="field">
          <label for="bvariant">选择变体</label>
          <select id="bvariant">
            <option value="">— 请选择 —</option>
            ${variantsOf(chosenScript()).map((v) => `<option value="${esc(v.id)}" ${v.id === variantId ? 'selected' : ''}>变体${esc(v.id)} · ${esc((v.text || '').slice(0, 30))}${(v.text || '').length > 30 ? '…' : ''}</option>`).join('')}
          </select>
        </div>` : ''}` : ''}
        <div class="field">
          <label for="binterval">每条间隔（秒）</label>
          <input type="number" id="binterval" value="${interval}" min="0" max="600">
        </div>
        <div class="field">
          <label>本次将发送（${tasks.length} 条）</label>
          <div style="max-height:190px;overflow:auto;border:1px solid var(--line);border-radius:8px">
            ${tasks.map((t) => `<div style="display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--line);font-size:12px">
              <b style="min-width:74px">${esc(t.commentAuthor || '未知')}</b>
              <span style="flex:1;min-width:0;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.commentContent || '')}</span>
              <span style="color:var(--ink-faint);white-space:nowrap">${esc(t.videoTitle || (t.videoId ? '视频 ' + t.videoId : ''))}</span>
            </div>`).join('')}
          </div>
        </div>`;
    }

    function progressHtml(okN) {
      const pct = tasks.length ? Math.round((results.length / tasks.length) * 100) : 0;
      return `
        <div class="progress-bar" style="margin:6px 0 10px"><div class="progress-bar__fill" style="width:${pct}%"></div></div>
        <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:8px">
          已完成 <b>${results.length}</b> / ${tasks.length} · 成功 <b style="color:var(--ok)">${okN}</b> · 失败 <b style="color:var(--danger)">${results.length - okN}</b>
          ${running ? ' · 发送中，请勿关闭浏览器…' : ''}
        </div>
        <div style="max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:8px">
          ${results.map((r) => `<div style="display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-bottom:1px solid var(--line);font-size:12px">
            <span style="color:${r.ok ? 'var(--ok)' : 'var(--danger)'};white-space:nowrap">${r.ok ? '✓ 已发送' : '✗ 失败'}</span>
            <b style="min-width:74px">${esc(r.task.commentAuthor || '未知')}</b>
            <span style="flex:1;min-width:0;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.msg)}">${esc(r.msg)}</span>
          </div>`).join('') || '<div style="padding:14px;text-align:center;color:var(--ink-faint);font-size:12.5px">准备中…</div>'}
        </div>`;
    }

    function bindPick() {
      $$('input[name="bmode"]').forEach((r) => r.addEventListener('change', () => {
        mode = r.value;
        if (mode === 'script' && !scriptId && commentScripts.length) {
          scriptId = commentScripts[0].id;
          const v0 = variantsOf(commentScripts[0])[0];
          variantId = v0 ? v0.id : null;
        }
        render();
      }));
      const bs = $('#bscript');
      if (bs) bs.addEventListener('change', () => {
        scriptId = bs.value || null;
        const v0 = variantsOf(chosenScript())[0];
        variantId = v0 ? v0.id : null;
        render();
      });
      const bv = $('#bvariant');
      if (bv) bv.addEventListener('change', () => { variantId = bv.value || null; render(); });
      const bi = $('#binterval');
      if (bi) bi.addEventListener('change', () => { interval = Math.max(0, parseInt(bi.value, 10) || 0); });
      $('#bstart')?.addEventListener('click', async () => {
        if (mode === 'script' && !chosenVariant()) { toast('请先选择话术变体', 'warn'); return; }
        try {
          const st = await API.commentAgentStatus();
          if (!st || st.ok === false || !st.cdpReady) {
            toast('自动化浏览器未启动，请先点「启动浏览器并登录」', 'warn');
            return;
          }
          if (st.loggedIn === false) { toast('浏览器已启动但抖音未登录，请先扫码登录', 'warn'); return; }
        } catch (e) { /* 状态取不到不阻断，由发送结果兜底 */ }
        if (!window.confirm(`确认向 ${tasks.length} 条评论真实发送回复？发送后无法撤回。`)) return;
        await run();
      });
    }

    async function run() {
      running = true; finished = false; results = []; stopped = false;
      render();
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        let text = '', sId, vId;
        try {
          if (mode === 'script') {
            const v = chosenVariant();
            text = v.text; sId = chosenScript().id; vId = v.id;
          } else {
            const pick = await API.pickCommentScript();
            if (!pick || pick.ok === false || !pick.text) throw new Error((pick && pick.message) || '没有可用的评论话术');
            text = pick.text; sId = pick.scriptId; vId = pick.variantId;
          }
          // 单条发送 20–200s，超时放到 180s
          const res = await API.commentExecute({
            taskId: t.id, text, confirm: true,
            match: t.commentContent || '',
            scriptId: sId || undefined, variantId: vId || undefined,
          }, 180000);
          const ok = !!(res && res.status === 'accepted');
          results.push({ task: t, ok, msg: ok ? '已发送' : ((res && res.message) || '未确认发送成功'), text });
        } catch (e) {
          results.push({ task: t, ok: false, msg: e.message || '发送异常', text });
        }
        render();
        if (stopped) break;
        if (i < tasks.length - 1 && interval > 0) await sleep(interval * 1000);
      }
      running = false; finished = true;
      render();
      const okN = results.filter((r) => r.ok).length;
      toast(`批量回复完成：成功 ${okN} / ${results.length} 条`, okN ? 'ok' : 'warn');
      interactSel.clear();
    }

    render();
  }

  function openReplyModal(taskId, commentScripts, task = {}, matchOverride = '') {
    let selectedScript = null;
    let selectedVariant = null;
    let aiSuggestions = null;
    let aiLoading = false;
    let selectedAiContent = null;

    // 内容来源：auto = 按权重自动挑 / script = 话术库手选 / ai = AI 建议
    let mode = 'auto';
    let picked = null;          // 自动挑选结果 {scriptId, variantId, scriptName, text, weight}

    // 流程状态：pick 选内容 → working 定位/发送中 → sent 已发送 / failed 未成功
    let phase = 'pick';
    let workingLabel = '';
    let previewResult = null;
    let sendResult = null;
    let sendError = '';
    let replyContent = '';
    let replyVariant = '';      // 本次实际使用的话术/变体，用于结果展示
    let aiGuard = null;          // 话术质检结果（候选池已移除质检，统一在评论回复这里做）

    async function loadAiSuggestions() {
      if (!(await aiEnsureConfigured())) return;
      aiLoading = true; renderModal();
      try {
        const result = await API.aiCommentSuggestion({
          comment: task.commentContent || '',
          video_title: task.videoTitle || '',
          source_keyword: '',
        });
        aiSuggestions = result.suggestions || [];
      } catch (e) {
        aiHandleError(e);
        aiSuggestions = [];
      } finally {
        aiLoading = false; renderModal();
      }
    }

    // 本次选中的回复内容与来源（供发送与话术归因）
    function currentReplyPayload() {
      if (mode === 'auto') {
        return picked
          ? { text: picked.text, scriptId: picked.scriptId, variantId: picked.variantId,
              label: picked.scriptName + ' · 变体' + picked.variantId }
          : null;
      }
      if (mode === 'ai') {
        return selectedAiContent
          ? { text: selectedAiContent, scriptId: null, variantId: null, label: 'AI 生成' }
          : null;
      }
      const script = commentScripts.find((s) => s.id === selectedScript);
      const variant = script?.variants.find((v) => v.id === selectedVariant);
      return variant
        ? { text: variant.text, scriptId: script.id, variantId: variant.id,
            label: script.name + ' · 变体' + variant.id }
        : null;
    }

    // 唯一发送出口：confirm=false 只定位并填入草稿，true 真实提交到抖音
    async function runSend(payload, confirm) {
      // 发送前把 {变量} 按当前业务画像实时解析（P1：画像→话术 贯通）
      const ctx = await ensureProfileCtx();
      const resolvedText = resolveProfileVars(payload.text, ctx);
      replyContent = resolvedText;
      replyVariant = payload.label || '';
      phase = 'working';
      workingLabel = confirm ? '正在定位评论并发送到抖音' : '正在定位目标评论';
      renderModal();
      const res = await API.commentExecute({
        taskId,
        text: resolvedText,
        confirm,
        match: matchOverride || task.commentContent || '',
        scriptId: payload.scriptId || undefined,
        variantId: payload.variantId || undefined,
      });
      sendResult = res || null;
      sendError = '';
      if (!confirm) {
        if (!res || res.ok === false || res.status === 'error') {
          phase = 'failed';
          sendError = (res && res.message) || '预览失败，请检查自动化浏览器是否已启动并登录抖音';
          renderModal();
          return;
        }
        previewResult = res;
        phase = 'previewed';
        renderModal();
        return;
      }
      if (res && res.status === 'accepted') {
        phase = 'sent';
        toast('评论已发送到抖音', 'ok');
      } else {
        phase = 'failed';
        sendError = (res && res.message) || '发送结果未知，请到抖音手动核查后再决定是否重试';
      }
      renderModal();
      // 发送成功后刷新列表与待办计数；未成功则保留弹窗让用户看清原因
      if (phase === 'sent') setTimeout(route, 600);
    }

    // 按权重挑一条评论话术；失败时进入失败态并返回 null
    async function autoPick() {
      phase = 'working';
      workingLabel = '正在按权重挑选话术';
      renderModal();
      const pick = await API.pickCommentScript();
      if (!pick || pick.ok === false || !pick.text) {
        phase = 'failed';
        sendError = (pick && pick.message)
          || '没有可用的评论类话术：请先在话术库创建 category=comment 的话术';
        renderModal();
        return null;
      }
      picked = pick;
      return { text: pick.text, scriptId: pick.scriptId, variantId: pick.variantId,
               label: pick.scriptName + ' · 变体' + pick.variantId };
    }

    // 一键：按权重挑一条评论话术，直接定位并发送（不再二次确认）
    async function doAutoSend() {
      const payload = await autoPick();
      if (payload) await runSend(payload, true);
    }

    // 按权重挑一条，但只定位填入草稿，不发送（发之前想先看看挑到什么）
    async function doAutoPreview() {
      const payload = await autoPick();
      if (payload) await runSend(payload, false);
    }

    function outcomeHtml(res, accepted, errorMsg) {
      const statusLabel = {
        accepted: '平台已接受',
        rejected: '平台拒绝',
        unknown: '结果未知',
        error: '执行失败',
      }[res && res.status] || '执行失败';
      const lines = [
        ['来源视频', res && res.videoUrl ? res.videoUrl : (task.videoTitle || '—')],
        ['定位评论', task.commentContent || (res && res.match) || '—'],
        ['使用话术', replyVariant || '—'],
        ['回复内容', replyContent || '—'],
        ['返回结果', statusLabel + (res && res.commentId ? '（评论ID ' + res.commentId + '）' : '')],
      ];
      return `
        <div class="reply-outcome reply-outcome--${accepted ? 'ok' : 'warn'}">
          <div class="reply-outcome__head">${accepted
            ? '抖音已接受这条回复'
            : '这次没有确认发送成功'}</div>
          <div class="reply-confirm-box">
            ${lines.map(([k, v]) => `<div class="reply-confirm-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}
          </div>
          ${errorMsg ? `<p class="reply-outcome__msg">${esc(errorMsg)}</p>` : ''}
          ${accepted
            ? '<p class="reply-confirm-note">公开可见性可能需要刷新或展开「X 条回复」后确认，系统不会再重复发送同一内容。</p>'
            : '<p class="reply-confirm-note">为避免重复评论，同一内容的发送记录已被锁定。请先到抖音确认是否真的没发出去，再决定处理方式。</p>'}
        </div>`;
    }

    function renderModal() {
      const scriptsHtml = commentScripts.length > 0 ? commentScripts.map((s) => `
        <div class="radio-card ${selectedScript === s.id ? 'radio-card--checked' : ''}" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;${selectedScript === s.id ? 'border-color:var(--brand);background:var(--brand-tint-2)' : ''}">
          <label style="cursor:pointer;display:block">
            <input type="radio" name="reply-script" value="${s.id}" ${selectedScript === s.id ? 'checked' : ''} style="margin-right:6px">
            <strong>${esc(s.name)}</strong>
            <div style="font-size:11px;color:var(--ink-faint);margin-top:2px">${esc(s.intro || '')}</div>
          </label>
          ${selectedScript === s.id ? `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
            <div style="font-size:12px;font-weight:600;margin-bottom:6px">选择变体：</div>
            ${s.variants.filter((v) => v.status === 'active').map((v) => `
              <label style="display:block;padding:6px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;${selectedVariant === v.id ? 'background:var(--brand-tint);border:1px solid var(--brand)' : 'border:1px solid transparent'}">
                <input type="radio" name="reply-variant" value="${v.id}" ${selectedVariant === v.id ? 'checked' : ''} style="margin-right:6px">
                <span style="font-family:var(--font-display);font-weight:700">变体${v.id}</span>
                <span style="font-size:11px;color:var(--ink-faint);margin-left:6px">权重${v.weight}% · 转化率${v.convRate != null ? v.convRate + '%' : '—'}</span>
                <div style="font-size:12px;color:var(--ink);margin-top:4px;line-height:1.5">${esc(v.text)}</div>
              </label>`).join('')}
          </div>` : ''}
        </div>`).join('') : '<p style="color:var(--ink-faint);font-size:13px">暂无评论类话术，请先在话术库创建 category=comment 的话术</p>';

      const aiHtml = aiLoading
        ? '<div style="color:var(--ink-soft);font-size:13px;padding:20px;text-align:center">AI 正在生成回复建议…</div>'
        : aiSuggestions && aiSuggestions.length > 0
          ? aiSuggestions.map((s) => `
            <label style="display:block;padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:8px;border:1px solid ${selectedAiContent === s.content ? 'var(--brand)' : 'var(--line)'};background:${selectedAiContent === s.content ? 'var(--brand-tint-2)' : 'transparent'}">
              <input type="radio" name="ai-suggestion" value="${esc(s.content)}" ${selectedAiContent === s.content ? 'checked' : ''} style="margin-right:6px">
              <span class="tag tag--low" style="margin-right:6px">${esc(s.label)}</span>
              <span style="font-size:13px;line-height:1.6">${esc(s.content)}</span>
            </label>`).join('')
          : '<div style="color:var(--ink-faint);font-size:13px;padding:16px;text-align:center">点击上方「AI 生成回复」按钮获取建议</div>';

      // 定位中 / 发送中：等待态
      if (phase === 'working') {
        const sending = workingLabel.indexOf('发送') >= 0;
        openModal(`
          <h2 id="modal-title">${esc(workingLabel)}</h2>
          <div class="reply-progress">
            <div class="reply-progress__bar"><span></span></div>
            <p>${sending
              ? '正在打开视频、滚动评论区、定位这条评论并提交，请不要关闭自动化浏览器…'
              : '正在打开视频、滚动评论区、定位这条评论，并把回复填入草稿…'}</p>
            <p class="reply-progress__hint">${sending
              ? '请勿重复点击，同一内容不会重复提交。'
              : '首次定位通常需要 20–40 秒；若浏览器里弹出验证码，请先手动完成再重试。'}</p>
          </div>
          <div class="modal__foot">
            <button type="button" class="btn" data-close>切换到后台</button>
          </div>`);
        return;
      }

      // 结果态：已发送 / 未确认成功
      if (phase === 'sent' || phase === 'failed') {
        const accepted = phase === 'sent';
        openModal(`
          <h2 id="modal-title">${accepted ? '评论已发送' : '评论未确认发送'}</h2>
          ${outcomeHtml(sendResult, accepted, sendError)}
          <div class="modal__foot">
            <button type="button" class="btn" data-close>关闭</button>
            ${accepted ? '' : '<button type="button" class="btn" id="reply-start-browser">启动自动化浏览器</button>'}
            ${accepted ? '' : '<button type="button" class="btn btn--primary" id="reply-back">返回修改</button>'}
          </div>`);
        $('#reply-back')?.addEventListener('click', () => { phase = 'pick'; sendError = ''; renderModal(); });
        $('#reply-start-browser')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          toast('正在启动自动化浏览器，请在弹出的窗口中扫码登录…', 'ok');
          const s = await API.commentAgentStartBrowser();
          btn.disabled = false;
          if (s && s.loggedIn === true) {
            toast('浏览器已就绪，可以重新尝试发送', 'ok');
            phase = 'pick'; sendError = ''; renderModal();
          } else if (s && s.cdpReady) {
            toast('浏览器已打开，请先扫码登录抖音再重试', 'warn');
          } else {
            toast((s && s.message) || '浏览器启动失败', 'warn');
          }
        });
        return;
      }

      // 预览确认态：草稿已在浏览器中填好，等用户点「确认发送」
      if (phase === 'previewed') {
        openModal(`
          <h2 id="modal-title">确认发送到抖音</h2>
          <div class="reply-confirm-box">
            <div class="reply-confirm-row"><span>目标账号</span><b>${esc(task.account || '当前登录账号')}</b></div>
            <div class="reply-confirm-row"><span>来源视频</span><b>${esc(previewResult.videoUrl || '—')}</b></div>
            <div class="reply-confirm-row"><span>定位到的评论</span><b>${esc(task.commentContent || previewResult.match || '—')}</b></div>
            ${previewResult.author ? `<div class="reply-confirm-row"><span>评论作者</span><b>${esc(previewResult.author)}</b></div>` : ''}
            ${previewResult.replyMode ? '<div class="reply-confirm-row"><span>回复对象校验</span><b>已锁定该评论的回复框</b></div>' : ''}
            ${replyVariant ? `<div class="reply-confirm-row"><span>使用话术</span><b>${esc(replyVariant)}</b></div>` : ''}
            <div class="reply-confirm-row"><span>已加载评论</span><b>${previewResult.visibleComments != null ? previewResult.visibleComments + ' 条' : '—'}</b></div>
          </div>
          <div class="reply-confirm-text">${esc(replyContent)}</div>
          <p class="reply-confirm-note">已在浏览器中定位到这条评论，内容已填入草稿。点击「确认发送」才会真正提交到抖音。</p>
          <div class="modal__foot">
            <button type="button" class="btn" id="reply-back">返回修改</button>
            <button type="button" class="btn btn--primary" id="reply-send">确认发送</button>
          </div>`);
        $('#reply-back')?.addEventListener('click', () => { phase = 'pick'; renderModal(); });
        $('#reply-send')?.addEventListener('click', () => {
          const payload = currentReplyPayload();
          if (payload) runSend(payload, true);
        });
        return;
      }

      // phase === 'pick'：选内容并发送
      const tabCls = (m) => (mode === m ? 'btn--primary' : 'btn--ghost');
      const manualReady = mode === 'auto' ? true : !!currentReplyPayload();
      const guardHtml = aiGuard ? `<div class="cg-guardresult" style="margin:10px 0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:12px">
        ${aiGuard.loading ? '<span class="muted">质检中…</span>'
          : aiGuard.error ? `<span class="tag tag--failed">质检出错</span> <span class="muted">${esc(aiGuard.error)}</span>`
          : `<span class="tag ${aiGuard.pass ? 'tag--healthy' : 'tag--failed'}">${aiGuard.pass ? '质检通过' : '未通过'}</span>
             <span class="muted">禁止 ${fmt(aiGuard.blockCount || 0)} · 提示 ${fmt(aiGuard.warnCount || 0)}</span>
             ${(aiGuard.hits || []).map((h) => `<div class="muted" style="margin-top:2px">${esc(h.category || '未分类')}：命中「${esc(h.matched || '')}」${h.advice ? '（' + esc(h.advice) + '）' : ''}</div>`).join('')}`}
      </div>` : '';

      openModal(`
        <h2 id="modal-title">回复这条评论</h2>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button type="button" class="btn btn--sm ${tabCls('auto')}" id="tab-auto">按权重自动</button>
          <button type="button" class="btn btn--sm ${tabCls('script')}" id="tab-script">话术库</button>
          <button type="button" class="btn btn--sm ${tabCls('ai')}" id="tab-ai" style="border-color:var(--brand);color:var(--brand-deep)">
            <span class="ico ico--sm" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-rocket"/></svg></span>AI 生成
          </button>
        </div>
        <div id="panel-auto" style="${mode === 'auto' ? '' : 'display:none'}">
          <div class="reply-confirm-box" style="margin-bottom:10px">
            <div class="reply-confirm-row"><span>挑选方式</span><b>按话术变体权重自动轮换</b></div>
            ${picked ? `<div class="reply-confirm-row"><span>上次挑到</span><b>${esc(picked.scriptName)} · 变体${esc(picked.variantId)}</b></div>` : ''}
          </div>
          <p class="reply-confirm-note" style="margin-top:0">点「按权重挑一条并发送」会直接定位评论并提交到抖音，不再二次确认。</p>
        </div>
        <div id="panel-script" style="${mode === 'script' ? '' : 'display:none'}">
          <div style="max-height:40vh;overflow-y:auto;margin-bottom:12px">
            ${scriptsHtml}
          </div>
        </div>
        <div id="panel-ai" style="${mode === 'ai' ? '' : 'display:none'}">
          <button type="button" class="btn btn--ghost btn--sm" id="btn-ai-generate" style="margin-bottom:10px;width:100%;border-color:var(--brand);color:var(--brand-deep)">
            ${aiLoading ? '生成中…' : '重新生成 AI 回复建议'}
          </button>
          <div style="max-height:35vh;overflow-y:auto">
            ${aiHtml}
          </div>
        </div>
        <p class="reply-confirm-note">「仅预览」只打开自动化浏览器定位这条评论并填入草稿，不发送；「发送」才会真正提交到抖音。发送前可先点「质检话术」检查是否触规。</p>
        ${guardHtml}
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--ghost" id="reply-guard" ${!manualReady ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>质检话术</button>
          <button type="button" class="btn btn--ghost" id="reply-preview" ${!manualReady ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>仅预览</button>
          <button type="button" class="btn btn--primary" id="reply-confirm" ${!manualReady ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>${mode === 'auto' ? '按权重挑一条并发送' : '定位并发送'}</button>
        </div>`);

      // Tab 切换
      $('#tab-auto')?.addEventListener('click', () => {
        mode = 'auto';
        selectedScript = null; selectedVariant = null; selectedAiContent = null;
        renderModal();
      });
      $('#tab-script')?.addEventListener('click', () => {
        mode = 'script'; selectedAiContent = null; renderModal();
      });
      $('#tab-ai')?.addEventListener('click', () => {
        mode = 'ai';
        selectedScript = null; selectedVariant = null;
        if (!aiSuggestions && !aiLoading) loadAiSuggestions();
        selectedAiContent = aiSuggestions && aiSuggestions[0] ? aiSuggestions[0].content : null;
        renderModal();
      });
      $('#btn-ai-generate')?.addEventListener('click', loadAiSuggestions);

      // 绑定话术选择
      $$('input[name="reply-script"]').forEach((inp) => {
        inp.addEventListener('change', () => { selectedScript = inp.value; selectedVariant = null; renderModal(); });
      });
      $$('input[name="reply-variant"]').forEach((inp) => {
        inp.addEventListener('change', () => { selectedVariant = inp.value; renderModal(); });
      });
      $$('input[name="ai-suggestion"]').forEach((inp) => {
        inp.addEventListener('change', () => { selectedAiContent = inp.value; renderModal(); });
      });

      // 主按钮：自动模式一键挑+发；手动模式发送所选内容
      $('#reply-confirm')?.addEventListener('click', () => {
        if (mode === 'auto') { doAutoSend(); return; }
        const payload = currentReplyPayload();
        if (payload) runSend(payload, true);
      });
      // 次按钮：只定位并填入草稿，不发送
      $('#reply-preview')?.addEventListener('click', () => {
        if (mode === 'auto') { doAutoPreview(); return; }
        const payload = currentReplyPayload();
        if (payload) runSend(payload, false);
      });
      $('#reply-guard')?.addEventListener('click', async () => {
        const payload = currentReplyPayload();
        if (!payload || !payload.text) { toast('请先选择或生成话术再质检', 'warn'); return; }
        aiGuard = { loading: true };
        renderModal();
        try {
          aiGuard = await API.guardCheck(payload.text, task.account || undefined);
        } catch (e) {
          aiGuard = { error: (e && e.message) ? e.message : String(e) };
        }
        renderModal();
      });
    }

    renderModal();
  }

  /** 一条话术（含变体 + 欢迎语）实际用到了哪些画像变量 */
  function scriptVarsOf(s) {
    if (!s) return [];
    const all = (s.variants || []).map((v) => v.text || '').join('\n') + '\n' + (s.welcomeMsg || '');
    return detectUsedVars(all);
  }

  /** 话术卡（精简版）：变体压成单行、点行展开全文。
      2026-09-13 精简：原卡片 454~613px（变体行各占 113~135px）→ 约 200px。
      ⚠️ r2Threshold 必须由调用方传入：它是 viewScripts 的局部变量，
      写成自由变量只在 convRate 全为 null 时不炸（短路），一旦有转化率数据就整页报错。 */
  function scriptCard(s, r2Threshold) {
    const r2 = r2Threshold == null ? 8 : r2Threshold;
    const vs = s.variants || [];
    const allText = vs.map((v) => v.text).join('\n') + '\n' + (s.welcomeMsg || '');
    const usedVars = detectUsedVars(allText);
    const catLabel = (SCRIPT_TABS.find((t) => t.key === s.category) || {}).label || s.category;
    const convs = vs.map((v) => v.convRate).filter((x) => x != null);
    const bestConv = convs.length ? Math.max.apply(null, convs) : null;

    const variantsHtml = vs.length ? vs.map((v) => {
      const meta = { active: ['使用中', 'is-on'], switched_off: ['已停用', 'is-off'], draft: ['草稿', 'is-draft'] }[v.status] || [v.status, ''];
      const conv = v.convRate != null ? v.convRate + '%' : '—';
      const low = v.convRate != null && v.convRate < r2;
      const tip = `发送 ${fmt(v.sent)} / 回复 ${fmt(v.replied)}`
        + (v.wechatAdded != null ? ` / 加微 ${fmt(v.wechatAdded)}` : '')
        + ` · 加微转化率 ${conv}`;
      return `
        <div class="svrow">
          <span class="svrow__id">${esc(v.id)}</span>
          <span class="svrow__tag ${meta[1]}">${esc(meta[0])}</span>
          <span class="svrow__text" data-raw="${esc(v.text)}" title="点击展开 / 收起全文">${esc(v.text)}</span>
          <span class="svrow__meta">
            <span class="svrow__w" title="权重（A/B 分配比例）">${v.weight}%</span>
            <span class="svrow__conv${low ? ' is-low' : ''}" title="${esc(tip)}">${conv}</span>
            ${v.r2Note ? `<span class="svrow__r2" title="${esc('变体按权重随机分配：' + v.r2Note)}">⚑</span>` : ''}
          </span>
        </div>`;
    }).join('') : '<div class="svrow svrow--empty">还没有变体，点「编辑」加一条。</div>';

    const varTags = usedVars.length
      ? `<span class="sc-foot__vars">绑定画像：${usedVars.map((k) => `<span class="var-chip var-chip--sm">{${esc(k)}}</span>`).join('')}</span>`
      : '';
    const welcome = (s.welcomeMsg || '').trim();

    return `
      <div class="card script-card${s.active === false ? ' is-off' : ''}" data-script-id="${esc(s.id)}">
        <div class="sc-head">
          <span class="sc-head__name" title="${esc(s.intro || '')}">${esc(s.name)}</span>
          ${s.isMain ? '<span class="tag tag--deal">主话术</span>' : ''}
          ${s.source === 'generated' ? '<span class="tag tag--brand">画像生成</span>' : ''}
          ${s.source === 'imported' ? '<span class="tag tag--brand">文件导入</span>' : ''}
          ${s.active === false ? '<span class="tag tag--failed">已停用</span>' : ''}
          <span class="tag tag--low">${esc(catLabel)}</span>
          <span class="card__spacer"></span>
          <span class="sc-head__meta">${vs.length} 变体${bestConv != null ? ' · 转化 ' + bestConv + '%' : ''}</span>
          <button type="button" class="btn btn--sm btn--ai" data-script-ai="${esc(s.id)}" title="勾选画像变量 → AI 按这些变量改写本条话术">AI 优化</button>
          <button type="button" class="btn btn--sm" data-script-edit="${esc(s.id)}">编辑</button>
          <button type="button" class="btn btn--sm" data-script-preview="${esc(s.id)}" title="用当前业务画像解析话术里的 {变量}">预览</button>
        </div>
        <div class="sc-vbox">${variantsHtml}</div>
        ${(varTags || welcome) ? `<div class="sc-foot">
          ${varTags}
          ${welcome ? `<span class="sc-foot__welcome" title="${esc(welcome)}">企微欢迎语：${esc(welcome.length > 36 ? welcome.slice(0, 36) + '…' : welcome)}</span>` : ''}
        </div>` : ''}
        <div class="scr-preview" id="scr-prev-${esc(s.id)}" hidden></div>
      </div>`;
  }

  /* ═══════════════════════════════════════════
     AI 话术优化面板（话术卡弹窗 / 编辑弹窗共用）

     用户勾选要参与的画像变量 → AI 只基于这些变量改写现有变体或追加新变体。
     输出保留 {变量} 占位符（不把画像值写死），所以画像改了话术自动跟着变。
     只产出草稿：勾选 + 可编辑，点「应用」才写回（写回方式由 onApply 决定）。
     ═══════════════════════════════════════════ */
  async function mountAiOptimize(host, opts) {
    const script = opts.script || {};
    const ctx = opts.ctx || await ensureProfileCtx();
    const getVariants = opts.getVariants || (() => []);
    const onApply = opts.onApply || (() => {});
    const used = scriptVarsOf(script);           // 本条话术已用的变量 → 默认勾上

    const groupsHtml = Object.keys(VAR_SRC).map((g) => {
      const list = SCRIPT_VARS.filter((v) => v.src === g);
      if (!list.length) return '';
      const chips = list.map((v) => {
        const val = String(v.get(ctx) || '').trim();
        const on = used.includes(v.key);
        const short = val.length > 14 ? val.slice(0, 14) + '…' : val;
        return `<label class="vchk${on ? ' is-on' : ''}${val ? '' : ' is-empty'}"
            title="${esc(VAR_SRC[g].label + ' · ' + v.label + '：' + (val || '画像里还没填这一项'))}">
          <input type="checkbox" data-v="${esc(v.key)}"${on ? ' checked' : ''}>
          <span class="vchk__k">{${esc(v.key)}}</span>
          <span class="vchk__v">${esc(short || '未填')}</span>
        </label>`;
      }).join('');
      return `<div class="vgroup"><span class="vgroup__name">${esc(VAR_SRC[g].label)}</span><div class="vgroup__chips">${chips}</div></div>`;
    }).join('');

    host.innerHTML = `
      <div class="aio">
        <div class="aio__sec">
          <div class="aio__hd">① 参与本次优化的画像变量
            <span class="aio__hint">已选 <b id="aio-n">${used.length}</b> 个 · 标「未填」的 AI 用不上，先去画像里填</span>
          </div>
          <div class="aio__vars" id="aio-vars">${groupsHtml}</div>
        </div>
        <div class="aio__sec">
          <div class="aio__hd">② 模式</div>
          <div class="aio__modes">
            <label class="aio__mode"><input type="radio" name="aio-mode" value="optimize" checked>
              <span>优化现有变体</span><em>每条给一版新的，变体编号不变</em></label>
            <label class="aio__mode"><input type="radio" name="aio-mode" value="new">
              <span>追加新变体</span><em><input type="number" id="aio-count" value="2" min="1" max="3"> 条（A/B 用）</em></label>
          </div>
        </div>
        <div class="aio__acts">
          <button type="button" class="btn btn--primary btn--sm" id="aio-run">生成优化方案</button>
          <button type="button" class="btn btn--sm" id="aio-again" hidden>换一批</button>
          <span class="aio__tip" id="aio-tip"></span>
        </div>
        <div class="aio__out" id="aio-out"></div>
      </div>`;

    const out = $('#aio-out', host);
    const tip = $('#aio-tip', host);
    const runBtn = $('#aio-run', host);
    const againBtn = $('#aio-again', host);
    let lastDrafts = [];

    // 勾选态：改 .vchk 的 is-on（样式）+ 更新计数
    $$('#aio-vars .vchk', host).forEach((lb) => {
      const cb = lb.querySelector('input[data-v]');
      cb.addEventListener('change', () => {
        lb.classList.toggle('is-on', cb.checked);
        $('#aio-n', host).textContent = $$('#aio-vars input[data-v]', host).filter((x) => x.checked).length;
      });
    });

    const selected = () => $$('#aio-vars input[data-v]', host).filter((x) => x.checked).map((x) => x.dataset.v);
    const mode = () => (host.querySelector('input[name="aio-mode"]:checked') || {}).value || 'optimize';

    const renderOut = (data) => {
      lastDrafts = data.drafts || [];
      const miss = data.missing || [];
      out.innerHTML = `
        ${miss.length ? `<div class="aio__warn">⚠️ 勾了但画像里没值：${miss.map((k) => esc('{' + k + '}')).join(' ')} — AI 已跳过，去「业务画像」补填后重生成更准。</div>` : ''}
        <div class="aio__list">
          ${lastDrafts.map((d, i) => `
            <div class="aio-draft" data-i="${i}">
              <div class="aio-draft__hd">
                <label class="aio-draft__pick"><input type="checkbox" data-pick checked> 采用</label>
                <span class="aio-draft__id">${esc(d.variantId)}${d.isNew ? ' · 新增' : ''}</span>
                <span class="card__spacer"></span>
                <button type="button" class="btn btn--sm" data-copy-draft>复制</button>
              </div>
              ${d.isNew ? '' : `<div class="aio-draft__old" title="原文">原文：${esc(d.old || '')}</div>`}
              <textarea class="aio-draft__text" data-text rows="2">${esc(d.text)}</textarea>
              <div class="aio-draft__prev" data-prev></div>
            </div>`).join('')}
        </div>
        <div class="aio__foot">
          <button type="button" class="btn btn--primary btn--sm" id="aio-apply">应用选中的 ${lastDrafts.length} 条</button>
          <span class="aio__hint">应用到话术后仍可编辑；新变体默认「草稿 + 权重 0」，设好权重再启用。</span>
        </div>`;

      const repaintPrev = () => {
        $$('.aio-draft', out).forEach((row) => {
          const ta = row.querySelector('[data-text]');
          const pv = row.querySelector('[data-prev]');
          const draw = () => {
            const t = ta.value.trim();
            pv.innerHTML = t
              ? `<span class="aio-draft__plabel">发送时解析：</span>${esc(resolveProfileVars(t, ctx)).replace(/\n/g, '<br>')}`
              : '';
          };
          ta.addEventListener('input', draw);
          draw();
        });
      };
      repaintPrev();

      out.querySelectorAll('[data-copy-draft]').forEach((b) => b.addEventListener('click', (e) => {
        const row = e.currentTarget.closest('.aio-draft');
        const t = row.querySelector('[data-text]').value;
        navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t).then(() => toast('已复制')) : toast('请手动复制', 'warn');
      }));

      $('#aio-apply', out).addEventListener('click', async () => {
        const picked = [];
        $$('.aio-draft', out).forEach((row) => {
          if (!row.querySelector('[data-pick]').checked) return;
          const i = parseInt(row.dataset.i, 10);
          const d = lastDrafts[i];
          const text = row.querySelector('[data-text]').value.trim();
          if (d && text) picked.push({ variantId: d.variantId, text, old: d.old || '', isNew: !!d.isNew });
        });
        if (!picked.length) { toast('至少勾选一条要应用的', 'warn'); return; }
        const btn = $('#aio-apply', out);
        btn.disabled = true; btn.textContent = '应用中…';
        try {
          await onApply(picked);
        } catch (err) {
          toast('应用失败：' + err.message, 'warn');
          btn.disabled = false; btn.textContent = '应用选中的 ' + lastDrafts.length + ' 条';
        }
      });
    };

    const run = async () => {
      const vars = selected();
      if (!vars.length) { toast('先勾选至少一个画像变量', 'warn'); return; }
      const vs = getVariants().filter((v) => (v.text || '').trim());
      if (!vs.length) { toast('这条话术还没有变体内容，先写一条再优化', 'warn'); return; }
      runBtn.disabled = true; againBtn.disabled = true;
      runBtn.textContent = 'AI 生成中…';
      tip.textContent = '正在调用 AI（约 10~60 秒）…';
      out.innerHTML = '';
      try {
        const data = await API.optimizeScript(script.id, {
          variables: vars,
          mode: mode(),
          count: parseInt(($('#aio-count', host) || {}).value, 10) || 2,
          variants: vs.map((v) => ({ variantId: v.variantId, text: v.text })),
        });
        renderOut(data);
        tip.textContent = '已生成，勾选要用的并可再改。';
        againBtn.hidden = false;
      } catch (err) {
        tip.textContent = '';
        out.innerHTML = `<div class="aio__err">生成失败：${esc(friendlyAiError(err.message))}</div>`;
      } finally {
        runBtn.disabled = false; runBtn.textContent = '生成优化方案';
        againBtn.disabled = false;
      }
    };

    runBtn.addEventListener('click', run);
    againBtn.addEventListener('click', run);
  }

  /** 把 AI 上游报错翻成人话（余额 / 未配置 / 超时） */
  function friendlyAiError(msg) {
    const m = String(msg || '');
    if (/INSUFFICIENT_BALANCE|余额/i.test(m)) return 'AI 账号余额不足，去「设置 → AI 配置」换 Key 或去中转站充值。';
    if (/没有配置|未配置|no api key|api_key/i.test(m)) return '还没配置 AI 接口，去「设置 → AI 配置」填 Key。';
    if (/超时|timeout/i.test(m)) return 'AI 调用超时，稍后重试（可少勾几个变量加快速度）。';
    if (/\b502\b/.test(m)) return 'AI 服务返回 502：多为第三方中转站余额不足或 Key 失效，去「设置 → AI 配置」检查。';
    return m || '未知错误';
  }

  /** 话术卡上的「AI 优化」：独立弹窗承载上面的面板，应用后直接落库并刷新 */
  async function openScriptAiDialog(script, onSaved) {
    openModal(`
      <h2 id="modal-title">AI 优化话术</h2>
      <p class="modal__lede">「${esc(script.name || '')}」· 勾选要参与的画像变量，AI 只按这些变量改写。
        输出保留 <code>{变量}</code> 占位符（不把画像值写死），画像改了话术自动跟着变。</p>
      <div id="aio-host"><div class="muted">正在读取业务画像…</div></div>
      <div class="modal__foot"><button type="button" class="btn" data-close>关闭</button></div>`, { wide: true });
    await mountAiOptimize($('#aio-host'), {
      script,
      getVariants: () => (script.variants || []).map((v) => ({ variantId: v.id || v.variantId, text: v.text || '' })),
      onApply: async (drafts) => {
        for (const d of drafts) {
          if (d.isNew) {
            await API.addScriptVariant(script.id, { variantId: d.variantId, text: d.text, weight: 0, status: 'draft' });
          } else {
            await API.updateScriptVariant(script.id, d.variantId, { text: d.text });
          }
        }
        toast('已应用 ' + drafts.length + ' 条到「' + (script.name || '') + '」', 'ok');
        closeModal();
        invalidateProfileCtx();
        if (onSaved) await onSaved();
      },
    });
  }

  /* ═══════════════════════════════════════════
     话术编辑弹窗（改名/分类/备注/欢迎语/启用 + 变体增删改）
     ═══════════════════════════════════════════ */
  const SCRIPT_CAT_OPTIONS = [
    ['comment', '评论话术'], ['welcome', '欢迎语/首句'], ['private_message', '私信话术'],
    ['wechat_guide', '微信引导'], ['objection', '异议处理'], ['nurture', '培育SOP'],
  ];
  const VARIANT_STATUS_OPTIONS = [
    ['active', '使用中'], ['switched_off', '已停用'], ['draft', '草稿'],
  ];
  /** 下一个可用的变体字母（A/B/C…），已用的跳过 */
  const nextVariantId = (used) => {
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i);
      if (!used.includes(c)) return c;
    }
    return 'V' + (used.length + 1);
  };

  /** 打开话术编辑弹窗。s = 话术对象（含 variants）；onSaved = 保存/删除成功后的刷新回调
      （刷新要用 viewScripts 里的 scripts/render，所以由调用方传进来，别在这里直接引用）。 */
  async function openScriptEditModal(s, onSaved) {
    const ctx = await ensureProfileCtx();
    // head = 话术级字段；vs = 变体数组。两者都只存内存，点「保存」才落库。
    const head = {
      name: s.name, category: s.category, intro: s.intro || '',
      welcomeMsg: s.welcomeMsg || '', active: s.active !== false,
    };
    let vs = (s.variants || []).map((v) => ({
      variantId: v.id, text: v.text || '',
      weight: v.weight == null ? 50 : v.weight, status: v.status || 'active',
    }));

    const catOpts = SCRIPT_CAT_OPTIONS
      .map(([k, l]) => `<option value="${k}"${k === head.category ? ' selected' : ''}>${l}</option>`).join('');
    const varChips = varChipsHtml(ctx);

    // AI 优化区默认收起；展开后回填的草稿只改内存里的 vs，点「保存」才落库
    let aiOpen = false;

    const formHtml = () => `
      <div class="se-info">
        <div class="field"><label for="se-name">话术名称</label><input type="text" id="se-name" value="${esc(head.name)}" placeholder="例：装修 · 报价跟进"></div>
        <div class="field"><label for="se-cat">话术分类</label><select id="se-cat">${catOpts}</select></div>
        <div class="field"><label for="se-intro">备注（选填）</label><input type="text" id="se-intro" value="${esc(head.intro)}" placeholder="例：报价后 24 小时内跟进"></div>
        <div class="field"><label for="se-welcome">企微欢迎语（加微后自动发送）</label><input type="text" id="se-welcome" value="${esc(head.welcomeMsg)}" placeholder="留空则不加微后发欢迎语"></div>
        <label class="se-active"><input type="checkbox" id="se-active"${head.active ? ' checked' : ''}> 启用（停用后评论回复 / 私信不再取这条话术）</label>
      </div>
      <div class="se-vbox" id="se-vbox">
        ${vs.map((v, i) => `
          <div class="se-v" data-i="${i}">
            <div class="se-v__head">
              <span class="se-v__id">${esc(v.variantId)}</span>
              <label class="se-v__w">权重 <input type="number" min="0" max="100" step="5" data-v-weight value="${v.weight}">%</label>
              <select class="se-v__status" data-v-status>${VARIANT_STATUS_OPTIONS
                .map(([k, l]) => `<option value="${k}"${k === v.status ? ' selected' : ''}>${l}</option>`).join('')}</select>
              <span class="card__spacer"></span>
              <button type="button" class="btn btn--sm btn--danger" data-v-del>删除变体</button>
            </div>
            <div class="se-v__vars">
              <button type="button" class="se-v__vars-toggle" data-v-vars-toggle>＋ 插入变量</button>
              <div class="var-chips" hidden>${varChips}</div>
            </div>
            <textarea data-v-text rows="3" placeholder="话术内容，可用 {变量} 绑定业务画像">${esc(v.text)}</textarea>
            <div class="se-v__prev" data-v-prev></div>
          </div>`).join('') || '<div class="se-vbox__empty">还没有变体，点下面「＋ 添加变体」。</div>'}
      </div>
      <div class="se-vbox__foot">
        <button type="button" class="btn btn--sm" id="se-add-v">＋ 添加变体</button>
        <span class="se-vbox__tip">建议至少 2 个变体做 A/B；权重按比例分配流量（合计 100% 最直观）。</span>
      </div>
      <div class="se-ai">
        <button type="button" class="btn btn--sm btn--ai" id="se-ai-toggle">${aiOpen ? '－ 收起 AI 优化' : '＋ AI 优化 / 扩写'}</button>
        <span class="se-vbox__tip">勾选要让 AI 参与的画像变量，改写结果回填到上面；点「保存」才生效。</span>
        <div class="se-ai__body" id="se-ai-body"${aiOpen ? '' : ' hidden'}></div>
      </div>`;

    openModal(`
      <h2 id="modal-title">编辑话术</h2>
      <p class="modal__lede">话术只存这里。用 <code>{变量}</code> 绑定业务画像，评论回复与私信发送时自动填充最新值。</p>
      <div id="se-wrap"></div>
      <div class="modal__foot se-foot">
        <button type="button" class="btn btn--danger" id="se-del-script">删除整条话术</button>
        <span class="card__spacer"></span>
        <button type="button" class="btn" data-close>取消</button>
        <button type="button" class="btn btn--primary" id="se-save">保存</button>
      </div>`, { wide: true });

    const root = $('#modal');

    /** 读表单：head 字段 + 变体数组（以 DOM 为准，未保存的编辑也算数） */
    const collect = () => {
      const rows = $$('.se-v', root);
      return {
        head: {
          name: $('#se-name', root).value.trim(),
          category: $('#se-cat', root).value,
          intro: $('#se-intro', root).value.trim(),
          welcomeMsg: $('#se-welcome', root).value.trim(),
          active: $('#se-active', root).checked,
        },
        variants: rows.map((el) => ({
          variantId: el.querySelector('.se-v__id').textContent.trim(),
          weight: parseInt(el.querySelector('[data-v-weight]').value, 10) || 0,
          status: el.querySelector('[data-v-status]').value,
          text: el.querySelector('[data-v-text]').value.trim(),
        })),
      };
    };

    /** 变体区重绘前的收尾：把当前 DOM 值收回内存 */
    const syncFromDom = () => {
      const cur = collect();
      Object.assign(head, cur.head);
      vs = cur.variants;
    };

    function wireForm() {
      // 每个变体：实时解析预览 + 变量芯片插入 + 删除本变体
      $$('.se-v', root).forEach((row) => {
        const ta = row.querySelector('[data-v-text]');
        const prev = row.querySelector('[data-v-prev]');
        const render = () => {
          const t = ta.value.trim();
          prev.innerHTML = t
            ? `<span class="se-v__prev-label">解析后：</span>${esc(resolveProfileVars(t, ctx)).replace(/\n/g, '<br>')}`
            : '<span class="muted">输入内容后，这里显示按当前画像解析的效果</span>';
        };
        ta.addEventListener('input', render);
        render();
        // 变量芯片默认收起（21 个芯片按 4 组铺开会很长），点「＋ 插入变量」展开
        const vTog = row.querySelector('[data-v-vars-toggle]');
        const vBox = row.querySelector('.se-v__vars .var-chips');
        if (vTog && vBox) vTog.addEventListener('click', () => {
          vBox.hidden = !vBox.hidden;
          vTog.textContent = vBox.hidden ? '＋ 插入变量' : '－ 收起变量';
        });
        row.querySelectorAll('.var-chip').forEach((chip) => {
          chip.addEventListener('click', () => {
            const tok = '{' + chip.dataset.var + '}';
            const a = ta.selectionStart || 0, b = ta.selectionEnd || 0;
            ta.value = ta.value.slice(0, a) + tok + ta.value.slice(b);
            ta.selectionStart = ta.selectionEnd = a + tok.length;
            ta.focus();
            render();
          });
        });
        row.querySelector('[data-v-del]').addEventListener('click', () => {
          const vid = row.querySelector('.se-v__id').textContent.trim();
          if ($$('.se-v', root).length <= 1) { toast('至少要留一个变体；不要整条话术请用「删除整条话术」', 'warn'); return; }
          if (!window.confirm('删除变体 ' + vid + '？保存后生效。')) return;
          syncFromDom();
          vs = vs.filter((v) => v.variantId !== vid);
          paint();
        });
      });
      // AI 优化 / 扩写：勾选画像变量 → AI 出草稿 → 回填到上面的变体（不落库，等「保存」）
      const aiTog = $('#se-ai-toggle', root);
      const aiBody = $('#se-ai-body', root);
      if (aiTog && aiBody) {
        aiTog.addEventListener('click', () => { aiOpen = !aiOpen; paint(); });
        if (aiOpen) {
          mountAiOptimize(aiBody, {
            script: { id: s.id, name: head.name, category: head.category, variants: vs },
            getVariants: () => collect().variants.filter((v) => (v.text || '').trim()),
            onApply: (drafts) => {
              syncFromDom();
              drafts.forEach((d) => {
                if (d.isNew) {
                  vs = vs.concat([{ variantId: d.variantId, text: d.text, weight: 0, status: 'draft' }]);
                } else {
                  const t = vs.find((x) => x.variantId === d.variantId);
                  if (t) t.text = d.text;
                }
              });
              paint();
              toast('已回填 ' + drafts.length + ' 条到编辑区，点「保存」才生效', 'ok');
            },
          }).catch(() => {});
        }
      }
      // 添加变体
      $('#se-add-v', root).addEventListener('click', () => {
        syncFromDom();
        vs = vs.concat([{
          variantId: nextVariantId(vs.map((v) => v.variantId)), text: '', weight: 0, status: 'draft',
        }]);
        paint();
      });
    }

    const paint = () => {
      const keep = root.scrollTop;
      $('#se-wrap', root).innerHTML = formHtml();
      wireForm();
      // 分类下拉要跟随 head（重绘后 selected 已在模板里处理，这里只兜底）
      const catSel = $('#se-cat', root);
      if (catSel) catSel.value = head.category;
      root.scrollTop = keep;
    };

    // 删除整条话术
    $('#se-del-script', root).addEventListener('click', async () => {
      if (!window.confirm('删除话术「' + head.name + '」及其全部变体？删除后不可恢复（历史归因记录保留）。')) return;
      const btn = $('#se-del-script', root);
      btn.disabled = true; btn.textContent = '删除中…';
      try {
        await API.deleteScript(s.id);
        toast('已删除话术：' + head.name, 'ok');
        closeModal();
        invalidateProfileCtx();
        if (onSaved) await onSaved();
      } catch (e) {
        toast('删除失败：' + e.message, 'warn');
        btn.disabled = false; btn.textContent = '删除整条话术';
      }
    });

    // 保存：话术级字段 + 变体增/删/改
    $('#se-save', root).addEventListener('click', async () => {
      const data = collect();
      if (!data.head.name) { toast('请填写话术名称', 'warn'); return; }
      const blank = data.variants.filter((v) => !v.text);
      if (blank.length) {
        if (!window.confirm('变体 ' + blank.map((v) => v.variantId).join('/') + ' 内容是空的，保存后它不会生效。仍要保存？')) return;
      }
      if (data.variants.length > 1) {
        const total = data.variants.reduce((a, v) => a + (v.weight || 0), 0);
        if (total !== 100 && !window.confirm('变体权重合计 ' + total + '%，不是 100%。权重只影响比例，仍可保存。继续？')) return;
      }
      const btn = $('#se-save', root);
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        await API.updateScript(s.id, {
          name: data.head.name, category: data.head.category, intro: data.head.intro,
          welcomeMsg: data.head.welcomeMsg, active: data.head.active,
        });
        const oldIds = (s.variants || []).map((v) => v.id);
        const newIds = data.variants.map((v) => v.variantId);
        for (const id of oldIds) {
          if (!newIds.includes(id)) await API.deleteScriptVariant(s.id, id);
        }
        for (const v of data.variants) {
          if (oldIds.includes(v.variantId)) {
            await API.updateScriptVariant(s.id, v.variantId, { text: v.text, weight: v.weight, status: v.status });
          } else {
            await API.addScriptVariant(s.id, { variantId: v.variantId, text: v.text, weight: v.weight, status: v.status });
          }
        }
        toast('已保存：' + data.head.name, 'ok');
        closeModal();
        invalidateProfileCtx();
        if (onSaved) await onSaved();
      } catch (e) {
        toast('保存失败：' + e.message, 'warn');
        btn.disabled = false; btn.textContent = '保存';
      }
    });

    paint();
  }

  /* ═══════════════════════════════════════════
     视图：账号管理（IMP-006）
     两个 Tab：账号（列表 + 概览 + 规则抽屉）/ 上线向导
     健康度已并入「账号」Tab（2026-09-12 合并，原「账号健康度」Tab 取消）
     ═══════════════════════════════════════════ */

  const ACC_STATUS_MAP = {
    healthy: ['healthy', '健康'],
    throttled40: ['throttled', 'R1 降速 40/天'],
    paused_24h: ['throttled', '暂停 24h'],
    safe_mode: ['safemode', '安全模式'],
    banned: ['banned', '已封禁'],
  };
  const ACC_SCHED_MAP = {
    active: ['healthy', '可调度'],
    paused: ['low', '已暂停'],
    throttled: ['throttled', '限流中'],
    safe_mode: ['safemode', '安全模式'],
    banned: ['banned', '已封禁'],
  };
  const ACC_FACTOR_LABELS = {
    dailyFreq: '日频', banHistory: '封禁史', login: '登录态',
    unsubscribe: '退订率', complaint: '投诉率',
  };
  const ACC_STRATEGY_LABELS = { round_robin: '轮询', weighted: '按权重', health_based: '按健康分' };

  /* 时间戳：后端返回 ISO 串，这里统一转人话 */
  function fmtAgo(v) {
    if (!v) return '—';
    // 后端 datetime 带微秒（6 位小数），部分浏览器解析会失败 → 截到毫秒
    const s = String(v).trim().replace(/(\.\d{3})\d+/, '$1');
    const t = new Date(s);
    if (isNaN(t.getTime())) return String(v);
    const p2 = (n) => String(n).padStart(2, '0');
    const mins = Math.floor((Date.now() - t.getTime()) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' 小时前';
    const days = Math.floor(hrs / 24);
    if (days === 1) return '昨天 ' + p2(t.getHours()) + ':' + p2(t.getMinutes());
    if (days < 7) return days + ' 天前';
    return p2(t.getMonth() + 1) + '-' + p2(t.getDate()) + ' ' + p2(t.getHours()) + ':' + p2(t.getMinutes());
  }

  /* 头像字：昵称可能含 [ ] 等符号，取第一个中英文数字 */
  function avatarText(n) {
    const s = String(n || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    return s ? s[0].toUpperCase() : '?';
  }
  /* 同名账号靠 id 尾号区分 */
  const shortId = (id) => String(id || '').slice(-4);

  function accFactorTags(a) {
    return Object.entries(a.factors || {}).map(([k, v]) =>
      `<span class="factor factor--${v}">${ACC_FACTOR_LABELS[k] || k}${v === 'bad' ? '✕' : v === 'warn' ? '△' : '✓'}</span>`).join('');
  }

  /* 概览条：4 个指标一行（不再用 7 列的 .grid--metrics） */
  function accOverview(accs, stats) {
    const n = accs.length;
    const avg = n ? Math.round(accs.reduce((s, a) => s + (a.healthScore || 0), 0) / n) : 0;
    const warn = accs.filter((a) => (a.healthScore || 0) < 60 || ['safe_mode', 'banned', 'throttled40'].includes(a.limitStatus));
    const sent = stats && stats.totalSent != null ? stats.totalSent : accs.reduce((s, a) => s + (a.dailyOutreach || 0), 0);
    const cap = accs.reduce((s, a) => s + (a.dailyLimit || 0), 0);
    return `
      <div class="grid grid--4">
        ${metric('账号数', fmt(n), n > 1 ? '多账号调度已启用' : '建议 1 人管 3-5 号（US4）')}
        ${metric('平均健康分', avg, '<60 黄色 · <40 自动进安全模式', avg >= 60 ? '' : 'danger')}
        ${metric('预警账号', warn.length, warn.length ? warn.map((a) => esc(a.nickname)).join('、') : '全部正常', warn.length ? 'danger' : '')}
        ${metric('今日已发送', fmt(sent), '账号日频上限合计 ' + fmt(cap), 'brand')}
      </div>`;
  }

  /* 账号行：紧凑表格行 */
  function accRow(a) {
    const s = a.sched || {};
    const hp = a.healthScore == null ? 0 : a.healthScore;
    const cls = hp >= 60 ? 'ok' : hp >= 40 ? 'warn' : 'danger';
    const fill = hp >= 60 ? 'var(--ok)' : hp >= 40 ? 'var(--warn)' : 'var(--danger)';
    const [tagCls, statusLabel] = ACC_STATUS_MAP[a.limitStatus] || ['low', a.limitStatus || '未知'];
    const [schedTagCls, schedLabel] = ACC_SCHED_MAP[s.status || 'active'] || ['low', s.status || '—'];
    const today = s.todaySent !== undefined ? s.todaySent : (a.dailyOutreach || 0);
    const limit = a.dailyLimit || 0;
    const note = a.r1Note || a.r3Note || a.lastBanReason || '';
    const danger = hp < 30 || a.limitStatus === 'banned';
    const abnormal = ['safe_mode', 'banned', 'throttled40', 'paused_24h'].includes(a.limitStatus)
      || Object.values(a.factors || {}).some((v) => v !== 'good');
    // v008：多账号登录态隔离 —— 当前正在使用哪个账号
    const act = window.__activeAccount || {};
    const isActive = act.accountId && act.accountId === a.id;
    return `
      <div class="acc-row${danger ? ' acc-row--danger' : ''}" data-acc="${esc(a.id)}">
        <div class="acc-row__id">
          <span class="avatar" style="background:hsl(${a.avatarHue || 200} 42% 42%)">${esc(avatarText(a.nickname))}</span>
          <div class="acc-row__meta">
            <div class="acc-row__name">${esc(a.nickname || '(未命名)')}<span class="acc-row__sid">…${esc(shortId(a.id))}</span></div>
            <div class="acc-row__sub">${note ? esc(note) : '更新于 ' + esc(fmtAgo(a.updatedAt))}</div>
          </div>
        </div>
        <div class="acc-row__health">
          <span class="gauge__num gauge__num--${cls}">${hp}</span>
          <span class="gauge__track"><span class="gauge__fill" style="display:block;width:${Math.max(0, Math.min(100, hp))}%;background:${fill}"></span></span>
        </div>
        <div class="acc-row__quota num">${fmt(today)}<span class="acc-row__sep">/</span>${limit || '—'}</div>
        <div class="acc-row__factors">${accFactorTags(a)}</div>
        <div class="acc-row__tags">
          <span class="tag tag--${tagCls}">${esc(statusLabel)}</span>
          <span class="tag tag--${schedTagCls}">调度：${esc(schedLabel)}</span>
          ${isActive
            ? `<span class="tag tag--ok">使用中</span><span class="tag tag--${act.loggedIn ? 'ok' : 'warn'}">${act.loggedIn ? '已登录' : '未登录'}</span>`
            : '<button type="button" class="btn btn--sm acc-row__detail" data-acc-switch>切换账号</button>'}
          ${abnormal ? '<button type="button" class="btn btn--sm acc-row__detail" data-acc-safe>详情</button>' : ''}
        </div>
      </div>`;
  }

  async function viewAccounts(params) {
    const tab = (params && params.get('tab')) || 'accounts';

    // 上线向导 Tab
    if (tab === 'wizard') {
      const stepParam = params.get('step');
      let initialStep = 0;
      if (stepParam) {
        const idx = LAUNCH_STEPS.findIndex((s) => s.key === stepParam);
        initialStep = idx >= 0 ? idx : (parseInt(stepParam, 10) || 0);
      }
      main.innerHTML = `
        <div class="view">
          ${pageHead({ icon: 'rocket', title: '账号管理', desc: '账号列表与上线向导' })}
          <div class="tabs" id="accounts-tabs">
            <button class="tab" data-tab="accounts">账号</button>
            <button class="tab tab--active" data-tab="wizard">上线向导</button>
          </div>
          ${launchWizardSkeletonHtml()}
        </div>`;
      bindAccountTabs();
      await renderLaunchWizardBody(initialStep);
      return;
    }

    main.innerHTML = '<div class="view"><div class="empty"><p>加载中…</p></div></div>';
    const [accs, schedAccs, schedStats, schedConfig, activeAcc] = await Promise.all([
      API.getAccounts(),
      API.fetchSchedulerAccounts().catch(() => []),
      API.fetchSchedulerStats().catch(() => ({ totalSent: 0, successRate: 0, activeAccounts: 0, perAccount: [] })),
      API.fetchSchedulerConfig().catch(() => ({ strategy: 'round_robin', healthThresholdWarn: 60, healthThresholdCritical: 30, maxConcurrent: 3 })),
      API.getActiveAccount().catch(() => ({})),
    ]);
    window.__activeAccount = activeAcc || {};
    const schedMap = {};
    (schedAccs || []).forEach((s) => { schedMap[s.accountId] = s; });
    const merged = (accs || []).map((a) => ({ ...a, sched: schedMap[a.id] || null }));
    window.__accState = { merged, schedConfig, schedStats };

    main.innerHTML = `
      <div class="view">
        ${pageHead({
          icon: 'phone', title: '账号管理',
          desc: '健康分 = 日频 + 封禁史 + 登录态 + 退订率 + 投诉率 · 低于 40 自动进安全模式',
          actions: `<button type="button" class="btn btn--sm" id="btn-acc-rules">健康度与调度规则</button>
                    <button type="button" class="btn btn--primary btn--sm" id="btn-add-acc">+ 绑定账号</button>`,
        })}
        <div class="tabs" id="accounts-tabs">
          <button class="tab tab--active" data-tab="accounts">账号</button>
          <button class="tab" data-tab="wizard">上线向导</button>
        </div>
        ${accOverview(merged, schedStats)}
        <div class="card acc-card-wrap">
          <div class="card__head">
            <span class="card__title">账号列表</span>
            <span class="card__hint">健康度低于 40 自动进安全模式 · R1 命中自动降速</span>
          </div>
          ${merged.length ? `
            <div class="acc-table__head">
              <span>账号</span><span>健康分</span><span>今日发送</span><span>五因子</span><span>状态</span>
            </div>
            <div class="acc-table">${merged.map((a) => accRow(a)).join('')}</div>`
            : '<div class="empty"><p>还没有绑定账号。点右上角「+ 绑定账号」，或去「上线向导」跑一遍。</p></div>'}
        </div>
      </div>`;

    bindAccountTabs();

    $('#btn-add-acc').addEventListener('click', openAccBindModal);
    $('#btn-acc-rules').addEventListener('click', () => openAccRulesDrawer(schedConfig, merged));

    // v008：切换当前使用的抖音账号（之后采集 / 评论都用该账号那份登录态）
    $$('[data-acc-switch]', main).forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acc]')?.dataset.acc;
      if (!id) return;
      b.disabled = true;
      try {
        const r = await API.activateAccount(id);
        if (r && r.inherited) toast(`已切换到「${r.nickname}」，已继承当前登录态，无需重新扫码`);
        else if (r && r.loggedIn) toast(`已切换到「${r.nickname}」，该账号已登录`);
        else toast(`已切换到「${(r && r.nickname) || ''}」，该账号还需扫码登录一次`, 'warn');
        await viewAccounts(params);
      } catch (e) {
        toast('切换失败：' + e.message, 'warn');
        b.disabled = false;
      }
    }));

    // 安全模式详情（读真实账号数据）
    $$('[data-acc-safe]', main).forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('[data-acc]')?.dataset.acc;
      const a = merged.find((x) => x.id === id);
      if (a) openAccSafeModal(a);
    }));
  }

  function bindAccountTabs() {
    const el = $('#accounts-tabs');
    if (!el) return;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      location.hash = `#/accounts?tab=${btn.dataset.tab}`;
    });
  }

  /* 绑定账号：真实写入（与上线向导第 4 步同一个接口） */
  function openAccBindModal() {
    openModal(`
      <h2 id="modal-title">绑定抖音账号</h2>
      <div class="confirm-note" style="margin-bottom:14px">
        这里登记的是账号的<strong>管理信息</strong>（用于频控与健康分监控）。抖音登录本身在「上线向导 → 扫码登录」完成。
      </div>
      <div class="field"><label for="acc-nick">账号昵称（备注名）</label>
        <input type="text" id="acc-nick" placeholder="例：装修案例·阿明"></div>
      <div class="field"><label for="acc-daily">该账号日频上限</label>
        <input type="number" id="acc-daily" value="80" min="1" max="500"></div>
      <div class="field"><label for="acc-notes">备注</label>
        <input type="text" id="acc-notes" placeholder="例：主号，只发私信不带链接"></div>
      <div class="modal__foot">
        <button type="button" class="btn" data-close>取消</button>
        <button type="button" class="btn btn--primary" id="acc-save">绑定</button>
      </div>`);
    $('#acc-save').addEventListener('click', async () => {
      const nickname = ($('#acc-nick')?.value || '').trim();
      if (!nickname) { toast('请填账号昵称', 'warn'); return; }
      const btn = $('#acc-save');
      btn.disabled = true;
      try {
        await API.createAccount({
          nickname,
          platform: 'douyin',
          dailyLimit: parseInt($('#acc-daily')?.value, 10) || 80,
          notes: ($('#acc-notes')?.value || '').trim(),
        });
        toast('账号已绑定');
        closeModal();
        viewAccounts();
      } catch (e) {
        toast('绑定失败：' + e.message, 'warn');
        btn.disabled = false;
      }
    });
  }

  /* 安全模式详情：读账号真实字段，不再硬编码 */
  function openAccSafeModal(a) {
    const bad = Object.entries(a.factors || {})
      .filter(([, v]) => v !== 'good')
      .map(([k]) => ACC_FACTOR_LABELS[k] || k);
    const [, statusLabel] = ACC_STATUS_MAP[a.limitStatus] || ['low', a.limitStatus || '—'];
    openModal(`
      <h2 id="modal-title">账号状态详情</h2>
      <dl class="kv">
        <dt>账号</dt><dd>${esc(a.nickname || '(未命名)')}（…${esc(shortId(a.id))}）</dd>
        <dt>健康分</dt><dd>${esc(a.healthScore == null ? '—' : a.healthScore)}</dd>
        <dt>限流状态</dt><dd>${esc(statusLabel)}</dd>
        <dt>异常因子</dt><dd>${bad.length ? esc(bad.join('、')) : '五因子均正常'}</dd>
        <dt>触发原因</dt><dd>${esc(a.r1Note || a.r3Note || a.lastBanReason || '暂无记录')}</dd>
        <dt>影响</dt><dd>全量暂停新触达 · 已发队列只读 · 该账号不再发送</dd>
        <dt>退出条件</dt><dd>需人工确认（防误恢复），写入审计日志</dd>
      </dl>
      <div class="modal__foot"><button type="button" class="btn" data-close>关闭</button></div>`);
  }

  /* 健康度与调度规则：说明 + 阈值 + 调度配置，都收进右侧抽屉 */
  function openAccRulesDrawer(cfg, accs) {
    const c = cfg || {};
    const n = (accs || []).length;
    const avg = n ? Math.round(accs.reduce((s, a) => s + (a.healthScore || 0), 0) / n) : 0;
    const opt = (v, label) => `<option value="${v}" ${c.strategy === v ? 'selected' : ''}>${label}</option>`;
    openDrawer(`
      <div class="drawer__head">
        <span class="drawer__title" id="drawer-title">健康度与调度规则</span>
        <button type="button" class="drawer__close" aria-label="关闭">✕</button>
      </div>
      <div class="drawer__body">
        <section>
          <h4 class="drawer__h4">健康分怎么算</h4>
          <p class="drawer__p">满分 100，由五个因子共同决定。任一项异常都会扣分；低于 <b>40</b> 自动进入安全模式（全量暂停新触达）。当前平均健康分 <b>${avg}</b>。</p>
          <ul class="rule-list">
            <li><b>日频</b><span>当日发送量是否接近上限</span></li>
            <li><b>封禁史</b><span>是否曾被限流或封禁</span></li>
            <li><b>登录态</b><span>登录是否有效、是否频繁掉线</span></li>
            <li><b>退订率</b><span>被拉黑 / 退订的比例</span></li>
            <li><b>投诉率</b><span>被举报投诉的比例</span></li>
          </ul>
        </section>
        <section>
          <h4 class="drawer__h4">调度配置</h4>
          <div class="field"><label for="sched-strategy">调度策略</label>
            <select id="sched-strategy">
              ${opt('round_robin', '轮询（round_robin）')}
              ${opt('weighted', '按权重（weighted）')}
              ${opt('health_based', '按健康分（health_based）')}
            </select></div>
          <div class="field"><label for="sched-max-concurrent">最大并发账号数</label>
            <input type="number" id="sched-max-concurrent" value="${esc(c.maxConcurrent ?? 3)}" min="1" max="20"></div>
          <div class="field"><label for="sched-threshold-warn">健康分警告阈值（低于此值降速 50%）</label>
            <input type="number" id="sched-threshold-warn" value="${esc(c.healthThresholdWarn ?? 60)}" min="0" max="100"></div>
          <div class="field"><label for="sched-threshold-critical">健康分严重阈值（低于此值不分配）</label>
            <input type="number" id="sched-threshold-critical" value="${esc(c.healthThresholdCritical ?? 30)}" min="0" max="100"></div>
          <button type="button" class="btn btn--primary" id="sched-save-config" style="width:100%;margin-top:4px">保存调度配置</button>
        </section>
      </div>`);
    bindSchedulerPanel();
  }

  function bindSchedulerPanel() {
    const saveBtn = $('#sched-save-config');
    if (!saveBtn) return;
    const val = (id) => document.getElementById(id)?.value;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await API.updateSchedulerConfig({
          strategy: val('sched-strategy'),
          maxConcurrent: parseInt(val('sched-max-concurrent'), 10) || 3,
          healthThresholdWarn: parseInt(val('sched-threshold-warn'), 10) || 60,
          healthThresholdCritical: parseInt(val('sched-threshold-critical'), 10) || 30,
        });
        toast('调度配置已保存', 'ok');
      } catch (e) {
        toast('保存失败：' + e.message, 'warn');
        saveBtn.disabled = false;
      }
    });
  }


  /* ═══════════════════════════════════════════
     视图：业务画像（5 步 · AI 的业务上下文）
     原「上手向导」的业务配置部分，入口在「话术与业务配置 → 业务画像」。
     与后端一一对应：
       1 业务画像    GET/PUT /api/business/profile
       2 产品知识库  GET/PUT /api/workbench/product
       3 目标客户    GET/PUT /api/workbench/audience
       4 话术策略    GET/PUT /api/workbench/scripts
       5 微信转化    GET/PUT /api/workbench/wechat
     状态 GET /api/onboarding/status · 跳过 POST /api/onboarding/skip
     ═══════════════════════════════════════════ */
  const BIZ_STEPS = [
    { key: 'business', label: '业务画像' },
    { key: 'product', label: '产品知识库' },
    { key: 'audience', label: '目标客户' },
    { key: 'wechat', label: '微信转化' },
  ];

  const BIZ_STEP_META = {
    business: { desc: '我是谁 · 全局业务上下文。行业、区域只在这里维护，产品与客户信息在各自模块。' },
    product: { desc: '卖什么 · 产品与价格只在这里维护，AI 生成话术时引用这里的内容。' },
    audience: { desc: '卖给谁 · 客户群、需求痛点与筛选关键词只在这里维护。' },
    wechat: { desc: '转化落点：加哪个微信、什么时候引导、用什么理由。' },
  };

  /* ══════════ 业务画像选项库（BIZ_OPTIONS）══════════
     一份清单全站复用：「业务画像 / 产品知识库 / 目标客户 / 微信转化 / 话术变量」引用同一份，
     同一概念全站只有一种写法（不会再出现「装修/家装/室内装修」三种写法）。
     所有字段都保留「自定义输入」，这里只是常用集合，不是白名单校验。 */
  const BIZ_OPTIONS = {
    industry: [
      '装修/家装', '建材/家居', '搬家/保洁', '家电/家居维修', '餐饮/小吃', '宠物服务', '婚庆/摄影', '旅游/民宿',
      '美容/美发/美甲', '医美/整形', '健身/瑜伽', '口腔/牙科', '健康体检/中医', '月子/母婴',
      '房产/中介', '法律咨询', '财税代账', '保险/金融', '教育培训', '汽车销售', '汽车服务/维修',
      '软件/小程序/代运营', '批发/零售', '其他',
    ],
    // 主营产品：随「所属行业」联动；行业未匹配时用通用兜底
    productGeneric: ['服务套餐', '单品/整机', '会员/年卡', '课程/培训', '咨询/方案', '定制服务'],
    productByIndustry: {
      '装修/家装': ['半包套餐', '全包套餐', '整装套餐', '局部翻新', '旧房改造', '软装设计', '免费量房出方案', '其他'],
      '建材/家居': ['全屋定制', '橱柜/衣柜', '门窗', '瓷砖/地板', '卫浴', '灯具', '家具', '其他'],
      '搬家/保洁': ['居民搬家', '公司搬迁', '日常保洁', '深度保洁', '开荒保洁', '家电清洗', '其他'],
      '家电/家居维修': ['空调维修/清洗', '水电维修', '管道疏通', '门窗维修', '家电安装', '其他'],
      '餐饮/小吃': ['堂食/正餐', '小吃/快餐', '火锅/烧烤', '烘焙/甜品', '奶茶/饮品', '团餐/配送', '其他'],
      '宠物服务': ['宠物寄养', '宠物美容', '宠物医院', '宠物训练', '宠物用品', '上门喂养', '其他'],
      '婚庆/摄影': ['婚礼策划', '婚纱摄影', '写真/亲子照', '商拍/形象照', '跟妆/礼服', '其他'],
      '旅游/民宿': ['民宿/客栈', '跟团游', '定制游', '门票/包车', '亲子研学', '其他'],
      '美容/美发/美甲': ['皮肤管理', '美甲美睫', '发型设计', '纹绣', '身体护理', '其他'],
      '医美/整形': ['轻医美', '皮肤光电', '整形手术', '注射填充', '术后修复', '其他'],
      '健身/瑜伽': ['私教课', '团课/小班', '会员年卡', '瑜伽/普拉提', '体测/康复', '其他'],
      '口腔/牙科': ['洗牙/检查', '正畸', '种植牙', '补牙/修复', '儿童齿科', '其他'],
      '健康体检/中医': ['体检套餐', '中医调理', '推拿/理疗', '慢病管理', '其他'],
      '月子/母婴': ['月嫂/月护', '月子中心', '产后修复', '育儿嫂', '母婴用品', '其他'],
      '房产/中介': ['二手房买卖', '新房代理', '租房中介', '商铺/写字楼', '过户代办', '其他'],
      '法律咨询': ['合同纠纷', '婚姻家事', '劳动争议', '债务催收', '企业法务', '其他'],
      '财税代账': ['代理记账', '税务筹划', '工商注册', '资质代办', '审计/汇算', '其他'],
      '保险/金融': ['寿险', '车险', '健康险', '贷款咨询', '理财规划', '其他'],
      '教育培训': ['学科辅导', '艺术培训', '职业技能', '雅思/留学', '成人学历', '其他'],
      '汽车销售': ['新车销售', '二手车', '新能源车', '以租代购', '其他'],
      '汽车服务/维修': ['保养/维修', '洗车美容', '贴膜/改装', '钣金喷漆', '年审/救援', '其他'],
      '软件/小程序/代运营': ['小程序开发', 'APP 开发', '网站/商城', '短视频代运营', '直播代播', 'AI 工具', '其他'],
      '批发/零售': ['批发供货', '门店零售', '电商店铺', '社群团购', '其他'],
    },
    // 服务区域：多选
    area: ['同城（本市）', '本市主城区', '本市全境', '周边区县', '跨市/邻省', '全国（可线上交付）'],
    target: ['个人消费者', '家庭用户', '年轻白领', '宝妈/家庭主妇', '业主/房东', '企业/公司采购', '个体商户/门店', '政府/事业单位', '学生', '老年人群'],
    // 价格档位（重心下移版：低档加密、砍掉百万档）
    price: ['面议/按方案报价', '500 元以内', '500–2000 元', '2000–5000 元', '5000–1 万', '1–3 万', '3–5 万', '5–10 万', '10–30 万', '30 万以上', '按月/年订阅'],
    goal: ['加微信/企业微信', '留手机号', '私信回复', '到店/上门', '直接下单', '预约体验', '关注账号', '进群', '领取资料'],
    tone: ['专业严谨', '真诚亲切', '热情有活力', '干脆利落', '耐心细致', '幽默轻松', '高端克制', '接地气/本地化'],
    groupName: ['主城毛坯房业主', '旧房改造客户', '同城有需求客户'],
    sellingPoints: ['免费上门量房/评估', '价格透明不增项', '自有团队不转包', '材料品牌可选', '多年质保', '先看案例再决定', '不满意可返工', '一对一专属顾问', '同城当天响应', '签订正规合同'],
    forbidden: ['保证零增项', '全市/全网最低价', '绝对/100% 保证', '包治/根治', '官方指定/唯一授权', '永久免费', '当天见效', '无任何风险'],
    needs: ['想了解报价', '想对比方案', '想先看案例', '想确认工期', '想了解材料/用料', '想确认售后保障', '想上门量房/看现场', '想省钱/找优惠', '想了解资质'],
    pain: ['怕增项加价', '怕工期拖延', '怕偷工减料', '怕材料以次充好', '怕售后没人管', '不懂行怕被坑', '预算不够', '选择困难', '担心效果不符', '怕交定金有风险'],
    intentKw: ['多少钱', '报价', '怎么收费', '贵不贵', '有优惠吗', '怎么联系', '能上门吗', '地址在哪', '想了解一下', '加个微信', '什么时候能看'],
    excludedKw: ['招聘', '求职', '兼职', '实习', '学徒', '加盟', '代理', '批发', '同行', '免费'],
    timing: ['评论区互动 1 次后', '私信咨询回复后', '发送报价后', '发送案例后', '用户主动问价时', '连续互动 2 次以上', '留资后 24 小时内'],
    guideReason: ['发详细报价单', '发同小区/同类案例', '领避坑清单或资料包', '免费上门量尺/评估', '专属顾问 1 对 1', '进客户交流群', '领专属优惠'],
    compliance: ['不主动索要手机号', '不承诺保价/最低价', '不做绝对化承诺', '不诱导私下交易', '不群发骚扰', '不冒充官方账号'],
  };

  /* 字段控件类型：
     · sel: <选项库 key>  → 单选下拉（可自定义）
     · tags: <选项库 key> → 多选标签（可自定义），tagSep 沿用该字段原有的存储分隔符，
                            以免破坏下游解析（关键词按逗号切、卖点/痛点按行切）
     · multi: true         → 多行纯文本
     都不带 → 单行纯文本 */
  /* use 取值（P0-2 判定，废弃旧 always/more）：
       ai     —— 字段进 AI 提示词（script_gen._context 用到的）
       var    —— 只作话术 {变量} 被引用（手写话术用）
       filter —— 采集打分 / 过滤用（意向关键词、排除关键词）
       none   —— 谁都不用（如合规备注）
     首屏必填 6 项：所属行业 / 产品名称 / 价格区间 / 目标客户 / 核心卖点 / 主要痛点。 */
  const BIZ_FIELDS = {
    business: [
      { k: 'industry', label: '所属行业', ph: '选择或输入行业', sel: 'industry', use: 'ai', req: true },
      { k: 'serviceArea', label: '服务区域', ph: '点此选择区域', tags: 'area', tagSep: '、', use: 'ai', req: false },
      { k: 'targetCustomer', label: '目标客户', ph: '选择或输入客户类型', sel: 'target', use: 'ai', req: true },
      { k: 'conversionGoal', label: '转化目标', ph: '选择或输入目标', sel: 'goal', use: 'ai', req: false },
      { k: 'tone', label: '沟通语气（最多 2 个）', ph: '点此选择语气', tags: 'tone', tagSep: '、', max: 2, use: 'ai', req: false },
      { k: 'selfIntro', label: '人设 / 自我介绍', ph: '一句话说清你是谁、什么风格', hint: 'AI 用它定开场白的口吻', multi: true, use: 'ai', req: false },
    ],
    product: [
      { k: 'productName', label: '产品名称', ph: '选择或输入产品', sel: 'product', use: 'ai', req: true },
      { k: 'description', label: '产品简介', ph: '一句话说清这个产品是什么、解决什么问题', multi: true, use: 'ai', req: false },
      { k: 'sellingPoints', label: '核心卖点', ph: '点此选择卖点', tags: 'sellingPoints', tagSep: '\n', use: 'ai', req: true },
      { k: 'priceRange', label: '价格区间', ph: '选择或输入价格档', sel: 'price', use: 'ai', req: true },
      { k: 'faq', label: '常见问题 FAQ', ph: '例：包设计吗？含基础设计，效果图另计', hint: '一行一条，问句在前', multi: true, use: 'var', req: false },
      { k: 'forbiddenClaims', label: '禁止承诺（不可说的话）', ph: '点此选择禁语', tags: 'forbidden', tagSep: '\n', use: 'ai', req: false },
      { k: 'serviceProcess', label: '服务流程', ph: '从接触到交付的关键步骤', hint: '一行一步，回车换行', multi: true, use: 'ai', req: false },
      { k: 'caseStudies', label: '成功案例', ph: '有代表性的成交案例', hint: '一行一个，写清「客户类型 + 结果」', multi: true, use: 'ai', req: false },
    ],
    audience: [
      { k: 'name', label: '客户群名称', ph: '选择或输入名称', sel: 'groupName', use: 'ai', req: false },
      { k: 'industry', label: '所属行业', ph: '选择或输入行业', sel: 'industry', use: 'var', req: false },
      { k: 'region', label: '所在区域', ph: '选择或输入区域', sel: 'area', use: 'var', req: false },
      { k: 'needs', label: '核心需求', ph: '点此选择需求', tags: 'needs', tagSep: '\n', use: 'ai', req: false },
      { k: 'painPoints', label: '主要痛点', ph: '点此选择痛点', tags: 'pain', tagSep: '\n', use: 'ai', req: true },
      { k: 'intentKeywords', label: '意向关键词', ph: '点此选择关键词', hint: '评论命中就加分、优先推给你', tags: 'intentKw', tagSep: ',', use: 'filter', req: false },
      { k: 'excludedKeywords', label: '排除关键词', ph: '点此选择排除词', hint: '评论命中就整条丢掉', tags: 'excludedKw', tagSep: ',', use: 'filter', req: false },
      { k: 'excludedCustomers', label: '不接的客户', ph: '明确不服务的客户类型', hint: '一行一类，避免无效跟进', multi: true, use: 'ai', req: false },
    ],
    wechat: [
      { k: 'wechatId', label: '微信号 / 企业微信', ph: '例：nanxi2026', hint: '会作为 {微信号} 插进话术', use: 'var', req: false },
      { k: 'guideTiming', label: '引导加微的时机', ph: '选择或输入时机', sel: 'timing', use: 'ai', req: false },
      { k: 'guideReason', label: '引导理由', ph: '点此选择理由', tags: 'guideReason', tagSep: '、', use: 'ai', req: false },
      { k: 'offerHook', label: '优惠 / 钩子', ph: '引流时的让利或诱饵', hint: '一行一个', multi: true, use: 'ai', req: false },
      { k: 'complianceNote', label: '合规备注', ph: '点此选择合规要点', tags: 'compliance', tagSep: '\n', use: 'none', req: false },
    ],
  };

  /* 4 张画像卡片已改为「记录集」接口（API.listProfileRecords / createProfileRecord /
     updateProfileRecord / deleteProfileRecord / setPrimaryProfileRecord），
     旧的单条 GET/PUT 仍由后端保留，供 onboarding 与 AI 生成使用。 */

  function bizConfigSkeletonHtml() {
    return `
        <div class="wizard">
          <div class="wizard__status" id="biz-status"></div>
          <div style="padding:2px 0">
            <div id="biz-panel"></div>
          </div>
        </div>`;
  }

  async function renderBizConfigBody() {
    const panel = $('#biz-panel');
    if (!panel) return;
    const wiz = { data: {}, cards: {}, status: null, busy: false };

    function renderStatus() {
      const el = $('#biz-status');
      if (!el) return;
      const s = wiz.status;
      if (!s) { el.style.display = 'none'; return; }
      el.style.display = '';
      const map = {
        pending: { cls: '', txt: '尚未开始', desc: '在下方任一卡片填写并保存即可，可随时中断再来' },
        in_progress: { cls: 'is-warn', txt: '进行中', desc: '已完成 ' + s.doneCount + '/' + s.total + ' 项' },
        completed: { cls: 'is-ok', txt: '已完成', desc: s.total + ' 步全部填写完成，配置已生效' },
        skipped: { cls: 'is-muted', txt: '已跳过', desc: '向导已跳过，仍可随时回来补填' },
      };
      const m = map[s.status] || map.pending;
      el.className = 'wizard__status ' + m.cls;
      el.innerHTML = `
        <span class="wizard__status-tag">${esc(m.txt)}</span>
        <span class="wizard__status-desc">${esc(m.desc)}</span>
        <span class="wizard__status-bar">
          ${BIZ_STEPS.map((st) => `<i class="${s.steps && s.steps[st.key] ? 'on' : ''}" title="${esc(st.label)}"></i>`).join('')}
        </span>`;
    }
    async function loadStatus() {
      try { wiz.status = await API.getOnboardingStatus(); } catch (e) { wiz.status = null; }
      renderStatus();
    }



    /* ══════════ 字段控件：纯文本 / 单选下拉 / 多选标签 ══════════
       下拉是自研的（不用原生 select / datalist），这样业务画像、话术变量、全站观感统一，
       且「选项 + 自定义输入」两种入口都在同一个面板里。 */
    const sepFromCode = (c) => (c === 'nl' ? '\n' : (c === 'comma' ? ',' : '、'));
    /** 按字段固有分隔符拆成标签数组（关键词按逗号、卖点/痛点按行、区域/语气按顿号） */
    function splitBySep(v, sep) {
      const s = String(v == null ? '' : v);
      const parts = sep === '\n' ? s.split('\n') : (sep === ',' ? s.split(/[,，]/) : s.split(/[、,，\n]/));
      return parts.map((x) => x.trim()).filter(Boolean);
    }
    /** 取某个选项库 key 的选项；`product` 特殊：随「所属行业」联动，未匹配则通用兜底 */
    function resolveOpts(optKey, cardKey, ctxData) {
      if (!optKey) return [];
      if (optKey === 'product') {
        // 正在编辑「业务画像」时用表单里当下的行业，否则用已保存的行业
        const src = cardKey === 'business' ? (ctxData || {}) : ((stOf('business').data) || {});
        const ind = String(src.industry || '').trim();
        return BIZ_OPTIONS.productByIndustry[ind] || BIZ_OPTIONS.productGeneric;
      }
      return BIZ_OPTIONS[optKey] || [];
    }
    /** 关闭所有展开的下拉（下拉面板挂在字段内，绝对定位覆盖，不撑高容器）。
        注意：表单现在在弹窗（#modal）里，不在 #biz-panel 内，所以按全文档找。 */
    function closeAllDrops(except) {
      $$('.bdrop.is-open').forEach((d) => {
        if (d === except) return;
        d.classList.remove('is-open');
        const t = d.querySelector('[data-drop-toggle]');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    }
    /** 读卡片表单当前值（以 DOM 为准：刚选下、还没保存的值也算数） */
    function collectCard(card) {
      const data = {};
      card.querySelectorAll('[data-field]').forEach((el) => { data[el.dataset.field] = String(el.value == null ? '' : el.value).trim(); });
      return data;
    }

    /* 用途徽章：use 取值 → 显示文案 + title（人话解释） */
    const FIELD_USE = {
      ai:     { label: '影响AI', title: '填了会决定 AI 写出来什么样' },
      var:    { label: '话术变量', title: '只在手写话术的 {变量} 里被引用，AI 不读它' },
      filter: { label: '采集过滤', title: '采集评论时给线索打分、过滤无效线索' },
      none:   { label: '暂未使用', title: '目前没有任何地方用到，可放心留空' },
    };
    function fieldLabelHtml(f, uid) {
      const u = FIELD_USE[f.use] || FIELD_USE.ai;
      const reqBadge = f.req ? ' <span class="fld-req" title="必填">*</span>' : '';
      const useBadge = ` <span class="fld-use is-${esc(f.use)}" title="${esc(u.title)}">${esc(u.label)}</span>`;
      return `<label for="${uid}">${reqBadge}${esc(f.label)}${useBadge}</label>`;
    }
    /** 输入框按内容分级给尺寸（CSS 里定：单行 40px、多行 88px 起、选择框随内容长高），
        不再把所有框一刀切拉成同一个高度 —— 单行框撑成 60px 显得空，多行框又不够写。 */
    function fieldHtml(f, val, cardKey, ctxData) {
      const v = val == null ? '' : String(val);
      // id 带卡片前缀：industry 在「业务画像」和「目标客户」里都有，不带前缀会撞 id、label 指错框
      const uid = `bz-${cardKey || ''}-${f.k}`;
      const ph = f.ph || '';
      const hint = f.hint ? `<span class="field__hint">${esc(f.hint)}</span>` : '';

      // ① 纯文本（单行 / 多行）
      if (!f.sel && !f.tags) {
        const common = `id="${uid}" data-field="${f.k}" placeholder="${esc(ph)}"`;
        return `
        <div class="field${f.multi ? ' field--multi' : ''}">
          ${fieldLabelHtml(f, uid)}
          ${f.multi
            ? `<textarea ${common} rows="3">${esc(v)}</textarea>`
            : `<input type="text" ${common} value="${esc(v)}">`}
          ${hint}
        </div>`;
      }

      // ② 多选标签：已选的显示为胶囊（可 × 移除），面板里点选项即添加、也能输入自定义
      if (f.tags) {
        const sep = f.tagSep === '\n' ? '\n' : (f.tagSep === ',' ? ',' : '、');
        const code = sep === '\n' ? 'nl' : (sep === ',' ? 'comma' : 'dot');
        const cur = splitBySep(v, sep);
        const rest = resolveOpts(f.tags, cardKey, ctxData).filter((o) => !cur.includes(o));
        return `
        <div class="field field--tags" data-tags="${f.k}" data-opt="${f.tags}" data-tagsep="${code}" data-ph="${esc(ph)}"${f.max ? ` data-max="${f.max}"` : ''}>
          ${fieldLabelHtml(f, uid)}
          <div class="bdrop" data-drop>
            <div class="bdrop__box" data-drop-toggle tabindex="0"
                 aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(f.label)}">
              <div class="bdrop__tags" data-tagbox>${cur.length
                ? cur.map((t) => `<span class="bchip">${esc(t)}<button type="button" class="bchip__x" data-tag-del="${esc(t)}" title="移除">×</button></span>`).join('')
                : `<span class="bdrop__ph">${esc(ph || '点此选择')}</span>`}</div>
              <span class="bdrop__pick" data-drop-open aria-hidden="true">＋ 选择</span>
              <span class="bdrop__caret" aria-hidden="true"></span>
            </div>
            <div class="bdrop__panel">
              <input type="text" class="bdrop__input" data-drop-input placeholder="输入自定义值，回车添加" aria-label="${esc(f.label)}：搜索或输入自定义值">
              <div class="bdrop__list" role="listbox">${rest.length
                ? rest.map((o) => `<button type="button" class="bdrop__opt" data-tag-add="${esc(o)}" role="option" aria-selected="false">${esc(o)}</button>`).join('')
                : ''}<span class="bdrop__none" hidden></span></div>
              <div class="bdrop__foot">
                <span class="bdrop__tip">${f.max ? `最多选 ${f.max} 项` : '可多选'}</span>
                <button type="button" class="btn btn--sm" data-tag-clear>清空</button>
                <button type="button" class="btn btn--sm btn--primary" data-drop-done>完成</button>
              </div>
            </div>
          </div>
          <input type="hidden" id="${uid}" data-field="${f.k}" value="${esc(v)}">
          ${hint}
        </div>`;
      }

      // ③ 单选下拉：点选项即选中并收起；也能输入自定义值回车确定
      const opts = resolveOpts(f.sel, cardKey, ctxData);
      const list = (v && !opts.includes(v)) ? [v].concat(opts) : opts;
      return `
        <div class="field" data-sel="${f.k}" data-opt="${f.sel}" data-ph="${esc(ph)}">
          ${fieldLabelHtml(f, uid)}
          <div class="bdrop" data-drop>
            <div class="bdrop__box" data-drop-toggle tabindex="0"
                 aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(f.label)}">
              <span class="bdrop__val${v ? '' : ' is-empty'}" data-val>${esc(v || ph || '请选择或输入')}</span>
              <span class="bdrop__caret" aria-hidden="true"></span>
            </div>
            <div class="bdrop__panel">
              <input type="text" class="bdrop__input" data-drop-input placeholder="输入自定义值，回车确定" aria-label="${esc(f.label)}：搜索或输入自定义值">
              <div class="bdrop__list" role="listbox">${list.map((o) => `<button type="button" class="bdrop__opt${o === v ? ' is-on' : ''}" data-sel-opt="${esc(o)}" role="option" aria-selected="${o === v}">${o === v ? '✓ ' : ''}${esc(o)}</button>`).join('')}<span class="bdrop__none" hidden></span></div>
            </div>
          </div>
          <input type="hidden" id="${uid}" data-field="${f.k}" value="${esc(v)}">
          ${hint}
        </div>`;
    }
    /** 必填 / 选填 各成一个通栏区块，区块内部再排字段网格。
        之前标题和「展开」按钮是网格里的普通格子，会和字段抢位置、错位到别的列；
        现在标题通栏、字段只在 .fsec__grid 里，必填与选填左右对齐一致。 */
    function fieldGroupsHtml(fields, data, cardKey) {
      const reqFields = fields.filter((f) => f.req);
      const optFields = fields.filter((f) => !f.req);
      const filled = optFields.filter((f) => String(data[f.k] == null ? '' : data[f.k]).trim()).length;
      return `
        <div class="biz-fields">
          ${reqFields.length ? `
          <section class="fsec">
            <div class="fsec__hd">
              <span class="fsec__tag is-req">必填</span>
              <span class="fsec__n">${reqFields.length} 项</span>
              <span class="fsec__tip">缺一项就保存不了</span>
            </div>
            <div class="fsec__grid">${reqFields.map((f) => fieldHtml(f, data[f.k], cardKey, data)).join('')}</div>
          </section>` : ''}
          ${optFields.length ? `
          <section class="fsec" data-opt-sec>
            <button type="button" class="fsec__hd fsec__hd--btn" data-more aria-expanded="false">
              <span class="fsec__caret" aria-hidden="true"></span>
              <span class="fsec__tag is-opt">选填</span>
              <span class="fsec__n">${optFields.length} 项</span>
              <span class="fsec__tip" data-opt-tip>${filled ? `已填 ${filled}` : '可先留空，之后再补'}</span>
            </button>
            <div class="fsec__body" data-more-body hidden>
              <div class="fsec__grid">${optFields.map((f) => fieldHtml(f, data[f.k], cardKey, data)).join('')}</div>
            </div>
          </section>` : ''}
        </div>`;
    }
    /** 选填区标题上的「已填 x」：下拉/标签改的是隐藏 input，不会冒泡 input 事件，
        所以改动值的地方统一 dispatch 一次 input（见 wireFields 里的 fireInput）。 */
    function refreshOptCount(root) {
      const sec = root.querySelector('[data-opt-sec]');
      if (!sec) return;
      const inputs = sec.querySelectorAll('[data-field]');
      const total = inputs.length;
      let filled = 0;
      inputs.forEach((el) => { if (String(el.value == null ? '' : el.value).trim()) filled += 1; });
      const tip = sec.querySelector('[data-opt-tip]');
      if (tip) tip.textContent = filled ? `已填 ${filled} / ${total}` : '可先留空，之后再补';
      const btn = sec.querySelector('[data-more]');
      if (btn) btn.classList.toggle('has-value', filled > 0);
    }
    /** 必填校验：空的标红并聚焦第一个；返回未填字段名列表 */
    function checkRequired(key, root) {
      const bad = [];
      (BIZ_FIELDS[key] || []).filter((f) => f.req).forEach((f) => {
        const el = root.querySelector(`[data-field="${f.k}"]`);
        const wrap = el ? el.closest('.field') : null;
        const ok = !!el && !!String(el.value == null ? '' : el.value).trim();
        if (wrap) wrap.classList.toggle('is-err', !ok);
        if (!ok) bad.push(f);
      });
      return bad;
    }
    function focusField(el) {
      if (!el) return;
      const wrap = el.closest('.field');
      const box = wrap && wrap.querySelector('.bdrop__box');
      const target = (el.type === 'hidden' && box) ? box : el;
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
      if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    /* ══════════ 记录集卡片（业务画像 / 产品知识库 / 目标客户 / 微信转化）══════════
       每张卡片支持多条记录：上面是记录列表，下面是表单。
       「新增」→ 空表单 → 保存时另存一条，不覆盖已有记录；点列表里的「编辑」则改那一条。
       其中带「主」标记的是主记录，话术变量与 AI 生成都取它。 */
    const RECORD_CARDS = ['business', 'product', 'audience', 'wechat'];
    const EMPTY_RECORD = {
      business: { conversionGoal: '添加微信', tone: '专业、真诚' },
      product: {}, audience: {}, wechat: {},
    };

    /** 列表里每条记录的标题：取最能代表这张卡片的一个字段 */
    function recTitle(key, rec) {
      const r = rec || {};
      if (key === 'business') return [r.industry, r.targetCustomer].filter(Boolean).join(' · ');
      if (key === 'product') return r.productName || '';
      if (key === 'audience') return r.name || '';
      if (key === 'wechat') return r.wechatId ? ('微信号 ' + r.wechatId) : '';
      return '';
    }
    /** 列表里第二条信息：帮助区分同名记录 */
    function recSub(key, rec) {
      const r = rec || {};
      if (key === 'business') return [r.serviceArea, r.selfIntro].filter(Boolean).join(' · ');
      if (key === 'product') return [r.priceRange, splitLines(r.sellingPoints)[0]].filter(Boolean).join(' · ');
      if (key === 'audience') return [r.region, splitLines(r.needs)[0]].filter(Boolean).join(' · ');
      if (key === 'wechat') return [r.guideTiming, r.guideReason].filter(Boolean).join(' · ');
      return '';
    }
    const fmtStamp = (s) => {
      if (!s) return '';
      const d = new Date(s);
      if (isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    function stOf(key) {
      if (!wiz.cards[key]) {
        wiz.cards[key] = { records: [], primaryId: null, editingId: null, creating: false, data: {} };
      }
      return wiz.cards[key];
    }

    /** 记录列表：每条记录一行，平铺在卡片里（主记录加「主」徽标 + 高亮）。
        超过 3 条时，前 3 条直出，其余收在「展开全部 N 条」后面 —— 就是一个可展开的长列表，
        不用浮层、不用切换器。 */
    function recordsHtml(key) {
      const st = stOf(key);
      if (!st.records.length) {
        return `<div class="biz-recs"><div class="biz-recs__empty">还没有记录。点右上角「+ 新增」，在弹出的表单里填好后保存。</div></div>`;
      }
      const rowHtml = (r) => {
        const title = recTitle(key, r) || '未命名记录';
        const sub = recSub(key, r);
        return `<div class="biz-rec${r.isPrimary ? ' is-cur' : ''}">
          <span class="biz-rec__badge${r.isPrimary ? ' is-main' : ''}">${r.isPrimary ? '主' : ''}</span>
          <div class="biz-rec__main">
            <b>${esc(title)}</b>
            ${sub ? `<span class="biz-rec__sub">${esc(sub)}</span>` : ''}
          </div>
          <span class="biz-rec__time">${esc(fmtStamp(r.updatedAt))}</span>
          <div class="biz-rec__acts">
            ${r.isPrimary ? '' : `<button type="button" class="btn btn--sm" data-primary="${key}" data-id="${esc(r.id)}">设为主</button>`}
            <button type="button" class="btn btn--sm" data-edit="${key}" data-id="${esc(r.id)}">编辑</button>
            <button type="button" class="btn btn--sm btn--danger" data-del="${key}" data-id="${esc(r.id)}">删除</button>
          </div>
        </div>`;
      };
      const HEAD = 3;
      const total = st.records.length;
      const many = total > HEAD;
      return `<div class="biz-recs">
        ${st.records.slice(0, HEAD).map(rowHtml).join('')}
        ${many ? `<div class="biz-recs__rest" data-rest="${key}" hidden>${st.records.slice(HEAD).map(rowHtml).join('')}</div>
        <button type="button" class="biz-recs__more" data-rectoggle="${key}" aria-expanded="false">展开全部 ${total} 条<span class="biz-recs__caret"></span></button>` : ''}
      </div>`;
    }

    /** 展开 / 收起记录列表的尾部。纯 DOM 切换，不重新拉数据。 */
    function toggleRecList(btn) {
      const card = btn.closest('[data-card]');
      const rest = card && card.querySelector('[data-rest]');
      if (!rest) return;
      const open = rest.hidden;
      rest.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('is-open', open);
      const st = stOf(card.dataset.card);
      btn.innerHTML = (open ? '收起' : '展开全部 ' + st.records.length + ' 条') + '<span class="biz-recs__caret"></span>';
    }

    /* ══════════ 新增 / 编辑弹窗 ══════════
       页面上只留记录列表，表单全部收进弹窗：新增=空表单（另存一条，不覆盖），
       编辑=带该条数据（只更新这一条）。保存后关闭弹窗并刷新列表。 */
    function openFormModal(key, rec) {
      const i = BIZ_STEPS.findIndex((st) => st.key === key);
      const meta = BIZ_STEP_META[key] || {};
      const label = i >= 0 ? BIZ_STEPS[i].label : key;
      const fields = BIZ_FIELDS[key] || [];
      const editing = !!(rec && rec.id);
      const data = Object.assign({}, EMPTY_RECORD[key], rec || {});
      openModal(`
        <h2>${editing ? '编辑' : '新增'} · ${esc(label)}</h2>
        <p class="modal__lede">${esc(meta.desc || '')}${editing ? '' : '　保存后会新增一条记录，不会覆盖已有的。'}</p>
        <div class="biz-form biz-form--modal" data-card="${key}">
          ${fieldGroupsHtml(fields, data, key)}
          <div class="modal__foot">
            <button type="button" class="btn" data-close>取消</button>
            <button type="button" class="btn btn--primary" data-save>${editing ? '保存修改' : '新增并保存'}</button>
          </div>
        </div>`, { wide: true, variant: 'biz' });

      const root = $('#modal .biz-form');
      if (!root) return;
      wireFields(root);

      // 选填折叠：事件委托挂在表单容器上，点 [data-more] 切换 body 的 hidden
      root.addEventListener('click', (e) => {
        const t = e.target.closest('[data-more]');
        if (!t) return;
        const body = root.querySelector('[data-more-body]');
        if (body) { body.hidden = !body.hidden; t.setAttribute('aria-expanded', String(!body.hidden)); }
      });
      // 编辑已有记录时，选填区有内容就直接展开，避免「填过的内容看起来像没填」；
      // 新增时保持收起，表单不至于一打开就很长。
      const optBody = root.querySelector('[data-more-body]');
      const optBtn = root.querySelector('[data-more]');
      if (editing && optBody && optBtn && optBody.querySelectorAll('[data-field]').length) {
        const hasVal = Array.from(optBody.querySelectorAll('[data-field]'))
          .some((el) => String(el.value == null ? '' : el.value).trim());
        if (hasVal) { optBody.hidden = false; optBtn.setAttribute('aria-expanded', 'true'); }
      }
      // 输入即更新「已填 x」、并清掉该字段的必填标红
      root.addEventListener('input', (e) => {
        const wrap = e.target.closest && e.target.closest('.field');
        if (wrap) wrap.classList.remove('is-err');
        refreshOptCount(root);
      });
      refreshOptCount(root);
      const btn = root.querySelector('[data-save]');
      btn.addEventListener('click', () => submitForm(key, rec, root, btn));
    }

    async function submitForm(key, rec, root, btn) {
      if (wiz.busy) return;
      const bad = checkRequired(key, root);
      if (bad.length) {
        toast('还有 ' + bad.length + ' 项必填没填：' + bad.map((f) => f.label).join('、'), 'warn');
        focusField(root.querySelector(`[data-field="${bad[0].k}"]`));
        return;
      }
      wiz.busy = true;
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        const data = collectCard(root);
        const label = (BIZ_STEPS.find((s) => s.key === key) || {}).label || key;
        if (rec && rec.id) {
          await API.updateProfileRecord(key, rec.id, data);
          toast('已保存：' + label, 'ok');
        } else {
          await API.createProfileRecord(key, data);
          toast('已新增一条「' + label + '」记录（并设为主记录）', 'ok');
        }
        invalidateProfileCtx();
        closeModal();
        await loadAll();
        await loadStatus();
        renderCards();
      } catch (e) {
        toast('保存失败：' + e.message, 'warn');
        btn.disabled = false; btn.textContent = old;
      } finally { wiz.busy = false; }
    }

    function cardHtml(key) {
      const i = BIZ_STEPS.findIndex((st) => st.key === key);
      const meta = BIZ_STEP_META[key] || {};
      const label = i >= 0 ? BIZ_STEPS[i].label : key;
      const st = stOf(key);
      return `
        <div class="card biz-card" data-card="${key}">
          <div class="biz-card__head">
            <b class="biz-card__title"><span class="biz-card__no">${i >= 0 ? i + 1 : ''}</span>${esc(label)}</b>
            <span class="biz-card__desc">${esc(meta.desc || '')}</span>
            <span class="biz-card__count">${st.records.length} 条</span>
            <button type="button" class="btn btn--sm btn--primary" data-new="${key}">+ 新增</button>
          </div>
          ${recordsHtml(key)}
        </div>`;
    }

    /** 拉取 4 张卡片的记录集 */
    async function loadAll() {
      await Promise.all(RECORD_CARDS.map(async (key) => {
        const st = stOf(key);
        let res = null;
        try { res = await API.listProfileRecords(key); } catch (e) { res = null; }
        const items = (res && (res.items || res)) || [];
        st.records = Array.isArray(items) ? items : [];
        st.primaryId = (res && res.primaryId)
          || (st.records.find((r) => r.isPrimary) || {}).id || null;

        if (st.creating) {
          st.data = Object.assign({}, EMPTY_RECORD[key], st.data);
        } else {
          let cur = st.records.find((r) => r.id === st.editingId);
          if (!cur) cur = st.records.find((r) => r.id === st.primaryId) || st.records[0] || null;
          st.editingId = cur ? cur.id : null;
          st.data = Object.assign({}, EMPTY_RECORD[key], cur || {});
        }
        wiz.data[key] = st.data;
      }));
    }

    /** 只重建卡片 DOM（不重新拉数据），供列表内操作后刷新 */
    function renderCards() {
      panel.innerHTML = `
        <div class="biz-grid">
          ${cardHtml('business')}
          ${cardHtml('product')}
          ${cardHtml('audience')}
          ${cardHtml('wechat')}
        </div>`;
      wireCards();
    }

    function wireCards() {
      $$('#biz-panel [data-card]').forEach((card) => {
        const key = card.dataset.card;
        if (!RECORD_CARDS.includes(key)) return;
        const st = stOf(key);

        const newBtn = card.querySelector('[data-new]');
        if (newBtn) newBtn.addEventListener('click', () => openFormModal(key, null));

        // 记录列表尾部「展开全部 / 收起」
        const recToggle = card.querySelector('[data-rectoggle]');
        if (recToggle) recToggle.addEventListener('click', () => toggleRecList(recToggle));

        card.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
          const rec = st.records.find((r) => r.id === b.dataset.id) || null;
          if (rec) openFormModal(key, rec);
        }));
        card.querySelectorAll('[data-primary]').forEach((b) => b.addEventListener('click', async () => {
          try {
            await API.setPrimaryProfileRecord(key, b.dataset.id);
            await loadAll();
            renderCards();
            toast('已设为主记录（话术变量与 AI 生成改用这条）', 'ok');
          } catch (e) { toast('设置失败：' + e.message, 'warn'); }
        }));
        card.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
          const rec = st.records.find((r) => r.id === b.dataset.id) || {};
          const name = recTitle(key, rec) || '未命名记录';
          if (!window.confirm('删除记录「' + name + '」？删除后不可恢复。')) return;
          try {
            await API.deleteProfileRecord(key, b.dataset.id);
            st.editingId = null;
            await loadAll();
            await loadStatus();
            renderCards();
            toast('已删除记录', 'ok');
          } catch (e) { toast('删除失败：' + e.message, 'warn'); }
        }));
      });
    }

    /** 绑定自研下拉：单选（选中即收起）/ 多选标签（点选即加、胶囊 × 移除、可输入自定义） */
    function wireFields(card) {
      card.querySelectorAll('.bdrop').forEach((drop) => {
        const field = drop.closest('.field');
        if (!field) return;
        const hidden = field.querySelector('input[data-field]');
        if (!hidden) return;
        // 下拉/标签改的是隐藏 input，不会自己冒泡事件；
        // 手动派发一次，让上层的「已填计数」「清掉标红」能感知到。
        const fireInput = () => hidden.dispatchEvent(new Event('input', { bubbles: true }));
        const panelEl = drop.querySelector('.bdrop__panel');
        const toggle = drop.querySelector('[data-drop-toggle]');
        const input = drop.querySelector('[data-drop-input]');
        const isTags = field.hasAttribute('data-tags');
        const ph = field.dataset.ph || '请选择或输入';
        const max = field.dataset.max ? parseInt(field.dataset.max, 10) : 0;
        // 面板内点击不冒泡到 document，否则会被"点外部关闭"立刻收起
        panelEl.addEventListener('click', (e) => e.stopPropagation());
        // 面板里输入即过滤候选；过滤到 0 条时，空态文案改成「回车添加自定义值」
        function applyFilter() {
          const listBox = panelEl.querySelector('.bdrop__list');
          if (!listBox) return;
          const q = String(input ? input.value : '').trim().toLowerCase();
          let hit = 0;
          listBox.querySelectorAll('[data-sel-opt], [data-tag-add]').forEach((b) => {
            const t = String(b.dataset.selOpt || b.dataset.tagAdd || '').toLowerCase();
            const on = !q || t.indexOf(q) >= 0;
            b.hidden = !on;
            if (on) hit += 1;
          });
          const noneEl = listBox.querySelector('.bdrop__none');
          if (!noneEl) return;
          noneEl.hidden = hit > 0;
          if (hit) return;
          noneEl.textContent = q
            ? `没有匹配项，回车添加「${String(input.value).trim()}」`
            : (isTags ? '常用项都已选完，可直接输入自定义值' : '暂无可选清单，直接输入自定义值');
        }
        if (input) {
          input.addEventListener('input', applyFilter);
          // Esc 只收面板，不关弹窗（escClose 已处理，这里再兜一次避免冒泡）
          input.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setOpen(false);
          });
        }
        // 键盘：聚焦触发框后回车/空格/下箭头都能展开
        if (toggle) {
          toggle.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
              e.preventDefault();
              if (isOpen()) { setOpen(false); return; }
              openPanel();
            }
          });
        }

        const setOpen = (on) => {
          drop.classList.toggle('is-open', !!on);
          if (toggle) toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
        };
        const isOpen = () => drop.classList.contains('is-open');
        // 展开前先按表单当前值刷新选项（例：「主营产品」要跟着刚选的行业变）。
        // 弹窗是滚动容器，字段贴着上/下边时面板会被裁掉：先量出面板自然高度，
        // 能放下就向下弹；下方不够但上方够就向上弹；两边都不够就压缩选项列表，
        // 保证面板整体落在容器内。右列字段若向右溢出，改为贴右对齐。
        let refreshOnOpen = () => {};
        const openPanel = () => {
          closeAllDrops(drop);
          if (input) { input.value = ''; input.focus({ preventScroll: true }); }
          refreshOnOpen();
          const listEl = panelEl.querySelector('.bdrop__list');
          if (listEl) listEl.style.maxHeight = '';
          drop.classList.remove('is-up');
          setOpen(true);
          applyFilter();

          const scroller = drop.closest('.modal');
          const base = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
          const r = drop.getBoundingClientRect();
          const h = panelEl.offsetHeight;
          const below = (base.bottom - r.bottom) - 6;
          const above = (r.top - base.top) - 6;
          const useUp = h > below && above > below;
          if (useUp) drop.classList.add('is-up');
          const avail = useUp ? above : below;
          if (h > avail && listEl) {
            // 固定部分（内边距 + 自定义输入框 + 底部条）约 110px
            listEl.style.maxHeight = Math.max(56, Math.round(avail - 110)) + 'px';
          }
          const cr = (scroller || document.documentElement).getBoundingClientRect();
          drop.classList.toggle('is-right', panelEl.getBoundingClientRect().right > cr.right - 6);
        };
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isOpen()) { setOpen(false); return; }
          openPanel();
        });
        // 多选标签里胶囊自带「×」，点框体中间容易误删；给一个明确的「＋ 选择」入口
        const openBtn = drop.querySelector('[data-drop-open]');
        if (openBtn) openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isOpen()) { setOpen(false); return; }
          openPanel();
        });

        if (!isTags) {
          /* ── 单选下拉 ── */
          const valEl = drop.querySelector('[data-val]');
          const listBox = drop.querySelector('.bdrop__list');
          const setVal = (next) => {
            hidden.value = next || '';
            if (valEl) {
              valEl.textContent = next || ph;
              valEl.classList.toggle('is-empty', !next);
            }
            listBox.querySelectorAll('[data-sel-opt]').forEach((b) => {
              const on = b.dataset.selOpt === next;
              b.classList.toggle('is-on', on);
              b.textContent = (on ? '✓ ' : '') + b.dataset.selOpt;
              b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            fireInput();
          };
          const renderOpts = () => {
            const cur = hidden.value;
            const base = resolveOpts(field.dataset.opt, card.dataset.card, collectCard(card));
            const list = (cur && !base.includes(cur)) ? [cur].concat(base) : base;
            listBox.innerHTML = list.map((o) => `<button type="button" class="bdrop__opt${o === cur ? ' is-on' : ''}" data-sel-opt="${esc(o)}" role="option" aria-selected="${o === cur}">${o === cur ? '✓ ' : ''}${esc(o)}</button>`).join('')
              + '<span class="bdrop__none" hidden></span>';
            listBox.querySelectorAll('[data-sel-opt]').forEach((b) => b.addEventListener('click', (e) => {
              e.stopPropagation();
              setVal(b.dataset.selOpt);
              input.value = '';
              setOpen(false);
            }));
            applyFilter();
          };
          renderOpts();
          refreshOnOpen = renderOpts;
          input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const t = input.value.trim();
            if (!t) return;
            setVal(t);
            input.value = '';
            applyFilter();
            setOpen(false);
          });
          return;
        }

        /* ── 多选标签 ── */
        const sep = sepFromCode(field.dataset.tagsep);
        const fdef = (BIZ_FIELDS[card.dataset.card] || []).find((x) => x.k === field.dataset.tags) || {};
        const label = fdef.label || field.dataset.tags || '该字段';
        const getCur = () => splitBySep(hidden.value, sep);
        const refresh = () => {
          const cur = getCur();
          // 有胶囊时才显示「＋ 选择」：空框已有占位文字提示，不必重复
          drop.classList.toggle('has-tags', cur.length > 0);
          const box = drop.querySelector('[data-tagbox]');
          box.innerHTML = cur.length
            ? cur.map((t) => `<span class="bchip">${esc(t)}<button type="button" class="bchip__x" data-tag-del="${esc(t)}" title="移除「${esc(t)}」" aria-label="移除「${esc(t)}」">×</button></span>`).join('')
            : `<span class="bdrop__ph">${esc(ph)}</span>`;
          box.querySelectorAll('[data-tag-del]').forEach((b) => b.addEventListener('click', (e) => {
            e.stopPropagation();
            hidden.value = getCur().filter((x) => x !== b.dataset.tagDel).join(sep);
            refresh();
            fireInput();
          }));
          const rest = resolveOpts(field.dataset.opt, card.dataset.card, collectCard(card)).filter((o) => !cur.includes(o));
          const listBox = drop.querySelector('.bdrop__list');
          listBox.innerHTML = rest.map((o) => `<button type="button" class="bdrop__opt" data-tag-add="${esc(o)}" role="option" aria-selected="false">${esc(o)}</button>`).join('')
            + '<span class="bdrop__none" hidden></span>';
          listBox.querySelectorAll('[data-tag-add]').forEach((b) => b.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur2 = getCur();
            const t = b.dataset.tagAdd;
            if (cur2.includes(t)) return;
            if (max && cur2.length >= max) { toast('「' + label + '」最多选 ' + max + ' 项', 'warn'); return; }
            hidden.value = cur2.concat([t]).join(sep);
            refresh();
            fireInput();
          }));
          const tipEl = drop.querySelector('.bdrop__tip');
          if (tipEl) tipEl.textContent = max ? `已选 ${cur.length} / ${max}` : (cur.length ? `已选 ${cur.length} 项` : '可多选');
          applyFilter();
        };
        refresh();
        refreshOnOpen = refresh;
        // 一键清空已选
        const clearBtn = drop.querySelector('[data-tag-clear]');
        if (clearBtn) clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!getCur().length) return;
          hidden.value = '';
          refresh();
          fireInput();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const t = input.value.trim();
          if (!t) return;
          const cur = getCur();
          if (!cur.includes(t)) {
            if (max && cur.length >= max) { toast('「' + label + '」最多选 ' + max + ' 项', 'warn'); input.value = ''; applyFilter(); return; }
            hidden.value = cur.concat([t]).join(sep);
            refresh();
            fireInput();
          }
          input.value = '';
          applyFilter();
        });
        const done = drop.querySelector('[data-drop-done]');
        if (done) done.addEventListener('click', (e) => { e.stopPropagation(); setOpen(false); });
      });

      // 点面板外任意处收起（只绑一次）
      if (!document.body.dataset.bizDropBound) {
        document.body.dataset.bizDropBound = '1';
        document.addEventListener('click', () => closeAllDrops(null));
      }
    }

    async function paint() {
      await loadAll();
      renderCards();
    }


    await loadStatus();
    await paint();
  }

  /* ═══════════════════════════════════════════
     视图：上线向导（把系统真正跑起来）
     7 步：环境自检 → 启动采集 → 扫码登录 → 绑定账号 → 配置采集 → 话术频控 → 启动看结果
     入口：「账号管理 → 上手向导」
     ═══════════════════════════════════════════ */
  const LAUNCH_STEPS = [
    { key: 'check', label: '环境自检' },
    { key: 'service', label: '启动采集' },
    { key: 'login', label: '扫码登录' },
    { key: 'account', label: '绑定账号' },
    { key: 'crawl', label: '配置采集' },
    { key: 'policy', label: '话术频控' },
    { key: 'launch', label: '启动看结果' },
  ];

  const READY_LABEL = {
    backend: '后端服务',
    crawl_service: '采集服务',
    douyin_login: '抖音登录态',
    ai: 'AI 模型',
    account: '抖音账号',
    business: '业务资料',
    database: '数据库',
  };

  const CRAWL_STATUS_MAP = {
    pending: { txt: '待启动', cls: '' },
    running: { txt: '采集中', cls: 'is-warn' },
    success: { txt: '采集完成', cls: 'is-ok' },
    completed: { txt: '采集完成', cls: 'is-ok' },
    failed: { txt: '采集失败', cls: 'is-bad' },
    stopped: { txt: '已停止', cls: '' },
  };

  /* 轮询句柄（切步/离开视图时要清掉，否则会叠加定时器） */
  let launchPoll = null;
  function clearLaunchPoll() { if (launchPoll) { clearInterval(launchPoll); launchPoll = null; } }

  /* window.CrawlAPI 与 api-settings.js 都是裸返回后端 JSON，不做驼峰转换，
     这里统一成前端字段名，避免两种命名混用出错 */
  function cs(s) {
    if (!s) return s;
    return {
      id: s.id,
      status: s.status,
      collectedCount: s.collected_count ?? s.collectedCount ?? 0,
      importedCount: s.imported_count ?? s.importedCount ?? 0,
      errorMessage: s.error_message ?? s.errorMessage ?? '',
      maxVideos: s.max_videos ?? s.maxVideos,
    };
  }

  function launchWizardSkeletonHtml() {
    return `
        <div class="wizard">
          <div class="wizard__status" id="lw-status"></div>
          <div class="wizard__steps" id="lw-steps">
            ${LAUNCH_STEPS.map((s, i) => `
              <div class="wizard__step" data-step="${i}">
                <span class="wizard__step-no">${i + 1}</span><span>${esc(s.label)}</span>
              </div>`).join('')}
          </div>
          <div class="card" style="padding:22px 26px">
            <div id="lw-panel"></div>
          </div>
        </div>`;
  }

  async function renderLaunchWizardBody(initialStep = 0) {
    const panel = $('#lw-panel');
    if (!panel) return;
    clearLaunchPoll();

    const wiz = {
      step: 0,
      readiness: null,
      service: null,
      loginTaskId: null,
      loginStatus: null,
      accounts: [],
      crawl: {
        crawlType: 'search', keyword: '', competitorAccount: '', videoUrl: '',
        intentKeywords: '', excludedKeywords: '',
        maxCommentsPerVideo: 50, maxVideos: 20, timeRange: 7, sortType: 'latest',
      },
      taskId: null,
      taskStatus: null,
      scripts: [], scriptId: '',
      dailyLimit: 60,
      compliance: { r1: true, r2: true, r3: true },
      busy: false,
    };

    /* ── 步骤条 ── */
    function paintSteps() {
      $$('#lw-steps .wizard__step').forEach((el) => {
        const i = +el.dataset.step;
        el.className = 'wizard__step'
          + (i < wiz.step ? ' wizard__step--done' : '')
          + (i === wiz.step ? ' wizard__step--active' : '');
        el.querySelector('.wizard__step-no').textContent = i < wiz.step ? '✓' : i + 1;
      });
    }

    function statusBar(cls, tag, desc) {
      const el = $('#lw-status');
      if (!el) return;
      if (!tag) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.className = 'wizard__status ' + (cls || '');
      el.innerHTML = `
        <span class="wizard__status-tag">${esc(tag)}</span>
        <span class="wizard__status-desc">${esc(desc || '')}</span>
        <span class="wizard__status-bar">
          ${LAUNCH_STEPS.map((s, i) => `<i class="${i < wiz.step ? 'on' : ''}" title="${esc(s.label)}"></i>`).join('')}
        </span>`;
    }

    function head(i) {
      return `
        <h2 style="font-family:var(--font-display);font-size:17px;margin-bottom:6px">第 ${i + 1} 步 · ${esc(LAUNCH_STEPS[i].label)}</h2>
        <p style="font-size:12.5px;color:var(--ink-faint);margin-bottom:18px">${esc(LAUNCH_STEP_DESC[i])}</p>`;
    }

    /* ══ 第1步：环境自检 ══ */
    async function renderCheck() {
      panel.innerHTML = `<div class="wizard__panel">${head(0)}<div id="lw-check"><div class="empty"><p>正在检测环境…</p></div></div></div>`;
      appendFoot();
      const box = $('#lw-check');
      try {
        wiz.readiness = await API.getReadiness();
      } catch (e) {
        box.innerHTML = `<div class="empty"><p>检测失败：${esc(e.message)}</p></div>`;
        statusBar('is-bad', '检测失败', e.message);
        return;
      }
      const r = wiz.readiness;
      const items = r.items || [];
      box.innerHTML = `
        <div class="ready">
          ${items.map((it) => `
            <div class="ready__item ${it.ok ? 'is-ok' : 'is-bad'}">
              <span class="ready__ico">${it.ok ? '✓' : '!'}</span>
              <div class="ready__body">
                <div class="ready__label">${esc(it.label)}</div>
                <div class="ready__detail">${esc(it.detail || '')}</div>
              </div>
              <div class="ready__act">
                ${it.action ? `<button type="button" class="btn btn--sm" data-ready-act="${esc(it.action.type)}" data-ready-step="${it.action.step ?? ''}">${esc(it.action.label)}</button>` : ''}
                ${it.link ? `<a class="btn btn--sm" href="${esc(it.link)}">去设置</a>` : ''}
              </div>
            </div>`).join('')}
        </div>
        <div class="ready__sum ${r.ok ? 'is-ok' : 'is-warn'}">
          ${r.ok ? '全部就绪，可以开始上线。' : '还有 ' + (r.blocking || []).length + ' 项阻塞上线：' + (r.blocking || []).map((k) => READY_LABEL[k] || k).join('、')}
        </div>`;
      statusBar(r.ok ? 'is-ok' : 'is-warn',
        r.ok ? '环境就绪' : '存在阻塞项',
        r.ok ? '所有检查项通过' : '阻塞项：' + (r.blocking || []).map((k) => READY_LABEL[k] || k).join('、'));

      $$('#lw-check [data-ready-act]').forEach((b) => b.addEventListener('click', async () => {
        const type = b.dataset.readyAct;
        if (type === 'start_crawl_service') {
          wiz.step = 1; await goStep(1);
          const btn = $('#lw-start-svc');
          if (btn) btn.click();
        } else if (type === 'goto_step') {
          const s = parseInt(b.dataset.readyStep, 10);
          if (!isNaN(s)) await goStep(s);
        }
      }));

      const again = $('#lw-recheck');
      if (again) again.addEventListener('click', () => renderCheck());
    }

    /* ══ 第2步：启动采集服务 ══ */
    async function renderService() {
      panel.innerHTML = `<div class="wizard__panel">${head(1)}
        <div id="lw-svc"><div class="empty"><p>正在读取采集服务状态…</p></div></div>
        <div class="confirm-note" style="margin-top:14px">
          采集服务是独立的 MediaCrawler 进程，负责去抖音抓评论。它没起来，采集任务一定会失败。
          本系统会用它自带的运行环境直接拉起，不依赖 <code>uv</code>。
        </div>
      </div>`;
      appendFoot();
      const box = $('#lw-svc');

      function paint(s) {
        box.innerHTML = `
          <div class="ready">
            <div class="ready__item ${s.running ? 'is-ok' : 'is-bad'}">
              <span class="ready__ico">${s.running ? '✓' : '!'}</span>
              <div class="ready__body">
                <div class="ready__label">采集服务${s.running ? '运行中' : '未运行'}</div>
                <div class="ready__detail">
                  ${esc(s.url || '')}
                  ${s.running ? ' · 状态 ' + esc(s.crawlerStatus || '未知') : ''}
                  ${s.pid ? ' · PID ' + esc(s.pid) : ''}
                  ${s.managed ? ' · 由本系统启动' : (s.running ? ' · 外部进程' : '')}
                </div>
              </div>
            </div>
          </div>
          ${s.lastError ? `<div class="ready__sum is-bad">${esc(s.lastError)}</div>` : ''}`;
      }

      async function load() {
        try { wiz.service = await API.getCrawlService(); } catch (e) { wiz.service = { running: false, url: '', lastError: e.message }; }
        paint(wiz.service);
        statusBar(wiz.service.running ? 'is-ok' : 'is-warn',
          wiz.service.running ? '采集服务就绪' : '等待启动',
          wiz.service.running ? '可以继续下一步' : '点击「启动采集服务」');
      }
      await load();

      const start = $('#lw-start-svc');
      if (start) start.addEventListener('click', async () => {
        if (wiz.busy) return;
        wiz.busy = true; start.disabled = true;
        start.textContent = '启动中…（最多等 20 秒）';
        try {
          wiz.service = await API.startCrawlService();
          paint(wiz.service);
          if (wiz.service.running) { toast('采集服务已就绪'); await load(); }
          else { toast('启动未成功：' + (wiz.service.lastError || '超时'), 'warn'); start.disabled = false; start.textContent = '重新启动'; }
        } catch (e) {
          toast('启动失败：' + e.message, 'warn');
          start.disabled = false; start.textContent = '重新启动';
        } finally { wiz.busy = false; }
      });

      const recheck = $('#lw-recheck-svc');
      if (recheck) recheck.addEventListener('click', () => load());
    }

    /* ══ 第3步：扫码登录 ══ */
    async function renderLogin() {
      const kw = (wiz.crawl.keyword || (wiz.readiness && '') || '装修').trim();
      panel.innerHTML = `<div class="wizard__panel">${head(2)}
        <div class="confirm-note" style="margin-bottom:14px">
          点下面的按钮会<strong>打开一个浏览器窗口</strong>，请用手机抖音 App 扫码登录。
          扫码成功后窗口会继续跑一个小采集（1 个视频 / 1 条评论），用来验证登录态是否真的可用。
        </div>
        <div class="field">
          <label for="lw-login-kw">试采关键词（用于唤起登录）</label>
          <input type="text" id="lw-login-kw" value="${esc(kw)}" placeholder="例：装修 半包 报价">
        </div>
        <div id="lw-login-st"><div class="empty"><p>尚未开始</p></div></div>
      </div>`;
      appendFoot();

      const box = $('#lw-login-st');
      function paint() {
        const s = wiz.loginStatus;
        if (!s) { box.innerHTML = '<div class="empty"><p>尚未开始</p></div>'; return; }
        const m = CRAWL_STATUS_MAP[s.status] || { txt: s.status || '未知', cls: '' };
        box.innerHTML = `
          <div class="ready">
            <div class="ready__item ${m.cls === 'is-ok' ? 'is-ok' : (m.cls === 'is-bad' ? 'is-bad' : '')}">
              <span class="ready__ico">${m.cls === 'is-ok' ? '✓' : (m.cls === 'is-bad' ? '!' : '…')}</span>
              <div class="ready__body">
                <div class="ready__label">登录 / 试采任务：${esc(m.txt)}</div>
                <div class="ready__detail">
                  已采集 ${esc(s.collectedCount ?? 0)} 条 · 已入库 ${esc(s.importedCount ?? 0)} 条
                </div>
              </div>
            </div>
          </div>
          ${s.errorMessage ? `<div class="ready__sum is-bad">${esc(s.errorMessage)}</div>` : ''}`;
      }

      clearLaunchPoll();
      function startPoll() {
        launchPoll = setInterval(async () => {
          if (!wiz.loginTaskId || !document.getElementById('lw-login-st')) { clearLaunchPoll(); return; }
          try {
            // 扫码登录创建的是 TaskService 的 media_crawler_live 任务，
            // 轮询改用采集服务（8090）实时状态，避免误用 CrawlTask 那套不匹配的接口。
            const live = await API.getCrawlLiveStatus();
            const st = live.status; // 'idle' | 'running' | 'error'
            if (st === 'running') wiz.loginSeenRunning = true;
            const ended = (st === 'idle' && wiz.loginSeenRunning) || st === 'error';
            const s = {
              status: st === 'error' ? 'failed' : (ended ? 'success' : 'running'),
              collectedCount: live.collectedCount || 0,
              importedCount: live.importedCount || 0,
              errorMessage: live.errorMessage || '',
            };
            wiz.loginStatus = s;
            paint();
            if (ended) {
              clearLaunchPoll();
              if (st === 'error') {
                statusBar('is-bad', '登录 / 试采失败', live.errorMessage || '请看采集服务状态');
              } else {
                statusBar('is-ok', '登录成功', '抖音扫码登录已完成，可以继续');
                try { await API.syncDouyinAccount(); } catch (_) { /* 无登录态时忽略，账号列表仅在扫码成功后出现 */ }
              }
              await refreshAccounts();
            }
          } catch (e) { /* 轮询失败不打断 */ }
        }, 2500);
      }

      const go = $('#lw-login-go');
      if (go) go.addEventListener('click', async () => {
        const keyword = ($('#lw-login-kw')?.value || '').trim();
        if (!keyword) { toast('请先填一个关键词', 'warn'); return; }
        wiz.crawl.keyword = keyword;
        if (wiz.busy) return;
        wiz.busy = true; go.disabled = true;
        try {
          const task = await API.startCrawlLiveLogin({
            keyword: keyword,
            count: 1,
            maxCommentsCount: 1,
            loginType: 'qrcode',
            headless: false,
          });
          wiz.loginTaskId = task.id;
          wiz.loginStatus = { status: 'running', collectedCount: 0, importedCount: 0 };
          paint();
          statusBar('is-warn', '等待扫码', '浏览器已打开，请用抖音 App 扫码登录');
          clearLaunchPoll(); startPoll();
        } catch (e) {
          toast('启动失败：' + e.message, 'warn');
          go.disabled = false;
        } finally { wiz.busy = false; }
      });
    }

    /* ══ 第4步：绑定账号 ══ */
    async function refreshAccounts() {
      try { wiz.accounts = (await API.getAccounts()) || []; } catch (e) { wiz.accounts = []; }
    }
    async function renderAccount() {
      await refreshAccounts();
      panel.innerHTML = `<div class="wizard__panel">${head(3)}
        <div class="confirm-note" style="margin-bottom:14px">
          MediaCrawler 侧已扫码登录的话，这里主要是给账号起个便于识别的备注名，并设定日发上限——
          频控和健康分监控都按账号走。可以跳过，之后再补。
        </div>
        <div class="grid grid--2">
          <div class="field"><label for="lw-acc-nick">账号昵称（备注名）</label>
            <input type="text" id="lw-acc-nick" placeholder="例：装修案例·阿明"></div>
          <div class="field"><label for="lw-acc-limit">该账号日频上限</label>
            <input type="number" id="lw-acc-limit" value="80" min="1" max="500"></div>
        </div>
        <div class="field"><label for="lw-acc-notes">备注</label>
          <input type="text" id="lw-acc-notes" placeholder="例：主号，只发私信不带链接"></div>
        <div class="card__head" style="margin-top:18px"><span class="card__title">已绑定账号</span>
          <span class="card__hint">共 ${wiz.accounts.length} 个</span></div>
        <div class="ready">
          ${wiz.accounts.length ? wiz.accounts.map((a) => `
            <div class="ready__item is-ok">
              <span class="ready__ico">✓</span>
              <div class="ready__body">
                <div class="ready__label">${esc(a.nickname || '(未命名)')}</div>
                <div class="ready__detail">${esc(a.platform || 'douyin')} · 日发上限 ${esc(a.dailyLimit ?? '-')} · 健康分 ${esc(a.healthScore ?? '-')}</div>
              </div>
            </div>`).join('') : '<div class="empty"><p>还没有绑定账号</p></div>'}
        </div>
      </div>`;
      appendFoot();

      const save = $('#lw-acc-save');
      if (save) save.addEventListener('click', async () => {
        const nickname = ($('#lw-acc-nick')?.value || '').trim();
        if (!nickname) { toast('请填账号昵称', 'warn'); return; }
        if (wiz.busy) return;
        wiz.busy = true; save.disabled = true;
        try {
          await API.createAccount({
            nickname: nickname,
            platform: 'douyin',
            dailyLimit: parseInt($('#lw-acc-limit')?.value, 10) || 80,
            notes: ($('#lw-acc-notes')?.value || '').trim(),
          });
          toast('账号已绑定');
          await renderAccount();
        } catch (e) {
          toast('绑定失败：' + e.message, 'warn');
          save.disabled = false;
        } finally { wiz.busy = false; }
      });
    }

    /* ══ 第5步：配置采集 ══ */
    async function renderCrawl() {
      const c = wiz.crawl;
      panel.innerHTML = `<div class="wizard__panel">${head(4)}
        <div class="field" style="margin-bottom:14px"><label>采集方式</label>
          <div class="radio-cards">
            <label class="radio-card ${c.crawlType === 'search' ? 'radio-card--checked' : ''}"><input type="radio" name="lw-ct" value="search" ${c.crawlType === 'search' ? 'checked' : ''}>
              <span class="radio-card__body"><span class="radio-card__title">关键词搜索</span><span class="radio-card__desc">按关键词找视频，抓评论区</span></span></label>
            <label class="radio-card ${c.crawlType === 'competitor' ? 'radio-card--checked' : ''}"><input type="radio" name="lw-ct" value="competitor" ${c.crawlType === 'competitor' ? 'checked' : ''}>
              <span class="radio-card__body"><span class="radio-card__title">对标账号</span><span class="radio-card__desc">采集竞品账号下的评论</span></span></label>
            <label class="radio-card ${c.crawlType === 'video' ? 'radio-card--checked' : ''}"><input type="radio" name="lw-ct" value="video" ${c.crawlType === 'video' ? 'checked' : ''}>
              <span class="radio-card__body"><span class="radio-card__title">指定视频</span><span class="radio-card__desc">只抓某条视频的评论</span></span></label>
          </div>
        </div>
        <div class="grid grid--2">
          <div class="field"><label for="lw-c-kw">关键词</label>
            <input type="text" id="lw-c-kw" value="${esc(c.keyword)}" placeholder="例：装修 半包 报价"></div>
          <div class="field"><label for="lw-c-comp">对标账号</label>
            <input type="text" id="lw-c-comp" value="${esc(c.competitorAccount)}" placeholder="例：some_designer"></div>
        </div>
        <div class="field"><label for="lw-c-video">视频链接</label>
          <input type="text" id="lw-c-video" value="${esc(c.videoUrl)}" placeholder="https://www.douyin.com/video/..."></div>
        <div class="grid grid--2">
          <div class="field"><label for="lw-c-intent">意向关键词（高意向判据）</label>
            <input type="text" id="lw-c-intent" value="${esc(c.intentKeywords)}" placeholder="逗号分隔。例：多少钱, 报价, 半包, 怎么收费"></div>
          <div class="field"><label for="lw-c-excl">排除关键词</label>
            <input type="text" id="lw-c-excl" value="${esc(c.excludedKeywords)}" placeholder="逗号分隔。例：招聘, 加盟, 同行"></div>
        </div>
        <div class="grid grid--2">
          <div class="field"><label for="lw-c-per">每个视频最多抓多少条评论</label>
            <input type="number" id="lw-c-per" value="${c.maxCommentsPerVideo}" min="1" max="2000"></div>
          <div class="field"><label for="lw-c-vids">最多抓几个视频</label>
            <input type="number" id="lw-c-vids" value="${c.maxVideos}" min="1" max="500"></div>
        </div>
        <div class="grid grid--2">
          <div class="field"><label for="lw-c-range">时间范围（天）</label>
            <input type="number" id="lw-c-range" value="${c.timeRange}" min="1" max="365"></div>
          <div class="field"><label for="lw-c-sort">排序方式</label>
            <select id="lw-c-sort">
              <option value="latest" ${c.sortType === 'latest' ? 'selected' : ''}>最新发布</option>
              <option value="most_liked" ${c.sortType === 'most_liked' ? 'selected' : ''}>最多点赞</option>
              <option value="most_commented" ${c.sortType === 'most_commented' ? 'selected' : ''}>最多评论</option>
            </select></div>
        </div>
        <div id="lw-c-task" class="ready__sum" style="display:none"></div>
      </div>`;
      appendFoot();

      $$('#lw-panel input[name="lw-ct"]').forEach((inp) => inp.addEventListener('change', () => {
        $$('#lw-panel .radio-card').forEach((cl) => cl.classList.remove('radio-card--checked'));
        inp.closest('.radio-card').classList.add('radio-card--checked');
      }));

      const save = $('#lw-c-save');
      if (save) save.addEventListener('click', async () => {
        const type = ($$('#lw-panel input[name="lw-ct"]').find((x) => x.checked) || {}).value || 'search';
        const payload = {
          crawl_type: type === 'search' ? 'search' : (type === 'competitor' ? 'competitor' : 'comment'),
          keyword: ($('#lw-c-kw')?.value || '').trim(),
          competitor_account: ($('#lw-c-comp')?.value || '').trim(),
          video_url: ($('#lw-c-video')?.value || '').trim(),
          source: 'own_comment',
          intent_keywords: ($('#lw-c-intent')?.value || '').trim(),
          excluded_keywords: ($('#lw-c-excl')?.value || '').trim(),
          max_comments_per_video: parseInt($('#lw-c-per')?.value, 10) || 50,
          max_videos: parseInt($('#lw-c-vids')?.value, 10) || 20,
          time_range: parseInt($('#lw-c-range')?.value, 10) || 7,
          sort_type: $('#lw-c-sort')?.value || 'latest',
          max_comments: (parseInt($('#lw-c-per')?.value, 10) || 50) * (parseInt($('#lw-c-vids')?.value, 10) || 20),
          name: '上线向导 · ' + (($('#lw-c-kw')?.value || '').trim() || ($('#lw-c-comp')?.value || '').trim() || (($('#lw-c-video')?.value || '').trim() ? '指定视频' : '采集任务')),
        };
        if (!payload.keyword && !payload.competitor_account && !payload.video_url) {
          toast('关键词 / 对标账号 / 视频链接 至少填一项', 'warn');
          return;
        }
        if (wiz.busy) return;
        wiz.busy = true; save.disabled = true;
        try {
          const task = await window.CrawlAPI.createTask(payload);
          wiz.taskId = task.id;
          wiz.crawl = Object.assign(wiz.crawl, {
            crawlType: type, keyword: payload.keyword, competitorAccount: payload.competitor_account,
            videoUrl: payload.video_url, intentKeywords: payload.intent_keywords,
            excludedKeywords: payload.excluded_keywords,
            maxCommentsPerVideo: payload.max_comments_per_video, maxVideos: payload.max_videos,
            timeRange: payload.time_range, sortType: payload.sort_type,
          });
          const box = $('#lw-c-task');
          if (box) { box.style.display = ''; box.className = 'ready__sum is-ok'; box.textContent = '采集任务已创建（' + task.id.slice(0, 8) + '…），下一步启动它。'; }
          toast('采集任务已创建');
        } catch (e) {
          toast('创建失败：' + e.message, 'warn');
        } finally { wiz.busy = false; save.disabled = false; }
      });
    }

    /* ══ 第6步：话术与频控 ══ */
    async function renderPolicy() {
      panel.innerHTML = `<div class="wizard__panel">${head(5)}<div class="empty"><p>加载话术与配置…</p></div></div>`;
      appendFoot();
      try {
        const [scripts, strategy, compliance] = await Promise.all([
          API.getScripts().catch(() => []),
          (window.API && window.API.fetchStrategySettings ? window.API.fetchStrategySettings() : Promise.resolve(null)).catch(() => null),
          (window.API && window.API.fetchComplianceSettings ? window.API.fetchComplianceSettings() : Promise.resolve(null)).catch(() => null),
        ]);
        wiz.scripts = scripts || [];
        if (strategy && strategy.daily_frequency_limit != null) wiz.dailyLimit = strategy.daily_frequency_limit;
        if (compliance) {
          wiz.compliance = {
            r1: compliance.r1_enabled !== false,
            r2: compliance.r2_enabled !== false,
            r3: compliance.r3_enabled !== false,
          };
        }
        if (!wiz.scriptId && wiz.scripts.length) {
          const main = wiz.scripts.find((s) => s.isMain) || wiz.scripts[0];
          wiz.scriptId = main.id;
        }
      } catch (e) { /* 用默认值 */ }

      panel.innerHTML = `<div class="wizard__panel">${head(5)}
        <div class="field" style="margin-bottom:16px"><label>话术包</label>
          <div class="radio-cards">
            ${wiz.scripts.length ? wiz.scripts.map((s) => `
              <label class="radio-card ${wiz.scriptId === s.id ? 'radio-card--checked' : ''}">
                <input type="radio" name="lw-sc" value="${esc(s.id)}" ${wiz.scriptId === s.id ? 'checked' : ''}>
                <span class="radio-card__body">
                  <span class="radio-card__title">${esc(s.name || '未命名话术')}${s.isMain ? ' · 主话术' : ''}</span>
                  <span class="radio-card__desc">${esc(s.intro || '')} · ${(s.variants || []).length} 个变体</span>
                </span></label>`).join('') : '<div class="empty"><p>话术库为空，可稍后在「话术库」里创建</p></div>'}
          </div>
        </div>
        <div class="grid grid--2">
          <div class="field"><label for="lw-p-limit">单账号每日私信上限</label>
            <input type="number" id="lw-p-limit" value="${wiz.dailyLimit}" min="1" max="500">
            <div class="field__hint" style="font-size:11.5px;color:var(--ink-faint);margin-top:4px">新号建议 40-60，保守比激进安全</div>
          </div>
          <div class="field"><label>合规护栏 R1/R2/R3</label>
            <div style="display:flex;flex-direction:column;gap:8px;padding-top:4px">
              <label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="lw-p-r1" ${wiz.compliance.r1 ? 'checked' : ''}> R1 日频超阈值自动降速</label>
              <label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="lw-p-r2" ${wiz.compliance.r2 ? 'checked' : ''}> R2 转化率过低自动切换话术</label>
              <label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="lw-p-r3" ${wiz.compliance.r3 ? 'checked' : ''}> R3 黑名单日增超阈值全量暂停</label>
            </div>
          </div>
        </div>
        <div class="confirm-note">安全兜底默认开启：健康分 &lt; 40 自动进入安全模式。建议三项全开——出问题时停得下来，比跑得快重要。</div>
        <div id="lw-p-msg" class="ready__sum" style="display:none"></div>
      </div>`;
      appendFoot();

      $$('#lw-panel input[name="lw-sc"]').forEach((inp) => inp.addEventListener('change', () => {
        $$('#lw-panel .radio-card').forEach((cl) => cl.classList.remove('radio-card--checked'));
        inp.closest('.radio-card').classList.add('radio-card--checked');
        wiz.scriptId = inp.value;
      }));

      const save = $('#lw-p-save');
      if (save) save.addEventListener('click', async () => {
        if (wiz.busy) return;
        wiz.busy = true; save.disabled = true;
        const limit = parseInt($('#lw-p-limit')?.value, 10) || 60;
        try {
          await API.updateStrategySettings({ daily_frequency_limit: limit });
          await API.updateComplianceSettings({
            r1_enabled: !!$('#lw-p-r1')?.checked,
            r2_enabled: !!$('#lw-p-r2')?.checked,
            r3_enabled: !!$('#lw-p-r3')?.checked,
          });
          wiz.dailyLimit = limit;
          const box = $('#lw-p-msg');
          if (box) { box.style.display = ''; box.className = 'ready__sum is-ok'; box.textContent = '已保存：日发上限 ' + limit + ' 条/账号，合规护栏已按选择生效。'; }
          toast('频控与合规已保存');
        } catch (e) {
          toast('保存失败：' + e.message, 'warn');
        } finally { wiz.busy = false; save.disabled = false; }
      });
    }

    /* ══ 第7步：启动看结果 ══ */
    async function renderLaunch() {
      const c = wiz.crawl;
      panel.innerHTML = `<div class="wizard__panel">${head(6)}
        <dl class="kv" style="font-size:13.5px">
          <dt>采集任务</dt><dd>${wiz.taskId ? esc((wiz.taskId || '').slice(0, 8)) + '…' : '<span style="color:var(--danger)">未创建</span>'}</dd>
          <dt>关键词</dt><dd>${esc(c.keyword || '—')}</dd>
          <dt>对标账号</dt><dd>${esc(c.competitorAccount || '—')}</dd>
          <dt>采集规模</dt><dd>最多 ${esc(c.maxVideos)} 个视频 × 每视频 ${esc(c.maxCommentsPerVideo)} 条评论 · 近 ${esc(c.timeRange)} 天</dd>
          <dt>意向词</dt><dd>${esc(c.intentKeywords || '—')}</dd>
          <dt>日频上限</dt><dd>${esc(wiz.dailyLimit)} 条 / 账号</dd>
        </dl>
        <div id="lw-launch-st" style="margin-top:16px"><div class="empty"><p>尚未启动</p></div></div>
      </div>`;
      appendFoot();

      const box = $('#lw-launch-st');
      function paint() {
        const s = wiz.taskStatus;
        if (!s) { box.innerHTML = '<div class="empty"><p>尚未启动</p></div>'; return; }
        const m = CRAWL_STATUS_MAP[s.status] || { txt: s.status || '未知', cls: '' };
        const done = ['success', 'completed'].includes(s.status);
        box.innerHTML = `
          <div class="ready">
            <div class="ready__item ${done ? 'is-ok' : (s.status === 'failed' ? 'is-bad' : '')}">
              <span class="ready__ico">${done ? '✓' : (s.status === 'failed' ? '!' : '…')}</span>
              <div class="ready__body">
                <div class="ready__label">采集任务：${esc(m.txt)}</div>
                <div class="ready__detail">已采集 ${esc(s.collectedCount ?? 0)} 条 · 已入库线索 ${esc(s.importedCount ?? 0)} 条</div>
              </div>
            </div>
          </div>
          ${s.errorMessage ? `<div class="ready__sum is-bad">${esc(s.errorMessage)}</div>` : ''}
          ${done ? `<div class="ready__sum is-ok">跑通了！去「线索池」看看抓到的评论，高意向的可以直接生成话术。</div>` : ''}`;
      }

      async function pollOnce() {
        if (!wiz.taskId || !document.getElementById('lw-launch-st')) { clearLaunchPoll(); return; }
        try {
          const s = cs(await window.CrawlAPI.getTaskStatus(wiz.taskId));
          wiz.taskStatus = s;
          paint();
          if (['success', 'completed', 'failed', 'stopped'].includes(s.status)) {
            clearLaunchPoll();
            statusBar(s.status === 'failed' ? 'is-bad' : 'is-ok',
              s.status === 'failed' ? '采集失败' : '采集完成',
              s.status === 'failed' ? (s.errorMessage || '') : ('入库线索 ' + (s.importedCount ?? 0) + ' 条'));
          }
        } catch (e) { /* 轮询失败不打断 */ }
      }

      const go = $('#lw-launch-go');
      if (go) go.addEventListener('click', async () => {
        if (!wiz.taskId) { toast('还没有采集任务，请回到上一步创建', 'warn'); return; }
        if (wiz.busy) return;
        wiz.busy = true; go.disabled = true; go.textContent = '启动中…';
        try {
          const task = await window.CrawlAPI.startTask(wiz.taskId);
          wiz.taskStatus = cs(task);
          paint();
          statusBar('is-warn', '采集进行中', '可以去喝杯水，这里会自动刷新');
          clearLaunchPoll();
          launchPoll = setInterval(pollOnce, 3000);
          await pollOnce();
        } catch (e) {
          toast('启动失败：' + e.message, 'warn');
          go.disabled = false; go.textContent = '启动采集';
        } finally { wiz.busy = false; }
      });

      const view = $('#lw-view-leads');
      if (view) view.addEventListener('click', () => { location.hash = '#/leads'; });

      if (wiz.taskStatus) paint();
    }

    const LAUNCH_STEP_DESC = [
      '先看看这台机器的环境准备好没有。缺什么，下面会逐条告诉你，并给出入口。',
      '采集服务负责去抖音把评论抓回来。它没起来，后面所有采集都会失败。',
      '抖音必须人工扫码登录，这一步会弹出浏览器窗口。',
      '账号用于频控与健康分监控。填个便于识别的名字即可。',
      '告诉系统去哪些关键词 / 账号 / 视频下抓评论，以及哪些词算高意向。',
      '选一套话术，设定日发上限和合规护栏——直接决定账号安不安全。',
      '启动采集任务，看真实数据进不进来。',
    ];

    /* ── 底部按钮 ── */
    function appendFoot() {
      const foot = document.createElement('div');
      foot.className = 'wizard__foot';
      const i = wiz.step;
      const last = i === LAUNCH_STEPS.length - 1;
      let mid = '';
      if (i === 0) mid = '<button type="button" class="btn" id="lw-recheck">重新检测</button><button type="button" class="btn btn--primary" id="lw-next">下一步 →</button>';
      else if (i === 1) mid = '<button type="button" class="btn" id="lw-recheck-svc">重新检测</button><button type="button" class="btn btn--primary" id="lw-start-svc">启动采集服务</button><button type="button" class="btn btn--primary" id="lw-next">下一步 →</button>';
      else if (i === 2) mid = '<button type="button" class="btn" id="lw-login-go">打开浏览器扫码登录</button><button type="button" class="btn btn--primary" id="lw-next">下一步 →</button>';
      else if (i === 3) mid = '<button type="button" class="btn" id="lw-acc-save">绑定账号</button><button type="button" class="btn btn--primary" id="lw-next">下一步 →</button>';
      else if (i === 4) mid = '<button type="button" class="btn" id="lw-c-save">保存采集任务</button><button type="button" class="btn btn--primary" id="lw-next">下一步 →</button>';
      else if (i === 5) mid = '<button type="button" class="btn" id="lw-p-save">保存配置</button><button type="button" class="btn btn--primary" id="lw-next">下一步 →</button>';
      else mid = '<button type="button" class="btn btn--primary btn--lg" id="lw-launch-go">启动采集</button><button type="button" class="btn" id="lw-view-leads">去看线索池</button>';

      foot.innerHTML = (i > 0 ? '<button type="button" class="btn" id="lw-prev">← 上一步</button>' : '<a class="btn" href="#/workbench">先不配置，去工作台</a>') + mid;
      panel.appendChild(foot);

      const prev = $('#lw-prev');
      if (prev) prev.addEventListener('click', () => goStep(i - 1));
      const next = $('#lw-next');
      if (next) next.addEventListener('click', () => goStep(i + 1));
    }

    /* ── 进入某一步 ── */
    async function goStep(i) {
      clearLaunchPoll();
      wiz.step = Math.max(0, Math.min(LAUNCH_STEPS.length - 1, i));
      paintSteps();
      const key = LAUNCH_STEPS[wiz.step].key;
      statusBar('', '', '');
      if (key === 'check') await renderCheck();
      else if (key === 'service') await renderService();
      else if (key === 'login') await renderLogin();
      else if (key === 'account') await renderAccount();
      else if (key === 'crawl') await renderCrawl();
      else if (key === 'policy') await renderPolicy();
      else await renderLaunch();
    }

    statusBar('', '', '');
    await goStep(initialStep);
  }

  /* 独立页（兼容旧路由 #/wizard，现由 legacyRedirects 转到 账号管理） */
  async function viewWizard() {
    const stepParam = (arguments[0] && arguments[0].get && arguments[0].get('step')) || null;
    let initialStep = 0;
    if (stepParam) {
      const idx = LAUNCH_STEPS.findIndex((s) => s.key === stepParam);
      initialStep = idx >= 0 ? idx : (parseInt(stepParam, 10) || 0);
    }
    main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'rocket', title: '上手向导', desc: '把系统真正跑起来：环境自检 → 启动采集 → 扫码登录 → 配置任务' })}
        ${launchWizardSkeletonHtml()}
      </div>`;
    await renderLaunchWizardBody(initialStep);
  }



  /* ═══════════════════════════════════════════
     视图：采集配置（MediaCrawler 采集任务管理）
     ═══════════════════════════════════════════ */
  const crawlState = {
    tasks: [],
    polling: null,
    busy: false,
    filter: { q: '', status: 'all', type: 'all', sort: 'recent' },
    modalId: null,          // 详情弹窗当前展示的任务 id（轮询时原地刷新）
    diag: { items: [], blocking: [], expanded: null, lastError: '', loaded: false },
  };

  /* ══════════ 环境检查（可展开清单） ══════════
     不再把一整段「MediaCrawler 未启动或未登录抖音…」糊在页面上：
     页面只留一行摘要，具体哪一项没就绪、怎么修，点开清单逐条看。 */
  const DIAG_ACTION = {
    start_crawl_service: () => { toast('正在拉起采集服务…'); API.startCrawlService && API.startCrawlService(); },
    goto_step: (a) => { location.hash = '#/accounts?tab=wizard&step=' + (a.step || 0); },
  };

  /** 拉取环境自检结果并渲染清单（不打 toast、不弹窗） */
  async function loadDiag() {
    const box = $('#crawl-diag');
    if (!box) return null;
    let rd = null;
    try { rd = await API.getReadiness(); } catch (e) { rd = null; }
    const d = crawlState.diag;
    if (rd && rd.items) {
      d.items = rd.items;
      d.blocking = rd.blocking || [];
      d.loaded = true;
    } else {
      d.items = [];
      d.blocking = [];
      d.loaded = false;
    }
    renderDiag();
    return d.blocking.length === 0;
  }

  function renderDiag() {
    const box = $('#crawl-diag');
    if (!box) return;
    const d = crawlState.diag;
    const items = d.items.slice();
    if (d.lastError) {
      items.unshift({ key: 'last_error', label: '上一次启动', ok: false, detail: d.lastError, action: null, link: null });
    }
    const bad = items.filter((i) => i.ok === false);
    // 默认收起（整段隐藏）：未展开就不显示任何提示，页面保持干净。
    // 有问题时页头「环境检查」按钮显示红点，用户点击才展开。
    // 仅当某个操作真正失败（diagFail / ensureDouyinLogin）才主动展开。
    if (d.expanded === null) d.expanded = false;
    const expanded = !!d.expanded;

    // 收起时整段隐藏：未展开就不显示「MediaCrawler 未启动…」这类提示
    box.hidden = !expanded;
    const ico = $('#crawl-diag-ico'), stat = $('#crawl-diag-stat');
    if (ico) { ico.textContent = bad.length ? '!' : '✓'; ico.className = 'diag__ico ' + (bad.length ? 'is-bad' : 'is-ok'); }
    if (stat) {
      stat.textContent = !d.loaded
        ? '自检服务未响应'
        : bad.length
          ? `${bad.length} 项待处理 · ${items.length - bad.length} 项就绪`
          : `${items.length} 项全部就绪`;
      stat.className = 'diag__stat ' + (bad.length ? 'is-bad' : 'is-ok');
    }
    const toggle = $('#crawl-diag-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
    const list = $('#crawl-diag-list');
    if (!list) return;
    list.hidden = !expanded;

    if (!d.loaded) {
      list.innerHTML = `<li class="diag__item"><span class="diag__dot is-bad"></span>
        <span class="diag__body"><span class="diag__label">环境自检</span>
        <span class="diag__detail">无法读取自检结果，请确认后端服务在运行。</span></span></li>`;
      return;
    }

    list.innerHTML = items.map((i) => {
      const ok = i.ok !== false;
      const act = i.action
        ? `<button type="button" class="btn btn--sm ${ok ? '' : 'btn--primary'}" data-diag-act="${esc(i.key)}">${esc(i.action.label || '处理')}</button>`
        : (i.link ? `<a class="btn btn--sm" data-close href="${esc(i.link)}">去配置</a>` : '');
      return `<li class="diag__item">
        <span class="diag__dot ${ok ? 'is-ok' : 'is-bad'}"></span>
        <span class="diag__body">
          <span class="diag__label">${esc(i.label || i.key)}</span>
          <span class="diag__detail">${esc(i.detail || '')}</span>
        </span>
        ${act ? `<span class="diag__act">${act}</span>` : ''}
      </li>`;
    }).join('');

    $$('[data-diag-act]', list).forEach((btn) => {
      btn.addEventListener('click', () => {
        const it = items.find((x) => x.key === btn.dataset.diagAct);
        const fn = it && it.action && DIAG_ACTION[it.action.type];
        if (fn) fn(it.action);
        else if (it && it.link) location.hash = it.link;
        else { location.hash = '#/accounts?tab=wizard'; }
      });
    });

    // 同步页头「环境检查」按钮的状态点（始终可见，作为展开入口）
    const dot = $('#crawl-diag-open-dot');
    if (dot) dot.className = 'dot ' + (bad.length ? 'is-bad' : (d.loaded ? 'is-ok' : 'is-warn'));
  }

  /** 启动失败：把原因收进清单并展开，不再弹一大段文案 */
  function diagFail(msg) {
    crawlState.diag.lastError = String(msg || '').slice(0, 240);
    crawlState.diag.expanded = true;
    renderDiag();
    const box = $('#crawl-diag');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('启动失败，已展开环境检查', 'warn');
  }

  const CRAWL_STATUS = {
    pending: { label: '待启动', cls: 'status-pill--muted' },
    running: { label: '采集中', cls: 'status-pill--running' },
    completed: { label: '已完成', cls: 'status-pill--ok' },
    failed: { label: '失败', cls: 'status-pill--danger' },
  };

  /** 采集任务：绝对时间 2026-09-13 06:44 */
  function crawlDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 把 crawlState.filter 同步回工具栏控件（用于「清空筛选」后复位） */
  function syncCrawlToolbar() {
    const f = crawlState.filter;
    const q = $('#crawl-q');
    const type = $('#crawl-type');
    const sort = $('#crawl-sort');
    if (q) q.value = f.q || '';
    if (type) type.value = f.type || 'all';
    if (sort) sort.value = f.sort || 'recent';
  }

  /** 绑定采集页筛选工具栏：搜索 / 状态 chips / 类型 / 排序 */
  function bindCrawlToolbar() {
    const q = $('#crawl-q');
    if (q) {
      let timer = null;
      q.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          crawlState.filter.q = q.value;
          renderCrawlTaskList();
        }, 200);
      });
    }
    $$('.crawl-toolbar [data-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        crawlState.filter.status = btn.dataset.status;
        renderCrawlTaskList();
      });
    });
    const type = $('#crawl-type');
    if (type) type.addEventListener('change', () => {
      crawlState.filter.type = type.value;
      renderCrawlTaskList();
    });
    const sort = $('#crawl-sort');
    if (sort) sort.addEventListener('change', () => {
      crawlState.filter.sort = sort.value;
      renderCrawlTaskList();
    });
  }

  async function viewCrawl() {
    if (crawlState.polling) { clearInterval(crawlState.polling); crawlState.polling = null; }
    crawlState.modalId = null;

    main.innerHTML = `
      <div class="view">
        ${pageHead({
          icon: 'i-rocket',
          title: '采集与筛选',
          desc: '从抖音评论区自动采集高意向用户，入库为线索',
          actions: `
            <button type="button" class="btn btn--ghost btn--sm" id="crawl-diag-open"
                    title="环境检查清单：查看采集服务 / 抖音登录 / 账号等就绪情况">
              <span class="dot" id="crawl-diag-open-dot"></span>环境检查
            </button>
            <button type="button" class="btn" id="crawl-reply-btn"
                    title="自动取你发过评论的视频，批量建检测任务，找出谁在你评论下回复了你">${ico('i-bell')} 检测谁回复了我</button>
            <button type="button" class="btn btn--primary" id="crawl-new-btn">${ico('i-rocket')} 新建采集任务</button>`,
        })}

        <!-- 环境检查：默认只显示一行摘要，点开是逐项清单 -->
        <section class="diag" id="crawl-diag" hidden>
          <button type="button" class="diag__summary" id="crawl-diag-toggle" aria-expanded="false" aria-controls="crawl-diag-list">
            <span class="diag__ico" id="crawl-diag-ico" aria-hidden="true">•</span>
            <span class="diag__title">环境检查</span>
            <span class="diag__stat" id="crawl-diag-stat">检测中…</span>
            <span class="diag__arrow" aria-hidden="true">▸</span>
          </button>
          <ul class="diag__list" id="crawl-diag-list" hidden></ul>
        </section>

        <!-- 概览：一眼看清全局，不必翻列表 -->
        <div class="crawl-kpi" id="crawl-kpi"></div>

        <div class="crawl-toolbar">
          <input type="search" class="crawl-toolbar__search" id="crawl-q"
                 placeholder="搜索任务名 / 关键词 / 账号" aria-label="搜索采集任务">
          <div class="crawl-segs" role="group" aria-label="按状态筛选">
            <button type="button" class="filter-chip" data-status="all" aria-pressed="true">全部<span class="count num" data-count="all">0</span></button>
            <button type="button" class="filter-chip" data-status="running" aria-pressed="false">采集中<span class="count num" data-count="running">0</span></button>
            <button type="button" class="filter-chip" data-status="pending" aria-pressed="false">待启动<span class="count num" data-count="pending">0</span></button>
            <button type="button" class="filter-chip" data-status="completed" aria-pressed="false">已完成<span class="count num" data-count="completed">0</span></button>
            <button type="button" class="filter-chip" data-status="failed" aria-pressed="false">失败<span class="count num" data-count="failed">0</span></button>
          </div>
          <div class="crawl-toolbar__right">
          <span class="crawl-toolbar__count" id="crawl-count"></span>
          <select class="crawl-toolbar__sort" id="crawl-type" aria-label="按任务类型筛选">
            <option value="all">全部类型</option>
            <option value="comment">评论采集</option>
            <option value="reply_check">回复检测</option>
          </select>
          <select class="crawl-toolbar__sort" id="crawl-sort" aria-label="排序方式">
            <option value="recent">最近创建</option>
            <option value="progress">进度优先</option>
            <option value="collected">采集最多</option>
          </select>
          </div>
        </div>

        <div class="crawl-grid" id="crawl-task-list">${emptyState('i-empty', '加载中…')}</div>
      </div>`;

    $('#crawl-new-btn').addEventListener('click', () => openCrawlCreateModal());

    // 环境检查：页头按钮是展开入口；展开后段内按钮可收起
    const diagToggle = $('#crawl-diag-toggle');
    if (diagToggle) diagToggle.addEventListener('click', () => {
      crawlState.diag.expanded = !crawlState.diag.expanded;
      renderDiag();
    });
    const diagOpen = $('#crawl-diag-open');
    if (diagOpen) diagOpen.addEventListener('click', () => {
      crawlState.diag.expanded = !crawlState.diag.expanded;
      renderDiag();
      const box = $('#crawl-diag');
      if (crawlState.diag.expanded && box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    syncCrawlToolbar();
    bindCrawlToolbar();
    await loadCrawlTasks();
    loadDiag();

    // 检测谁回复了我：一键从「我发过评论的视频」批量建检测任务
    const crawlReplyBtn = $('#crawl-reply-btn');
    if (crawlReplyBtn) crawlReplyBtn.addEventListener('click', () => runReplyCheck(crawlReplyBtn));

    // 运行中任务自动刷新状态
    crawlState.polling = setInterval(async () => {
      const running = crawlState.tasks.filter((t) => t.status === 'running');
      if (running.length > 0) {
        for (const t of running) {
          try {
            const st = await window.CrawlAPI.getTaskStatus(t.id);
            const idx = crawlState.tasks.findIndex((x) => x.id === t.id);
            if (idx >= 0) {
              crawlState.tasks[idx] = { ...crawlState.tasks[idx], ...st };
            }
          } catch (e) { /* ignore */ }
        }
        renderCrawlTaskList();
        if (crawlState.modalId) refreshCrawlTaskModal();
      }
    }, 5000);
  }

  /* ────────── 弹窗一：新建采集任务 ────────── */
  function openCrawlCreateModal() {
    openModal(`
      <h2 id="modal-title">新建采集任务</h2>
      <p class="modal__lede">至少填写一项采集入口。采集结果会按高意向关键词打分后，自动入库为线索。</p>

      <div class="field">
        <label for="crawl-name">任务名称 <span class="field__hint">可选</span></label>
        <input type="text" id="crawl-name" placeholder="留空自动生成，如：关键词:装修">
      </div>

      <div class="form-sec">
        <div class="form-sec__title">采集入口 <span class="tag">三项至少填一项</span></div>
        <div class="field">
          <label for="crawl-keyword">搜索关键词</label>
          <input type="text" id="crawl-keyword" placeholder="例：装修 报价">
        </div>
        <div class="field">
          <label for="crawl-competitor">对标账号</label>
          <input type="text" id="crawl-competitor" placeholder="抖音昵称或主页 URL">
        </div>
        <div class="field">
          <label for="crawl-video">指定视频 URL</label>
          <input type="text" id="crawl-video" placeholder="https://www.douyin.com/video/...">
        </div>
      </div>

      <div class="form-sec">
        <div class="form-sec__title">筛选与上限 <span class="tag">可选</span></div>
        <div class="field__row">
          <div class="field">
            <label for="crawl-source">来源归因</label>
            <select id="crawl-source">
              <option value="own_comment">自有视频评论区</option>
              <option value="competitor">对标账号监控</option>
            </select>
          </div>
          <div class="field">
            <label for="crawl-max">最大采集条数</label>
            <input type="number" id="crawl-max" value="100" min="1" max="10000">
          </div>
        </div>
        <div class="field">
          <label for="crawl-intent">高意向关键词 <span class="field__hint">逗号分隔，命中加权评分</span></label>
          <input type="text" id="crawl-intent" placeholder="多少钱,报价,加微信,怎么合作">
        </div>
      </div>

      <div class="modal__foot">
        <button type="button" class="btn" data-close>取消</button>
        <button type="button" class="btn btn--primary" id="crawl-create-btn">创建任务</button>
      </div>
    `);

    requestAnimationFrame(() => { const el = $('#crawl-keyword'); if (el) el.focus(); });

    const createBtn = $('#crawl-create-btn');
    createBtn.addEventListener('click', async () => {
      const payload = {
        name: $('#crawl-name').value.trim(),
        keyword: $('#crawl-keyword').value.trim(),
        competitor_account: $('#crawl-competitor').value.trim(),
        video_url: $('#crawl-video').value.trim(),
        source: $('#crawl-source').value,
        intent_keywords: $('#crawl-intent').value.trim(),
        max_comments: parseInt($('#crawl-max').value, 10) || 100,
        crawl_type: 'comment',
      };
      if (!payload.keyword && !payload.competitor_account && !payload.video_url) {
        toast('至少填写一项：关键词 / 对标账号 / 视频 URL', 'warn');
        return;
      }
      createBtn.disabled = true;
      try {
        const task = await window.CrawlAPI.createTask(payload);
        toast('采集任务已创建，可直接启动采集');
        await loadCrawlTasks();
        // 同一个弹窗直接切换成这个任务的采集视图（不关闭再打开，避免闪一下）
        if (task && task.id) openCrawlTaskModal(task.id);
        else closeModal();
      } catch (e) {
        toast('创建失败：' + e.message, 'warn');
      } finally {
        createBtn.disabled = false;
      }
    });
  }

  /* ────────── 弹窗二：任务详情（创建后点开就是它自己的采集视图） ────────── */
  function crawlFindTask(id) {
    return (crawlState.tasks || []).find((x) => String(x.id) === String(id)) || null;
  }

  function openCrawlTaskModal(taskId) {
    const t = crawlFindTask(taskId);
    if (!t) { toast('任务不存在或已删除', 'warn'); return; }
    crawlState.modalId = t.id;
    openModal(crawlTaskModalHtml(t));
    bindCrawlTaskModal();
  }

  function refreshCrawlTaskModal() {
    const modal = $('#modal');
    if (!modal || modal.hidden) return;
    const t = crawlFindTask(crawlState.modalId);
    if (!t) { crawlState.modalId = null; closeModal(); return; }
    modal.innerHTML = crawlTaskModalHtml(t);
    $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closeModal));
    bindCrawlTaskModal();
  }

  function crawlTaskModalHtml(t) {
    const sm = CRAWL_STATUS[t.status] || CRAWL_STATUS.pending;
    const isReply = t.crawl_type === 'reply_check';
    const target = t.max_comments || 0;
    const collected = t.collected_count || 0;
    const imported = t.imported_count || 0;
    const rate = collected ? Math.round((imported / collected) * 100) : 0;
    const pct = target ? Math.min(100, Math.round((collected / target) * 100)) : 0;

    const entries = [];
    if (t.keyword) entries.push(['搜索关键词', t.keyword]);
    if (t.competitor_account) entries.push(['对标账号', t.competitor_account]);
    if (t.video_url) entries.push(['指定视频', t.video_url]);
    if (t.account) entries.push(['指定账号', t.account]);
    if (!entries.length) entries.push(['采集入口', '评论采集']);

    return `
      <h2 id="modal-title">${esc(t.name || '未命名任务')}</h2>
      <div class="crawl-modal__badges">
        <span class="ctask__dot ctask__dot--${esc(t.status)}"></span>
        <span class="ctask__type">${isReply ? '回复检测' : '评论采集'}</span>
        <span class="status-pill ${sm.cls}">${sm.label}</span>
        <span class="crawl-modal__spacer"></span>
        <span class="crawl-modal__time">${esc(crawlRelTime(t.created_at))}</span>
      </div>

      <div class="crawl-modal__progress">
        <div class="crawl-modal__progress-top">
          <span>已采集 <b>${collected.toLocaleString('zh-CN')}</b>${target ? ` / 目标 ${target.toLocaleString('zh-CN')}` : ''}</span>
          <span class="crawl-modal__rate">入库 ${imported.toLocaleString('zh-CN')}${collected ? ` · 入库率 ${rate}%` : ''}</span>
        </div>
        <div class="progress-bar"><div class="progress-bar__fill" style="width:${pct}%"></div></div>
      </div>

      <dl class="crawl-modal__kv">
        ${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('')}
        <dt>来源归因</dt><dd>${t.source === 'competitor' ? '对标账号监控' : '自有视频评论区'}</dd>
        <dt>创建时间</dt><dd>${esc(crawlDateTime(t.created_at))}</dd>
      </dl>

      <p class="crawl-modal__tip">${isReply
        ? '命中结果回到「待办互动 → 评论回复 → 已回复追踪」，可直接继续回复。'
        : '采集结果按意向分入库，去「线索」页即可筛选跟进。'}</p>

      <div class="modal__foot modal__foot--split">
        <button type="button" class="btn btn--ghost" data-crawl="delete">删除任务</button>
        <span class="crawl-modal__spacer"></span>
        <button type="button" class="btn" data-close>关闭</button>
        ${t.status === 'running' ? '<button type="button" class="btn" data-crawl="stop">停止采集</button>' : ''}
        ${(t.status === 'pending' || t.status === 'failed')
          ? `<button type="button" class="btn btn--primary" data-crawl="start">${t.status === 'failed' ? '重新采集' : '启动采集'}</button>` : ''}
        ${t.status === 'completed'
          ? `<a class="btn btn--primary" data-close href="${isReply ? '#/interact' : '#/leads'}">${isReply ? '查看回复' : '查看线索'}</a>` : ''}
      </div>`;
  }

  function bindCrawlTaskModal() {
    const modal = $('#modal');
    $$('[data-crawl]', modal).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const t = crawlFindTask(crawlState.modalId);
        if (!t) { crawlState.modalId = null; closeModal(); return; }
        const action = btn.dataset.crawl;
        btn.disabled = true;
        try {
          if (action === 'start') {
            if (!(await ensureDouyinLogin())) { btn.disabled = false; return; }
            try {
              await window.CrawlAPI.startTask(t.id);
              toast('采集已启动');
              crawlState.diag.lastError = '';
              renderDiag();
            } catch (err) {
              // 失败原因不弹大段文案，收进页面的环境检查清单
              crawlState.modalId = null;
              closeModal();
              diagFail(err.message);
              btn.disabled = false;
              return;
            }
          } else if (action === 'stop') {
            await window.CrawlAPI.stopTask(t.id);
            toast('采集已停止');
          } else if (action === 'delete') {
            if (!window.confirm(`删除任务「${t.name || '未命名任务'}」？已入库的线索不受影响。`)) {
              btn.disabled = false;
              return;
            }
            await window.CrawlAPI.deleteTask(t.id);
            toast('任务已删除');
            crawlState.modalId = null;
            closeModal();
            await loadCrawlTasks();
            return;
          }
          await loadCrawlTasks();
          if (crawlState.modalId) refreshCrawlTaskModal();
          else btn.disabled = false;
        } catch (err) {
          toast('操作失败：' + err.message, 'warn');
          btn.disabled = false;
        }
      });
    });
  }

  /* ────────── 一键检测谁回复了我 ────────── */
  async function runReplyCheck(btn) {
    let videos = [];
    try {
      const tasks = await API.getCommentTasks();
      const arr = Array.isArray(tasks) ? tasks : ((tasks && tasks.items) || []);
      const seen = new Set();
      arr.forEach((t) => {
        const u = (t.videoUrl || t.video_url || '').trim();
        if (u && /video\//.test(u)) seen.add(u);
      });
      videos = [...seen];
    } catch (e) { /* 取失败按空处理 */ }

    if (!videos.length) {
      toast('还没有带视频链接的评论任务，先去「待办互动」发过评论再检测', 'warn');
      return;
    }

    // 已建过检测任务的视频不重复创建
    const existed = new Set((crawlState.tasks || [])
      .filter((t) => t.crawl_type === 'reply_check' && t.video_url)
      .map((t) => String(t.video_url).trim()));
    const pending = videos.filter((v) => !existed.has(v)).slice(0, 10);

    if (!pending.length) {
      toast('这些视频都已建过检测任务，无需重复创建');
      return;
    }

    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '检测中…';
    let created = 0, started = 0;
    try {
      for (const v of pending) {
        const task = await window.CrawlAPI.createTask({
          name: '检测回复 · ' + v.slice(-14),
          crawl_type: 'reply_check',
          video_url: v,
          source: 'own_comment',
          max_comments: 200,
        });
        created++;
        try { await window.CrawlAPI.startTask(task.id); started++; } catch (e) { /* 未登录等留待手工启动 */ }
      }
      toast(`已创建 ${created} 个检测任务（启动 ${started} 个），结果回到「待办互动 → 评论回复」`);
      await loadCrawlTasks();
    } catch (e) {
      toast('检测任务创建失败：' + e.message, 'warn');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  async function loadCrawlTasks() {
    try {
      crawlState.tasks = await window.CrawlAPI.listTasks();
      renderCrawlTaskList();
    } catch (e) {
      crawlState.tasks = [];
      const list = $('#crawl-task-list');
      if (list) list.innerHTML = emptyState('i-alert', '无法连接后端 API：' + e.message);
      renderCrawlKpi([]);
    }
  }

  /** 相对时间：3 分钟前 / 昨天 14:20 / 09-12 */
  function crawlRelTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 172800) return `昨天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 顶部概览：总数 / 采集中 / 已入库线索 / 失败 */
  function renderCrawlKpi(all) {
    const box = $('#crawl-kpi');
    if (!box) return;
    const running = all.filter((t) => t.status === 'running').length;
    const failed = all.filter((t) => t.status === 'failed').length;
    const imported = all.reduce((s, t) => s + (t.imported_count || 0), 0);
    box.innerHTML = `
      <div class="crawl-kpi__item">
        <div class="crawl-kpi__label">总任务</div>
        <div class="crawl-kpi__value">${all.length}</div>
      </div>
      <div class="crawl-kpi__item">
        <div class="crawl-kpi__label">采集中</div>
        <div class="crawl-kpi__value ${running ? 'crawl-kpi__value--ok' : ''}">${running}</div>
        <div class="crawl-kpi__foot">${running ? '实时刷新中' : '当前无运行任务'}</div>
      </div>
      <div class="crawl-kpi__item">
        <div class="crawl-kpi__label">已入库线索</div>
        <div class="crawl-kpi__value">${imported.toLocaleString('zh-CN')}</div>
      </div>
      <div class="crawl-kpi__item">
        <div class="crawl-kpi__label">失败</div>
        <div class="crawl-kpi__value ${failed ? 'crawl-kpi__value--bad' : ''}">${failed}</div>
        <div class="crawl-kpi__foot">${failed ? '可重新采集' : '无异常'}</div>
      </div>`;
  }

  function renderCrawlTaskList() {
    const list = $('#crawl-task-list');
    if (!list) return;
    const all = crawlState.tasks || [];
    const f = crawlState.filter;

    renderCrawlKpi(all);

    // 状态筛选按钮：计数 + 选中态
    const counts = { all: all.length, running: 0, pending: 0, completed: 0, failed: 0 };
    all.forEach((t) => { if (counts[t.status] !== undefined) counts[t.status] += 1; });
    $$('.crawl-toolbar [data-status]').forEach((btn) => {
      const k = btn.dataset.status;
      const c = btn.querySelector('.count');
      if (c) c.textContent = counts[k] || 0;
      btn.setAttribute('aria-pressed', String(f.status === k));
    });

    // 筛选：状态 → 类型 → 关键词
    let rows = all.slice();
    if (f.status !== 'all') rows = rows.filter((t) => t.status === f.status);
    if (f.type !== 'all') rows = rows.filter((t) => (t.crawl_type || 'comment') === f.type);
    const q = (f.q || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter((t) => [t.name, t.keyword, t.competitor_account, t.video_url, t.account]
        .some((v) => String(v || '').toLowerCase().includes(q)));
    }

    // 排序
    if (f.sort === 'progress') {
      rows.sort((a, b) => (b.collected_count || 0) / (b.max_comments || 1) - (a.collected_count || 0) / (a.max_comments || 1));
    } else if (f.sort === 'collected') {
      rows.sort((a, b) => (b.collected_count || 0) - (a.collected_count || 0));
    } else {
      rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    const filtered = rows.length !== all.length;
    const head = $('#crawl-count');
    if (head) {
      head.innerHTML = all.length
        ? `任务 <b>${rows.length}</b> / ${all.length}${filtered ? '<span class="crawl-toolbar__flag">已筛选</span>' : ''}`
        : '';
    }

    if (!all.length) {
      list.innerHTML = `<div class="empty">
        <div class="empty__ico">${ico('i-rocket')}</div>
        <p>还没有采集任务。点「新建采集任务」填关键词 / 对标账号 / 视频 URL，即可开始采集。</p>
        <button type="button" class="btn btn--primary btn--sm" id="crawl-empty-new" style="margin-top:10px">${ico('i-rocket')} 新建采集任务</button>
      </div>`;
      const en = $('#crawl-empty-new');
      if (en) en.addEventListener('click', () => openCrawlCreateModal());
      return;
    }
    if (!rows.length) {
      list.innerHTML = `<div class="empty">
        <div class="empty__ico">${ico('i-empty')}</div>
        <p>当前筛选条件下没有任务</p>
        <button type="button" class="btn btn--sm" id="crawl-filter-reset" style="margin-top:8px">清空筛选</button>
      </div>`;
      const rs = $('#crawl-filter-reset');
      if (rs) rs.addEventListener('click', () => {
        crawlState.filter = { q: '', status: 'all', type: 'all', sort: 'recent' };
        syncCrawlToolbar();
        renderCrawlTaskList();
      });
      return;
    }

    list.innerHTML = `${rows.map((t) => {
      const sm = CRAWL_STATUS[t.status] || CRAWL_STATUS.pending;
      const target = t.max_comments || 0;
      const collected = t.collected_count || 0;
      const imported = t.imported_count || 0;
      const progress = target ? Math.min(100, Math.round((collected / target) * 100)) : 0;
      const rate = collected ? Math.round((imported / collected) * 100) : 0;
      const entryParts = [];
      if (t.keyword) entryParts.push(`关键词 ${esc(t.keyword)}`);
      if (t.competitor_account) entryParts.push(`对标 ${esc(t.competitor_account)}`);
      if (t.video_url) entryParts.push('指定视频');
      const isReply = t.crawl_type === 'reply_check';
      const when = crawlRelTime(t.created_at);
      return `<article class="ctask ctask--${esc(t.status)}" data-id="${esc(t.id)}" tabindex="0" role="button" aria-label="查看任务详情：${esc(t.name || '未命名任务')}">
        <div class="ctask__top">
          <span class="ctask__dot ctask__dot--${esc(t.status)}"></span>
          <h3 class="ctask__title" title="${esc(t.name || '未命名任务')}">${esc(t.name || '未命名任务')}</h3>
          ${isReply ? '<span class="ctask__type">回复检测</span>' : ''}
        </div>
        <p class="ctask__meta">${entryParts.join(' · ') || '评论采集'} · 目标 ${target} 条</p>
        <div class="ctask__stats">
          <span>已采<b>${collected.toLocaleString('zh-CN')}</b></span>
          <span>入库<b>${imported.toLocaleString('zh-CN')}</b></span>
          <span>入库率<b>${collected ? rate + '%' : '—'}</b></span>
        </div>
        ${t.status === 'running' ? `<div class="progress-bar ctask__progress"><div class="progress-bar__fill" style="width:${progress}%"></div></div>` : ''}
        <div class="ctask__foot">
          <span class="status-pill ${sm.cls}">${sm.label}</span>
          ${when ? `<span class="ctask__when">${esc(when)}</span>` : ''}
          <span class="crawl-toolbar__spacer"></span>
          ${t.status === 'pending' || t.status === 'failed' ?
            `<button type="button" class="btn btn--primary btn--sm" data-action="start">${t.status === 'failed' ? '重新采集' : '启动采集'}</button>` : ''}
          ${t.status === 'running' ?
            `<button type="button" class="btn btn--sm" data-action="stop">停止</button>` : ''}
          ${t.status === 'completed' ?
            `<a class="btn btn--sm" href="${isReply ? '#/interact' : '#/leads'}">${isReply ? '查看回复' : '查看线索'}</a>` : ''}
        </div>
      </article>`;
    }).join('')}`;

    // 点卡片任意位置 = 打开详情弹窗
    $$('#crawl-task-list .ctask').forEach((card) => {
      const open = () => openCrawlTaskModal(card.dataset.id);
      card.addEventListener('click', (e) => { if (!e.target.closest('button, a')) open(); });
      card.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, a')) { e.preventDefault(); open(); }
      });
    });

    $$('#crawl-task-list [data-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const item = e.target.closest('.ctask');
        const id = item.dataset.id;
        const action = e.target.dataset.action;
        if (action === 'detail') { openCrawlTaskModal(id); return; }
        btn.disabled = true;
        try {
          if (action === 'start') {
            // 启动前先看环境检查清单，未就绪就地展开，不打断操作
            const ready = await ensureDouyinLogin();
            if (!ready) return;
            try {
              await window.CrawlAPI.startTask(id);
              toast('采集已启动');
              crawlState.diag.lastError = '';
              renderDiag();
            } catch (err) {
              diagFail(err.message);   // 原因进清单，不弹窗
            }
          } else if (action === 'stop') {
            await window.CrawlAPI.stopTask(id);
            toast('采集已停止');
          } else if (action === 'delete') {
            const t = crawlFindTask(id);
            if (!window.confirm(`删除任务「${(t && t.name) || '未命名任务'}」？已入库的线索不受影响。`)) return;
            await window.CrawlAPI.deleteTask(id);
            toast('任务已删除');
          }
          await loadCrawlTasks();
        } catch (err) {
          toast('操作失败：' + err.message, 'warn');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  /* ══════════ 导航角标（P3-12: 动态从 /api/workbench/badges 获取） ══════════ */
  async function renderNavBadges() {
    try {
      const badges = await API.getNavBadges();
      if (!badges) return;
      $('#nav-leads-badge').textContent = badges.leads || 0;

      const dmBadge = $('#nav-dm-badge');
      if (dmBadge) {
        if (badges.dmQueue > 0) { dmBadge.hidden = false; dmBadge.textContent = badges.dmQueue; }
        else { dmBadge.hidden = true; }
      }

      const accBadge = $('#nav-acc-badge');
      if (badges.accountsWarn > 0) { accBadge.hidden = false; accBadge.textContent = badges.accountsWarn; }
      else { accBadge.hidden = true; }

      $('#nav-cust-badge').textContent = badges.customers || 0;
      $('#nav-fu-badge').textContent = badges.followups || 0;

      const interactBadge = $('#nav-interact-badge');
      if (interactBadge) {
        if (badges.replies > 0) {
          interactBadge.hidden = false;
          interactBadge.textContent = badges.replies > 99 ? '99+' : String(badges.replies);
        } else {
          interactBadge.hidden = true;
        }
      }
    } catch (e) { /* 静默 */ }
  }

  /* ═══════════════════════════════════════════
     视图：系统设置（配置中心）
     ═══════════════════════════════════════════ */
  async function viewSettings(params) {
    const outerTab = (params && params.get('tab')) || 'settings';

    // 旧链接兜底：向导已迁到「账号管理 → 上手向导」
    if (outerTab === 'wizard') {
      location.hash = '#/accounts?tab=wizard';
      return;
    }

    // 业务配置已与话术库合到「话术与业务配置」页（2026-09-13），旧链接统一跳过去
    if (outerTab === 'business') {
      location.hash = '#/scripts?tab=business';
      return;
    }

    // 数据备份Tab
    if (outerTab === 'backup') {
      main.innerHTML = `
        <div class="view">
          ${pageHead({ icon: 'i-gear', title: '系统', desc: '系统设置与数据管理' })}
          <div class="tabs" id="outer-settings-tabs">
            <button class="tab" data-tab="settings">系统设置</button>
            <button class="tab tab--active" data-tab="backup">数据备份</button>
          </div>
          <div id="backup-mount"></div>
        </div>`;
      $('#outer-settings-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        location.hash = `#/settings?tab=${btn.dataset.tab}`;
      });
      await renderBackupBody($('#backup-mount'));
      return;
    }

    const SettingsAPI = window.API || {};
    const tabs = [
      { key: 'ai', label: 'AI 设置' },
      { key: 'strategy', label: '话术策略' },
      { key: 'compliance', label: '合规规则' },
      { key: 'crawl', label: '采集设置' },
      { key: 'notification', label: '通知设置' },
    ];
    let activeTab = 'ai';
    let settingsData = null;

    main.innerHTML = pageHead({
      icon: 'i-gear',
      title: '系统设置',
      desc: '配置 AI 模型、话术策略、合规规则、采集参数与通知提醒',
    }) + `
      <div class="tabs" id="outer-settings-tabs">
        <button class="tab tab--active" data-tab="settings">系统设置</button>
        <button class="tab" data-tab="backup">数据备份</button>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="settings-tabs" id="settings-tabs" style="display:flex;border-bottom:1px solid var(--border);background:var(--bg-soft)">
          ${tabs.map(t => `<button type="button" class="settings-tab-btn" data-tab="${t.key}" style="flex:1;padding:12px 8px;border:none;background:transparent;cursor:pointer;font-size:13px;color:var(--ink-soft);border-bottom:2px solid transparent;transition:all .2s">${t.label}</button>`).join('')}
        </div>
        <div id="settings-tab-content" style="padding:20px"></div>
      </div>
    `;

    // 加载配置
    try {
      settingsData = await SettingsAPI.fetchAllSettings();
    } catch (e) {
      settingsData = {
        ai: { provider: 'doubao', api_key: '', model: '', temperature: 0.7, timeout: 30 },
        strategy: { auto_score_threshold: 60, r2_switch_threshold: 8, daily_frequency_limit: 80 },
        compliance: { r1_threshold: 80, r1_enabled: true, r2_threshold: 8, r2_enabled: true, r3_threshold: 3, r3_enabled: true },
        crawl: { default_keywords: [], crawl_interval_minutes: 30, max_comments_per_video: 100 },
        notification: { new_dm_alert: true, followup_reminder: true, deal_alert: true },
      };
      toast('配置加载失败，使用默认值：' + e.message, 'warn');
    }

    function renderTab() {
      const container = $('#settings-tab-content');
      // 更新 tab 按钮样式
      $$('.settings-tab-btn').forEach(btn => {
        const active = btn.dataset.tab === activeTab;
        btn.style.color = active ? 'var(--brand-deep)' : 'var(--ink-soft)';
        btn.style.borderBottomColor = active ? 'var(--brand-deep)' : 'transparent';
        btn.style.fontWeight = active ? '600' : '400';
        btn.style.background = active ? 'var(--bg)' : 'transparent';
      });

      if (activeTab === 'ai') {
        const ai = settingsData.ai || {};
        container.innerHTML = `
          <div class="field" style="margin-bottom:16px">
            <label for="set-ai-provider">Provider</label>
            <select id="set-ai-provider" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
              <option value="doubao" ${ai.provider === 'doubao' ? 'selected' : ''}>豆包 (Doubao / Volcengine Ark)</option>
              <option value="dashscope" ${ai.provider === 'dashscope' ? 'selected' : ''}>通义千问 (DashScope)</option>
              <option value="openai" ${ai.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容 (sailapi 等任意网关)</option>
            </select>
          </div>
          <div class="field" id="set-ai-baseurl-field" style="margin-bottom:16px;${ai.provider === 'openai' ? '' : 'display:none'}">
            <label for="set-ai-baseurl">API Base URL（OpenAI 兼容，需含 /v1）</label>
            <input type="text" id="set-ai-baseurl" value="${esc(ai.base_url || '')}" placeholder="https://sub.sailapi.top/v1" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
            <p style="font-size:12px;color:var(--ink-soft);margin:6px 0 0">OpenAI 兼容基地址，例如 https://sub.sailapi.top/v1（后面可一键拉取该网关上的全部模型）</p>
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-ai-key">API Key</label>
            <input type="password" id="set-ai-key" value="${esc(ai.api_key || '')}" placeholder="sk-..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-ai-model">模型名称 / Model ID</label>
            <input type="text" id="set-ai-model" list="set-ai-model-list" value="${esc(ai.model || '')}" placeholder="如 gpt-4o / 从网关拉取" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
            <datalist id="set-ai-model-list"></datalist>
            <button type="button" class="btn" id="set-ai-fetch-models" style="margin-top:8px;${ai.provider === 'openai' ? 'display:inline-block' : 'display:none'}">从网关拉取模型列表</button>
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-ai-temp">温度 (Temperature)：<span id="set-ai-temp-val">${ai.temperature ?? 0.7}</span></label>
            <input type="range" id="set-ai-temp" min="0" max="2" step="0.1" value="${ai.temperature ?? 0.7}" style="width:100%">
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-ai-timeout">超时（秒）</label>
            <input type="number" id="set-ai-timeout" min="1" max="120" value="${ai.timeout ?? 30}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-top:20px">
            <button type="button" class="btn btn--primary" id="set-ai-save">保存 AI 配置</button>
            <button type="button" class="btn" id="set-ai-test">测试连接</button>
            <span id="set-ai-test-result" style="font-size:12px;color:var(--ink-soft)"></span>
          </div>
        `;
        // 温度滑块实时显示
        $('#set-ai-temp').addEventListener('input', (e) => {
          $('#set-ai-temp-val').textContent = e.target.value;
        });
        // Provider 切换：openai 时显示基地址与拉取模型按钮
        $('#set-ai-provider').addEventListener('change', (e) => {
          const isOpenAI = e.target.value === 'openai';
          $('#set-ai-baseurl-field').style.display = isOpenAI ? '' : 'none';
          $('#set-ai-fetch-models').style.display = isOpenAI ? 'inline-block' : 'none';
        });
        // 从网关拉取模型列表（仅 openai）
        $('#set-ai-fetch-models').addEventListener('click', async () => {
          const btn = $('#set-ai-fetch-models');
          btn.disabled = true;
          btn.textContent = '拉取中...';
          try {
            const data = await SettingsAPI.fetchAIModels();
            const models = (data.models || []);
            const dl = $('#set-ai-model-list');
            dl.innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
            if (!($('#set-ai-model').value).trim() && models.length) {
              $('#set-ai-model').value = models[0];
            }
            toast(`已拉取 ${models.length} 个可用模型，可在模型输入框下拉选择`);
          } catch (e) {
            toast('拉取模型失败：' + e.message, 'warn');
          } finally {
            btn.disabled = false;
            btn.textContent = '从网关拉取模型列表';
          }
        });
        // 保存
        $('#set-ai-save').addEventListener('click', async () => {
          const payload = {
            provider: $('#set-ai-provider').value,
            api_key: $('#set-ai-key').value,
            model: $('#set-ai-model').value,
            base_url: $('#set-ai-baseurl').value,
            temperature: parseFloat($('#set-ai-temp').value),
            timeout: parseInt($('#set-ai-timeout').value, 10),
          };
          try {
            const result = await SettingsAPI.updateAISettings(payload);
            settingsData.ai = result;
            toast('AI 配置已保存，热更新生效');
          } catch (e) {
            toast('保存失败：' + e.message, 'warn');
          }
        });
        // 测试连接
        $('#set-ai-test').addEventListener('click', async () => {
          const resultEl = $('#set-ai-test-result');
          resultEl.textContent = '测试中...';
          resultEl.style.color = 'var(--ink-soft)';
          try {
            const result = await SettingsAPI.testAIConnection({
              provider: $('#set-ai-provider').value,
              api_key: $('#set-ai-key').value,
              model: $('#set-ai-model').value,
              base_url: $('#set-ai-baseurl').value,
              timeout: parseInt($('#set-ai-timeout').value, 10) || 10,
            });
            if (result.success) {
              resultEl.textContent = '✓ ' + result.message;
              resultEl.style.color = 'var(--ok)';
            } else {
              resultEl.textContent = '✗ ' + result.message;
              resultEl.style.color = 'var(--danger)';
            }
          } catch (e) {
            resultEl.textContent = '✗ 测试请求失败：' + e.message;
            resultEl.style.color = 'var(--danger)';
          }
        });
      } else if (activeTab === 'strategy') {
        const s = settingsData.strategy || {};
        container.innerHTML = `
          <div class="field" style="margin-bottom:16px">
            <label for="set-st-score">自动评分阈值（≥此值自动标记高意向）</label>
            <input type="number" id="set-st-score" min="0" max="100" step="1" value="${s.auto_score_threshold ?? 60}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-st-r2">R2 话术切换转化率阈值（%）</label>
            <input type="number" id="set-st-r2" min="0" max="100" step="0.5" value="${s.r2_switch_threshold ?? 8}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-st-daily">单账号日频上限</label>
            <input type="number" id="set-st-daily" min="1" max="500" step="1" value="${s.daily_frequency_limit ?? 80}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div style="margin-top:20px">
            <button type="button" class="btn btn--primary" id="set-st-save">保存策略配置</button>
          </div>
        `;
        $('#set-st-save').addEventListener('click', async () => {
          const payload = {
            auto_score_threshold: parseFloat($('#set-st-score').value),
            r2_switch_threshold: parseFloat($('#set-st-r2').value),
            daily_frequency_limit: parseInt($('#set-st-daily').value, 10),
          };
          try {
            const result = await SettingsAPI.updateStrategySettings(payload);
            settingsData.strategy = result;
            toast('话术策略配置已保存');
          } catch (e) {
            toast('保存失败：' + e.message, 'warn');
          }
        });
      } else if (activeTab === 'compliance') {
        const c = settingsData.compliance || {};
        const ruleRow = (id, label, thresholdVal, enabledVal, desc) => `
          <div style="padding:14px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <strong style="font-size:14px">${label}</strong>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                <input type="checkbox" id="set-c-${id}-enabled" ${enabledVal ? 'checked' : ''} style="accent-color:var(--brand-deep);width:16px;height:16px">
                启用
              </label>
            </div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px">${desc}</div>
            <div class="field" style="margin-bottom:0">
              <label for="set-c-${id}-threshold">阈值</label>
              <input type="number" id="set-c-${id}-threshold" step="0.5" value="${thresholdVal}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
            </div>
          </div>
        `;
        container.innerHTML = `
          ${ruleRow('r1', 'R1 · 单账号日频限流', c.r1_threshold ?? 80, c.r1_enabled ?? true, '单账号日发送量 ≥ 阈值时，自动降速至 40 条/天')}
          ${ruleRow('r2', 'R2 · 话术变体自动切换', c.r2_threshold ?? 8, c.r2_enabled ?? true, '变体按权重随机分配（转化率未回写，R2 自动切换暂不触发）')}
          ${ruleRow('r3', 'R3 · 黑名单激增安全模式', c.r3_threshold ?? 3, c.r3_enabled ?? true, '黑名单日增 > 阈值（%）或账号封禁时，触发全量暂停安全模式')}
          <div style="margin-top:20px">
            <button type="button" class="btn btn--primary" id="set-c-save">保存合规规则</button>
          </div>
        `;
        $('#set-c-save').addEventListener('click', async () => {
          const payload = {
            r1_threshold: parseFloat($('#set-c-r1-threshold').value),
            r1_enabled: $('#set-c-r1-enabled').checked,
            r2_threshold: parseFloat($('#set-c-r2-threshold').value),
            r2_enabled: $('#set-c-r2-enabled').checked,
            r3_threshold: parseFloat($('#set-c-r3-threshold').value),
            r3_enabled: $('#set-c-r3-enabled').checked,
          };
          try {
            const result = await SettingsAPI.updateComplianceSettings(payload);
            settingsData.compliance = result;
            toast('合规规则配置已保存');
          } catch (e) {
            toast('保存失败：' + e.message, 'warn');
          }
        });
      } else if (activeTab === 'crawl') {
        const cr = settingsData.crawl || {};
        const keywords = Array.isArray(cr.default_keywords) ? cr.default_keywords.join(', ') : '';
        container.innerHTML = `
          <div class="field" style="margin-bottom:16px">
            <label for="set-cr-keywords">默认采集关键词（逗号分隔）</label>
            <textarea id="set-cr-keywords" rows="3" placeholder="如：全屋装修,旧房改造,装修报价" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink);resize:vertical">${esc(keywords)}</textarea>
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-cr-interval">采集间隔（分钟）</label>
            <input type="number" id="set-cr-interval" min="1" max="1440" value="${cr.crawl_interval_minutes ?? 30}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div class="field" style="margin-bottom:16px">
            <label for="set-cr-max">单视频最大评论采集数</label>
            <input type="number" id="set-cr-max" min="1" max="10000" value="${cr.max_comments_per_video ?? 100}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
          </div>
          <div style="margin-top:20px">
            <button type="button" class="btn btn--primary" id="set-cr-save">保存采集配置</button>
          </div>
        `;
        $('#set-cr-save').addEventListener('click', async () => {
          const kwRaw = $('#set-cr-keywords').value;
          const keywords = kwRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
          const payload = {
            default_keywords: keywords,
            crawl_interval_minutes: parseInt($('#set-cr-interval').value, 10),
            max_comments_per_video: parseInt($('#set-cr-max').value, 10),
          };
          try {
            const result = await SettingsAPI.updateCrawlSettings(payload);
            settingsData.crawl = result;
            toast('采集配置已保存');
          } catch (e) {
            toast('保存失败：' + e.message, 'warn');
          }
        });
      } else if (activeTab === 'notification') {
        const n = settingsData.notification || {};
        const notifRow = (id, label, desc, checked) => `
          <div style="padding:14px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div>
              <strong style="font-size:14px;display:block;margin-bottom:4px">${label}</strong>
              <span style="font-size:12px;color:var(--ink-soft)">${desc}</span>
            </div>
            <label style="cursor:pointer">
              <input type="checkbox" id="set-n-${id}" ${checked ? 'checked' : ''} style="accent-color:var(--brand-deep);width:18px;height:18px">
            </label>
          </div>
        `;
        container.innerHTML = `
          ${notifRow('dm', '新私信提醒', '收到用户主动私信时通知', n.new_dm_alert ?? true)}
          ${notifRow('followup', '跟进提醒', '今日有待跟进客户时通知', n.followup_reminder ?? true)}
          ${notifRow('deal', '成交提醒', '客户成交时通知', n.deal_alert ?? true)}
          <div style="margin-top:20px">
            <button type="button" class="btn btn--primary" id="set-n-save">保存通知设置</button>
          </div>
        `;
        $('#set-n-save').addEventListener('click', async () => {
          const payload = {
            new_dm_alert: $('#set-n-dm').checked,
            followup_reminder: $('#set-n-followup').checked,
            deal_alert: $('#set-n-deal').checked,
          };
          try {
            const result = await SettingsAPI.updateNotificationSettings(payload);
            settingsData.notification = result;
            toast('通知设置已保存');
          } catch (e) {
            toast('保存失败：' + e.message, 'warn');
          }
        });
      }
    }

    // Tab 切换
    $$('.settings-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTab();
      });
    });

    renderTab();

    // 外层Tab切换
    $('#outer-settings-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      location.hash = `#/settings?tab=${btn.dataset.tab}`;
    });
  }


  /* ═══════════════════════════════════════════
     视图：数据备份与恢复
     ═══════════════════════════════════════════ */
  async function renderBackupBody(mount) {
    const BK = (window.API || {}).apiBackup || {};
    let backups = [];
    let settings = { enabled: false, retain_count: 7, last_auto_backup_at: null };

    mount.innerHTML = `
      <div class="backup-page">
        <!-- 操作区 -->
        <div class="card backup-actions">
          <div class="backup-actions__row">
            <button type="button" class="btn btn--primary" id="bk-create">
              <svg width="14" height="14" viewBox="0 0 24 24" style="margin-right:6px"><use href="#i-check"/></svg>立即备份
            </button>
            <button type="button" class="btn" id="bk-export">
              <svg width="14" height="14" viewBox="0 0 24 24" style="margin-right:6px"><use href="#i-arrow"/></svg>导出 JSON 全量
            </button>
            <span id="bk-action-status" class="backup-action-status"></span>
          </div>
        </div>

        <!-- 自动备份设置 -->
        <div class="card" style="margin-top:16px">
          <h3 style="font-size:15px;margin-bottom:14px">自动备份设置</h3>
          <div class="backup-settings-row">
            <label class="backup-toggle">
              <input type="checkbox" id="bk-auto-enabled">
              <span>启用自动备份</span>
            </label>
            <div class="backup-settings-field">
              <label for="bk-retain">保留最近份数</label>
              <input type="number" id="bk-retain" min="1" max="30" value="7" style="width:80px">
            </div>
            <button type="button" class="btn btn--primary btn--sm" id="bk-save-settings">保存设置</button>
          </div>
          <div id="bk-last-backup" style="font-size:12px;color:var(--ink-soft);margin-top:10px"></div>
        </div>

        <!-- 备份列表 -->
        <div class="card" style="margin-top:16px">
          <h3 style="font-size:15px;margin-bottom:14px">备份列表</h3>
          <div id="bk-list-container">
            <div style="text-align:center;padding:40px;color:var(--ink-faint)">加载中...</div>
          </div>
        </div>
      </div>
    `;

    /* ── 加载数据 ── */
    async function loadAll() {
      try {
        settings = await BK.getSettings();
      } catch (e) { /* use defaults */ }
      $('#bk-auto-enabled').checked = !!settings.enabled;
      $('#bk-retain').value = settings.retain_count || 7;
      $('#bk-last-backup').textContent = settings.last_auto_backup_at
        ? `上次自动备份：${settings.last_auto_backup_at}`
        : '尚未执行过自动备份';
      await loadList();
    }

    async function loadList() {
      const container = $('#bk-list-container');
      try {
        const res = await BK.list();
        backups = res.backups || [];
        if (!backups.length) {
          container.innerHTML = emptyState('i-empty', '暂无备份文件');
          return;
        }
        container.innerHTML = `
          <table class="backup-table">
            <thead>
              <tr>
                <th>文件名</th><th>大小</th><th>创建时间</th><th>类型</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${backups.map((b, i) => `
                <tr>
                  <td class="backup-filename">${esc(b.filename)}</td>
                  <td>${esc(b.size_display || '')}</td>
                  <td>${esc((b.created_at || '').replace('T', ' ').slice(0, 19))}</td>
                  <td><span class="badge badge--${b.type === 'auto' ? 'info' : b.type === 'pre_restore' ? 'warn' : 'default'}">${esc(b.type)}</span></td>
                  <td class="backup-ops">
                    <button type="button" class="btn btn--warn btn--sm bk-restore" data-idx="${i}">恢复</button>
                    <button type="button" class="btn btn--danger btn--sm bk-delete" data-idx="${i}">删除</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
        // 绑定恢复按钮
        $$('.bk-restore', container).forEach(btn => {
          btn.addEventListener('click', () => {
            const b = backups[parseInt(btn.dataset.idx, 10)];
            confirmRestore(b.filename);
          });
        });
        // 绑定删除按钮
        $$('.bk-delete', container).forEach(btn => {
          btn.addEventListener('click', () => {
            const b = backups[parseInt(btn.dataset.idx, 10)];
            confirmDelete(b.filename);
          });
        });
      } catch (e) {
        container.innerHTML = `<div style="color:var(--danger);text-align:center;padding:20px">加载失败：${esc(e.message)}</div>`;
      }
    }

    /* ── 立即备份 ── */
    $('#bk-create').addEventListener('click', async () => {
      const status = $('#bk-action-status');
      status.textContent = '备份中...';
      status.style.color = 'var(--ink-soft)';
      try {
        const result = await BK.create();
        status.textContent = '✓ 备份成功：' + result.filename;
        status.style.color = 'var(--ok)';
        toast('备份创建成功');
        await loadList();
      } catch (e) {
        status.textContent = '✗ 备份失败：' + e.message;
        status.style.color = 'var(--danger)';
      }
    });

    /* ── 导出 JSON ── */
    $('#bk-export').addEventListener('click', async () => {
      const status = $('#bk-action-status');
      status.textContent = '导出中...';
      status.style.color = 'var(--ink-soft)';
      try {
        const result = await BK.exportJson();
        status.textContent = '✓ 导出成功：' + result.filename;
        status.style.color = 'var(--ok)';
        toast('全量导出完成');
        if (result.file_url) {
          window.open(result.file_url, '_blank');
        }
      } catch (e) {
        status.textContent = '✗ 导出失败：' + e.message;
        status.style.color = 'var(--danger)';
      }
    });

    /* ── 保存设置 ── */
    $('#bk-save-settings').addEventListener('click', async () => {
      const payload = {
        enabled: $('#bk-auto-enabled').checked,
        retain_count: parseInt($('#bk-retain').value, 10) || 7,
      };
      try {
        settings = await BK.updateSettings(payload);
        toast('自动备份设置已保存');
        $('#bk-last-backup').textContent = settings.last_auto_backup_at
          ? `上次自动备份：${settings.last_auto_backup_at}`
          : '尚未执行过自动备份';
      } catch (e) {
        toast('保存失败：' + e.message, 'warn');
      }
    });

    /* ── 恢复确认弹窗 ── */
    function confirmRestore(filename) {
      openModal({
        title: '确认恢复备份？',
        body: `<p style="color:var(--ink)">即将从 <strong>${esc(filename)}</strong> 恢复数据库。</p>
               <p style="color:var(--warn);margin-top:10px">⚠ 恢复将覆盖当前数据，系统已自动创建恢复前备份，确定继续？</p>`,
        confirmText: '确认恢复',
        confirmClass: 'btn--danger',
        onConfirm: async () => {
          try {
            const result = await BK.restore(filename);
            if (result.success) {
              toast('恢复成功，建议重启后端服务使数据完全生效');
            } else {
              toast('恢复失败：' + result.message, 'warn');
            }
            closeModal();
            await loadList();
          } catch (e) {
            toast('恢复请求失败：' + e.message, 'warn');
            closeModal();
          }
        },
      });
    }

    /* ── 删除确认 ── */
    function confirmDelete(filename) {
      openModal({
        title: '确认删除备份？',
        body: `<p>即将删除备份文件 <strong>${esc(filename)}</strong>，此操作不可撤销。</p>`,
        confirmText: '确认删除',
        confirmClass: 'btn--danger',
        onConfirm: async () => {
          try {
            await BK.delete(filename);
            toast('备份已删除');
            closeModal();
            await loadList();
          } catch (e) {
            toast('删除失败：' + e.message, 'warn');
            closeModal();
          }
        },
      });
    }

    /* ── 简化弹窗（复用全局 modal） ── */
    function openModal({ title, body, confirmText, confirmClass, onConfirm }) {
      const modal = $('#modal'), bd = $('#modal-backdrop');
      modal.innerHTML = `
        <div class="modal__body" style="padding:24px">
          <h3 style="margin-bottom:14px;font-size:16px">${title}</h3>
          <div style="margin-bottom:20px">${body}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button type="button" class="btn" id="modal-cancel">取消</button>
            <button type="button" class="btn ${confirmClass || 'btn--primary'}" id="modal-confirm">${confirmText || '确认'}</button>
          </div>
        </div>
      `;
      modal.hidden = false; bd.hidden = false;
      requestAnimationFrame(() => { modal.classList.add('show'); bd.classList.add('show'); });
      $('#modal-cancel').addEventListener('click', closeModal);
      $('#modal-confirm').addEventListener('click', onConfirm);
      bd.onclick = closeModal;
      document.addEventListener('keydown', escCloseOnce);
    }
    function escCloseOnce(e) {
      if (e.key === 'Escape') { closeModal(); }
    }

    await loadAll();
  }

  async function viewBackup() {
    main.innerHTML = pageHead({
      icon: 'i-clock',
      title: '数据备份与恢复',
      desc: '手动备份、自动备份调度、全量数据导出与恢复',
    }) + '<div id="backup-mount"></div>';
    await renderBackupBody($('#backup-mount'));
  }

  /* ═══════════════════════════════════════════
     视图：系统监控（P4-C）
     ═══════════════════════════════════════════ */
  let _monitorTimer = null;
  const MONITOR_STATUS_COLORS = {
    ok: '#22c55e', warning: '#f59e0b', warn: '#f59e0b',
    error: '#ef4444', stopped: '#9ca3af', unknown: '#9ca3af',
  };
  const MONITOR_SEV_COLORS = { danger: '#ef4444', warn: '#f59e0b', info: '#35597e', ok: '#22c55e' };

  function _monUptime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + '天 ' + h + '时';
    if (h > 0) return h + '时 ' + m + '分';
    return m + '分 ' + (sec % 60) + '秒';
  }
  function _monDot(status) {
    const color = MONITOR_STATUS_COLORS[status] || '#9ca3af';
    return `<span class="mon-dot" style="background:${color}"></span>`;
  }

  async function viewMonitor() {
    if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }

    main.innerHTML = `<div class="view">
      ${pageHead({ icon: 'shield', title: '系统监控', desc: '后端 / 数据库 / AI 配置 / 采集引擎 / 任务与日志 · 每 30 秒自动刷新',
        actions: '<span class="mon-updated" id="monitor-updated-at"></span>' })}
      <div class="empty"><p>加载中…</p></div>
    </div>`;

    function renderMonitor(d) {
      const { health, db, apiStats, accounts, tasks, logs } = d;

      /* ── 系统状态卡片行（5 个） ── */
      const compCards = [
        { label: '后端', c: health.backend, sub: `${esc(health.backend.version)} · 运行 ${esc(_monUptime(health.backend.uptime))}` },
        { label: '数据库', c: health.database, sub: `${esc((health.database.fileSizeMb || 0).toFixed(2))} MB` },
        { label: 'AI 配置', c: health.aiConfig, sub: health.aiConfig.apiKeyConfigured ? esc(health.aiConfig.provider + ' · ' + health.aiConfig.model) : '未配置 API Key' },
        { label: '采集引擎', c: health.crawler, sub: health.crawler.running ? '运行中 · ' + health.crawler.tasksCount + ' 任务' : '未运行' },
        { label: '桌面端', c: health.desktop, sub: '暂未接入' },
      ].map(({ label, c, sub }) => `
        <div class="mon-comp">
          <div class="mon-comp__head">${_monDot(c.status)}<span class="mon-comp__label">${esc(label)}</span></div>
          <div class="mon-comp__status">${esc(c.status)}</div>
          <div class="mon-comp__sub">${sub}</div>
        </div>`).join('');

      /* ── 数据库信息 ── */
      const tableRows = (db.tables || []).map((t) =>
        `<div class="mon-table-row"><span class="mon-table-name">${esc(t.table)}</span><span class="num">${fmt(t.count)}</span></div>`).join('');

      /* ── API 统计 ── */
      const topRows = (apiStats.top5Endpoints || []).map((e) => `
        <div class="mon-ap-row">
          <span class="mon-ap-endpoint">${esc(e.endpoint)}</span>
          <span class="num">${fmt(e.total)} 次</span>
          <span class="num mon-ap-rate">${(e.errorRate || 0).toFixed(1)}% 错误</span>
        </div>`).join('');

      /* ── 账号健康度表格 ── */
      const accRows = accounts.map((a) => {
        const bad = a.healthScore < 60;
        const fillColor = a.healthScore >= 80 ? '#22c55e' : a.healthScore >= 60 ? '#f59e0b' : '#ef4444';
        const limitTag = {
          healthy: '<span class="tag tag--healthy">健康</span>',
          warn: '<span class="tag tag--throttled">预警</span>',
          throttled40: '<span class="tag tag--throttled">降速40</span>',
          safe_mode: '<span class="tag tag--safemode">安全模式</span>',
          banned: '<span class="tag tag--banned">已封禁</span>',
        }[a.limitStatus] || esc(a.limitStatus);
        return `
        <div class="mon-acc-row ${bad ? 'mon-acc-row--bad' : ''}">
          <span class="mon-acc-name">${esc(a.nickname)}</span>
          <span class="mon-acc-gauge">
            <span class="mon-acc-score">${a.healthScore}</span>
            <span class="gauge__track"><span class="gauge__fill" style="width:${a.healthScore}%;background:${fillColor}"></span></span>
          </span>
          <span>${limitTag}</span>
          <span class="num">今日 ${fmt(a.todaySent)}</span>
          <span class="num">预警 ${a.warningCount}</span>
        </div>`;
      }).join('');

      /* ── 最近日志 ── */
      const logRows = logs.map((l) => {
        const color = MONITOR_SEV_COLORS[l.severity] || '#9ca3af';
        const t = (l.createdAt || '').replace('T', ' ').slice(0, 19);
        return `
        <div class="mon-log-row">
          <span class="mon-log-dot" style="background:${color}"></span>
          <span class="mon-log-type">${esc(l.eventType)}</span>
          <span class="mon-log-msg">${esc(l.message)}</span>
          <span class="mon-log-time num">${esc(t)}</span>
        </div>`;
      }).join('');

      main.innerHTML = `
      <div class="view">
        ${pageHead({ icon: 'shield', title: '系统监控', desc: '后端 / 数据库 / AI 配置 / 采集引擎 / 任务与日志 · 每 30 秒自动刷新',
          actions: '<span class="mon-updated" id="monitor-updated-at"></span>' })}

        <div class="mon-comp-grid">${compCards}</div>

        <div class="grid grid--main-side">
          <div class="card">
            <div class="card__head">
              <span class="card__title">数据库信息</span>
              <span class="card__hint">SQLite · 文件 ${fmt(db.tableCount)} 张表 · 共 ${fmt(db.totalRecords)} 条记录</span>
            </div>
            <div class="mon-kv-grid">
              <div class="mon-kv"><span class="mon-kv__k">文件路径</span><span class="mon-kv__v mon-path">${esc(db.filePath)}</span></div>
              <div class="mon-kv"><span class="mon-kv__k">文件大小</span><span class="mon-kv__v">${(db.fileSizeMb || 0).toFixed(2)} MB</span></div>
              <div class="mon-kv"><span class="mon-kv__k">最近备份</span><span class="mon-kv__v">${db.lastBackupAt ? esc(String(db.lastBackupAt).replace('T',' ').slice(0,19)) : '无'}</span></div>
            </div>
            <div class="mon-table-list">${tableRows || '<p class="muted">无表</p>'}</div>
          </div>

          <div class="card">
            <div class="card__head">
              <span class="card__title">API 统计</span>
              <span class="card__hint">内存计数 · 重启清零</span>
            </div>
            <div class="mon-kpi-row">
              <div class="mon-kpi"><span class="mon-kpi__v num">${fmt(apiStats.totalRequests)}</span><span class="mon-kpi__k">总请求</span></div>
              <div class="mon-kpi"><span class="mon-kpi__v num">${(apiStats.errorRate || 0).toFixed(1)}%</span><span class="mon-kpi__k">错误率</span></div>
              <div class="mon-kpi"><span class="mon-kpi__v num">${(apiStats.avgResponseTime || 0).toFixed(0)} ms</span><span class="mon-kpi__k">平均响应</span></div>
            </div>
            <div class="mon-ap-list">${topRows || '<p class="muted">暂无请求</p>'}</div>
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">任务运行态</span>
            <span class="card__hint">采集任务 / 私信队列 / 调度器</span>
          </div>
          <div class="mon-task-grid">
            <div class="mon-task-block">
              <div class="mon-task__t">采集任务</div>
              <div class="mon-task__nums">
                <span>运行 <b>${tasks.crawlTasks.running}</b></span>
                <span>完成 <b>${tasks.crawlTasks.completed}</b></span>
                <span>失败 <b>${tasks.crawlTasks.failed}</b></span>
              </div>
            </div>
            <div class="mon-task-block">
              <div class="mon-task__t">私信队列</div>
              <div class="mon-task__nums">
                <span>待发 <b>${tasks.dmQueue.pending}</b></span>
                <span>已发 <b>${tasks.dmQueue.sent}</b></span>
                <span>失败 <b>${tasks.dmQueue.failed}</b></span>
                <span>频控 <b>${tasks.dmQueue.throttled}</b></span>
              </div>
            </div>
            <div class="mon-task-block">
              <div class="mon-task__t">调度器</div>
              <div class="mon-task__nums">
                <span>${_monDot(tasks.scheduler.status === 'running' ? 'ok' : 'stopped')} ${esc(tasks.scheduler.status)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">账号健康度</span>
            <span class="card__hint">健康分 &lt; 60 红色高亮</span>
          </div>
          <div class="mon-acc-head">
            <span>账号</span><span>健康分</span><span>状态</span><span>今日发送</span><span>预警数</span>
          </div>
          <div class="mon-acc-list">${accRows || '<p class="muted">无账号</p>'}</div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">最近系统日志</span>
            <span class="card__hint">审计事件 · 时间倒序</span>
          </div>
          <div class="mon-log-list">${logRows || '<p class="muted">暂无日志</p>'}</div>
        </div>
      </div>`;

      const el = $('#monitor-updated-at');
      if (el) el.textContent = '最后更新 ' + new Date().toLocaleTimeString('zh-CN');
    }

    async function loadMonitor() {
      try {
        const data = await Promise.all([
          API.fetchMonitorHealth(),
          API.fetchMonitorDatabase(),
          API.fetchMonitorApiStats(),
          API.fetchMonitorAccounts(),
          API.fetchMonitorTasks(),
          API.fetchMonitorLogs(20),
        ]);
        renderMonitor({
          health: data[0], db: data[1], apiStats: data[2],
          accounts: data[3], tasks: data[4], logs: data[5],
        });
      } catch (e) {
        const el = $('#monitor-updated-at');
        if (el) el.textContent = '刷新失败：' + (e && e.message ? e.message : e);
      }
    }

    await loadMonitor();
    _monitorTimer = setInterval(loadMonitor, 30000);
  }

  /* 离开监控页时清除定时器 */
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '#/workbench').replace('#/', '');
    if (h !== 'monitor' && _monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }
    if (h !== 'crawl' && crawlState.polling) { clearInterval(crawlState.polling); crawlState.polling = null; }
    if (h !== 'interact' && h !== 'dm' && window._dmBatchTimer) { clearInterval(window._dmBatchTimer); window._dmBatchTimer = null; }
  });


  /* 补充样式表：变量筛选器 + AI 话术优化面板。
     ⚠️ 本应并入 assets/css/style.css，但该文件当前被主机写入保护挡住
        （C 盘 0 字节 → 改动备份写不进去 → 写入 fail-closed），只能落到独立 css 再动态挂载。
        磁盘恢复后：把 style-ai.css 内容并进 style.css，删掉这段挂载代码即可。 */
  (function mountExtraStyle() {
    if (document.getElementById('style-ai')) return;
    const link = document.createElement('link');
    link.id = 'style-ai';
    link.rel = 'stylesheet';
    link.href = 'assets/css/style-ai.css';
    document.head.appendChild(link);
  })();

  /* ══════════ 启动 ══════════ */
  (async function init() {
    const rt = await API.getRuntime();
    state.safeMode = rt.safeMode;
    state.taskRunning = rt.taskRunning;
    renderTopbar();
    renderNavBadges();
    renderBellBadge();
    setInterval(renderBellBadge, 30000);
    // 子菜单展开/收起点击事件
    document.addEventListener('click', (e) => {
      const toggle = e.target.closest('.nav-toggle');
      if (toggle) {
        const targetId = toggle.dataset.toggle;
        const submenu = document.getElementById(targetId);
        if (submenu) {
          const item = submenu.closest('.nav-item--has-sub');
          if (item) item.classList.toggle('expanded');
        }
      }
    });

    route();
  })();
})();
