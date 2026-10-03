// BIFROST 引擎
// 数据来源：/data/site-index.json（由 tools/materialize-site.mjs 从数据库物化）。
// 阅读走静态产物；搜索走检索接口，接口不可用时退回索引内的本地过滤。
(() => {
  const INDEX_URL = '/data/site-index.json';
  const SITE_CONFIG_URL = '/data/site.json';

  // 位面用 sessionStorage：刷新保持，重开（新会话）回到 Logic
  const STORAGE = {
    phase: 'bifrost:phase',
    section: 'bifrost:section',
    entry: 'bifrost:entry',
  };

  const READING_LAYOUTS = ['magazine', 'column'];
  const IMAGE_LAYOUTS = ['uniform56', 'editorial56', 'editorial64'];
  const SEARCH_LIMIT = 30;

  // 视觉与身份由前端定义；分类法与内容列表来自索引
  const PHASE_STYLE = {
    logic: {
      title: 'LOGIC ARCHIVE',
      subtitle: '把复杂的事拆开，慢慢记下来。',
      dashboardTitle: '技术整理与项目记录',
      dashboardText: '把复杂的问题拆开，记下解决过程、取舍和还需要继续想的地方。',
      status: '技术整理与项目记录还在收拢，留下的内容会慢慢出现在这里。',
      pill: 'LOGIC · STABLE',
      footer: 'Logic 位面',
      themeColor: '#0a0f14',
      bridgeColor: 'rgba(121, 201, 192, 0.24)',
      boot: ['点亮 Logic 的档案灯…', '整理目录与近作…', '准备阅读界面…'],
      empty: '第一份真正准备好的技术记录出现后，会从这里开始。',
    },
    fantasy: {
      title: '幻想回廊',
      subtitle: '把读过的、想过的，慢慢留在这里。',
      dashboardTitle: '阅读、活动与慢慢写下的文字',
      dashboardText: '从最近读到的、见到的和还留在心里的内容开始。',
      status: '书架已经掸过灰，新的阅读、活动与手记会陆续到来。',
      pill: 'FANTASY · REVERIE',
      footer: 'Fantasy 位面',
      themeColor: '#f6f0e7',
      bridgeColor: 'rgba(185, 122, 131, 0.28)',
      boot: ['点亮回廊灯火…', '拂去书架浮尘…', '准备阅读界面…'],
      empty: '等第一篇文章准备好，它会从这里出现。',
    },
  };

  // 分区英文角标：比直译更讲究一档，Logic 保持简短技术风
  const SECTION_EN = {
    daily: 'MOMENTS',
    review: 'CRITIQUE',
    activity: 'FIELDNOTES',
    essay: 'MISCELLANY',
    archive: 'ARCHIVES',
    docs: 'DOCS',
    notes: 'NOTES',
    algo: 'ALGO',
    showcase: 'SHOWCASE',
  };

  const state = {
    index: null,
    siteConfig: {},
    phase: 'logic',
    view: 'dashboard',
    section: '',
    entryId: '',
    seriesId: '',
    readingLayout: 'magazine',
    imageLayout: 'editorial56',
    query: '',
    facets: { phase: '', section: '', tags: new Set() },
    results: [],
    activeIndex: 0,
    phaseIndex: 0,
  };

  const el = {};

  window.addEventListener('DOMContentLoaded', init);
  window.addEventListener('popstate', onPopState);

  // ---------- 存储 ----------

  function readStored(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function writeStored(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  // ---------- 启动 ----------

  async function init() {
    cacheElements();
    bindEvents();

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

    // 位面列表来自索引，必须等索引到位后再解析，否则 ?phase=logic 这类直链会失效
    state.readingLayout = resolveLayout('reading', READING_LAYOUTS, 'magazine');
    state.imageLayout = resolveLayout('images', IMAGE_LAYOUTS, 'editorial56');
    state.phase = resolvePhase();
    applyPhase(state.phase);
    applyLayoutAttributes(null);
    initAmbience();

    renderSidebar();
    updateStatusNote();
    window.setInterval(updateFooterClock, 1000);
    updateFooterClock();
    await restoreRoute();
  }

  function cacheElements() {
    el.html = document.documentElement;
    el.body = document.body;
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
    el.searchKey = document.querySelector('[data-search-key]');
    el.searchInput = document.querySelector('[data-search-input]');
    el.searchFacets = document.querySelector('[data-search-facets]');
    el.searchResults = document.querySelector('[data-search-results]');

    el.phasePanel = document.querySelector('[data-phase-panel]');
    el.phaseTrigger = document.querySelector('[data-phase-trigger]');
    el.phaseResults = document.querySelector('[data-phase-results]');
  }

  function bindEvents() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    el.main.addEventListener('scroll', onMainScroll, { passive: true });
    if (el.navToggle) el.navToggle.addEventListener('click', () => setNavOpen(!isNavOpen()));
    if (el.soundToggle) el.soundToggle.addEventListener('click', onSoundToggle);
    if (el.searchTrigger) el.searchTrigger.addEventListener('click', () => openSearch());
    if (el.phaseTrigger) el.phaseTrigger.addEventListener('click', () => openPhasePanel());
    if (el.searchKey) el.searchKey.textContent = isApplePlatform() ? '⌘K' : 'Ctrl K';

    if (el.searchInput) {
      el.searchInput.addEventListener('input', () => {
        state.query = el.searchInput.value;
        scheduleSearch();
      });
    }
    el.searchPanel.addEventListener('keydown', onSearchKeyDown);
    el.searchPanel.addEventListener('click', (event) => {
      if (event.target === el.searchPanel) closePanels();
    });
    el.searchResults.addEventListener('click', onSearchResultsClick);
    el.searchFacets.addEventListener('click', onFacetClick);

    // 面板内部每次打开都会重建，所以事件都委托在面板根节点上
    el.phasePanel.addEventListener('keydown', onPhaseKeyDown);
    el.phasePanel.addEventListener('input', onPhaseInput);
    el.phasePanel.addEventListener('click', onPhasePanelClick);

    document.addEventListener('pointerdown', onFirstInteraction, { once: true });
  }

  // ---------- 位面与版式 ----------

  function phases() {
    return state.index?.phases || [];
  }

  function phaseConfig(id) {
    return phases().find((phase) => phase.id === id) || phases()[0] || { id: 'fantasy', label: 'Fantasy', sections: [] };
  }

  function sectionMeta(id) {
    return (state.index?.sections || {})[id] || { id, label: id, layout: 'magazine' };
  }

  function resolveLayout(name, allowed, fallback) {
    const requested = new URL(window.location.href).searchParams.get(name);
    return allowed.includes(requested) ? requested : fallback;
  }

  function resolvePhase() {
    const url = new URL(window.location.href);
    const urlPhase = url.searchParams.get('phase');
    if (phases().some((phase) => phase.id === urlPhase)) return urlPhase;
    const stored = readStored(STORAGE.phase);
    if (phases().some((phase) => phase.id === stored)) return stored;
    return phases()[0]?.id || 'logic';
  }

  function applyPhase(phase) {
    state.phase = phase;
    const style = PHASE_STYLE[phase] || PHASE_STYLE.logic;
    el.html.dataset.phase = phase;
    el.body.classList.toggle('phase-fantasy', phase === 'fantasy');
    if (el.siteTitle) el.siteTitle.textContent = style.title;
    if (el.siteSubtitle) el.siteSubtitle.textContent = style.subtitle;
    if (el.phasePill) el.phasePill.textContent = style.pill;
    if (el.footerStatus) el.footerStatus.textContent = style.footer;
    if (el.themeColor) el.themeColor.setAttribute('content', style.themeColor);
    if (window.BifrostAmbience) window.BifrostAmbience.setPhase(phase);
    if (window.BifrostInteractions) window.BifrostInteractions.setPhase(phase);
    writeStored(STORAGE.phase, phase);
  }

  /**
   * 补齐版式属性——CSS 里有 100+ 条规则依赖它们。
   * 缺了这层，分型排版、阅读版式与评论区对齐都会失效。
   */
  function applyLayoutAttributes(entry) {
    if (el.html) {
      el.html.dataset.readingLayout = state.readingLayout;
      el.html.dataset.imageLayout = state.imageLayout;
    }
    if (!el.view) return;
    if (!entry) {
      delete el.view.dataset.entryType;
      delete el.view.dataset.entryLayout;
      delete el.main.dataset.entryLayout;
      return;
    }
    const isDiary = entry.kind === 'note' || entry.entryType === 'moment';
    el.view.dataset.entryType = isDiary ? 'diary' : 'article';
    el.view.dataset.entryLayout = entry.layout || 'longform';
    el.main.dataset.entryLayout = entry.layout || 'longform';
  }

  function switchPhase(phase) {
    // 选择当前位面时也算一次导航：回到该位面的总览
    if (phase === state.phase) {
      renderDashboard();
      syncUrl();
      return;
    }
    const style = PHASE_STYLE[phase] || PHASE_STYLE.logic;
    const bridge = playBridge(style.bridgeColor);
    const commit = () => {
      applyPhase(phase);
      writeStored(STORAGE.section, '');
      writeStored(STORAGE.entry, '');
      state.section = '';
      state.entryId = '';
      state.seriesId = '';
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

  // ---------- 数据访问 ----------

  function entryById(id) {
    return (state.index?.entries || []).find((entry) => entry.entryId === id) || null;
  }

  function entryByPath(path) {
    return (state.index?.entries || []).find((entry) => entry.path === path) || null;
  }

  function phaseEntries(phase = state.phase) {
    return (state.index?.entries || []).filter((entry) => entry.phase === phase);
  }

  function phaseMoments(phase = state.phase) {
    return (state.index?.moments || []).filter((moment) => moment.phase === phase);
  }

  function allSeries() {
    return state.index?.series || [];
  }

  function seriesById(id) {
    return allSeries().find((series) => series.id === id) || null;
  }

  function seriesMembers(series) {
    return (series?.memberIds || []).map(entryById).filter(Boolean);
  }

  function sectionCounts() {
    const map = new Map();
    for (const entry of phaseEntries()) {
      map.set(entry.section, (map.get(entry.section) || 0) + 1);
    }
    for (const moment of phaseMoments()) {
      map.set(moment.section, (map.get(moment.section) || 0) + 1);
    }
    return map;
  }

  // ---------- 侧栏 ----------

  function renderSidebar() {
    const config = phaseConfig(state.phase);
    const sections = (config.sections || []).filter((section) => section.id !== 'showcase');
    const counts = sectionCounts();
    const activeSection = state.view === 'section' ? state.section : '';
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

  function updateTreeActive() {
    el.tree.querySelectorAll('.tree__link').forEach((link) => {
      const isSection = link.dataset.section === state.section && state.view === 'section';
      const isOverview = link.dataset.action === 'dashboard' && state.view === 'dashboard';
      link.classList.toggle('is-active', isSection || isOverview);
    });
  }

  // ---------- 首页 ----------

  function renderDashboard() {
    state.view = 'dashboard';
    state.section = '';
    state.entryId = '';
    state.seriesId = '';
    writeStored(STORAGE.section, '');
    writeStored(STORAGE.entry, '');
    applyLayoutAttributes(null);
    if (state.phase === 'logic') renderLogicDashboard();
    else renderFantasyDashboard();
    updateTreeActive();
    window.BifrostMediaPreview?.mount(el.view);
  }

  function renderHero(config, style) {
    return `
      <section class="article-surface view__hero">
        <p class="hero__eyebrow">${escapeHtml(config.label)} · 总览</p>
        <h1 class="hero__title">${escapeHtml(style.dashboardTitle)}</h1>
        <p class="hero__text">${escapeHtml(style.dashboardText)}</p>
      </section>
    `;
  }

  function renderFantasyDashboard() {
    const config = phaseConfig(state.phase);
    const style = PHASE_STYLE[state.phase] || PHASE_STYLE.fantasy;
    const entries = phaseEntries();
    const moments = phaseMoments();
    // 日常已有专属预览卡，磁贴里不再重复入口
    const sections = (config.sections || []).filter((section) => section.id !== 'showcase' && section.id !== 'daily');
    const counts = sectionCounts();
    const totalWords = entries.reduce((sum, entry) => sum + (entry.wordCount || 0), 0);
    const wordText = totalWords >= 10000 ? `${(totalWords / 10000).toFixed(1)} 万字` : `${totalWords} 字`;
    const lastUpdate = entries[0]?.date || '';

    el.view.innerHTML = `
      ${renderHero(config, style)}

      <section class="home-stats" aria-label="站点统计">
        <span class="home-stats__item"><b>${entries.length}</b> 篇文章</span>
        <span class="home-stats__dot" aria-hidden="true"></span>
        <span class="home-stats__item"><b>${moments.length}</b> 条日常</span>
        <span class="home-stats__dot" aria-hidden="true"></span>
        <span class="home-stats__item">共 <b>${escapeHtml(wordText)}</b></span>
        ${lastUpdate ? `<span class="home-stats__dot" aria-hidden="true"></span><span class="home-stats__item">最近更新 <b>${escapeHtml(lastUpdate)}</b></span>` : ''}
      </section>

      ${moments.length ? `
        <section class="home-card">
          <div class="home-card__head">
            <h2>日常</h2>
            <a class="home-card__more" data-action="section" data-section="daily" href="?phase=${state.phase}&section=daily">全部 ${moments.length} 条 →</a>
          </div>
          ${moments.slice(0, 3).map((moment) => renderHomeMoment(moment)).join('')}
        </section>` : ''}

      <section class="home-block">
        <div class="home-block__head"><h2>去哪里看</h2></div>
        <div class="section-tiles">
          ${sections.map((section) => {
            const meta = sectionMeta(section.id);
            const count = counts.get(section.id) || 0;
            const desc = meta.description || (meta.layout === 'timeline' ? '短动态时间流' : '');
            const glyph = escapeHtml(String(section.label || '?').charAt(0));
            return `
              <a class="section-tile${count ? '' : ' section-tile--empty'}" data-action="section" data-section="${escapeHtml(section.id)}" href="?phase=${state.phase}&section=${encodeURIComponent(section.id)}">
                <span class="section-tile__glyph" aria-hidden="true">${glyph}</span>
                <span class="section-tile__label">${escapeHtml(section.label)}</span>
                <span class="section-tile__desc">${escapeHtml([desc, count ? `${count} 篇` : '筹备中'].filter(Boolean).join(' · '))}</span>
              </a>`;
          }).join('')}
        </div>
      </section>

      ${entries.length ? `
        <section class="home-block">
          <div class="home-block__head">
            <h2>最近更新</h2>
            <button class="home-card__more" type="button" data-action="search-all">共 ${entries.length} 篇 →</button>
          </div>
          <div class="entry-rows">
            ${entries.slice(0, 6).map((entry) => renderEntryRow(entry)).join('')}
          </div>
        </section>` : ''}
    `;
    updateDocumentMeta(config.label, style.dashboardText);
  }

  function renderLogicDashboard() {
    const config = phaseConfig(state.phase);
    const style = PHASE_STYLE.logic;
    const showcase = state.index?.showcase || null;
    const techStack = showcase?.techStack || [];
    const projects = (showcase?.projectIds || []).map(entryById).filter(Boolean);

    el.view.innerHTML = `
      ${renderHero(config, style)}

      <section class="article-surface">
        <p class="hero__eyebrow">简介</p>
        <p class="hero__text">${escapeHtml(showcase?.intro || '简介还没写。')}</p>
      </section>

      <section class="home-block">
        <div class="home-block__head"><h2>技术栈</h2></div>
        ${techStack.length
          ? `<div class="entry-rows">
              ${techStack.map((group) => `
                <div class="entry-row">
                  <span class="entry-row__date">${escapeHtml(group.group || '')}</span>
                  <span class="entry-row__title">${escapeHtml((group.items || []).join(' · '))}</span>
                </div>
              `).join('')}
            </div>`
          : '<p class="hero__text">技术栈还没填。</p>'}
      </section>

      <section class="home-block">
        <div class="home-block__head"><h2>项目</h2></div>
        ${projects.length
          ? `<div class="card-grid">${projects.map((project) => renderCard(project)).join('')}</div>`
          : `<p class="hero__text">${escapeHtml('项目还在整理，之后会出现在这里。')}</p>`}
      </section>
    `;
    updateDocumentMeta(config.label, style.dashboardText);
  }

  function renderHomeMoment(moment) {
    const media = moment.video && moment.video.coverUrl
      ? `<span class="home-moment__media"><img src="${escapeHtml(moment.video.coverUrl)}" alt="" loading="lazy"></span>`
      : '';
    return `
      <a class="home-moment" href="${escapeHtml(moment.path)}" data-action="moment" data-moment="${escapeHtml(moment.id)}">
        <div class="home-moment__meta">
          <span class="home-moment__time">${escapeHtml(relativeDate(moment.publishedAt))}</span>
          ${(moment.tags || []).slice(0, 2).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}
        </div>
        ${media}
        <p class="home-moment__text">${escapeHtml(moment.text || moment.summary || '')}</p>
      </a>
    `;
  }

  function renderEntryRow(entry) {
    const thumb = entry.coverUrl
      ? `<span class="entry-row__thumb"><img src="${escapeHtml(entry.coverUrl)}" alt="" loading="lazy"></span>`
      : renderMiniCover(entry);
    return `
      <a class="entry-row" data-action="entry" data-entry="${escapeHtml(entry.entryId)}" href="${escapeHtml(entry.path)}">
        ${thumb}
        <span class="entry-row__date">${escapeHtml(formatDate(entry.date))}</span>
        <span class="entry-row__title">${escapeHtml(entry.title)}</span>
        <span class="entry-row__section">${escapeHtml(sectionMeta(entry.section).label || '')}</span>
      </a>
    `;
  }

  /** 最近更新行的 36px mini 封面：与卡片封面同一套哈希变体。 */
  function renderMiniCover(entry) {
    const title = String(entry.title || '').trim();
    const hash = coverHash(title);
    const glyph = escapeHtml(title.charAt(0) || '文');
    const textures = ['noise', 'grid', 'dots', 'diag'];
    return `
      <span class="entry-row__thumb cover cover--mini cover--w${hash % 5} cover--tex-${textures[hash % textures.length]}" aria-hidden="true">
        <i class="cover__wash"></i>
        <i class="cover__tex"></i>
        <span class="cover__title"><span class="cover__title-text">${glyph}</span></span>
      </span>
    `;
  }

  // ---------- 分区 ----------

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
    state.seriesId = '';
    applyLayoutAttributes(null);
    writeStored(STORAGE.section, sectionId);
    writeStored(STORAGE.entry, '');

    if (section.layout === 'timeline' || sectionId === 'daily') {
      renderDailyFeed(config, section);
    } else {
      const items = sectionItems(sectionId);
      el.view.innerHTML = `
        <section class="article-surface view__hero">
          <p class="hero__eyebrow">${escapeHtml(config.label)} · ${escapeHtml(section.label)}</p>
          <h1 class="hero__title">${escapeHtml(section.label)}</h1>
          <p class="hero__text">共 ${countForSection(sectionId)} 篇。</p>
        </section>
        ${items.length ? renderMagazine(items) : renderMessage('这里还没有内容', '等第一份内容准备好，它会出现在这里。')}
      `;
    }
    updateTreeActive();
    updateDocumentMeta(section.label, `${config.label} · ${section.label}`);
    el.main.scrollTo({ top: 0 });
    window.BifrostMediaPreview?.mount(el.view);
  }

  function countForSection(sectionId) {
    return sectionItems(sectionId).reduce((total, item) => total + (item.type === 'series' ? item.series.memberIds.length : 1), 0);
  }

  /** 分区内的条目：同一系列的成员收成一张卡片。 */
  function sectionItems(sectionId) {
    const entries = phaseEntries().filter((entry) => entry.section === sectionId);
    const seenSeries = new Set();
    const items = [];
    for (const entry of entries) {
      const series = entry.seriesId ? seriesById(entry.seriesId) : null;
      if (!series) {
        items.push({ type: 'entry', entry, date: entry.date || '' });
        continue;
      }
      if (seenSeries.has(series.id)) continue;
      seenSeries.add(series.id);
      const members = seriesMembers(series);
      items.push({ type: 'series', series, date: members[0]?.date || entry.date || '' });
    }
    return items;
  }

  function renderMagazine(items) {
    const [lead, ...rest] = items;
    return `
      <section class="magazine">
        ${renderLead(lead)}
        <div class="card-grid">
          ${rest.map((item) => (item.type === 'series' ? renderSeriesCard(item.series) : renderCard(item.entry))).join('')}
        </div>
      </section>
    `;
  }

  function renderLead(item) {
    return item.type === 'series' ? renderSeriesCard(item.series, 'lead-card') : renderLeadCard(item.entry);
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

  function renderSeriesCard(series, wrapperClass = 'entry-card') {
    const members = seriesMembers(series);
    const cover = members.find((member) => member.coverUrl);
    // 系列封面：成员封面 → 以系列标题生成的文字封面
    const coverHtml = cover
      ? `<span class="${wrapperClass === 'lead-card' ? 'lead-card__cover' : 'entry-card__cover'}"><img src="${escapeHtml(cover.coverUrl)}" alt="" loading="lazy"></span>`
      : renderTextCover({
          title: series.title,
          section: members[0]?.section || '',
          date: members[0]?.date || '',
        }, wrapperClass === 'lead-card' ? 'lead-card__cover' : 'entry-card__cover');
    return `
      <a class="${wrapperClass}" data-action="series" data-series="${escapeHtml(series.id)}" href="${escapeHtml(series.path)}">
        ${coverHtml}
        <span class="${wrapperClass === 'lead-card' ? 'lead-card__body' : 'entry-card__body'}">
          <span class="series-card__badge">系列 · ${members.length} 篇</span>
          <span class="${wrapperClass === 'lead-card' ? 'lead-card__title' : 'entry-card__title'}">${escapeHtml(series.title)}</span>
          ${series.description ? `<span class="${wrapperClass === 'lead-card' ? 'lead-card__summary' : 'entry-card__summary'}">${escapeHtml(series.description)}</span>` : ''}
        </span>
      </a>
    `;
  }

  function renderCover(entry, className) {
    if (entry.coverUrl) {
      return `<span class="${className}"><img src="${escapeHtml(entry.coverUrl)}" alt="" loading="lazy"></span>`;
    }
    return renderTextCover(entry, className);
  }

  // ---------- 文字封面：标题哈希决定 wash/纹理/排布，同一篇全站恒定 ----------

  function coverHash(text) {
    let hash = 0;
    const value = String(text || '');
    for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    return hash;
  }

  /** 标点优先断句：在断点插 <wbr>，浏览器优先在此换行；行数上限交给 CSS line-clamp。 */
  function breakableTitle(title) {
    return escapeHtml(title)
      .replace(/[·・—–：:，,、。；;！!？?）)]/g, (mark) => `${mark}<wbr>`)
      .replace(/[（(]/g, (mark) => `<wbr>${mark}`);
  }

  function coverDate(date) {
    const value = String(date || '');
    return value.length >= 7 ? `${value.slice(0, 4)}.${value.slice(5, 7)}` : '';
  }

  function renderTextCover(entry, className) {
    const title = String(entry.title || '').trim() || '未命名';
    const hash = coverHash(title);
    const phase = state.phase === 'fantasy' ? 'fantasy' : 'logic';
    // 竖排题笺仅 Fantasy 且短标题；长标题在 A/B/D 之间轮换
    const layouts = phase === 'fantasy' && title.length <= 10
      ? ['center', 'spine', 'vertical', 'dossier']
      : ['center', 'spine', 'dossier'];
    const layout = layouts[hash % layouts.length];
    const wash = hash % 5;
    const textures = phase === 'fantasy' ? ['noise', 'grid', 'dots', 'diag'] : ['grid', 'dots', 'diag', 'noise'];
    const texture = textures[hash % textures.length];
    const glyph = escapeHtml(title.charAt(0));
    const sectionLabel = entry.section ? sectionMeta(entry.section).label : '';
    const sectionEn = entry.section ? (SECTION_EN[entry.section] || sectionMeta(entry.section).id.toUpperCase()) : '';
    // 编号档案框：分区英文前三位 + 年月（如 CRI 2026.09）
    const refPrefix = sectionEn ? sectionEn.slice(0, 3) : 'REF';
    const kicker = sectionLabel || sectionEn
      ? `<span class="cover__kicker" aria-hidden="true">${escapeHtml(sectionLabel)}${sectionLabel && sectionEn ? ' · ' : ''}${escapeHtml(sectionEn)}</span>`
      : '<span class="cover__kicker" aria-hidden="true">系列 · SERIES</span>';
    const size = className.startsWith('lead-') ? ' cover--lead' : '';
    return `
      <span class="${className} ${className}--text cover cover--${layout} cover--w${wash} cover--tex-${texture}${size}" aria-hidden="true">
        <i class="cover__wash"></i>
        <i class="cover__tex"></i>
        <span class="cover__watermark">${glyph}</span>
        ${kicker}
        <span class="cover__title"><span class="cover__title-text">${breakableTitle(title)}</span></span>
        ${coverDate(entry.date) ? `<span class="cover__date" data-ref="${escapeHtml(refPrefix)}">${escapeHtml(coverDate(entry.date))}</span>` : ''}
        <span class="cover__stamp">${glyph}</span>
      </span>
    `;
  }

  function renderTags(entry, max) {
    const tags = (entry.tags || []).slice(0, max);
    if (!tags.length) return '';
    return `<span class="entry-card__tags">${tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</span>`;
  }

  // ---------- 日常时间流 ----------

  const DAILY_BATCH = 3;

  /** 纯文本动态：裸链自动成链接、#话题# 染色（QQ 空间常见格式）。 */
  function formatMomentText(text) {
    return escapeHtml(text)
      .replace(/#([^#\s]{1,24})#/g, '<span class="moment__topic">#$1#</span>')
      .replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function relativeDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return formatDate(value);
    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return formatDate(String(value).slice(0, 10));
  }

  function renderDailyFeed(config, section) {
    // 置顶排最前，其余按月份倒序；月份分批渲染（设计决策 4：滚动加载）
    const all = phaseMoments().filter((moment) => moment.section === section.id);
    const pinned = all.filter((moment) => moment.pinned);
    const rest = all.filter((moment) => !moment.pinned);
    const byMonth = new Map();
    for (const moment of rest) {
      const list = byMonth.get(moment.month) || [];
      list.push(moment);
      byMonth.set(moment.month, list);
    }
    const months = [...byMonth.entries()];
    state.dailyMonths = months;
    state.dailyRendered = 0;

    el.view.innerHTML = `
      <header class="daily-head">
        <p class="daily-head__eyebrow">${escapeHtml(config.label)} · ${escapeHtml(SECTION_EN[section.id] || section.id.toUpperCase())}</p>
        <div class="daily-head__row">
          <h1 class="daily-head__title">${escapeHtml(section.label)}</h1>
          <span class="daily-head__count">共 ${all.length} 条 · 按月份倒序${pinned.length ? ` · 置顶 ${pinned.length}` : ''}</span>
        </div>
      </header>
      <div class="moment-feed">
        ${pinned.length ? `
          <section class="moment-month moment-month--pinned">
            <h2 class="moment-month__label">置顶</h2>
            ${pinned.map((moment) => renderMoment(moment, true)).join('')}
          </section>` : ''}
        ${renderDailyMonths()}
      </div>
      ${months.length > DAILY_BATCH ? `
        <div class="moment-feed__foot">
          <button class="moment-feed__more" type="button" data-daily-more>
            显示更早的动态 <i>还有 ${months.length - DAILY_BATCH} 个月</i>
          </button>
        </div>` : ''}
    `;
    state.dailyRendered = Math.min(DAILY_BATCH, months.length);
    bindDailyMore();
    void mountInlineInteractions();
  }

  /** 渲染下一批月份的 HTML（含首次批量）。 */
  function renderDailyMonths() {
    const months = state.dailyMonths || [];
    const from = state.dailyRendered || 0;
    const to = Math.min(months.length, from + DAILY_BATCH);
    return months.slice(from, to).map(([month, list]) => `
      <section class="moment-month">
        <h2 class="moment-month__label">
          <span>${escapeHtml(month)}</span>
          <i>${list.length} 条</i>
        </h2>
        ${list.map((moment) => renderMoment(moment)).join('')}
      </section>
    `).join('');
  }

  function bindDailyMore() {
    const button = el.view.querySelector('[data-daily-more]');
    if (!button) return;
    const append = () => {
      const html = renderDailyMonths();
      state.dailyRendered = Math.min((state.dailyMonths || []).length, (state.dailyRendered || 0) + DAILY_BATCH);
      button.closest('.moment-feed__foot').insertAdjacentHTML('beforebegin', html);
      const remaining = (state.dailyMonths || []).length - state.dailyRendered;
      if (remaining <= 0) {
        button.closest('.moment-feed__foot').remove();
        if (state.dailyObserver) {
          state.dailyObserver.disconnect();
          state.dailyObserver = null;
        }
      } else {
        button.querySelector('i').textContent = `还有 ${remaining} 个月`;
      }
      void mountInlineInteractions();
    };
    button.addEventListener('click', append);
    // 滚动到底自动加载
    state.dailyObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        state.dailyObserver.disconnect();
        state.dailyObserver = null;
        append();
        bindDailyMore();
      }
    }, { root: el.main, rootMargin: '160px' });
    state.dailyObserver.observe(button);
  }

  function renderMoment(moment, isPinned = false) {
    const video = moment.video && moment.video.watchUrl
      ? `<a class="moment__video" href="${escapeHtml(moment.video.watchUrl)}" target="_blank" rel="noopener noreferrer">
          ${moment.video.coverUrl ? `<img src="${escapeHtml(moment.video.coverUrl)}" alt="" loading="lazy">` : ''}
          <span class="moment__video-title">${escapeHtml(moment.video.title || moment.video.watchUrl)}</span>
        </a>`
      : '';
    const flags = [
      isPinned || moment.pinned ? '<span class="moment__flag">置顶</span>' : '',
      moment.featured ? '<span class="moment__flag moment__flag--featured">精选</span>' : '',
    ].filter(Boolean).join('');
    return `
      <article class="moment-card${moment.featured ? ' is-featured' : ''}" id="m-${escapeHtml(moment.id)}" data-moment="${escapeHtml(moment.id)}">
        <header class="moment__meta">
          <a class="moment__permalink" href="${escapeHtml(moment.path)}" title="这条动态的独立页面">
            <time>${escapeHtml(formatDate(String(moment.publishedAt).slice(0, 10)))}</time>
          </a>
          ${flags}
          ${(moment.tags || []).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}
        </header>
        <div class="moment__body">${moment.html || `<p>${formatMomentText(moment.text || '')}</p>`}</div>
        ${video}
      </article>
    `;
  }

  /** 时间流里的每条动态各挂一个独立的互动块；计数用一次批量请求取回。 */
  async function mountInlineInteractions() {
    const interactions = window.BifrostInteractions;
    const config = state.siteConfig ? state.siteConfig.interactions : null;
    if (!interactions || typeof interactions.mountInline !== 'function') return;
    // 只挂未挂载过的卡片（分批加载后会重复进入这里）
    const cards = [...el.view.querySelectorAll('[data-moment]')]
      .filter((card) => card.dataset.interactionsMounted !== '1');
    if (!cards.length) return;
    const summaries = typeof interactions.fetchSummaries === 'function'
      ? await interactions.fetchSummaries(cards.map((card) => card.dataset.moment), config)
      : new Map();
    for (const card of cards) {
      // 批量请求期间可能已经切走，跳过已卸载的卡片
      if (!card.isConnected) continue;
      const id = card.dataset.moment;
      card.dataset.interactionsMounted = '1';
      card.append(interactions.mountInline({ entryId: id }, config, state.phase, summaries.get(id) || null));
    }
  }

  // ---------- 系列 ----------

  async function renderSeries(seriesId, memberId = '') {
    const series = seriesById(seriesId);
    if (!series) {
      renderDashboard();
      return;
    }
    const members = seriesMembers(series);
    const active = members.find((member) => member.entryId === memberId) || members[0];
    if (!active) {
      renderDashboard();
      return;
    }
    state.view = 'series';
    state.seriesId = seriesId;
    state.entryId = active.entryId;
    state.section = active.section;
    renderSidebar();

    const nav = `
      <section class="article-surface series-intro">
        <p class="hero__eyebrow">系列 · ${members.length} 篇</p>
        <h1 class="hero__title">${escapeHtml(series.title)}</h1>
        ${series.description ? `<p class="hero__text">${escapeHtml(series.description)}</p>` : ''}
        <nav class="series-nav" aria-label="系列成员">
          ${members.map((member) => `
            <a class="series-nav__item${member.entryId === active.entryId ? ' is-active' : ''}"
               data-action="series-member" data-series="${escapeHtml(series.id)}" data-entry="${escapeHtml(member.entryId)}"
               href="?phase=${state.phase}&series=${encodeURIComponent(series.id)}&entry=${encodeURIComponent(member.entryId)}">${escapeHtml(member.title)}</a>
          `).join('')}
        </nav>
      </section>
    `;
    const body = await fetchEntryBody(active);
    el.view.innerHTML = `${nav}${renderEntryMeta(active)}${body}`;
    applyLayoutAttributes(active);
    mountEntryExtras(active);
    updateTreeActive();
    updateDocumentMeta(series.title, series.description || '');
    el.main.scrollTo({ top: 0 });
  }

  // ---------- 阅读页 ----------

  async function fetchEntryBody(entry) {
    try {
      const response = await fetch(entry.path);
      if (!response.ok) throw new Error(String(response.status));
      return extractFragment(await response.text());
    } catch {
      return renderMessage('这一页暂时没有打开', '稍后再试，或返回总览。');
    }
  }

  function extractFragment(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('script, meta, title, link, style, noscript').forEach((node) => node.remove());
    return doc.body.innerHTML;
  }

  /** 元信息行必须是 .content-viewer 的直接子元素：宽屏有右侧栏时 CSS 会隐藏它。 */
  function renderEntryMeta(entry) {
    const tags = entry.tags || [];
    const minutes = entry.minutes || 1;
    const sectionLabel = sectionMeta(entry.section).label || '';
    return `
      <div class="entry-meta">
        <span class="entry-meta__date">${escapeHtml(formatDate(entry.date))}</span>
        <span>${escapeHtml(sectionLabel)} · 约 ${minutes} 分钟</span>
        ${tags.length ? `<span class="entry-meta__tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
      </div>
    `;
  }

  /** 右侧阅读信息栏与上一篇 / 下一篇：结构补齐后，CSS 里现成的规则就会生效。 */
  function renderReadingGutter(entry) {
    const minutes = entry.minutes || 1;
    const tags = entry.tags || [];
    const gutter = document.createElement('aside');
    gutter.className = `reading-gutter reading-gutter--${entry.layout || 'longform'}`;
    gutter.setAttribute('aria-label', '阅读信息与进度');
    gutter.innerHTML = `
      <div class="reading-gutter__line" aria-hidden="true"><i data-reading-progress-fill></i></div>
      <div class="reading-gutter__meta">
        <span>${escapeHtml(formatDate(entry.date))}</span>
        <span>约 ${minutes} 分钟</span>
        <span>${escapeHtml(sectionMeta(entry.section).label || '')}</span>
      </div>
      ${tags.length ? `<div class="reading-gutter__tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <button class="reading-gutter__top" type="button" data-reading-top>↑<span>回到顶部</span></button>
    `;
    gutter.querySelector('[data-reading-top]').addEventListener('click', () => {
      el.main.scrollTo({ top: 0, behavior: 'smooth' });
    });
    el.view.append(gutter);
  }

  function renderPager(entry) {
    const list = phaseEntries();
    const index = list.findIndex((item) => item.entryId === entry.entryId);
    if (index < 0) return;
    const prev = index > 0 ? list[index - 1] : null;
    const next = index < list.length - 1 ? list[index + 1] : null;
    if (!prev && !next) return;
    const pager = document.createElement('nav');
    pager.className = 'pager';
    pager.innerHTML = `
      ${prev ? `<a data-action="entry" data-entry="${escapeHtml(prev.entryId)}" href="${escapeHtml(prev.path)}"><span class="pager__dir">上一篇</span><span>${escapeHtml(prev.title)}</span></a>` : '<span></span>'}
      ${next ? `<a data-action="entry" data-entry="${escapeHtml(next.entryId)}" href="${escapeHtml(next.path)}"><span class="pager__dir">下一篇</span><span>${escapeHtml(next.title)}</span></a>` : '<span></span>'}
    `;
    el.view.append(pager);
  }

  function mountEntryExtras(entry) {
    renderReadingGutter(entry);
    renderPager(entry);
    mountInteractions(entry);
    window.BifrostMediaPreview?.mount(el.view);
    window.requestAnimationFrame(updateReadingProgress);
  }

  async function openEntry(entryId, options = {}) {
    const entry = entryById(entryId);
    if (!entry) {
      renderDashboard();
      return;
    }
    state.view = 'entry';
    state.entryId = entryId;
    state.section = entry.section;
    state.seriesId = options.seriesId || '';
    writeStored(STORAGE.entry, entryId);
    writeStored(STORAGE.section, entry.section);
    renderSidebar();
    applyLayoutAttributes(entry);

    const series = entry.seriesId ? seriesById(entry.seriesId) : null;
    const note = series && !options.seriesId
      ? `<p class="entry-series-note">属于系列 <a data-action="series" data-series="${escapeHtml(series.id)}" href="${escapeHtml(series.path)}">${escapeHtml(series.title)}</a></p>`
      : '';

    el.view.innerHTML = `${note}${renderEntryMeta(entry)}<p class="hero__text">正在打开…</p>`;
    const body = await fetchEntryBody(entry);
    el.view.innerHTML = `${note}${renderEntryMeta(entry)}${body}`;
    mountEntryExtras(entry);
    updateTreeActive();
    updateDocumentMeta(entry.title, entry.summary || '');
    el.main.scrollTo({ top: 0 });
  }

  function mountInteractions(entry) {
    const interactions = window.BifrostInteractions;
    const config = state.siteConfig ? state.siteConfig.interactions : null;
    if (!interactions) return;
    if (config && config.entryModel !== 'entryId') return;
    interactions.mount(
      { entryId: entry.entryId, path: entry.path, title: entry.title },
      el.view,
      config,
      state.phase,
    );
  }

  let progressFrame = 0;

  function onMainScroll() {
    if (progressFrame) return;
    progressFrame = window.requestAnimationFrame(() => {
      progressFrame = 0;
      updateReadingProgress();
    });
  }

  function updateReadingProgress() {
    const fill = el.view?.querySelector('[data-reading-progress-fill]');
    const article = el.view?.querySelector('.article-surface');
    if (!fill || !article) return;
    const mainRect = el.main.getBoundingClientRect();
    const articleRect = article.getBoundingClientRect();
    const start = articleRect.top - mainRect.top + el.main.scrollTop;
    const end = start + article.offsetHeight - el.main.clientHeight * 0.72;
    const ratio = Math.max(0, Math.min(1, (el.main.scrollTop - start) / Math.max(1, end - start)));
    fill.style.setProperty('--reading-progress', `${(ratio * 100).toFixed(2)}%`);
  }

  // ---------- 路由 ----------

  async function restoreRoute() {
    const url = new URL(window.location.href);
    const urlEntry = url.searchParams.get('entry') || '';
    const urlSection = url.searchParams.get('section') || '';
    const urlSeries = url.searchParams.get('series') || '';
    const explicitPhase = url.searchParams.has('phase');
    // 显式给定位面（但没有指定内容）时回到该位面总览，不恢复上次阅读
    const restoreRead = !urlEntry && !urlSection && !urlSeries && !explicitPhase;
    const entryId = urlEntry || (restoreRead ? readStored(STORAGE.entry) : '');
    const section = urlSection || (restoreRead && !entryId ? readStored(STORAGE.section) : '');

    if (urlSeries && seriesById(urlSeries)) {
      await renderSeries(urlSeries, urlEntry);
      syncUrl({ replace: true });
      return;
    }
    if (entryId && entryById(entryId)) {
      await openEntry(entryId);
      syncUrl({ replace: true });
      return;
    }
    if (entryId && momentById(entryId)) {
      await openMomentDeepLink(entryId);
      return;
    }
    if (section && (phaseConfig(state.phase).sections || []).some((item) => item.id === section)) {
      writeStored(STORAGE.entry, '');
      renderSection(section);
      syncUrl({ replace: true });
      return;
    }
    renderDashboard();
    syncUrl({ replace: true });
  }

  function momentById(id) {
    return (state.index?.moments || []).find((moment) => moment.id === id) || null;
  }

  /** 动态的独立页：回到时间流并定位到那一条。 */
  async function openMomentDeepLink(id) {
    const moment = momentById(id);
    if (!moment) {
      renderDashboard();
      return;
    }
    applyPhase(moment.phase || 'fantasy');
    renderSidebar();
    renderSection(moment.section || 'daily');
    syncUrl({ replace: true, entryId: id });
    const card = el.view.querySelector(`[data-moment="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: 'center' });
      card.classList.add('is-highlighted');
      window.setTimeout(() => card.classList.remove('is-highlighted'), 2000);
    }
  }

  function onPopState() {
    const url = new URL(window.location.href);
    const phase = url.searchParams.get('phase');
    if (phase && phase !== state.phase) applyPhase(phase);
    const series = url.searchParams.get('series');
    const entryId = url.searchParams.get('entry');
    const section = url.searchParams.get('section');
    if (series) renderSeries(series, entryId || '');
    else if (entryId && entryById(entryId)) openEntry(entryId);
    else if (section) renderSection(section);
    else renderDashboard();
    renderSidebar();
  }

  function syncUrl({ replace = false, entryId = '' } = {}) {
    const url = new URL(window.location.href);
    url.searchParams.set('phase', state.phase);
    url.searchParams.delete('series');
    url.searchParams.delete('entry');
    url.searchParams.delete('section');
    if (state.view === 'series' && state.seriesId) {
      url.searchParams.set('series', state.seriesId);
      url.searchParams.set('entry', entryId || state.entryId);
    } else if (state.view === 'entry' && state.entryId) {
      url.searchParams.set('entry', state.entryId);
    } else if (state.view === 'section' && state.section) {
      url.searchParams.set('section', state.section);
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
      writeStored(STORAGE.entry, '');
      renderSection(link.dataset.section);
      syncUrl();
    } else if (action === 'entry') {
      openEntry(link.dataset.entry).then(() => syncUrl());
    } else if (action === 'moment') {
      openMomentDeepLink(link.dataset.moment);
    } else if (action === 'search-all') {
      openSearch();
    } else if (action === 'series') {
      renderSeries(link.dataset.series).then(() => syncUrl());
    } else if (action === 'series-member') {
      openEntry(link.dataset.entry, { seriesId: link.dataset.series }).then(() => syncUrl());
    }
  }

  // ---------- 搜索 ----------

  let searchTimer = 0;
  let searchToken = 0;

  function searchEndpoint() {
    const config = state.siteConfig ? state.siteConfig.search : null;
    if (!config || config.enabled === false || !config.apiBaseUrl) return '';
    return String(config.apiBaseUrl).replace(/\/+$/, '');
  }

  function searchDocs() {
    // 索引未就绪时（启动瞬间按 Ctrl/K）返回空表，面板降级为空态而不是抛错
    const entries = (state.index?.entries || []).map((entry) => ({
      kind: 'entry',
      id: entry.entryId,
      path: entry.path,
      title: entry.title,
      summary: entry.summary,
      phase: entry.phase,
      section: entry.section,
      tags: entry.tags || [],
      date: entry.date,
      // searchText 由物化管线写入（正文前 800 字）；缺省时退回标题+摘要+标签
      text: `${entry.title}\n${entry.summary || ''}\n${(entry.tags || []).join(' ')}\n${entry.searchText || ''}`,
    }));
    const moments = (state.index?.moments || []).map((moment) => ({
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

  const RECENT_SEARCH_KEY = 'bifrost:recent-searches';
  const TIME_FACETS = [
    { key: 'week', label: '近一周', days: 7 },
    { key: 'month', label: '近一月', days: 31 },
    { key: 'quarter', label: '近三月', days: 92 },
    { key: 'year', label: '今年', days: 366 },
  ];

  function isApplePlatform() {
    const source = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
    return /Mac|iPhone|iPad|iPod/i.test(String(source));
  }

  function readRecentSearches() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) || '[]');
      return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  function saveRecentSearch(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return;
    const list = readRecentSearches().filter((item) => item !== trimmed);
    list.unshift(trimmed);
    try {
      localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(list.slice(0, 5)));
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function clearRecentSearches() {
    try {
      localStorage.removeItem(RECENT_SEARCH_KEY);
    } catch {
      /* 忽略 */
    }
  }

  function fromDateFor(key) {
    const hit = TIME_FACETS.find((item) => item.key === key);
    if (!hit) return '';
    return new Date(Date.now() - hit.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  /** 转义后高亮查询词；剔除会破坏 HTML 实体的字符，避免 mark 截断 &amp; 这类转义序列。 */
  function highlightText(text, query) {
    const escaped = escapeHtml(text);
    const safe = String(query || '').replace(/[&<>"'\s]*$/g, '').replace(/[.*+?^${}()|[\]\\&<>"']/g, '');
    if (!safe) return escaped;
    try {
      return escaped.replace(new RegExp(safe, 'gi'), (match) => `<mark>${match}</mark>`);
    } catch {
      return escaped;
    }
  }

  function snippetAround(text, query, radius = 72) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!query) return source.slice(0, radius);
    const index = source.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) return '';
    const start = Math.max(0, index - Math.floor(radius / 3));
    const end = Math.min(source.length, start + radius);
    return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
  }

  /** 检索服务返回的片段已经用 <mark> 标出命中：整体转义后再把标记还原，避免当成正文显示。 */
  function renderSnippet(snippet, query) {
    const raw = String(snippet || '');
    if (raw.includes('<mark>')) {
      return escapeHtml(raw)
        .replaceAll('&lt;mark&gt;', '<mark>')
        .replaceAll('&lt;/mark&gt;', '</mark>');
    }
    return highlightText(raw, query);
  }

  function renderSearchSkeleton() {
    el.searchResults.innerHTML = `
      <div class="search-skeleton" aria-hidden="true">
        ${'<span class="search-skeleton__row"></span>'.repeat(5)}
      </div>`;
  }

  function openSearch() {
    closePanels();
    el.searchPanel.classList.add('is-active');
    state.query = '';
    state.facets = { phase: state.phase, section: '', type: '', from: '', tags: new Set() };
    state.showAllTags = false;
    state.searchMeta = null;
    if (el.searchInput) el.searchInput.value = '';
    void runSearch();
    window.setTimeout(() => el.searchInput?.focus(), 0);
  }

  function scheduleSearch() {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void runSearch();
    }, 180);
  }

  async function runSearch() {
    const activeQuery = state.query.trim();
    // 空态：没有关键词、也没有收窄条件时不打远程，只展示最近搜索与热门标签
    const narrowed = Boolean(state.facets.section || state.facets.type || state.facets.from || state.facets.tags.size);
    if (!activeQuery && !narrowed) {
      searchToken += 1;
      state.results = [];
      state.activeIndex = 0;
      state.searchMeta = null;
      renderSearchFacets(localFacetCounts());
      renderSearchResults();
      return;
    }
    const endpoint = searchEndpoint();
    if (!endpoint) {
      renderSearchLocal();
      return;
    }
    const token = (searchToken += 1);
    const params = new URLSearchParams();
    const query = activeQuery;
    if (query) params.set('q', query);
    if (state.facets.phase) params.set('phase', state.facets.phase);
    if (state.facets.section) params.set('section', state.facets.section);
    if (state.facets.type) params.set('type', state.facets.type === 'moment' ? 'moment' : 'article');
    if (state.facets.from) params.set('from', fromDateFor(state.facets.from));
    if (state.facets.tags.size) params.set('tags', [...state.facets.tags].join(','));
    params.set('limit', String(SEARCH_LIMIT));
    if (token === searchToken) renderSearchSkeleton();
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
      state.searchMeta = { total: typeof payload.total === 'number' ? payload.total : state.results.length, source: 'remote' };
      renderSearchFacets(payload.facets || {});
      renderSearchResults();
    } catch {
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
      snippet: doc.snippet || '',
    };
  }

  function renderSearchFacets(facetCounts) {
    state.lastFacetCounts = facetCounts;
    const countOf = (name, value) => {
      const hit = (facetCounts[name] || []).find((item) => item.value === value);
      return hit ? hit.count : 0;
    };
    const sections = Object.values(state.index?.sections || {})
      .filter((section) => !state.facets.phase || section.phase === state.facets.phase);
    const tagLimit = state.showAllTags ? 40 : 12;
    const tags = (facetCounts.tags || []).slice(0, tagLimit);
    const tagTotal = (facetCounts.tags || []).length;
    const typeCountOf = (kind) => countOf('entryType', kind === 'moment' ? 'moment' : 'article');
    el.searchFacets.innerHTML = `
      <div class="facet-row">
        <span class="facet-label">位面</span>
        ${(state.index?.phases || []).map((phase) => `<button class="facet${state.facets.phase === phase.id ? ' is-on' : ''}" data-facet="phase" data-value="${escapeHtml(phase.id)}">${escapeHtml(phase.label)}${countOf('phase', phase.id) ? ` <i>${countOf('phase', phase.id)}</i>` : ''}</button>`).join('')}
      </div>
      <div class="facet-row">
        <span class="facet-label">类型</span>
        <button class="facet${state.facets.type ? '' : ' is-on'}" data-facet="type" data-value="">全部</button>
        <button class="facet${state.facets.type === 'entry' ? ' is-on' : ''}" data-facet="type" data-value="entry">文章${typeCountOf('entry') ? ` <i>${typeCountOf('entry')}</i>` : ''}</button>
        <button class="facet${state.facets.type === 'moment' ? ' is-on' : ''}" data-facet="type" data-value="moment">动态${typeCountOf('moment') ? ` <i>${typeCountOf('moment')}</i>` : ''}</button>
      </div>
      <div class="facet-row">
        <span class="facet-label">分区</span>
        <button class="facet${state.facets.section ? '' : ' is-on'}" data-facet="section" data-value="">全部</button>
        ${sections.map((section) => `<button class="facet${state.facets.section === section.id ? ' is-on' : ''}" data-facet="section" data-value="${escapeHtml(section.id)}">${escapeHtml(section.label)}${countOf('section', section.id) ? ` <i>${countOf('section', section.id)}</i>` : ''}</button>`).join('')}
      </div>
      <div class="facet-row">
        <span class="facet-label">时间</span>
        <button class="facet${state.facets.from ? '' : ' is-on'}" data-facet="from" data-value="">任何时间</button>
        ${TIME_FACETS.map((item) => `<button class="facet${state.facets.from === item.key ? ' is-on' : ''}" data-facet="from" data-value="${item.key}">${item.label}</button>`).join('')}
      </div>
      <div class="facet-row">
        <span class="facet-label">标签</span>
        ${tags.length
          ? tags.map((tag) => `<button class="facet${state.facets.tags.has(tag.value) ? ' is-on' : ''}" data-facet="tag" data-value="${escapeHtml(tag.value)}">${escapeHtml(tag.value)} <i>${tag.count}</i></button>`).join('')
          : '<span class="facet-label">暂无</span>'}
        ${tagTotal > 12 ? `<button class="facet facet--more" data-facet="tags-more">${state.showAllTags ? '收起' : `显示全部 ${tagTotal}`}</button>` : ''}
      </div>
    `;
  }

  function renderSearchIdle() {
    const recent = readRecentSearches();
    const tags = (state.index?.tags || []).slice(0, 10);
    return `
      ${recent.length ? `
        <div class="search-idle">
          <div class="search-idle__head">
            <span class="facet-label">最近搜索</span>
            <button class="search-idle__clear" type="button" data-search-clear-recent>清空</button>
          </div>
          <div class="search-idle__chips">
            ${recent.map((item) => `<button class="facet" type="button" data-recent="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')}
          </div>
        </div>` : ''}
      ${tags.length ? `
        <div class="search-idle">
          <div class="search-idle__head"><span class="facet-label">热门标签</span></div>
          <div class="search-idle__chips">
            ${tags.map((tag) => `<button class="facet" type="button" data-hot-tag="${escapeHtml(tag.label)}">${escapeHtml(tag.label)} <i>${tag.count}</i></button>`).join('')}
          </div>
        </div>` : ''}
      ${recent.length || tags.length ? '' : '<p class="command-empty">输入关键词开始搜索。</p>'}
    `;
  }

  function renderSearchResults() {
    const query = state.query.trim();
    const meta = state.searchMeta || {};
    const head = `
      <div class="search-meta${state.results.length ? '' : ' search-meta--empty'}">
        <span>${meta.total != null ? `找到 ${meta.total} 条` : ''}</span>
        ${meta.source === 'local' ? '<span class="search-meta__note">检索服务不可用，已切换本地搜索</span>' : ''}
      </div>`;
    if (!query && !state.results.length) {
      el.searchResults.innerHTML = head + renderSearchIdle();
      return;
    }
    el.searchResults.innerHTML = state.results.length
      ? head + state.results.map((doc, index) => `
          <a class="command-item${index === 0 ? ' is-active' : ''}" data-result-index="${index}" data-path="${escapeHtml(doc.path)}" data-id="${escapeHtml(doc.id)}" data-kind="${escapeHtml(doc.kind)}">
            <i class="command-item__dot" data-phase="${escapeHtml(doc.phase || '')}" aria-hidden="true"></i>
            <span class="command-item__main">
              <span class="command-item__label">${highlightText(doc.title, query)}</span>
              <span class="command-item__hint">${escapeHtml([formatDate(doc.date), sectionMeta(doc.section).label, ...(doc.tags || []).slice(0, 2)].filter(Boolean).join(' · '))}</span>
              ${doc.snippet ? `<span class="command-item__snippet">${renderSnippet(doc.snippet, query)}</span>` : ''}
            </span>
          </a>
        `).join('')
      : head + '<p class="command-empty">没有匹配的内容。换个关键词，或减少几个筛选条件试试。</p>';
  }

  function renderSearchLocal() {
    const docs = searchDocs();
    const query = state.query.trim().toLowerCase();
    const fromIso = state.facets.from ? fromDateFor(state.facets.from) : '';
    const results = docs.filter((doc) => {
      if (state.facets.phase && doc.phase !== state.facets.phase) return false;
      if (state.facets.section && doc.section !== state.facets.section) return false;
      if (state.facets.type && doc.kind !== state.facets.type) return false;
      if (fromIso && doc.date && String(doc.date) < fromIso) return false;
      for (const tag of state.facets.tags) {
        if (!doc.tags.includes(tag)) return false;
      }
      if (!query) return true;
      return doc.text.toLowerCase().includes(query);
    });
    state.results = results.slice(0, SEARCH_LIMIT).map((doc) => ({
      ...doc,
      snippet: query ? snippetAround(doc.text, state.query.trim()) : '',
    }));
    state.activeIndex = 0;
    state.searchMeta = { total: results.length, source: 'local' };

    renderSearchFacets(localFacetCounts());
    renderSearchResults();
  }

  /** 本地分面计数：空态与降级搜索共用，避免为了分面每次都打一次远程请求。 */
  function localFacetCounts() {
    const docs = searchDocs();
    const visible = docs.filter((doc) => !state.facets.phase || doc.phase === state.facets.phase);
    const tagCounts = new Map();
    for (const doc of visible) {
      for (const tag of doc.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    return {
      phase: (state.index?.phases || []).map((phase) => ({ value: phase.id, count: phaseEntries(phase.id).length })),
      entryType: [
        { value: 'article', count: visible.filter((doc) => doc.kind === 'entry').length },
        { value: 'moment', count: visible.filter((doc) => doc.kind === 'moment').length },
      ],
      section: [...new Set(docs.map((doc) => doc.section))].map((section) => ({ value: section, count: docs.filter((doc) => doc.section === section).length })),
      tags: topTags.map(([value, count]) => ({ value, count })),
    };
  }

  function onFacetClick(event) {
    const button = event.target.closest('[data-facet]');
    if (!button) return;
    const { facet, value } = button.dataset;
    if (facet === 'phase') state.facets.phase = value;
    else if (facet === 'section') state.facets.section = value;
    else if (facet === 'type') state.facets.type = value;
    else if (facet === 'from') state.facets.from = value;
    else if (facet === 'tag') {
      if (state.facets.tags.has(value)) state.facets.tags.delete(value);
      else state.facets.tags.add(value);
    } else if (facet === 'tags-more') {
      state.showAllTags = !state.showAllTags;
      renderSearchFacets(state.lastFacetCounts || {});
      return;
    }
    void runSearch();
  }

  function onSearchResultsClick(event) {
    if (event.target.closest('[data-search-clear-recent]')) {
      clearRecentSearches();
      renderSearchResults();
      return;
    }
    const recent = event.target.closest('[data-recent]');
    if (recent) {
      state.query = recent.dataset.recent;
      if (el.searchInput) el.searchInput.value = state.query;
      void runSearch();
      return;
    }
    const hotTag = event.target.closest('[data-hot-tag]');
    if (hotTag) {
      state.facets.tags.add(hotTag.dataset.hotTag);
      void runSearch();
      return;
    }
    const result = event.target.closest('[data-result-index]');
    if (result) {
      activateResult(Number(result.dataset.resultIndex));
    }
  }

  function onPhasePanelClick(event) {
    const phaseItem = event.target.closest('[data-phase-id]');
    if (phaseItem) {
      closePanels();
      if (phaseItem.dataset.phaseId === 'admin') {
        window.location.href = '/admin.html';
        return;
      }
      switchPhase(phaseItem.dataset.phaseId);
      return;
    }
    if (event.target === el.phasePanel) closePanels();
  }

  async function activateResult(index) {
    const doc = state.results[index];
    if (!doc) return;
    saveRecentSearch(state.query);
    closePanels();
    if (doc.phase !== state.phase) {
      applyPhase(doc.phase);
      renderSidebar();
    }
    if (doc.kind === 'moment') {
      renderSection(doc.section);
      syncUrl();
      const card = el.view.querySelector(`[data-moment="${CSS.escape(doc.id)}"]`);
      card?.scrollIntoView({ block: 'center' });
      if (card) {
        card.classList.add('is-highlighted');
        window.setTimeout(() => card.classList.remove('is-highlighted'), 2000);
      }
      return;
    }
    await openEntry(doc.id);
    syncUrl();
  }

  function onSearchKeyDown(event) {
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

  // ---------- 位面面板（~） ----------

  const PHASE_COMMANDS = {
    logic: 'logic',
    reset: 'logic',
    shutdown: 'logic',
    fantasy: 'fantasy',
    'set up!': 'fantasy',
    setup: 'fantasy',
    admin: 'admin',
    管理: 'admin',
  };

  function openPhasePanel() {
    closePanels();
    el.phasePanel.classList.add('is-active');
    el.phasePanel.innerHTML = `
      <div class="command-panel phase-panel">
        <input class="command-input" data-phase-input type="text" autocomplete="off" placeholder="输入 logic / fantasy 切换位面，admin 进管理台">
        <div class="command-results" data-phase-results></div>
        <p class="command-help">↑↓ 选择 · Enter 确认 · Esc 关闭</p>
      </div>
    `;
    el.phaseInput = el.phasePanel.querySelector('[data-phase-input]');
    el.phaseResults = el.phasePanel.querySelector('[data-phase-results]');
    state.phaseIndex = 0;
    renderPhaseResults('');
    window.setTimeout(() => el.phaseInput?.focus(), 0);
  }

  function phaseCommandMatches(query) {
    const items = [];
    const names = Object.keys(PHASE_COMMANDS);
    for (const name of names) {
      if (query && !name.includes(query)) continue;
      const phase = PHASE_COMMANDS[name];
      if (items.some((item) => item.phase === phase)) continue;
      const label = phase === 'fantasy' ? 'Fantasy 位面'
        : phase === 'admin' ? '管理台'
          : 'Logic 位面';
      const hint = phase === 'admin' ? `输入 ${name} · 需 Microsoft 登录` : `输入 ${name}`;
      items.push({ phase, label, hint });
    }
    return items.slice(0, 4);
  }

  function renderPhaseResults(query) {
    const list = phases();
    const matched = phaseCommandMatches(query.trim().toLowerCase());
    const items = matched.length
      ? matched
      : list.map((phase) => ({ phase: phase.id, label: `${phase.label} 位面`, hint: phase.id === state.phase ? '当前' : `${(phase.sections || []).length} 个分区` }));
    state.phaseItems = items;
    if (state.phaseIndex >= items.length) state.phaseIndex = 0;
    el.phaseResults.innerHTML = items.length
      ? items.map((item, index) => `
          <a class="command-item${index === state.phaseIndex ? ' is-active' : ''}" data-phase-id="${escapeHtml(item.phase)}" data-phase-index="${index}">
            <span class="command-item__label">${escapeHtml(item.label)}</span>
            <span class="command-item__hint">${escapeHtml(item.hint || '')}</span>
          </a>
        `).join('')
      : '<p class="command-empty">没有匹配的命令。</p>';
  }

  function onPhaseInput(event) {
    if (!event.target.matches('[data-phase-input]')) return;
    state.phaseIndex = 0;
    renderPhaseResults(event.target.value);
  }

  function onPhaseKeyDown(event) {
    if (event.key === 'Escape') {
      closePanels();
      return;
    }
    const items = state.phaseItems || [];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.phaseIndex = (state.phaseIndex + delta + items.length) % items.length;
      el.phaseResults.querySelectorAll('.command-item').forEach((node, index) => {
        node.classList.toggle('is-active', index === state.phaseIndex);
      });
      el.phaseResults.querySelector('.command-item.is-active')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[state.phaseIndex];
      if (item) {
        closePanels();
        if (item.phase === 'admin') {
          window.location.href = '/admin.html';
          return;
        }
        switchPhase(item.phase);
      }
    }
  }

  function closePanels() {
    const active = document.activeElement;
    el.searchPanel?.classList.remove('is-active');
    el.phasePanel?.classList.remove('is-active');
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

  function updateStatusNote() {
    const style = PHASE_STYLE[state.phase] || PHASE_STYLE.logic;
    if (el.statusText) el.statusText.textContent = style.status;
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

  function renderMessage(title, text) {
    return `
      <section class="article-surface">
        <p class="hero__eyebrow">BIFROST</p>
        <h2 class="hero__title">${escapeHtml(title)}</h2>
        <p class="hero__text">${escapeHtml(text)}</p>
      </section>
    `;
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
