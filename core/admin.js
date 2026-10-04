(() => {
  const SESSION_KEY = 'bifrost:admin:session';
  const state = {
    config: null,
    msal: null,
    account: null,
    session: null,
    entries: [],
    series: [],
    tags: [],
    moments: [],
    selectedEntryId: '',
    publishTimer: 0,
  };

  const elements = {};

  function cache() {
    [
      'refresh',
      'statusGrid',
      'publishNow',
      'publishState',
      'publishMessage',
      'entryPhase',
      'entrySection',
      'entryQuery',
      'entriesLoad',
      'entriesList',
      'entryDetail',
      'seriesLabel',
      'seriesDescription',
      'seriesCreate',
      'seriesList',
      'seriesMessage',
      'tagsLoad',
      'tagsList',
      'tagsMessage',
      'momentsLoad',
      'momentsList',
      'momentsMessage',
      'uploadFile',
      'uploadTitle',
      'uploadPhase',
      'uploadSection',
      'uploadTags',
      'uploadCover',
      'uploadSubmit',
      'uploadMessage',
      'importTasks',
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
    ].forEach((key) => {
      elements[key] = document.querySelector(`[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`);
    });
    elements.account = document.querySelector('[data-admin-account]');
    elements.login = document.querySelector('[data-admin-login]');
    elements.logout = document.querySelector('[data-admin-logout]');
    elements.toast = document.querySelector('[data-admin-toast]');
    elements.gate = document.querySelector('[data-login-gate]');
    elements.gateMsLogin = document.querySelector('[data-gate-ms-login]');
    elements.gateForm = document.querySelector('[data-gate-form]');
    elements.gateUser = document.querySelector('[data-gate-user]');
    elements.gatePass = document.querySelector('[data-gate-pass]');
    elements.gateSubmit = document.querySelector('[data-gate-submit]');
    elements.gateMessage = document.querySelector('[data-gate-message]');
    elements.app = document.querySelector('[data-admin-app]');
  }

  function isLocalDevelopment() {
    return ['localhost', '127.0.0.1'].includes(location.hostname);
  }

  // ---------- 登录会话（账密通道） ----------

  function readSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (!session?.token || new Date(session.expiresAt).getTime() <= Date.now() + 60000) return null;
      return session;
    } catch {
      return null;
    }
  }

  function storeSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    state.session = null;
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
      throw new Error('Microsoft 登录库加载失败，请刷新页面重试。');
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
    state.account = redirect?.account || state.msal.getAllAccounts()[0] || null;
  }

  async function login() {
    if (!state.msal) {
      await initMsal();
    }
    if (!state.msal) {
      if (isLocalDevelopment()) {
        toast('本地开发模式：管理接口将使用 ADMIN_DEV_BYPASS。');
        return;
      }
      throw new Error('Microsoft 登录不可用，请改用站点口令登录。');
    }
    await state.msal.loginRedirect({ scopes: [state.config.admin.apiScope] });
  }

  async function logout() {
    clearSession();
    if (state.msal && state.account) {
      await state.msal.logoutRedirect({ account: state.account });
      return;
    }
    showGate('已退出登录。');
  }

  async function token() {
    if (state.session) {
      if (new Date(state.session.expiresAt).getTime() > Date.now() + 30000) {
        return state.session.token;
      }
      showGate('登录已过期，请重新登录。');
      throw new Error('登录已过期，请重新登录。');
    }
    if (!state.msal || !state.account) {
      if (isLocalDevelopment()) return '';
      throw new Error('请先登录。');
    }
    const result = await state.msal.acquireTokenSilent({
      account: state.account,
      scopes: [state.config.admin.apiScope],
    });
    return result.accessToken;
  }

  function setIdentity() {
    const name = state.session?.name
      || state.account?.name
      || state.account?.username
      || (isLocalDevelopment() && !authReady() ? '本地开发' : '');
    elements.account.textContent = name || '尚未登录';
    elements.login.hidden = Boolean(name);
    elements.logout.hidden = !name;
  }

  function showGate(message = '') {
    clearSession();
    elements.app.hidden = true;
    elements.gate.hidden = false;
    if (message) {
      elements.gateMessage.textContent = message;
    }
    setIdentity();
  }

  function enterApp() {
    elements.gate.hidden = true;
    elements.gateMessage.textContent = '';
    elements.app.hidden = false;
    setIdentity();
    if (apiBase()) {
      loadAll().catch((error) => toast(error.message));
    } else {
      elements.statusGrid.replaceChildren(statusCard('配置', '等待接入', '请先填写 Azure API 地址'));
    }
  }

  /** 账密登录：拿到的会话令牌存 sessionStorage，后续请求走 Authorization: bfs_… */
  async function gateLogin(event) {
    event.preventDefault();
    const username = elements.gateUser.value.trim();
    const password = elements.gatePass.value;
    if (!username || !password) {
      elements.gateMessage.textContent = '请输入账号与口令。';
      return;
    }
    elements.gateSubmit.disabled = true;
    elements.gateMessage.textContent = '正在验证…';
    try {
      const response = await fetch(`${apiBase()}/manage/auth/login`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `登录失败（HTTP ${response.status}）`);
      }
      const session = {
        token: payload.token,
        expiresAt: payload.expiresAt,
        name: payload.name || username,
        method: 'password',
      };
      storeSession(session);
      state.session = session;
      elements.gatePass.value = '';
      enterApp();
    } catch (error) {
      elements.gateMessage.textContent = error.message;
    } finally {
      elements.gateSubmit.disabled = false;
    }
  }

  async function api(route, options = {}) {
    const accessToken = await token();
    const isForm = options.form instanceof FormData;
    const response = await fetch(`${apiBase()}${route}`, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: isForm ? options.form : (options.body ? JSON.stringify(options.body) : undefined),
      credentials: 'omit',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) {
        showGate('登录状态已失效，请重新登录。');
      }
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
    const pendingComments = Number(payload.commentCounts?.pending) || 0;
    elements.statusGrid.replaceChildren(
      statusCard('API', payload.service === 'ok' ? '正常' : payload.service),
      statusCard('QQ 会话', payload.qzone?.state || '未连接', payload.qzone?.checkedAt || ''),
      statusCard('同步任务', payload.sync?.state || '空闲', payload.sync?.updatedAt || ''),
      statusCard('待审核评论', pendingComments ? `${pendingComments} 条` : '无', pendingComments ? '到评论管理处理' : ''),
      statusCard('最近导出', payload.lastExport?.exportedAt || '尚未导出', `${payload.lastExport?.count || 0} 条`),
    );
    renderPublishState(payload.publish);
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

  function renderPublishState(publish) {
    if (!elements.publishState) return;
    const dirty = Boolean(publish?.dirty);
    const last = publish?.lastPublish;
    elements.publishNow.disabled = !dirty;
    elements.publishNow.textContent = dirty ? '发布站点' : '暂无待发布';
    const lines = [];
    lines.push(dirty
      ? `有待发布变更（标记于 ${publish.markedAt ? new Date(publish.markedAt).toLocaleString('zh-CN') : '未知时间'}）。`
      : '数据库与静态产物一致，无需发布。');
    if (last) {
      lines.push(last.status === 'succeeded'
        ? `上次发布成功：${new Date(last.publishedAt).toLocaleString('zh-CN')}${last.commit ? ` · commit ${String(last.commit).slice(0, 7)}` : ''}`
        : `上次发布失败：${last.error || '原因未知'}`);
    }
    elements.publishState.textContent = lines.join(' ');
  }

  // ---------- 发布 ----------

  async function publishNow() {
    elements.publishMessage.textContent = '正在触发发布任务…';
    elements.publishNow.disabled = true;
    try {
      await api('/manage/publish', { method: 'POST' });
      elements.publishMessage.textContent = '发布任务已提交，物化与检索推送在云端进行，几分钟后站点更新。';
      window.setTimeout(() => loadStatus().catch(() => {}), 5000);
    } catch (error) {
      elements.publishMessage.textContent = error.message;
      elements.publishNow.disabled = false;
    }
  }

  // ---------- 条目管理 ----------

  async function loadEntries() {
    const params = new URLSearchParams();
    if (elements.entryPhase.value) params.set('phase', elements.entryPhase.value);
    if (elements.entrySection.value.trim()) params.set('section', elements.entrySection.value.trim());
    if (elements.entryQuery.value.trim()) params.set('q', elements.entryQuery.value.trim());
    const query = params.toString();
    const payload = await api(`/manage/entries${query ? `?${query}` : ''}`);
    state.entries = payload.items || [];
    state.selectedEntryId = '';
    renderEntries();
  }

  function coverLabel(entry) {
    if (entry.coverSource === 'manual') return '手动封面';
    if (entry.coverSource === 'auto-first') return '首图封面';
    if (entry.coverSource === 'text') return '文字封面';
    return '无封面';
  }

  function renderEntries() {
    if (!state.entries.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '当前筛选条件下没有条目。';
      elements.entriesList.replaceChildren(empty);
      return;
    }
    const cards = state.entries.map((entry) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'admin-row admin-row--clickable';
      if (entry.id === state.selectedEntryId) row.classList.add('admin-row--active');
      const title = document.createElement('strong');
      title.textContent = entry.title || entry.slug || entry.id;
      const meta = document.createElement('span');
      meta.className = 'admin-muted';
      meta.textContent = [
        entry.phase,
        entry.section,
        entry.status,
        coverLabel(entry),
        entry.seriesId ? `系列 ${entry.seriesId.replace('series:', '')}` : '',
      ].filter(Boolean).join(' · ');
      row.append(title, meta);
      row.addEventListener('click', () => selectEntry(entry.id));
      return row;
    });
    elements.entriesList.replaceChildren(...cards);
  }

  async function selectEntry(entryId) {
    state.selectedEntryId = entryId;
    renderEntries();
    elements.entryDetail.replaceChildren();
    const placeholder = document.createElement('p');
    placeholder.className = 'admin-muted';
    placeholder.textContent = '正在加载条目详情…';
    elements.entryDetail.append(placeholder);
    try {
      const detail = await api(`/manage/entries/${encodeURIComponent(entryId)}`);
      renderEntryDetail(detail);
    } catch (error) {
      placeholder.textContent = error.message;
    }
  }

  function renderEntryDetail(detail) {
    const wrap = document.createElement('div');
    wrap.className = 'admin-stack';

    const title = document.createElement('h3');
    title.textContent = detail.entry.title || detail.entry.slug;
    const meta = document.createElement('p');
    meta.className = 'admin-muted';
    meta.textContent = `${detail.entry.path || detail.entry.slug} · ${detail.entry.wordCount} 字 · ${detail.entry.status}`;
    wrap.append(title, meta);

    // 封面候选
    const coverHead = document.createElement('p');
    coverHead.className = 'admin-eyebrow';
    coverHead.textContent = `封面 · ${coverLabel(detail.entry)} · 点击候选图切换`;
    const grid = document.createElement('div');
    grid.className = 'admin-cover-grid';
    const candidates = detail.coverCandidates || [];
    if (candidates.length) {
      candidates.forEach((candidate) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'admin-cover';
        item.title = candidate.sourceName || candidate.assetId;
        if (candidate.isCurrent) item.classList.add('admin-cover--current');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = candidate.sourceName || '封面候选';
        if (candidate.blobUrl) img.src = candidate.blobUrl;
        item.append(img);
        item.addEventListener('click', async () => {
          item.disabled = true;
          try {
            await api(`/manage/entries/${encodeURIComponent(detail.entry.id)}`, {
              method: 'PATCH',
              body: { cover: { assetId: candidate.assetId } },
            });
            toast('封面已更新，发布后生效。');
            await selectEntry(detail.entry.id);
            await loadEntries();
          } catch (error) {
            toast(error.message);
            item.disabled = false;
          }
        });
        grid.append(item);
      });
    } else {
      const none = document.createElement('span');
      none.className = 'admin-muted';
      none.textContent = '正文没有图片，使用文字封面。';
      grid.append(none);
    }
    if (detail.entry.cover?.assetId) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'admin-button';
      clear.textContent = '改用文字封面';
      clear.addEventListener('click', async () => {
        clear.disabled = true;
        try {
          await api(`/manage/entries/${encodeURIComponent(detail.entry.id)}`, {
            method: 'PATCH',
            body: { cover: null },
          });
          toast('已切换为文字封面，发布后生效。');
          await selectEntry(detail.entry.id);
          await loadEntries();
        } catch (error) {
          toast(error.message);
          clear.disabled = false;
        }
      });
      grid.append(clear);
    }
    wrap.append(coverHead, grid);

    // 系列归属
    const seriesHead = document.createElement('p');
    seriesHead.className = 'admin-eyebrow';
    seriesHead.textContent = '系列归属';
    const seriesRow = document.createElement('div');
    seriesRow.className = 'admin-actions';
    const seriesSelect = document.createElement('select');
    seriesSelect.className = 'admin-input';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '不属于任何系列';
    seriesSelect.append(noneOption);
    state.series.forEach((series) => {
      const option = document.createElement('option');
      option.value = series.id;
      option.textContent = series.label;
      if (series.id === detail.entry.seriesId) option.selected = true;
      seriesSelect.append(option);
    });
    const seriesSave = document.createElement('button');
    seriesSave.type = 'button';
    seriesSave.className = 'admin-button';
    seriesSave.textContent = '保存归属';
    seriesSave.addEventListener('click', async () => {
      seriesSave.disabled = true;
      try {
        await api(`/manage/entries/${encodeURIComponent(detail.entry.id)}`, {
          method: 'PATCH',
          body: { seriesId: seriesSelect.value },
        });
        toast('系列归属已更新，发布后生效。');
        await Promise.all([loadSeries(), loadEntries()]);
        await selectEntry(detail.entry.id);
      } catch (error) {
        toast(error.message);
        seriesSave.disabled = false;
      }
    });
    seriesRow.append(seriesSelect, seriesSave);
    wrap.append(seriesHead, seriesRow);

    // 标签编辑
    const tagsHead = document.createElement('p');
    tagsHead.className = 'admin-eyebrow';
    tagsHead.textContent = '标签（回车添加，点 × 移除）';
    const tagBox = document.createElement('div');
    tagBox.className = 'admin-tags';
    const current = [...detail.entry.tags];
    const tagInput = document.createElement('input');
    tagInput.className = 'admin-input';
    tagInput.placeholder = '输入标签后回车';
    const commitTags = async (tags) => {
      try {
        await api(`/manage/entries/${encodeURIComponent(detail.entry.id)}`, {
          method: 'PATCH',
          body: { tags },
        });
        toast('标签已更新，发布后生效。');
        await Promise.all([loadTags(), loadEntries()]);
        await selectEntry(detail.entry.id);
      } catch (error) {
        toast(error.message);
      }
    };
    const renderChips = () => {
      [...tagBox.querySelectorAll('.admin-chip')].forEach((chip) => chip.remove());
      current.forEach((tag, index) => {
        const chip = document.createElement('span');
        chip.className = 'admin-chip';
        chip.textContent = tag;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `移除标签 ${tag}`);
        remove.addEventListener('click', () => {
          current.splice(index, 1);
          void commitTags(current);
        });
        chip.append(remove);
        tagBox.append(chip);
      });
    };
    tagInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = tagInput.value.trim();
      if (!value || current.includes(value)) {
        tagInput.value = '';
        return;
      }
      current.push(value);
      tagInput.value = '';
      void commitTags(current);
    });
    tagBox.append(tagInput);
    renderChips();
    wrap.append(tagsHead, tagBox);

    elements.entryDetail.replaceChildren(wrap);
  }

  // ---------- 系列管理 ----------

  async function loadSeries() {
    const payload = await api('/manage/series');
    state.series = payload.items || [];
    renderSeries();
  }

  function renderSeries() {
    if (!state.series.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '还没有系列。';
      elements.seriesList.replaceChildren(empty);
      return;
    }
    const cards = state.series.map((series) => {
      const card = document.createElement('article');
      card.className = 'admin-stack';

      const head = document.createElement('div');
      head.className = 'admin-row';
      const label = document.createElement('strong');
      label.textContent = series.label;
      const id = document.createElement('span');
      id.className = 'admin-muted';
      id.textContent = series.id;
      head.append(label, id);

      const info = document.createElement('div');
      info.className = 'admin-actions';
      const labelInput = document.createElement('input');
      labelInput.className = 'admin-input';
      labelInput.value = series.label;
      labelInput.setAttribute('aria-label', '系列名称');
      const descInput = document.createElement('input');
      descInput.className = 'admin-input';
      descInput.value = series.description || '';
      descInput.placeholder = '系列简介';
      descInput.setAttribute('aria-label', '系列简介');
      const saveInfo = document.createElement('button');
      saveInfo.type = 'button';
      saveInfo.className = 'admin-button';
      saveInfo.textContent = '保存基本信息';
      saveInfo.addEventListener('click', async () => {
        saveInfo.disabled = true;
        try {
          await api(`/manage/series/${encodeURIComponent(series.id)}`, {
            method: 'PATCH',
            body: { label: labelInput.value, description: descInput.value },
          });
          elements.seriesMessage.textContent = '系列信息已保存，发布后生效。';
          await loadSeries();
        } catch (error) {
          elements.seriesMessage.textContent = error.message;
          saveInfo.disabled = false;
        }
      });
      info.append(labelInput, descInput, saveInfo);

      const members = document.createElement('div');
      members.className = 'admin-rows';
      if (!series.memberIds.length) {
        const none = document.createElement('span');
        none.className = 'admin-muted';
        none.textContent = '暂无成员，可在“条目管理”里把条目挂到该系列。';
        members.append(none);
      }
      series.memberIds.forEach((member, index) => {
        const row = document.createElement('div');
        row.className = 'admin-row';
        const name = document.createElement('span');
        name.textContent = `${index + 1}. ${member.title || member.entryId}`;
        const actions = document.createElement('div');
        actions.className = 'admin-actions';
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'admin-button';
        up.textContent = '上移';
        up.disabled = index === 0;
        up.addEventListener('click', () => reorderSeries(series, index, index - 1));
        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'admin-button';
        down.textContent = '下移';
        down.disabled = index === series.memberIds.length - 1;
        down.addEventListener('click', () => reorderSeries(series, index, index + 1));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'admin-button';
        remove.textContent = '移出';
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await api(`/manage/entries/${encodeURIComponent(member.entryId)}`, {
              method: 'PATCH',
              body: { seriesId: '' },
            });
            elements.seriesMessage.textContent = '成员已移出，发布后生效。';
            await Promise.all([loadSeries(), loadEntries()]);
          } catch (error) {
            elements.seriesMessage.textContent = error.message;
            remove.disabled = false;
          }
        });
        actions.append(up, down, remove);
        row.append(name, actions);
        members.append(row);
      });

      const danger = document.createElement('div');
      danger.className = 'admin-actions';
      const removeSeries = document.createElement('button');
      removeSeries.type = 'button';
      removeSeries.className = 'admin-button';
      removeSeries.textContent = '删除系列';
      removeSeries.addEventListener('click', async () => {
        removeSeries.disabled = true;
        try {
          await api(`/manage/series/${encodeURIComponent(series.id)}`, { method: 'DELETE' });
          elements.seriesMessage.textContent = '系列已删除，发布后生效。';
          await Promise.all([loadSeries(), loadEntries()]);
        } catch (error) {
          elements.seriesMessage.textContent = error.message;
          removeSeries.disabled = false;
        }
      });
      danger.append(removeSeries);

      card.append(head, info, members, danger);
      return card;
    });
    elements.seriesList.replaceChildren(...cards);
  }

  async function reorderSeries(series, from, to) {
    if (to < 0 || to >= series.memberIds.length) return;
    const memberIds = series.memberIds.map((member) => member.entryId);
    const [moved] = memberIds.splice(from, 1);
    memberIds.splice(to, 0, moved);
    try {
      await api(`/manage/series/${encodeURIComponent(series.id)}`, {
        method: 'PATCH',
        body: { memberIds },
      });
      elements.seriesMessage.textContent = '顺序已保存，发布后生效。';
      await Promise.all([loadSeries(), loadEntries()]);
    } catch (error) {
      elements.seriesMessage.textContent = error.message;
    }
  }

  async function createSeries() {
    elements.seriesMessage.textContent = '';
    try {
      await api('/manage/series', {
        method: 'POST',
        body: {
          label: elements.seriesLabel.value,
          description: elements.seriesDescription.value,
        },
      });
      elements.seriesLabel.value = '';
      elements.seriesDescription.value = '';
      elements.seriesMessage.textContent = '系列已创建，把条目挂进去后发布即可生效。';
      await loadSeries();
    } catch (error) {
      elements.seriesMessage.textContent = error.message;
    }
  }

  // ---------- 标签管理 ----------

  async function loadTags() {
    const payload = await api('/manage/tags');
    state.tags = payload.items || [];
    renderTags();
  }

  function renderTags() {
    if (!state.tags.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '没有标签。';
      elements.tagsList.replaceChildren(empty);
      return;
    }
    const rows = state.tags.map((tag) => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const label = document.createElement('span');
      label.textContent = tag.count ? `${tag.label}（${tag.count}）` : `${tag.label}（未使用）`;
      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      const input = document.createElement('input');
      input.className = 'admin-input';
      input.placeholder = '改为 / 合并到';
      input.setAttribute('aria-label', `${tag.label} 的目标标签`);
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'admin-button';
      apply.textContent = '确认';
      apply.addEventListener('click', async () => {
        if (!input.value.trim()) {
          elements.tagsMessage.textContent = '请先填入目标标签名。';
          return;
        }
        apply.disabled = true;
        try {
          const result = await api('/manage/tags/rename', {
            method: 'POST',
            body: { from: tag.label, to: input.value },
          });
          elements.tagsMessage.textContent = `已转移 ${result.updated} 篇条目到「${result.to}」，发布后生效。`;
          await Promise.all([loadTags(), loadEntries()]);
        } catch (error) {
          elements.tagsMessage.textContent = error.message;
          apply.disabled = false;
        }
      });
      actions.append(input, apply);
      row.append(label, actions);
      return row;
    });
    elements.tagsList.replaceChildren(...rows);
  }

  // ---------- 动态管理 ----------

  async function loadMoments() {
    const payload = await api('/manage/moments');
    state.moments = payload.items || [];
    renderMoments();
  }

  function renderMoments() {
    if (!state.moments.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '还没有动态。';
      elements.momentsList.replaceChildren(empty);
      return;
    }
    const rows = state.moments.map((moment) => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const label = document.createElement('span');
      label.className = 'admin-moment-text';
      label.textContent = `${String(moment.publishedAt || '').slice(0, 10)} ${moment.text || moment.summary || '（无文字）'}`;
      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      [
        ['pinned', '置顶'],
        ['featured', '精选'],
      ].forEach(([key, text]) => {
        const check = document.createElement('label');
        check.className = 'admin-check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = Boolean(moment[key]);
        box.addEventListener('change', async () => {
          box.disabled = true;
          try {
            await api(`/manage/moments/${encodeURIComponent(moment.id)}`, {
              method: 'PATCH',
              body: { month: moment.month, [key]: box.checked },
            });
            elements.momentsMessage.textContent = `已${box.checked ? '开启' : '关闭'}${text}，发布后生效。`;
            moment[key] = box.checked;
          } catch (error) {
            elements.momentsMessage.textContent = error.message;
            box.checked = !box.checked;
          }
          box.disabled = false;
        });
        check.append(box, document.createTextNode(text));
        actions.append(check);
      });
      row.append(label, actions);
      return row;
    });
    elements.momentsList.replaceChildren(...rows);
  }

  // ---------- 上传导入 ----------

  const UPLOAD_SECTIONS = {
    fantasy: ['review', 'activity', 'essay', 'archive'],
    logic: ['docs', 'notes', 'algo'],
  };

  const IMPORT_STATUS = {
    queued: '排队中',
    running: '转换中',
    succeeded: '已入库',
    failed: '失败',
  };

  function refreshUploadSections() {
    const sections = UPLOAD_SECTIONS[elements.uploadPhase.value] || UPLOAD_SECTIONS.fantasy;
    elements.uploadSection.replaceChildren(...sections.map((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      return option;
    }));
  }

  async function submitUpload() {
    const file = elements.uploadFile.files?.[0];
    if (!file) {
      elements.uploadMessage.textContent = '请先选择要上传的文件。';
      return;
    }
    const form = new FormData();
    form.append('file', file);
    if (elements.uploadTitle.value.trim()) form.append('title', elements.uploadTitle.value.trim());
    form.append('phase', elements.uploadPhase.value);
    form.append('section', elements.uploadSection.value);
    if (elements.uploadTags.value.trim()) form.append('tags', elements.uploadTags.value.trim());
    if (elements.uploadCover.value.trim()) form.append('coverIndex', elements.uploadCover.value.trim());

    elements.uploadSubmit.disabled = true;
    elements.uploadMessage.textContent = '正在上传原件…';
    try {
      const payload = await api('/manage/import', { method: 'POST', form });
      elements.uploadMessage.textContent = `导入任务已提交（${payload.task.fileName}），转换在云端进行，完成后回到“发布”触发上线。`;
      elements.uploadFile.value = '';
      elements.uploadTitle.value = '';
      elements.uploadTags.value = '';
      elements.uploadCover.value = '';
      await loadImportTasks();
    } catch (error) {
      elements.uploadMessage.textContent = error.message;
    } finally {
      elements.uploadSubmit.disabled = false;
    }
  }

  function renderImportTask(task) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const label = document.createElement('span');
    const detail = [
      IMPORT_STATUS[task.status] || task.status,
      task.fileName,
      task.title || '',
      task.status === 'succeeded' && task.entryId ? `条目 ${task.entryId}` : '',
      task.counts ? `${task.counts.wordCount || 0} 字 / ${task.counts.mediaCount || 0} 图` : '',
      task.error ? `原因：${task.error}` : '',
    ].filter(Boolean).join(' · ');
    label.textContent = detail;
    label.className = 'admin-moment-text';
    const time = document.createElement('small');
    time.className = 'admin-muted';
    time.textContent = new Date(task.updatedAt || task.requestedAt).toLocaleString('zh-CN');
    row.append(label, time);
    return row;
  }

  function renderImportTasks() {
    let tasks = state.importTasks || [];
    if (!tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = '还没有导入任务。';
      elements.importTasks.replaceChildren(empty);
      return;
    }
    elements.importTasks.replaceChildren(...tasks.map(renderImportTask));
    const active = tasks.some((task) => task.status === 'queued' || task.status === 'running');
    window.clearTimeout(state.publishTimer);
    if (active) {
      state.publishTimer = window.setTimeout(() => loadImportTasks().catch(() => {}), 10000);
    }
  }

  async function loadImportTasks() {
    const payload = await api('/manage/import');
    state.importTasks = payload.items || [];
    renderImportTasks();
  }

  // ---------- 互动与同步（原有功能） ----------

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
      comment.entryId,
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
            body: { entryId: comment.entryId, status: value },
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
    await Promise.all([
      loadStatus(),
      loadSyncReport(),
      loadComments(),
      loadRules(),
      loadOverrides(),
      loadSeries(),
      loadImportTasks(),
    ]);
  }

  function bind() {
    elements.login.addEventListener('click', () => login().catch((error) => toast(error.message)));
    elements.logout.addEventListener('click', () => logout().catch((error) => toast(error.message)));
    elements.gateMsLogin.addEventListener('click', () => login().catch((error) => toast(error.message)));
    elements.gateForm.addEventListener('submit', gateLogin);
    elements.refresh.addEventListener('click', () => loadAll().catch((error) => toast(error.message)));
    elements.publishNow.addEventListener('click', publishNow);
    elements.entriesLoad.addEventListener('click', () => loadEntries().catch((error) => toast(error.message)));
    elements.seriesCreate.addEventListener('click', () => createSeries().catch((error) => toast(error.message)));
    elements.tagsLoad.addEventListener('click', () => loadTags().catch((error) => toast(error.message)));
    elements.momentsLoad.addEventListener('click', () => loadMoments().catch((error) => toast(error.message)));
    elements.uploadPhase.addEventListener('change', refreshUploadSections);
    elements.uploadSubmit.addEventListener('click', submitUpload);
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
    refreshUploadSections();
    try {
      const response = await fetch('/data/site.json');
      const site = await response.json();
      state.config = site.interactions || {};
    } catch (error) {
      showGate(`站点配置加载失败：${error.message}`);
      return;
    }
    try {
      await initMsal();
    } catch {
      // Microsoft 通道不可用时仍可走账密登录，错误在点击按钮时由 login() 重新抛出。
    }
    state.session = readSession();
    const devMode = isLocalDevelopment() && !authReady();
    if (state.session || state.account || devMode) {
      enterApp();
    } else {
      showGate();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => toast(error.message));
  });
})();
