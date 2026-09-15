/* ═══════════════════════════════════════════════════════════
   评论候选池工作台 · 真实 API 对接模块（P3）
   ───────────────────────────────────────────────────────────
   覆盖「评论候选池」视图所需的端点：
     GET  /comments/tasks            评论回复任务列表
     POST /comments/tasks            创建评论回复任务（人工确认后）
     POST /comments/guard-check      话术质检（敏感词 + 话术套路）
     GET  /comments/guard-rules      质检规则列表
     POST /ai/comment-insight        单条评论语义四维分级
     POST /ai/comment-suggestion     生成 3 条评论回复建议
     GET  /comments/risk-summary     负面评论风险聚合（L1/L2/L3）
     POST /comments/desensitize      单段文本脱敏

   本文件在 mock-data.js 与其它 api-*.js 之后、app.js 之前加载，
   以合并方式挂载到 window.MOCK_API（即 app.js 中的 API 对象）。

   注意：/ai/comment-suggestion 在 AI 未配置密钥时返回 503，
        调用方需据 err.status === 503 给出「请先配置 API Key」提示；
        /ai/comment-insight 在 AI 不可用时不报错，走兜底值（other/C）。
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const API_BASE = 'http://127.0.0.1:8000/api';
  const FETCH_TIMEOUT = 20000;

  /* ── 顶部加载条（与其它 api-*.js 保持同一交互） ── */
  let _loadingCount = 0;
  let _loadingEl = null;
  function _ensureLoadingEl() {
    if (_loadingEl || typeof document === 'undefined') return _loadingEl;
    _loadingEl = document.createElement('div');
    _loadingEl.id = 'api-loading-bar';
    _loadingEl.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#1e6e52,#3a9d7a);z-index:9999;transition:width .3s ease;box-shadow:0 0 8px rgba(30,110,82,.5);';
    if (document.body) document.body.appendChild(_loadingEl);
    return _loadingEl;
  }
  function _showLoading() {
    _loadingCount++;
    const el = _ensureLoadingEl();
    if (el) { el.style.width = '70%'; el.style.opacity = '1'; }
  }
  function _hideLoading() {
    _loadingCount = Math.max(0, _loadingCount - 1);
    if (_loadingCount === 0 && _loadingEl) {
      _loadingEl.style.width = '100%';
      setTimeout(() => { if (_loadingCount === 0 && _loadingEl) _loadingEl.style.opacity = '0'; }, 200);
    }
  }

  async function apiFetch(path, options = {}) {
    const { timeout = FETCH_TIMEOUT, ...init } = options; // 允许调用方放宽超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    _showLoading();
    try {
      const res = await fetch(API_BASE + path, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = (j && j.detail) || ''; } catch (e) { /* ignore */ }
        const err = new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      return res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        const e2 = new Error('请求超时，请检查后端服务是否启动');
        e2.status = 0;
        throw e2;
      }
      if (err instanceof TypeError) {
        const e2 = new Error('网络错误，请检查后端服务是否启动（' + err.message + '）');
        e2.status = 0;
        throw e2;
      }
      throw err;
    } finally {
      _hideLoading();
    }
  }

  /* ── 字段归一化：兼容后端 snake_case / camelCase，前端统一 camelCase ── */
  function _camelKey(k) {
    return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  function _normalize(obj) {
    if (Array.isArray(obj)) return obj.map(_normalize);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) out[_camelKey(k)] = _normalize(obj[k]);
      }
      return out;
    }
    return obj;
  }

  /* ══════════════════════════════════════════════════════════
     评论回复任务（读 / 写）
     ══════════════════════════════════════════════════════════ */

  /** 评论回复任务列表  GET /api/comments/tasks?status= */
  async function getCommentGrowthTasks(status) {
    const query = status ? '?status=' + encodeURIComponent(status) : '';
    const data = await apiFetch('/comments/tasks' + query);
    return _normalize(data) || [];
  }

  /** 创建评论回复任务  POST /api/comments/tasks */
  async function createCommentGrowthTask(payload = {}) {
    const body = {
      lead_id: payload.leadId || payload.lead_id || '',
      comment_content: payload.commentContent || payload.comment_content || '',
      video_title: payload.videoTitle || payload.video_title || '',
      reply_content: payload.replyContent || payload.reply_content || '',
      video_url: payload.videoUrl || payload.video_url || '',
      comment_id: payload.commentId || payload.comment_id || '',
      priority: payload.priority || 'P2',
    };
    if (payload.account) body.account = payload.account;
    if (payload.replyScriptId) body.reply_script_id = payload.replyScriptId;
    const data = await apiFetch('/comments/tasks', { method: 'POST', body: JSON.stringify(body) });
    return _normalize(data);
  }

  /** 批量推送到「待办互动 → 评论回复」  POST /api/comments/tasks/push
   *  评论候选池只是候选池，不在这里回复；选中后推过去，到待办互动才写话术发送。
   *  返回 {created, skipped, taskIds, items[]}（同一线索已有未闭环任务时跳过） */
  async function pushCommentTasks(leadIds, opts = {}) {
    const body = { lead_ids: (leadIds || []).filter(Boolean) };
    if (opts.account) body.account = opts.account;
    if (opts.priority) body.priority = opts.priority;
    if (opts.replyContent) body.reply_content = opts.replyContent;
    if (opts.replyScriptId) body.reply_script_id = opts.replyScriptId;
    const data = await apiFetch('/comments/tasks/push', { method: 'POST', body: JSON.stringify(body) });
    return _normalize(data);
  }

  /* ══════════════════════════════════════════════════════════
     话术质检
     ══════════════════════════════════════════════════════════ */

  /** 话术质检  POST /api/comments/guard-check  → {pass, blockCount, warnCount, hits[], sanitized, ...} */
  async function guardCheck(content, account) {
    const body = { content: content || '' };
    if (account) body.account = account;
    const data = await apiFetch('/comments/guard-check', { method: 'POST', body: JSON.stringify(body) });
    return _normalize(data);
  }

  /** 质检规则列表  GET /api/comments/guard-rules */
  async function listGuardRules(enabledOnly = true) {
    const data = await apiFetch('/comments/guard-rules?enabled_only=' + (enabledOnly ? 'true' : 'false'));
    return _normalize(data) || [];
  }

  /* ══════════════════════════════════════════════════════════
     AI 语义分级 / 回复建议
     ══════════════════════════════════════════════════════════ */

  /** 单条评论语义分级  POST /api/ai/comment-insight
   *  AI 不可用时不报错，返回兜底：category=other / intentLevel=C */
  async function commentInsight(payload = {}) {
    const body = {
      comment: payload.comment || '',
      video_title: payload.videoTitle || payload.video_title || '',
      source_keyword: payload.sourceKeyword || payload.source_keyword || '',
    };
    const data = await apiFetch('/ai/comment-insight', { method: 'POST', body: JSON.stringify(body), timeout: 120000 }); // AI 慢，放宽
    return _normalize(data);
  }

  /** 生成 3 条回复建议  POST /api/ai/comment-suggestion
   *  AI 未配置密钥时抛 err.status=503，调用方需给出「请先配置 API Key」提示 */
  async function commentSuggestion(payload = {}) {
    const body = {
      comment: payload.comment || '',
      video_title: payload.videoTitle || payload.video_title || '',
      source_keyword: payload.sourceKeyword || payload.source_keyword || '',
      scenario: payload.scenario || 'auto',
      industry: payload.industry || 'other',
    };
    const data = await apiFetch('/ai/comment-suggestion', { method: 'POST', body: JSON.stringify(body), timeout: 120000 }); // AI 慢，放宽
    return _normalize(data) || { suggestions: [] };
  }

  /* ══════════════════════════════════════════════════════════
     风险聚合 / 脱敏
     ══════════════════════════════════════════════════════════ */

  /** 负面评论风险聚合  GET /api/comments/risk-summary?start_date=&end_date= */
  async function getRiskSummary(startDate, endDate) {
    const qs = new URLSearchParams();
    if (startDate) qs.set('start_date', startDate);
    if (endDate) qs.set('end_date', endDate);
    const query = qs.toString();
    const data = await apiFetch('/comments/risk-summary' + (query ? '?' + query : ''));
    return _normalize(data);
  }

  /** 单段文本脱敏  POST /api/comments/desensitize */
  async function desensitizeText(text) {
    const data = await apiFetch('/comments/desensitize', {
      method: 'POST',
      body: JSON.stringify({ text: text || '' }),
    });
    return _normalize(data);
  }

  /* ══════════════════════════════════════════════════════════
     挂载到全局 window.MOCK_API（合并写法，避免覆盖其它模块）
     ══════════════════════════════════════════════════════════ */
  window.MOCK_API = window.MOCK_API || {};
  Object.assign(window.MOCK_API, {
    getCommentGrowthTasks,
    createCommentGrowthTask,
    pushCommentTasks,
    guardCheck,
    listGuardRules,
    commentInsight,
    commentSuggestion,
    getRiskSummary,
    desensitizeText,
  });
})();
