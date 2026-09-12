/* ═══════════════════════════════════════════════════════════
   上线向导 + 业务配置 真实 API 对接模块
   ───────────────────────────────────────────────────────────
   一、上线向导（把系统真正跑起来）
     GET  /api/onboarding/readiness      环境自检
     GET  /api/crawler/service           采集服务状态
     POST /api/crawler/service/start     启动采集服务
     POST /api/crawler/service/stop      停止采集服务
     GET  /api/crawler/live/status       实时采集状态
     POST /api/crawler/live/start        启动实时采集（唤起浏览器扫码登录）
     POST /api/accounts                  绑定抖音账号
     （采集任务的增删启停走 window.CrawlAPI，见 api-crawl.js）

   二、业务配置 5 步（供 AI 理解业务，各自独立单例）
     GET/PUT  /api/business/profile      第1步 业务画像
     GET/PUT  /api/workbench/product     第2步 产品知识库
     GET/PUT  /api/workbench/audience    第3步 目标客户
     GET/PUT  /api/workbench/scripts     第4步 话术策略
     GET/PUT  /api/workbench/wechat      第5步 微信转化
     GET  /api/onboarding/status · POST /api/onboarding/skip · POST /api/onboarding/wizard

   加载顺序：必须在 mock-data.js 之后加载，通过 Object.assign
   覆盖 window.MOCK_API 中对应函数。
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── API 基址配置 ── */
  const API_BASE = 'http://127.0.0.1:8000/api';
  const FETCH_TIMEOUT = 10000; // 10 秒超时

  /* ── 全局加载指示器（顶部进度条，与其他 api-*.js 行为一致） ── */
  let _loadingCount = 0;
  let _loadingEl = null;
  function _ensureLoadingEl() {
    if (_loadingEl) return _loadingEl;
    _loadingEl = document.createElement('div');
    _loadingEl.id = 'api-loading-bar';
    _loadingEl.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#1e6e52,#3a9d7a);z-index:9999;transition:width .3s ease;box-shadow:0 0 8px rgba(30,110,82,.5);';
    document.body.appendChild(_loadingEl);
    return _loadingEl;
  }
  function _showLoading() {
    _loadingCount++;
    const el = _ensureLoadingEl();
    el.style.width = '70%';
    el.style.opacity = '1';
  }
  function _hideLoading() {
    _loadingCount = Math.max(0, _loadingCount - 1);
    if (_loadingCount === 0 && _loadingEl) {
      _loadingEl.style.width = '100%';
      setTimeout(() => { if (_loadingCount === 0 && _loadingEl) _loadingEl.style.opacity = '0'; }, 200);
    }
  }

  /* ── 统一 apiFetch：10秒超时 / HTTP错误 / 网络错误 ── */
  async function apiFetch(path, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    _showLoading();
    try {
      const res = await fetch(API_BASE + path, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          // FastAPI 校验错误 detail 可能是数组
          if (Array.isArray(j.detail)) {
            detail = j.detail.map((d) => d.msg || JSON.stringify(d)).join('；');
          } else {
            detail = j.detail || '';
          }
        } catch (e) { /* ignore */ }
        const err = new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      return res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('请求超时，请检查后端服务是否启动');
      }
      if (err instanceof TypeError) {
        throw new Error('网络错误，请检查后端服务是否启动（' + err.message + '）');
      }
      throw err;
    } finally {
      _hideLoading();
    }
  }

  /* ── 字段归一化：后端 snake_case → 前端 camelCase ── */
  function _camelKey(k) {
    return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  function _normalize(obj) {
    if (Array.isArray(obj)) return obj.map(_normalize);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          out[_camelKey(k)] = _normalize(obj[k]);
        }
      }
      return out;
    }
    return obj;
  }

  /* ── 请求体字段转换：前端 camelCase → 后端 snake_case ── */
  function _snakeKey(k) {
    return k.replace(/([A-Z])/g, (_, c) => '_' + c.toLowerCase());
  }
  function _snakeify(obj) {
    if (Array.isArray(obj)) return obj.map(_snakeify);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          out[_snakeKey(k)] = _snakeify(obj[k]);
        }
      }
      return out;
    }
    return obj;
  }

  /* ════════ 向导状态 ════════ */

  /**
   * 查询上手状态：5 步各自完成度 + 整体状态
   * GET /api/onboarding/status
   * @returns {Promise<Object>} { status, skipped, doneCount, total, steps }
   */
  async function getOnboardingStatus() {
    const data = await apiFetch('/onboarding/status');
    return _normalize(data);
  }

  /**
   * 跳过上手向导
   * POST /api/onboarding/skip
   * @param {boolean} confirmed - 必填，未确认则后端返回 ok=false
   */
  async function skipOnboarding(confirmed) {
    const data = await apiFetch('/onboarding/skip', {
      method: 'POST',
      body: JSON.stringify({ confirmed: !!confirmed }),
    });
    return _normalize(data);
  }

  /**
   * 向导聚合提交（可一次提交多步配置）
   * POST /api/onboarding/wizard
   * @param {Object} payload { business?, product?, audience?, scripts?, wechat? }
   *   注意：步骤 key 用 snake_case 字段名，这里统一做转换
   */
  async function submitWizard(payload) {
    const data = await apiFetch('/onboarding/wizard', {
      method: 'POST',
      body: JSON.stringify(_snakeify(payload || {})),
    });
    return _normalize(data);
  }

  /* ════════ 第1步 · 业务画像 ════════ */

  async function getBusinessProfile() {
    return _normalize(await apiFetch('/business/profile'));
  }

  async function saveBusinessProfile(payload) {
    return _normalize(await apiFetch('/business/profile', {
      method: 'PUT',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ════════ 第2步 · 产品知识库 ════════ */

  async function getProductKnowledge() {
    return _normalize(await apiFetch('/workbench/product'));
  }

  async function saveProductKnowledge(payload) {
    return _normalize(await apiFetch('/workbench/product', {
      method: 'PUT',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ════════ 第3步 · 目标客户 ════════ */

  async function getAudienceProfile() {
    return _normalize(await apiFetch('/workbench/audience'));
  }

  async function saveAudienceProfile(payload) {
    return _normalize(await apiFetch('/workbench/audience', {
      method: 'PUT',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ════════ 第4步 · 话术策略 ════════ */

  async function getScriptStrategy() {
    return _normalize(await apiFetch('/workbench/scripts'));
  }

  async function saveScriptStrategy(payload) {
    return _normalize(await apiFetch('/workbench/scripts', {
      method: 'PUT',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ════════ 微信转化设置 ════════ */

  async function getWeChatSettings() {
    return _normalize(await apiFetch('/workbench/wechat'));
  }

  async function saveWeChatSettings(payload) {
    return _normalize(await apiFetch('/workbench/wechat', {
      method: 'PUT',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ════════ 上线自检 ════════ */

  /**
   * 环境自检：逐项检查上线条件（后端/采集服务/登录态/AI/账号/业务资料/数据库）
   * GET /api/onboarding/readiness
   * @returns {Promise<Object>} { ok, checkedAt, blocking, items:[{key,label,ok,detail,action,link}] }
   */
  async function getReadiness() {
    return _normalize(await apiFetch('/onboarding/readiness'));
  }

  /* ════════ 采集服务（MediaCrawler）管控 ════════ */

  /**
   * 采集服务状态
   * GET /api/crawler/service
   * @returns {Promise<Object>} { running, reachable, managed, url, pid, root, pythonPath, crawlerStatus, lastError }
   */
  async function getCrawlService() {
    return _normalize(await apiFetch('/crawler/service'));
  }

  /** 启动采集服务（已就绪则直接返回当前状态）—— POST /api/crawler/service/start */
  async function startCrawlService() {
    return _normalize(await apiFetch('/crawler/service/start', { method: 'POST' }));
  }

  /** 停止采集服务（仅停止由本系统拉起的）—— POST /api/crawler/service/stop */
  async function stopCrawlService() {
    return _normalize(await apiFetch('/crawler/service/stop', { method: 'POST' }));
  }

  /* ════════ 扫码登录（借一次实时采集唤起浏览器登录） ════════ */

  /** 实时采集状态 —— GET /api/crawler/live/status */
  async function getCrawlLiveStatus() {
    return _normalize(await apiFetch('/crawler/live/status'));
  }

  /**
   * 启动实时采集（headless=false 时会打开浏览器供抖音扫码登录）
   * POST /api/crawler/live/start
   * @param {Object} payload { keyword, count, maxCommentsCount, loginType, headless, intentKeywords, excludedKeywords }
   */
  async function startCrawlLiveLogin(payload) {
    return _normalize(await apiFetch('/crawler/live/start', {
      method: 'POST',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ════════ 抖音账号绑定 ════════ */

  /**
   * 绑定抖音账号 —— POST /api/accounts
   * @param {Object} payload { nickname, platform, dailyLimit, notes }
   */
  async function createAccount(payload) {
    return _normalize(await apiFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify(_snakeify(payload || {})),
    }));
  }

  /* ── 挂载到全局 window.MOCK_API（覆盖 mock 回退版本） ── */
  window.MOCK_API = window.MOCK_API || {};
  Object.assign(window.MOCK_API, {
    /* 向导状态 */
    getOnboardingStatus,
    skipOnboarding,
    submitWizard,
    /* 上线自检 */
    getReadiness,
    /* 采集服务管控 */
    getCrawlService,
    startCrawlService,
    stopCrawlService,
    /* 扫码登录 */
    getCrawlLiveStatus,
    startCrawlLiveLogin,
    /* 账号绑定 */
    createAccount,
    /* 第1步 业务画像 */
    getBusinessProfile,
    saveBusinessProfile,
    /* 第2步 产品知识库 */
    getProductKnowledge,
    saveProductKnowledge,
    /* 第3步 目标客户 */
    getAudienceProfile,
    saveAudienceProfile,
    /* 第4步 话术策略 */
    getScriptStrategy,
    saveScriptStrategy,
    /* 第5步 微信转化 */
    getWeChatSettings,
    saveWeChatSettings,
  });
})();
