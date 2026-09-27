(() => {
  const state = {
    config: null,
    msal: null,
    account: null,
  };

  const elements = {};

  function cache() {
    [
      'account',
      'login',
      'logout',
      'refresh',
      'statusGrid',
      'commentsList',
      'commentStatusFilter',
      'commentsLoad',
      'rulesEditor',
      'rulesSave',
      'rulesMessage',
      'overridesEditor',
      'overridesSave',
      'overridesMessage',
      'syncDry',
      'syncIncremental',
      'syncBackfill',
      'qzoneReconnect',
      'qzoneQr',
      'qzoneQrImage',
      'qzoneMessage',
      'syncReport',
      'export',
      'exportMessage',
      'toast',
    ].forEach((key) => {
      elements[key] = document.querySelector(`[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`);
    });
    elements.account = document.querySelector('[data-admin-account]');
    elements.login = document.querySelector('[data-admin-login]');
    elements.logout = document.querySelector('[data-admin-logout]');
  }

  function isLocalDevelopment() {
    return ['localhost', '127.0.0.1'].includes(location.hostname);
  }

  function authReady() {
    const admin = state.config?.admin || {};
    return Boolean(admin.tenantId && admin.clientId && admin.apiScope);
  }

  function apiBase() {
    return String(state.config?.apiBaseUrl || '').replace(/\/+$/, '');
  }

  async function initMsal() {
    if (!authReady()) {
      if (!isLocalDevelopment()) {
        throw new Error('Azure 互动配置尚未填写，请先更新 data/site.json。');
      }
      return;
    }
    if (!window.msal) {
      throw new Error('Microsoft 登录库加载失败，请检查网络后刷新。');
    }
    state.msal = new window.msal.PublicClientApplication({
      auth: {
        clientId: state.config.admin.clientId,
        authority: `https://login.microsoftonline.com/${state.config.admin.tenantId}`,
        redirectUri: `${location.origin}/admin.html`,
        postLogoutRedirectUri: `${location.origin}/admin.html`,
      },
      cache: {
        cacheLocation: 'sessionStorage',
      },
    });
    await state.msal.initialize();
    const redirect = await state.msal.handleRedirectPromise();
    const account = redirect?.account || state.msal.getAllAccounts()[0] || null;
    setAccount(account);
  }

  function setAccount(account) {
    state.account = account;
    elements.account.textContent = account?.name || account?.username || '尚未登录';
    elements.login.hidden = Boolean(account);
    elements.logout.hidden = !account;
  }

  async function token() {
    if (!state.msal || !state.account) {
      if (isLocalDevelopment()) return '';
      throw new Error('请先使用 Microsoft 账号登录。');
    }
    const result = await state.msal.acquireTokenSilent({
      account: state.account,
      scopes: [state.config.admin.apiScope],
    });
    return result.accessToken;
  }

  async function login() {
    if (!state.msal) {
      await initMsal();
    }
    if (!state.msal) {
      toast('本地开发模式：管理接口将使用 ADMIN_DEV_BYPASS。');
      return;
    }
    await state.msal.loginRedirect({ scopes: [state.config.admin.apiScope] });
  }

  async function logout() {
    if (!state.msal) return;
    await state.msal.logoutRedirect({ account: state.account });
  }

  async function api(route, options = {}) {
    const accessToken = await token();
    const response = await fetch(`${apiBase()}${route}`, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'omit',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.message || `管理请求失败（HTTP ${response.status}）`);
    }
    return payload;
  }

  function statusCard(label, value, detail = '') {
    const card = document.createElement('article');
    card.className = 'admin-status-card';
    const title = document.createElement('strong');
    title.textContent = label;
    const main = document.createElement('span');
    main.textContent = value;
    card.append(title, main);
    if (detail) {
      const small = document.createElement('span');
      small.textContent = detail;
      card.append(small);
    }
    return card;
  }

  async function loadStatus() {
    const payload = await api('/manage/status');
    elements.statusGrid.replaceChildren(
      statusCard('API', payload.service === 'ok' ? '正常' : payload.service),
      statusCard('QQ 会话', payload.qzone?.state || '未连接', payload.qzone?.checkedAt || ''),
      statusCard('同步任务', payload.sync?.state || '空闲', payload.sync?.updatedAt || ''),
      statusCard('最近导出', payload.lastExport?.exportedAt || '尚未导出', `${payload.lastExport?.count || 0} 条`),
    );
    if (payload.lastSync) {
      elements.qzoneMessage.textContent = [
        payload.lastSync.dryRun ? '最近一次为验收同步' : '最近一次为发布同步',
        `候选 ${payload.lastSync.counts?.publishedCandidate || 0}`,
        `待确认 ${payload.lastSync.counts?.pendingReview || 0}`,
        `隔离 ${payload.lastSync.counts?.quarantined || 0}`,
      ].join('；');
    }
    return payload;
  }

  async function loadSyncReport() {
    const payload = await api('/manage/sync/report');
    const report = payload.report;
    if (!report) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '尚无验收报告。请先运行“验收同步”。';
      elements.syncReport.replaceChildren(empty);
      return;
    }

    const summary = document.createElement('p');
    summary.className = 'admin-muted';
    summary.textContent = `生成于 ${new Date(report.generatedAt).toLocaleString('zh-CN')}，共 ${report.records?.length || 0} 条记录。`;
    const records = (report.records || []).slice(0, 100).map((record) => {
      const card = document.createElement('article');
      card.className = 'admin-review';
      const header = document.createElement('header');
      const title = document.createElement('strong');
      title.textContent = record.title || record.id;
      const status = document.createElement('span');
      status.textContent = `${record.publishStatus} · ${(record.reviewReasons || []).join(', ') || '无风险标记'}`;
      header.append(title, status);
      const body = document.createElement('p');
      body.textContent = String(record.text || '').slice(0, 220) || '（无文字）';
      const meta = document.createElement('small');
      meta.textContent = `${record.source?.visibility || 'unknown'} · ${record.media?.length || 0} 个媒体项`;
      card.append(header, body, meta);
      const mediaUrl = record.media?.[0]?.sourceUrl || record.media?.[0]?.url || '';
      if (mediaUrl) {
        const mediaLink = document.createElement('a');
        mediaLink.href = mediaUrl;
        mediaLink.target = '_blank';
        mediaLink.rel = 'noopener noreferrer';
        mediaLink.textContent = '打开首个源媒体检查清晰度';
        card.append(mediaLink);
      }
      return card;
    });
    elements.syncReport.replaceChildren(summary, ...records);
  }

  function commentCard(comment) {
    const card = document.createElement('article');
    card.className = 'admin-comment';

    const main = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'admin-comment__meta';
    [
      comment.nickname || '匿名用户',
      comment.path,
      new Date(comment.createdAt).toLocaleString('zh-CN'),
    ].forEach((value) => {
      const item = document.createElement('span');
      item.textContent = value;
      meta.append(item);
    });
    const status = document.createElement('span');
    status.className = 'admin-comment__status';
    status.textContent = comment.status;
    meta.append(status);
    const body = document.createElement('p');
    body.className = 'admin-comment__body';
    body.textContent = comment.content;
    main.append(meta, body);

    const actions = document.createElement('div');
    actions.className = 'admin-comment__actions';
    const choices = [
      ['published', '发布'],
      ['pending', '待审核'],
      ['hidden', '隐藏'],
      ['deleted', '删除'],
    ];
    choices.forEach(([value, label]) => {
      if (comment.status === value && value !== 'deleted') return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/manage/comments/${encodeURIComponent(comment.id)}`, {
            method: value === 'deleted' ? 'DELETE' : 'PATCH',
            body: { path: comment.path, status: value },
          });
          await loadComments();
        } catch (error) {
          toast(error.message);
        } finally {
          button.disabled = false;
        }
      });
      actions.append(button);
    });
    card.append(main, actions);
    return card;
  }

  async function loadComments() {
    const statusFilter = elements.commentStatusFilter.value;
    const payload = await api(`/manage/comments${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''}`);
    if (!payload.items.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '当前筛选条件下没有评论。';
      elements.commentsList.replaceChildren(empty);
      return;
    }
    elements.commentsList.replaceChildren(...payload.items.map(commentCard));
  }

  async function loadRules() {
    const payload = await api('/manage/settings');
    elements.rulesEditor.value = JSON.stringify(payload.rules, null, 2);
  }

  async function saveRules() {
    elements.rulesMessage.textContent = '';
    try {
      const rules = JSON.parse(elements.rulesEditor.value);
      const payload = await api('/manage/settings', { method: 'PUT', body: { rules } });
      elements.rulesEditor.value = JSON.stringify(payload.rules, null, 2);
      elements.rulesMessage.textContent = '规则已保存。';
    } catch (error) {
      elements.rulesMessage.textContent = error.message;
    }
  }

  async function loadOverrides() {
    const payload = await api('/manage/overrides');
    elements.overridesEditor.value = JSON.stringify(payload.overrides, null, 2);
  }

  async function saveOverrides() {
    elements.overridesMessage.textContent = '';
    try {
      const body = JSON.parse(elements.overridesEditor.value);
      const payload = await api('/manage/overrides', {
        method: 'PUT',
        body: { overrides: body.overrides || body },
      });
      elements.overridesEditor.value = JSON.stringify(payload, null, 2);
      elements.overridesMessage.textContent = '覆盖已保存。';
    } catch (error) {
      elements.overridesMessage.textContent = error.message;
    }
  }

  async function startSync(mode, dryRun) {
    elements.qzoneMessage.textContent = '正在启动同步任务…';
    try {
      await api('/manage/sync', {
        method: 'POST',
        body: { mode, dryRun, backfillDays: 31 },
      });
      elements.qzoneMessage.textContent = '同步任务已提交，状态会自动刷新。';
      await loadStatus();
    } catch (error) {
      elements.qzoneMessage.textContent = error.message;
    }
  }

  async function pollQzone() {
    try {
      const payload = await api('/manage/qzone/status');
      elements.qzoneMessage.textContent = payload.auth?.message || payload.status?.message || '';
      if (payload.auth?.qrUrl) {
        elements.qzoneQr.hidden = false;
        elements.qzoneQrImage.src = payload.auth.qrUrl;
      } else if (payload.auth?.state !== 'waiting_for_scan') {
        elements.qzoneQr.hidden = true;
        elements.qzoneQrImage.removeAttribute('src');
      }
      if (payload.auth?.state === 'connected') {
        elements.qzoneMessage.textContent = 'QQ 会话已更新。';
        await loadStatus();
      }
    } catch (error) {
      elements.qzoneMessage.textContent = error.message;
    }
  }

  async function reconnectQzone() {
    elements.qzoneMessage.textContent = '正在启动 QQ 登录任务…';
    try {
      await api('/manage/qzone/reconnect', { method: 'POST' });
      window.setTimeout(pollQzone, 1200);
    } catch (error) {
      elements.qzoneMessage.textContent = error.message;
    }
  }

  async function exportNow() {
    elements.exportMessage.textContent = '正在导出…';
    try {
      const payload = await api('/manage/export', { method: 'POST' });
      elements.exportMessage.textContent = `已导出 ${payload.count} 条数据。`;
      await loadStatus();
    } catch (error) {
      elements.exportMessage.textContent = error.message;
    }
  }

  let toastTimer = 0;
  function toast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 4200);
  }

  async function loadAll() {
    if (!apiBase()) {
      elements.statusGrid.replaceChildren(statusCard('配置', '等待接入', '请先填写 Azure API 地址'));
      return;
    }
    await Promise.all([loadStatus(), loadSyncReport(), loadComments(), loadRules(), loadOverrides()]);
  }

  function bind() {
    elements.login.addEventListener('click', () => login().catch((error) => toast(error.message)));
    elements.logout.addEventListener('click', () => logout().catch((error) => toast(error.message)));
    elements.refresh.addEventListener('click', () => loadAll().catch((error) => toast(error.message)));
    elements.commentsLoad.addEventListener('click', () => loadComments().catch((error) => toast(error.message)));
    elements.rulesSave.addEventListener('click', saveRules);
    elements.overridesSave.addEventListener('click', saveOverrides);
    elements.syncDry.addEventListener('click', () => startSync('backfill', true));
    elements.syncIncremental.addEventListener('click', () => startSync('incremental', false));
    elements.syncBackfill.addEventListener('click', () => startSync('backfill', false));
    elements.qzoneReconnect.addEventListener('click', reconnectQzone);
    elements.export.addEventListener('click', exportNow);
  }

  async function init() {
    cache();
    bind();
    const response = await fetch('/data/site.json');
    const site = await response.json();
    state.config = site.interactions || {};
    try {
      await initMsal();
      await loadAll();
    } catch (error) {
      elements.statusGrid.replaceChildren(statusCard('配置错误', error.message));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => toast(error.message));
  });
})();
