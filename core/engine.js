// BIFROST 引擎（重写版）
// 数据来源：/data/site-index.json（由 tools/materialize-site.mjs 从数据库物化）。
// 阅读走静态产物；搜索在当前阶段先基于索引在客户端完成，后续换成检索服务。
(() => {
  const INDEX_URL = '/data/site-index.json';
  const SITE_CONFIG_URL = '/data/site.json';
  const STORAGE = {
    phase: 'bifrost:phase',
    section: 'bifrost:section',
    entry: 'bifrost:entry',
  };

  // 视觉与身份仍由前端定义；分类法与内容列表来自索引
  const PHASE_STYLE = {
    logic: {
      title: 'LOGIC ARCHIVE',
      subtitle: '把复杂的事拆开，慢慢记下来。',
      pill: 'LOGIC · STABLE',
      footer: 'Logic 位面',
      themeColor: '#0a0f14',
      bridgeColor: 'rgba(121, 201, 192, 0.24)',
      boot: ['点亮 Logic 的档案灯…', '整理目录与近作…', '准备阅读界面…'],
      empty: '技术整理与项目记录还在收拢。',
    },
    fantasy: {
      title: '幻想回廊',
      subtitle: '把读过的、想过的，慢慢留在这里。',
      pill: 'FANTASY · REVERIE',
      footer: 'Fantasy 位面',
      themeColor: '#f6f0e7',
      bridgeColor: 'rgba(185, 122, 131, 0.28)',
      boot: ['点亮回廊灯火…', '拂去书架浮尘…', '准备阅读界面…'],
      empty: '书架已经掸过灰，新的内容会陆续到来。',
    },
  };

  const SEARCH_LIMIT = 30;

  const state = {
    index: null,
    siteConfig: {},
    phase: 'fantasy',
    view: 'dashboard',
    section: '',
    entryId: '',
    query: '',
    facets: { phase: '', section: '', tags: new Set() },
    results: [],
    activeIndex: 0,
  };

  const el = {};

  window.addEventListener('DOMContentLoaded', init);
  window.addEventListener('popstate', onPopState);

  async function init() {
    cacheElements();
    bindEvents();
    state.phase = resolvePhase();
    applyPhase(state.phase);
    initAmbience();

    try {
      const response = await fetch(INDEX_URL);
      if (!response.ok) throw new Error(String(response.status));
      state.index = await response.json();
    } catch {
      state.index = null;
    }
    try {
      const response = await fetch(SITE_CONFIG_URL);
      state.siteConfig = response.ok ? await response.json() : {};
    } catch {
      state.siteConfig = {};
    }

    if (!state.index) {
      el.view.innerHTML = renderMessage('内容索引暂时没有读到', '稍后刷新页面，或检查 /data/site-index.json 是否已生成。');
      return;
    }

    renderSidebar();
    updateStatusNote();
    window.setInterval(updateFooterClock, 1000);
    updateFooterClock();

    await restoreRoute();
  }

  function cacheElements() {
    el.html = document.documentElement;
    el.shell = document.querySelector('.shell');
    el.navToggle = document.querySelector('[data-nav-toggle]');
    el.siteTitle = document.querySelector('[data-site-title]');
    el.siteSubtitle = document.querySelector('[data-site-subtitle]');
    el.phasePill = document.querySelector('[data-phase-pill]');
    el.tree = document.querySelector('[data-tree]');
    el.view = document.querySelector('[data-view]');
    el.main = document.querySelector('.main');
    el.themeColor = document.querySelector('meta[name="theme-color"]');
    el.statusText = document.querySelector('[data-status-text]');
    el.statusTitle = document.querySelector('[data-status-title]');
    el.footerStatus = document.querySelector('[data-footer-status]');
    el.footerClock = document.querySelector('[data-footer-clock]');
    el.soundToggle = document.querySelector('[data-sound-toggle]');
    el.soundLabel = document.querySelector('[data-sound-label]');

    el.searchPanel = document.querySelector('[data-search-panel]');
    el.searchTrigger = document.querySelector('[data-search-trigger]');
    el.searchInput = document.querySelector('[data-search-input]');
    el.searchFacets = document.querySelector('[data-search-facets]');
    el.searchResults = document.querySelector('[data-search-results]');

    el.phasePanel = document.querySelector('[data-phase-panel]');
    el.phaseTrigger = document.querySelector('[data-phase-trigger]');
    el.phaseResults = document.querySelector('[data-phase-results]');

    el.bootOverlay = document.querySelector('[data-boot-overlay]');
    el.bootLog = document.querySelector('[data-boot-log]');
    el.bootBar = document.querySelector('[data-boot-bar]');
  }

  function bindEvents() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    el.main.addEventListener('scroll', onScroll, { passive: true });
    if (el.navToggle) el.navToggle.addEventListener('click', () => setNavOpen(!isNavOpen()));
    if (el.soundToggle) el.soundToggle.addEventListener('click', onSoundToggle);
    if (el.searchTrigger) el.searchTrigger.addEventListener('click', () => openSearch());
    if (el.phaseTrigger) el.phaseTrigger.addEventListener('click', () => openPhasePanel());
    if (el.searchInput) {
      el.searchInput.addEventListener('input', () => {
        state.query = el.searchInput.value;
        scheduleSearch();
      });
      el.searchInput.addEventListener('keydown', onPanelKeyDown);
    }
    el.searchPanel.addEventListener('click', (event) => {
      if (event.target === el.searchPanel) closePanels();
    });
    el.searchResults.addEventListener('click', onPanelResultClick);
    el.searchFacets.addEventListener('click', onFacetClick);
    el.phasePanel.addEventListener('click', (event) => {
      if (event.target === el.phasePanel) closePanels();
    });
    el.phaseResults.addEventListener('click', onPanelResultClick);
    document.addEventListener('pointerdown', onFirstInteraction, { once: true });
  }

  // ---------- 阶段 ----------

  function phases() {
    return state.index?.phases || [];
  }

  function phaseConfig(id) {
    return phases().find((phase) => phase.id === id) || phases()[0] || { id: 'fantasy', label: 'Fantasy', sections: [] };
  }

  function resolvePhase() {
    const url = new URL(window.location.href);
    const urlPhase = url.searchParams.get('phase');
    if (phases().some((phase) => phase.id === urlPhase)) return urlPhase;
    const stored = localStorage.getItem(STORAGE.phase);
    if (phases().some((phase) => phase.id === stored)) return stored;
    if (phases().length) return phases()[0].id;
    return 'fantasy';
  }

  function applyPhase(phase) {
    state.phase = phase;
    const style = PHASE_STYLE[phase] || PHASE_STYLE.fantasy;
    el.html.dataset.phase = phase;
    document.body.classList.toggle('phase-fantasy', phase === 'fantasy');
    if (el.siteTitle) el.siteTitle.textContent = style.title;
    if (el.siteSubtitle) el.siteSubtitle.textContent = style.subtitle;
    if (el.phasePill) el.phasePill.textContent = style.pill;
    if (el.footerStatus) el.footerStatus.textContent = style.footer;
    if (el.themeColor) el.themeColor.setAttribute('content', style.themeColor);
    if (window.BifrostAmbience) window.BifrostAmbience.setPhase(phase);
    if (window.BifrostInteractions) window.BifrostInteractions.setPhase(phase);
    localStorage.setItem(STORAGE.phase, phase);
  }

  function switchPhase(phase) {
    if (phase === state.phase) return;
    const style = PHASE_STYLE[phase] || PHASE_STYLE.fantasy;
    const bridge = playBridge(style.bridgeColor);
    const commit = () => {
      applyPhase(phase);
      localStorage.removeItem(STORAGE.section);
      localStorage.removeItem(STORAGE.entry);
      state.section = '';
      state.entryId = '';
      renderSidebar();
      renderDashboard();
      syncUrl({ replace: false });
    };
    if (bridge) window.setTimeout(commit, 360);
    else commit();
  }

  function playBridge(color) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const node = document.createElement('div');
    node.className = 'bridge-overlay';
    node.style.setProperty('--bridge-color', color);
    document.body.appendChild(node);
    window.setTimeout(() => node.remove(), 1080);
    return node;
  }

  // ---------- 侧栏 ----------

  function renderSidebar() {
    const config = phaseConfig(state.phase);
    const sections = config.sections || [];
    const activeSection = state.view === 'section' ? state.section : '';
    const counts = sectionCounts();
    el.tree.innerHTML = `
      <a class="tree__link tree__link--overview${state.view === 'dashboard' ? ' is-active' : ''}" data-action="dashboard" href="?phase=${state.phase}">
        <span>${escapeHtml(config.label)} 总览</span>
      </a>
      <div class="tree__sections">
        ${sections.map((section) => `
          <a class="tree__link${section.id === activeSection ? ' is-active' : ''}" data-action="section" data-section="${escapeHtml(section.id)}" href="?phase=${state.phase}&section=${encodeURIComponent(section.id)}">
            <span>${escapeHtml(section.label)}</span>
            ${counts.get(section.id) ? `<span class="tree__count">${counts.get(section.id)}</span>` : ''}
          </a>
        `).join('')}
      </div>
    `;
    updateTreeActive();
  }

  function sectionCounts() {
    const map = new Map();
    for (const entry of (state.index?.entries || [])) {
      if (entry.phase !== state.phase) continue;
      map.set(entry.section, (map.get(entry.section) || 0) + 1);
    }
    if (state.phase === 'fantasy') {
      const moments = (state.index?.moments || []).filter((moment) => moment.section === 'daily').length;
      if (moments) map.set('daily', moments);
    }
    return map;
  }

  function updateTreeActive() {
    el.tree.querySelectorAll('.tree__link').forEach((link) => {
      const isSection = link.dataset.section === state.section && state.view === 'section';
      const isOverview = link.dataset.action === 'dashboard' && state.view === 'dashboard';
      link.classList.toggle('is-active', isSection || isOverview);
    });
  }

  // ---------- 视图 ----------

  function phaseEntries(phase = state.phase) {
    return (state.index?.entries || []).filter((entry) => entry.phase === phase);
  }

  function phaseMoments() {
    return (state.index?.moments || []).filter((moment) => moment.phase === state.phase);
  }

  function renderDashboard() {
    state.view = 'dashboard';
    state.section = '';
    state.entryId = '';
    const config = phaseConfig(state.phase);
    const style = PHASE_STYLE[state.phase] || PHASE_STYLE.fantasy;
    const entries = phaseEntries();
    const recent = entries.slice(0, 5);
    const moments = phaseMoments().slice(0, 3);
    const sections = config.sections || [];

    el.view.innerHTML = `
      <section class="article-surface view__hero">
        <p class="hero__eyebrow">${escapeHtml(config.label)} · 总览</p>
        <h1 class="hero__title">${escapeHtml(style.subtitle)}</h1>
        <p class="hero__text">${entries.length + phaseMoments().length ? `共 ${entries.length} 篇文章 · ${phaseMoments().length} 条动态` : escapeHtml(style.empty)}</p>
      </section>

      <section class="section-cards">
        ${sections.map((section) => `
          <a class="section-card" data-action="section" data-section="${escapeHtml(section.id)}" href="?phase=${state.phase}&section=${encodeURIComponent(section.id)}">
            <span class="section-card__label">${escapeHtml(section.label)}</span>
            <span class="section-card__meta">${sectionCounts().get(section.id) || 0} 条${section.layout === 'timeline' ? ' · 时间流' : ''}</span>
          </a>
        `).join('')}
      </section>

      ${recent.length ? `
        <section class="article-surface">
          <p class="hero__eyebrow">最近更新</p>
          <div class="entry-list entry-list--compact">
            ${recent.map((entry) => renderCompactRow(entry)).join('')}
          </div>
        </section>` : ''}

      ${moments.length ? `
        <section class="article-surface">
          <p class="hero__eyebrow">日常</p>
          <div class="moment-feed moment-feed--preview">
            ${moments.map((moment) => renderMoment(moment)).join('')}
          </div>
        </section>` : ''}
    `;
    updateTreeActive();
    updateDocumentMeta(config.label, style.subtitle);
    window.BifrostMediaPreview?.mount(el.view);
  }

  function renderSection(sectionId) {
    const config = phaseConfig(state.phase);
    const section = (config.sections || []).find((item) => item.id === sectionId);
    if (!section) {
      renderDashboard();
      return;
    }
    state.view = 'section';
    state.section = sectionId;
    state.entryId = '';

    if (section.layout === 'timeline' || sectionId === 'daily') {
      const moments = phaseMoments().filter((moment) => moment.section === sectionId);
      const byMonth = new Map();
      for (const moment of moments) {
        const list = byMonth.get(moment.month) || [];
        list.push(moment);
        byMonth.set(moment.month, list);
      }
      el.view.innerHTML = `
        <section class="article-surface view__hero">
          <p class="hero__eyebrow">${escapeHtml(config.label)} · ${escapeHtml(section.label)}</p>
          <h1 class="hero__title">${escapeHtml(section.label)}</h1>
          <p class="hero__text">共 ${moments.length} 条，按月份倒序。</p>
        </section>
        <div class="moment-feed">
          ${[...byMonth.entries()].map(([month, list]) => `
            <section class="moment-month">
              <h2 class="moment-month__label">${escapeHtml(month)}</h2>
              ${list.map((moment) => renderMoment(moment)).join('')}
            </section>
          `).join('')}
        </div>
      `;
    } else {
      const entries = phaseEntries().filter((entry) => entry.section === sectionId);
      el.view.innerHTML = `
        <section class="article-surface view__hero">
          <p class="hero__eyebrow">${escapeHtml(config.label)} · ${escapeHtml(section.label)}</p>
          <h1 class="hero__title">${escapeHtml(section.label)}</h1>
          <p class="hero__text">共 ${entries.length} 篇。</p>
        </section>
        ${entries.length ? renderMagazine(entries) : renderMessage('这里还没有内容', '等第一份内容准备好，它会出现在这里。')}
      `;
    }
    updateTreeActive();
    updateDocumentMeta(section.label, `${config.label} · ${section.label}`);
    el.main.scrollTo({ top: 0 });
    window.BifrostMediaPreview?.mount(el.view);
  }

  function renderMagazine(entries) {
    const [lead, ...rest] = entries;
    return `
      <section class="magazine">
        ${renderLeadCard(lead)}
        <div class="card-grid">
          ${rest.map((entry) => renderCard(entry)).join('')}
        </div>
      </section>
    `;
  }

  function renderLeadCard(entry) {
    return `
      <a class="lead-card" data-action="entry" data-entry="${escapeHtml(entry.entryId)}" href="${escapeHtml(entry.path)}">
        ${renderCover(entry, 'lead-card__cover')}
        <span class="lead-card__body">
          <span class="lead-card__date">${escapeHtml(formatDate(entry.date))}</span>
          <span class="lead-card__title">${escapeHtml(entry.title)}</span>
          ${entry.summary ? `<span class="lead-card__summary">${escapeHtml(entry.summary)}</span>` : ''}
          ${renderTags(entry, 3)}
        </span>
      </a>
    `;
  }

  function renderCard(entry) {
    return `
      <a class="entry-card" data-action="entry" data-entry="${escapeHtml(entry.entryId)}" href="${escapeHtml(entry.path)}">
        ${renderCover(entry, 'entry-card__cover')}
        <span class="entry-card__body">
          <span class="entry-card__date">${escapeHtml(formatDate(entry.date))}${entry.wordCount ? ` · ${entry.wordCount} 字` : ''}</span>
          <span class="entry-card__title">${escapeHtml(entry.title)}</span>
          ${entry.summary ? `<span class="entry-card__summary">${escapeHtml(entry.summary)}</span>` : ''}
          ${renderTags(entry, 2)}
        </span>
      </a>
    `;
  }

  function renderCover(entry, className) {
    if (entry.coverUrl) {
      return `<span class="${className}"><img src="${escapeHtml(entry.coverUrl)}" alt="" loading="lazy"></span>`;
    }
    // 文字封面：无图时由标题排版而成
    return `<span class="${className} ${className}--text" aria-hidden="true"><span>${escapeHtml(textCover(entry.title))}</span></span>`;
  }

  function textCover(title) {
    const text = String(title || '').trim();
    return text.length > 18 ? `${text.slice(0, 18)}` : text;
  }

  function renderTags(entry, max) {
    const tags = (entry.tags || []).slice(0, max);
    if (!tags.length) return '';
    return `<span class="entry-card__tags">${tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</span>`;
  }

  function renderCompactRow(entry) {
    return `
      <a class="recent-item" data-action="entry" data-entry="${escapeHtml(entry.entryId)}" href="${escapeHtml(entry.path)}">
        <span class="recent-item__date">${escapeHtml(formatDate(entry.date))}</span>
        <span class="recent-item__label">${escapeHtml(entry.title)}</span>
      </a>
    `;
  }

  function renderMoment(moment) {
    const video = moment.video && moment.video.watchUrl
      ? `<a class="moment__video" href="${escapeHtml(moment.video.watchUrl)}" target="_blank" rel="noopener noreferrer">
          ${moment.video.coverUrl ? `<img src="${escapeHtml(moment.video.coverUrl)}" alt="" loading="lazy">` : ''}
          <span class="moment__video-title">${escapeHtml(moment.video.title || moment.video.watchUrl)}</span>
        </a>`
      : '';
    return `
      <article class="moment-card">
        <header class="moment__meta">
          <time>${escapeHtml(formatDate(String(moment.publishedAt).slice(0, 10)))}</time>
          ${(moment.tags || []).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}
        </header>
        <div class="moment__body">${moment.html || `<p>${escapeHtml(moment.text || '')}</p>`}</div>
        ${video}
        <footer class="moment__actions">
          <a class="moment__permalink" href="${escapeHtml(moment.path)}" title="打开这条动态的独立页面">链接</a>
        </footer>
      </article>
    `;
  }

  function renderMessage(title, text) {
    return `
      <section class="article-surface">
        <p class="hero__eyebrow">BIFROST</p>
        <h2 class="hero__title">${escapeHtml(title)}</h2>
        <p class="hero__text">${escapeHtml(text)}</p>
      </section>
    `;
  }

  // ---------- 打开条目 ----------

  let routeToken = 0;

  async function openEntry(entryId) {
    const entry = (state.index.entries || []).find((item) => item.entryId === entryId);
    if (!entry) return;
    const token = ++routeToken;
    state.view = 'entry';
    state.section = entry.section;
    state.entryId = entryId;
    renderSidebar();

    el.view.innerHTML = renderMessage('正在打开…', entry.title);
    try {
      const response = await fetch(entry.path);
      const raw = await response.text();
      if (token !== routeToken) return;
      if (!response.ok) throw new Error(String(response.status));
      const body = extractFragment(raw);
      el.view.innerHTML = `
        <section class="entry-chrome">
          <p class="entry-meta">
            <span>${escapeHtml(formatDate(entry.date))}</span>
            <span>·</span>
            <span>${escapeHtml((state.index.sections[entry.section] || {}).label || '')}</span>
            ${entry.wordCount ? `<span>· 约 ${Math.max(1, Math.round(entry.wordCount / 400))} 分钟</span>` : ''}
          </p>
          ${renderTags(entry, 6)}
        </section>
        ${body}
      `;
      window.BifrostMediaPreview?.mount(el.view);
      mountInteractions(entry);
    } catch {
      if (token === routeToken) el.view.innerHTML = renderMessage('这一页暂时没有打开', '稍后再试，或返回总览。');
    }
    updateTreeActive();
    updateDocumentMeta(entry.title, entry.summary || '');
    el.main.scrollTo({ top: 0 });
  }

  function extractFragment(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('script, meta, title, link, style, noscript').forEach((node) => node.remove());
    return doc.body.innerHTML;
  }

  function mountInteractions(entry) {
    if (!window.BifrostInteractions) return;
    // 互动接口迁移到 entryId 之前，接口不认识新路径，先不发起注定失败的请求。
    // 迁移完成后把 data/site.json 的 interactions.entryModel 改为 "entryId" 即可开启。
    const config = state.siteConfig ? state.siteConfig.interactions : null;
    if (config && config.entryModel !== 'entryId') return;
    window.BifrostInteractions.mount(
      { path: entry.path, entryId: entry.entryId, title: entry.title },
      el.view,
      config,
      state.phase,
    );
  }

  // ---------- 路由 ----------

  async function restoreRoute() {
    const url = new URL(window.location.href);
    // URL 参数优先于"上次阅读"：显式打开某个分区时，不应被恢复逻辑带偏
    const urlEntry = url.searchParams.get('entry') || '';
    const urlSection = url.searchParams.get('section') || '';
    const entryId = urlEntry || (urlSection ? '' : (localStorage.getItem(STORAGE.entry) || ''));
    const section = urlSection || (entryId ? '' : (localStorage.getItem(STORAGE.section) || ''));
    if (entryId && (state.index.entries || []).some((entry) => entry.entryId === entryId)) {
      await openEntry(entryId);
      return;
    }
    if (section && (phaseConfig(state.phase).sections || []).some((item) => item.id === section)) {
      localStorage.removeItem(STORAGE.entry);
      renderSection(section);
      localStorage.setItem(STORAGE.section, section);
      syncUrl({ replace: true });
      return;
    }
    renderDashboard();
    syncUrl({ replace: true });
  }

  function onPopState() {
    const url = new URL(window.location.href);
    const phase = url.searchParams.get('phase');
    if (phase && phase !== state.phase) applyPhase(phase);
    const entryId = url.searchParams.get('entry');
    const section = url.searchParams.get('section');
    if (entryId) openEntry(entryId);
    else if (section) renderSection(section);
    else renderDashboard();
  }

  function syncUrl({ replace = false } = {}) {
    const url = new URL(window.location.href);
    url.searchParams.set('phase', state.phase);
    if (state.view === 'entry' && state.entryId) {
      url.searchParams.set('entry', state.entryId);
      url.searchParams.delete('section');
    } else if (state.view === 'section' && state.section) {
      url.searchParams.set('section', state.section);
      url.searchParams.delete('entry');
    } else {
      url.searchParams.delete('entry');
      url.searchParams.delete('section');
    }
    const method = replace ? 'replaceState' : 'pushState';
    window.history[method]({ phase: state.phase }, '', url);
  }

  function onDocumentClick(event) {
    const link = event.target.closest('[data-action]');
    if (!link) return;
    event.preventDefault();
    setNavOpen(false);
    const action = link.dataset.action;
    if (action === 'dashboard') {
      renderDashboard();
      syncUrl();
    } else if (action === 'section') {
      renderSection(link.dataset.section);
      localStorage.setItem(STORAGE.section, link.dataset.section);
      localStorage.removeItem(STORAGE.entry);
      syncUrl();
    } else if (action === 'entry') {
      const entryId = link.dataset.entry;
      localStorage.setItem(STORAGE.entry, entryId);
      openEntry(entryId).then(() => syncUrl());
    }
  }

  // ---------- 搜索 ----------

  let searchTimer = 0;
  let searchToken = 0;

  /** 检索服务地址：没配置时退回索引内的本地过滤。 */
  function searchEndpoint() {
    const config = state.siteConfig ? state.siteConfig.search : null;
    if (!config || config.enabled === false || !config.apiBaseUrl) return '';
    return String(config.apiBaseUrl).replace(/\/+$/, '');
  }

  function searchDocs() {
    const entries = (state.index.entries || []).map((entry) => ({
      kind: 'entry',
      id: entry.entryId,
      path: entry.path,
      title: entry.title,
      summary: entry.summary,
      phase: entry.phase,
      section: entry.section,
      tags: entry.tags || [],
      date: entry.date,
      text: `${entry.title}\n${entry.summary || ''}\n${(entry.tags || []).join(' ')}`,
    }));
    const moments = (state.index.moments || []).map((moment) => ({
      kind: 'moment',
      id: moment.id,
      path: moment.path,
      title: moment.summary || moment.text?.slice(0, 24) || '动态',
      summary: moment.summary,
      phase: moment.phase,
      section: moment.section,
      tags: moment.tags || [],
      date: String(moment.publishedAt).slice(0, 10),
      text: `${moment.text || ''}\n${(moment.tags || []).join(' ')}`,
    }));
    return [...entries, ...moments];
  }

  function scheduleSearch() {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void runSearch();
    }, 180);
  }

  async function runSearch() {
    const endpoint = searchEndpoint();
    if (!endpoint) {
      renderSearchLocal();
      return;
    }

    const token = (searchToken += 1);
    const params = new URLSearchParams();
    const query = state.query.trim();
    if (query) params.set('q', query);
    if (state.facets.phase) params.set('phase', state.facets.phase);
    if (state.facets.section) params.set('section', state.facets.section);
    if (state.facets.tags.size) params.set('tags', [...state.facets.tags].join(','));
    params.set('limit', String(SEARCH_LIMIT));

    try {
      const response = await fetch(`${endpoint}/search?${params.toString()}`, {
        signal: AbortSignal.timeout(6000),
      });
      const payload = await response.json();
      if (token !== searchToken) return;
      if (!payload.enabled) {
        renderSearchLocal();
        return;
      }
      state.results = (payload.items || []).map(toResultItem);
      state.activeIndex = 0;
      renderSearchFacets(payload.facets || {});
      renderSearchResults();
    } catch {
      // 检索服务不可用时退回本地过滤，保证搜索仍然可用
      if (token === searchToken) renderSearchLocal();
    }
  }

  function toResultItem(doc) {
    return {
      kind: doc.entryType === 'moment' ? 'moment' : 'entry',
      id: doc.entryId,
      path: doc.path,
      title: doc.title || doc.summary || '（无标题）',
      phase: doc.phase,
      section: doc.section,
      tags: doc.tags || [],
      date: String(doc.publishedAt || '').slice(0, 10),
    };
  }

  function renderSearchFacets(facetCounts) {
    const countOf = (name, value) => {
      const hit = (facetCounts[name] || []).find((item) => item.value === value);
      return hit ? hit.count : 0;
    };
    const sections = Object.values(state.index.sections || {})
      .filter((section) => !state.facets.phase || section.phase === state.facets.phase);
    const tags = (facetCounts.tags || []).slice(0, 12);

    el.searchFacets.innerHTML = `
      <div class="facet-row">
        <span class="facet-label">位面</span>
        ${(state.index.phases || []).map((phase) => `<button class="facet${state.facets.phase === phase.id ? ' is-on' : ''}" data-facet="phase" data-value="${escapeHtml(phase.id)}">${escapeHtml(phase.label)}${countOf('phase', phase.id) ? ` <i>${countOf('phase', phase.id)}</i>` : ''}</button>`).join('')}
      </div>
      <div class="facet-row">
        <span class="facet-label">分区</span>
        <button class="facet${state.facets.section ? '' : ' is-on'}" data-facet="section" data-value="">全部</button>
        ${sections.map((section) => `<button class="facet${state.facets.section === section.id ? ' is-on' : ''}" data-facet="section" data-value="${escapeHtml(section.id)}">${escapeHtml(section.label)}${countOf('section', section.id) ? ` <i>${countOf('section', section.id)}</i>` : ''}</button>`).join('')}
      </div>
      <div class="facet-row">
        <span class="facet-label">标签</span>
        ${tags.length
          ? tags.map((tag) => `<button class="facet${state.facets.tags.has(tag.value) ? ' is-on' : ''}" data-facet="tag" data-value="${escapeHtml(tag.value)}">${escapeHtml(tag.value)} <i>${tag.count}</i></button>`).join('')
          : '<span class="facet-label">暂无</span>'}
      </div>
    `;
  }

  function renderSearchResults() {
    el.searchResults.innerHTML = state.results.length
      ? state.results.map((doc, index) => `
          <a class="command-item${index === 0 ? ' is-active' : ''}" data-result-index="${index}" data-path="${escapeHtml(doc.path)}" data-id="${escapeHtml(doc.id)}" data-kind="${escapeHtml(doc.kind)}">
            <span class="command-item__label">${escapeHtml(doc.title)}</span>
            <span class="command-item__hint">${escapeHtml([formatDate(doc.date), (state.index.sections[doc.section] || {}).label, ...(doc.tags || []).slice(0, 2)].filter(Boolean).join(' · '))}</span>
          </a>
        `).join('')
      : '<p class="command-empty">没有匹配的内容。</p>';
  }

  function openSearch() {
    closePanels();
    el.searchPanel.classList.add('is-active');
    state.query = '';
    state.facets = { phase: state.phase, section: '', tags: new Set() };
    if (el.searchInput) el.searchInput.value = '';
    void runSearch();
    window.setTimeout(() => el.searchInput?.focus(), 0);
  }

  /** 本地过滤：检索服务未配置或不可用时使用。 */
  function renderSearchLocal() {
    const docs = searchDocs();
    const query = state.query.trim().toLowerCase();
    const results = docs.filter((doc) => {
      if (state.facets.phase && doc.phase !== state.facets.phase) return false;
      if (state.facets.section && doc.section !== state.facets.section) return false;
      for (const tag of state.facets.tags) {
        if (!doc.tags.includes(tag)) return false;
      }
      if (!query) return true;
      return doc.text.toLowerCase().includes(query);
    });
    state.results = results.slice(0, SEARCH_LIMIT);
    state.activeIndex = 0;

    const tagCounts = new Map();
    for (const doc of docs) {
      if (state.facets.phase && doc.phase !== state.facets.phase) continue;
      for (const tag of doc.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    renderSearchFacets({
      phase: (state.index.phases || []).map((phase) => ({ value: phase.id, count: phaseEntries(phase.id).length })),
      section: [...new Set(docs.map((doc) => doc.section))].map((section) => ({ value: section, count: docs.filter((doc) => doc.section === section).length })),
      tags: topTags.map(([value, count]) => ({ value, count })),
    });
    renderSearchResults();
  }

  function onFacetClick(event) {
    const button = event.target.closest('[data-facet]');
    if (!button) return;
    const { facet, value } = button.dataset;
    if (facet === 'phase') state.facets.phase = value;
    else if (facet === 'section') state.facets.section = value;
    else if (facet === 'tag') {
      if (state.facets.tags.has(value)) state.facets.tags.delete(value);
      else state.facets.tags.add(value);
    }
    void runSearch();
  }

  function onPanelResultClick(event) {
    const item = event.target.closest('[data-result-index]');
    if (item) activateResult(Number(item.dataset.resultIndex));
  }

  async function activateResult(index) {
    const doc = state.results[index];
    if (!doc) return;
    closePanels();
    if (doc.phase !== state.phase) {
      applyPhase(doc.phase);
      renderSidebar();
    }
    if (doc.kind === 'moment') {
      renderSection(doc.section);
      syncUrl();
      window.setTimeout(() => el.main.scrollTo({ top: 0 }), 0);
      return;
    }
    await openEntry(doc.id);
    syncUrl();
  }

  function onPanelKeyDown(event) {
    if (event.key === 'Escape') {
      closePanels();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!state.results.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.activeIndex = (state.activeIndex + delta + state.results.length) % state.results.length;
      el.searchResults.querySelectorAll('.command-item').forEach((node, index) => {
        node.classList.toggle('is-active', index === state.activeIndex);
      });
      el.searchResults.querySelector('.command-item.is-active')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateResult(state.activeIndex);
    }
  }

  // ---------- 位面面板 ----------

  function openPhasePanel() {
    closePanels();
    el.phasePanel.classList.add('is-active');
    const list = phases();
    el.phaseResults.innerHTML = list.map((phase, index) => `
      <a class="command-item${phase.id === state.phase ? ' is-active' : ''}" data-phase-id="${escapeHtml(phase.id)}" data-index="${index}">
        <span class="command-item__label">${escapeHtml(phase.label)} 位面</span>
        <span class="command-item__hint">${phase.id === state.phase ? '当前' : `${(phase.sections || []).length} 个分区`}</span>
      </a>
    `).join('');
    el.phaseResults.querySelectorAll('[data-phase-id]').forEach((node) => {
      node.addEventListener('click', () => {
        closePanels();
        switchPhase(node.dataset.phaseId);
      });
    });
  }

  function closePanels() {
    const active = document.activeElement;
    el.searchPanel?.classList.remove('is-active');
    el.phasePanel?.classList.remove('is-active');
    // 面板关闭后若焦点还留在输入框里，会挡住全局快捷键，这里主动释放
    if (active instanceof HTMLElement
      && (el.searchPanel?.contains(active) || el.phasePanel?.contains(active))) {
      active.blur();
    }
  }

  // ---------- 键盘 ----------

  function onKeyDown(event) {
    const typing = event.target instanceof Element
      && (event.target.matches('input, textarea, select') || event.target.isContentEditable);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === 'Escape') {
      closePanels();
      return;
    }
    if (typing) return;
    if (event.key === '~' || event.key === '`') {
      event.preventDefault();
      if (el.phasePanel.classList.contains('is-active')) closePanels();
      else openPhasePanel();
    }
  }

  // ---------- 杂项 ----------

  function setNavOpen(open) {
    if (!el.shell || !el.navToggle) return;
    el.shell.classList.toggle('is-nav-open', open);
    el.navToggle.setAttribute('aria-expanded', String(open));
  }

  function isNavOpen() {
    return Boolean(el.shell?.classList.contains('is-nav-open'));
  }

  function onScroll() {
    /* 阅读进度等后续按需接入 */
  }

  function updateStatusNote() {
    const style = PHASE_STYLE[state.phase] || PHASE_STYLE.fantasy;
    if (el.statusText) el.statusText.textContent = style.subtitle;
    const latest = phaseEntries()[0] || phaseMoments()[0];
    const date = latest ? String(latest.publishedAt || latest.date || '').slice(0, 10) : '';
    if (el.statusTitle) el.statusTitle.textContent = date ? `更新于 ${formatDate(date)}` : '更新于 —';
  }

  function updateFooterClock() {
    if (!el.footerClock) return;
    const now = new Date();
    if (state.phase === 'logic') {
      const pad = (value) => String(value).padStart(2, '0');
      el.footerClock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      return;
    }
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    el.footerClock.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${weekdays[now.getDay()]}`;
  }

  function updateDocumentMeta(title, description) {
    document.title = title ? `${title} · BIFROST` : 'BIFROST';
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.append(meta);
    }
    meta.setAttribute('content', description || '');
  }

  function formatDate(value) {
    if (!value) return '—';
    const text = String(value).slice(0, 10);
    const currentYear = String(new Date().getFullYear());
    return text.startsWith(`${currentYear}-`) ? text.slice(5).replace('-', '.') : text.replaceAll('-', '.');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ---------- 环境音 ----------

  const SOUND_LABELS = { off: '环境音 关闭', pending: '环境音 点击启动', on: '环境音 开启' };

  function initAmbience() {
    const ambience = window.BifrostAmbience;
    if (!ambience) return;
    ambience.restore((status) => renderSoundState(status));
    ambience.setPhase(state.phase);
  }

  function renderSoundState(status) {
    if (!el.soundToggle) return;
    el.soundLabel.textContent = SOUND_LABELS[status] || SOUND_LABELS.off;
    el.soundToggle.dataset.soundState = status;
    el.soundToggle.setAttribute('aria-pressed', String(status !== 'off'));
  }

  async function onSoundToggle() {
    const ambience = window.BifrostAmbience;
    if (!ambience) return;
    if (ambience.status() === 'pending') await ambience.resume();
    else await ambience.toggle();
  }

  function onFirstInteraction(event) {
    const ambience = window.BifrostAmbience;
    if (!ambience || !ambience.isEnabled()) return;
    if (el.soundToggle && event?.target instanceof Node && el.soundToggle.contains(event.target)) return;
    void ambience.resume();
  }
})();
