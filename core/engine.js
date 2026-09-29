const STORAGE_KEYS = {
  phase: 'bifrost:phase',
  path: 'bifrost:path',
  scroll: 'bifrost:scroll',
};

const ENTRIES_URL = '/data/entries.json';
const SITE_CONFIG_URL = '/data/site.json';

const PHASES = {
  logic: {
    label: 'Logic',
    pill: 'LOGIC · STABLE',
    title: 'LOGIC ARCHIVE',
    subtitle: '把复杂的事拆开，慢慢记下来。',
    hint: '按 Ctrl/Cmd+K 搜索或切换位面',
    status: '技术整理与项目记录还在收拢，留下的内容会慢慢出现在这里。',
    footer: 'Logic 位面',
    boot: [
      '点亮 Logic 的档案灯…',
      '整理目录与近作…',
      '准备阅读界面…',
    ],
    themeColor: '#0a0f14',
    bridgeColor: 'rgba(121, 201, 192, 0.24)',
    dashboardUrl: '/content/dashboards/logic-dash.html',
    sections: [
      { id: 'overview', label: '总览' },
      { id: 'tech', label: '技术笔记' },
      { id: 'project', label: '工程记录' },
      { id: 'log', label: '整理日志' },
    ],
  },
  fantasy: {
    label: 'Fantasy',
    pill: 'FANTASY · REVERIE',
    title: '幻想回廊',
    subtitle: '把读过的、想过的，慢慢留在这里。',
    hint: '按 Ctrl/Cmd+K 搜索或切换位面',
    status: '书架已经掸过灰，新的阅读、活动与手记会陆续到来。',
    footer: 'Fantasy 位面',
    boot: [
      '点亮回廊灯火…',
      '拂去书架浮尘…',
      '准备阅读界面…',
    ],
    themeColor: '#f6f0e7',
    bridgeColor: 'rgba(185, 122, 131, 0.28)',
    dashboardUrl: '/content/dashboards/fantasy-dash.html',
    sections: [
      { id: 'overview', label: '总览' },
      { id: 'daily', label: '日常' },
      { id: 'activity', label: '活动' },
      { id: 'review', label: '评论' },
      { id: 'essay', label: '随笔' },
    ],
  },
};

// 键顺序决定搜索命中多个别名时的展示顺序，与默认相位保持一致：Logic 在前
const COMMAND_PHASES = {
  logic: 'logic',
  reset: 'logic',
  shutdown: 'logic',
  fantasy: 'fantasy',
  'set up!': 'fantasy',
  setup: 'fantasy',
};

const PUBLIC_COMMANDS = {
  logic: 'logic',
  fantasy: 'fantasy',
};

const IMAGE_LAYOUTS = ['uniform56', 'editorial56', 'editorial64'];

const state = {
  phase: 'logic',
  currentPath: '',
  readingLayout: 'column',
  imageLayout: 'uniform64',
  bootPlayed: false,
  treeData: null,
  treeQuery: '',
  entries: [],
  siteConfig: {},
  paletteItems: [],
  paletteIndex: 0,
};

const elements = {};

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('popstate', onPopState);

async function init() {
  cacheElements();
  bindGlobalEvents();
  state.readingLayout = 'magazine';
  state.imageLayout = resolveImageLayout();
  elements.html.dataset.readingLayout = state.readingLayout;
  elements.html.dataset.imageLayout = state.imageLayout;

  state.phase = resolvePhase();
  applyPhase(state.phase);
  initAmbience();

  if (!hasPersistentState()) {
    playBootSequence();
  }

  try {
    await loadEntries();
  } catch (_error) {
    state.entries = [];
  }

  try {
    await loadSiteConfig();
  } catch (_error) {
    state.siteConfig = {};
  }

  renderNavigation();
  updateStatusNote();
  window.setInterval(updateFooterClock, 1000);

  const initialPath = resolveInitialPath();
  if (initialPath) {
    await openRoute(initialPath, { pushState: false, remember: false });
  } else {
    await openDashboard({ pushState: false });
  }

  syncUrl({
    replace: true,
    path: state.currentPath && !state.currentPath.includes('/content/dashboards/') ? state.currentPath : '',
  });
}

function resolveImageLayout() {
  const requested = new URL(window.location.href).searchParams.get('images');
  return IMAGE_LAYOUTS.includes(requested) ? requested : 'editorial56';
}

function cacheElements() {
  elements.html = document.documentElement;
  elements.body = document.body;
  elements.siteTitle = document.querySelector('[data-site-title]');
  elements.siteSubtitle = document.querySelector('[data-site-subtitle]');
  elements.phasePill = document.querySelector('[data-phase-pill]');
  elements.phaseHint = document.querySelector('[data-phase-hint]');
  elements.tree = document.querySelector('[data-tree]');
  elements.viewer = document.querySelector('[data-content-viewer]');
  elements.main = document.querySelector('.main');
  elements.footerStatus = document.querySelector('[data-footer-status]');
  elements.footerClock = document.querySelector('[data-footer-clock]');
  elements.statusText = document.querySelector('[data-status-text]');
  elements.statusTitle = document.querySelector('[data-status-title]');
  elements.themeColor = document.querySelector('meta[name="theme-color"]');
  elements.bootBar = document.querySelector('[data-boot-bar]');
  elements.commandOverlay = document.querySelector('[data-command-overlay]');
  elements.commandInput = document.querySelector('[data-command-input]');
  elements.commandResults = document.querySelector('[data-command-results]');
  elements.bootOverlay = document.querySelector('[data-boot-overlay]');
  elements.bootLog = document.querySelector('[data-boot-log]');
  elements.soundToggle = document.querySelector('[data-sound-toggle]');
  elements.soundLabel = document.querySelector('[data-sound-label]');
}

function bindGlobalEvents() {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  elements.commandInput.addEventListener('keydown', onCommandKeyDown);
  elements.commandInput.addEventListener('input', onCommandInput);
  elements.commandOverlay.addEventListener('click', onCommandOverlayClick);
  elements.main.addEventListener('scroll', onMainScroll, { passive: true });
  elements.tree.addEventListener('input', onTreeSearchInput);
  if (elements.soundToggle) {
    elements.soundToggle.addEventListener('click', onSoundToggle);
  }
  document.addEventListener('pointerdown', onFirstInteraction, { once: true });
}

function onCommandInput() {
  renderPaletteResults(elements.commandInput.value);
}

function onCommandOverlayClick(event) {
  if (event.target === elements.commandOverlay) {
    closeCommandOverlay();
    return;
  }

  const item = event.target.closest('[data-palette-index]');
  if (item) {
    activatePaletteItem(Number(item.dataset.paletteIndex));
  }
}

let scrollSaveTimer = 0;

function onMainScroll() {
  updateReadingProgress();
  if (scrollSaveTimer) {
    return;
  }

  scrollSaveTimer = window.setTimeout(() => {
    scrollSaveTimer = 0;
    saveScrollPosition();
  }, 250);
}

function saveScrollPosition() {
  if (!state.currentPath || state.currentPath.includes('/content/dashboards/')) {
    return;
  }

  const payload = {
    path: state.currentPath,
    top: Math.round(elements.main.scrollTop),
  };
  localStorage.setItem(STORAGE_KEYS.scroll, JSON.stringify(payload));
}

function restoreScrollPosition(path) {
  const raw = localStorage.getItem(STORAGE_KEYS.scroll);
  let savedTop = 0;

  if (raw) {
    try {
      const saved = JSON.parse(raw);
      if (saved && saved.path === path && typeof saved.top === 'number' && saved.top > 0) {
        savedTop = saved.top;
      }
    } catch (_error) {
      savedTop = 0;
    }
  }

  elements.main.scrollTop = savedTop;
}

function resolvePhase() {
  const url = new URL(window.location.href);
  const urlPhase = normalizePhase(url.searchParams.get('phase'));
  const urlPath = normalizeStoredPath(url.searchParams.get('path'));
  const storedPhase = normalizePhase(localStorage.getItem(STORAGE_KEYS.phase));
  const storedPath = normalizeStoredPath(localStorage.getItem(STORAGE_KEYS.path));

  if (urlPhase) {
    return urlPhase;
  }

  if (urlPath) {
    return phaseFromPath(urlPath);
  }

  if (storedPhase) {
    return storedPhase;
  }

  if (storedPath) {
    return phaseFromPath(storedPath);
  }

  return 'logic';
}

function resolveInitialPath() {
  const url = new URL(window.location.href);
  const urlPath = normalizeStoredPath(url.searchParams.get('path'));
  if (urlPath) {
    return urlPath;
  }

  const storedPath = normalizeStoredPath(localStorage.getItem(STORAGE_KEYS.path));
  if (storedPath && phaseFromPath(storedPath) === state.phase) {
    return storedPath;
  }

  return '';
}

function normalizePhase(value) {
  if (value === 'fantasy') {
    return 'fantasy';
  }

  if (value === 'logic') {
    return 'logic';
  }

  return '';
}

function normalizeStoredPath(value) {
  if (!value) {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function phaseFromPath(path) {
  if (path.startsWith('/content/fantasy/') || path.startsWith('/content/dashboards/fantasy')) {
    return 'fantasy';
  }

  if (path.startsWith('/content/logic/') || path.startsWith('/content/dashboards/logic')) {
    return 'logic';
  }

  return state.phase;
}

function hasPersistentState() {
  return Boolean(localStorage.getItem(STORAGE_KEYS.phase) || localStorage.getItem(STORAGE_KEYS.path));
}

function applyPhase(phase) {
  const config = PHASES[phase];
  elements.html.dataset.phase = phase;
  elements.body.classList.toggle('phase-fantasy', phase === 'fantasy');
  elements.siteTitle.textContent = config.title;
  elements.siteSubtitle.textContent = config.subtitle;
  elements.phasePill.textContent = config.pill;
  elements.phaseHint.textContent = config.hint;
  elements.footerStatus.textContent = config.footer;
  if (elements.themeColor) {
    elements.themeColor.setAttribute('content', config.themeColor);
  }
  if (window.BifrostAmbience) {
    window.BifrostAmbience.setPhase(phase);
  }
  if (window.BifrostInteractions) {
    window.BifrostInteractions.setPhase(phase);
  }
  updateStatusNote();
  updateFooterClock();
  localStorage.setItem(STORAGE_KEYS.phase, phase);
}

function updateStatusNote() {
  const config = PHASES[state.phase];
  if (elements.statusText) {
    elements.statusText.textContent = config.status;
  }

  const latest = phaseEntries(state.phase)[0];
  if (elements.statusTitle) {
    elements.statusTitle.textContent = latest ? `更新于 ${formatDate(latest.date)}` : '更新于 —';
  }
}

function updateFooterClock() {
  if (!elements.footerClock) {
    return;
  }

  const now = new Date();
  if (state.phase === 'logic') {
    const pad = (value) => String(value).padStart(2, '0');
    elements.footerClock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return;
  }

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  elements.footerClock.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${weekdays[now.getDay()]}`;
}

function onTreeSearchInput(event) {
  if (!event.target.matches('[data-tree-search]')) {
    return;
  }
  state.treeQuery = event.target.value;
  renderNavigation({ preserveFocus: true, selectionStart: event.target.selectionStart });
}

function entrySearchText(entry) {
  return [
    entry.label,
    entry.summary,
    entry.category,
    entry.sectionLabel,
    ...(entry.tags || []),
    String(entry.date || '').slice(0, 4),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function renderNavigation({ preserveFocus = false, selectionStart = null } = {}) {
  if (!elements.tree) {
    return;
  }
  const phaseConfig = PHASES[state.phase];
  const query = state.treeQuery.trim().toLowerCase();
  const allEntries = phaseEntries(state.phase);
  const activePath = state.currentPath || '';

  if (query) {
    const matches = allEntries.filter((entry) => entrySearchText(entry).includes(query));
    elements.tree.innerHTML = `
      <input class="tree__search" type="search" data-tree-search value="${escapeHtml(state.treeQuery)}" placeholder="搜索标题、标签或年份" aria-label="搜索当前位面的文章">
      <p class="tree__search-meta">${matches.length} 条匹配</p>
      <div class="tree__flat">
        ${matches
          .map(
            (entry) => `
              <a class="tree__link tree__link--result${entry.path === activePath ? ' is-active' : ''}" href="${escapeHtml(entry.path)}" data-path="${escapeHtml(entry.path)}">
                <span>${escapeHtml(entry.label)}</span>
                <small>${escapeHtml(entry.sectionLabel || entry.category || '')} · ${escapeHtml(formatDate(entry.date))}</small>
              </a>
            `,
          )
          .join('')}
      </div>
    `;
  } else {
    const sections = phaseConfig.sections
      .map((section, index) => {
        const items = section.id === 'overview'
          ? [
              {
                label: `${phaseConfig.label} 总览`,
                path: phaseConfig.dashboardUrl,
              },
            ]
          : allEntries
              .filter((entry) => entry.section === section.id)
              .map((entry) => ({ label: entry.label, path: entry.path }));
        const count = section.id === 'overview' ? 0 : items.length;
        const hasActive = items.some((item) => item.path === activePath);
        return `
          <details class="tree__section"${hasActive || (!activePath && index === 0) ? ' open' : ''}>
            <summary>
              <span>${escapeHtml(section.label)}</span>
              ${count ? `<span class="tree__count">${count}</span>` : ''}
            </summary>
            <div class="tree__items">
              ${items
                .map(
                  (item) => `
                    <a class="tree__link${item.path === activePath ? ' is-active' : ''}" href="${escapeHtml(item.path)}" data-path="${escapeHtml(item.path)}">${escapeHtml(item.label)}</a>
                  `,
                )
                .join('')}
            </div>
          </details>
        `;
      })
      .join('');
    elements.tree.innerHTML = `
      <input class="tree__search" type="search" data-tree-search value="${escapeHtml(state.treeQuery)}" placeholder="搜索标题、标签或年份" aria-label="搜索当前位面的文章">
      <div class="tree__sections">${sections}</div>
    `;
  }

  if (preserveFocus) {
    const input = elements.tree.querySelector('[data-tree-search]');
    if (input) {
      input.focus();
      if (typeof selectionStart === 'number') {
        input.setSelectionRange(selectionStart, selectionStart);
      }
    }
  }
}

async function loadEntries() {
  const response = await fetch(ENTRIES_URL);
  if (!response.ok) {
    throw new Error(`Failed to load entries: ${response.status}`);
  }

  const payload = await response.json();
  state.entries = Array.isArray(payload.entries) ? payload.entries : [];
}

async function loadSiteConfig() {
  const response = await fetch(SITE_CONFIG_URL);
  if (!response.ok) {
    throw new Error(`Failed to load site config: ${response.status}`);
  }

  const payload = await response.json();
  state.siteConfig = payload && typeof payload === 'object' ? payload : {};
}

// ---------- 环境音 ----------

const SOUND_LABELS = {
  off: '环境音 关闭',
  pending: '环境音 点击启动',
  on: '环境音 开启',
};

function initAmbience() {
  const ambience = window.BifrostAmbience;
  if (!ambience) {
    return;
  }

  ambience.restore((status) => renderSoundState(status));
  ambience.setPhase(state.phase);
}

function renderSoundState(status) {
  if (!elements.soundToggle) {
    return;
  }

  elements.soundLabel.textContent = SOUND_LABELS[status] || SOUND_LABELS.off;
  elements.soundToggle.dataset.soundState = status;
  elements.soundToggle.setAttribute('aria-pressed', String(status !== 'off'));
}

async function onSoundToggle() {
  const ambience = window.BifrostAmbience;
  if (!ambience) {
    return;
  }

  // 上次访问开着环境音时按钮显示"点击启动"：这一次点击应当开始播放，而不是关掉它
  if (ambience.status() === 'pending') {
    await ambience.resume();
    return;
  }

  await ambience.toggle();
}

function onFirstInteraction(event) {
  const ambience = window.BifrostAmbience;
  if (!ambience || !ambience.isEnabled()) {
    return;
  }

  // 开关自己会处理这次手势，避免先恢复播放又被 click 切成关闭
  if (elements.soundToggle && event && event.target instanceof Node
    && elements.soundToggle.contains(event.target)) {
    return;
  }

  // 上次访问开着环境音：首次交互时补上浏览器要求的用户手势
  void ambience.resume();
}

// ---------- 评论与互动 ----------

function mountComments(entry) {
  if (!window.BifrostInteractions) {
    return;
  }
  window.BifrostInteractions.mount(
    entry,
    elements.viewer,
    state.siteConfig ? state.siteConfig.interactions : null,
    state.phase,
  );
}

function removeComments() {
  if (window.BifrostInteractions) {
    window.BifrostInteractions.clear(elements.viewer);
    return;
  }
  elements.viewer.querySelectorAll('.comments').forEach((node) => node.remove());
}

function entryByPath(path) {
  return state.entries.find((entry) => entry.path === path) || null;
}

function byDateDesc(a, b) {
  return (b.date || '').localeCompare(a.date || '');
}

function phaseEntries(phase) {
  return state.entries.filter((entry) => entry.phase === phase).sort(byDateDesc);
}

function recentEntries(phase, limit) {
  return phaseEntries(phase).slice(0, limit);
}

function formatDate(value) {
  if (!value) {
    return '—';
  }

  const currentYear = String(new Date().getFullYear());
  return value.startsWith(`${currentYear}-`)
    ? value.slice(5).replace('-', '.')
    : value.replaceAll('-', '.');
}

function renderTagChips(entry, max) {
  const tags = (entry.tags || []).slice(0, max);
  if (!tags.length) {
    return '';
  }

  return `<span class="recent-item__tags">${tags
    .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
    .join('')}</span>`;
}

function setMount(name, html, hasContent) {
  const mount = elements.viewer.querySelector(`[data-mount="${name}"]`);
  if (!mount) {
    return;
  }

  mount.innerHTML = html;
  const host = mount.closest('.card, .panel');
  if (host) {
    host.classList.toggle('is-hidden', !hasContent);
  }
}

function hydrateDashboard() {
  const empty = elements.viewer.querySelector('[data-dashboard-empty]');
  if (empty) {
    empty.classList.toggle('is-hidden', phaseEntries(state.phase).length > 0);
  }
  const recent = recentEntries(state.phase, 5);
  setMount(
    'recent',
    recent
      .map(
        (entry) => `
        <a class="recent-item" href="${entry.path}" data-path="${entry.path}">
          <span class="recent-item__date">${escapeHtml(formatDate(entry.date))}</span>
          <span class="recent-item__label">${escapeHtml(entry.label)}</span>
          ${renderTagChips(entry, 2)}
        </a>
      `,
      )
      .join(''),
    recent.length > 0,
  );

  const featured = phaseEntries(state.phase).filter((entry) => entry.featured).slice(0, 4);
  setMount(
    'featured',
    featured
      .map(
        (entry) => `
        <a class="recent-item" href="${entry.path}" data-path="${entry.path}">
          <span class="recent-item__date">${escapeHtml(formatDate(entry.date))}</span>
          <span class="recent-item__label">${escapeHtml(entry.label)}</span>
          ${renderTagChips(entry, 2)}
        </a>
      `,
      )
      .join(''),
    featured.length > 0,
  );

  const diaries = phaseEntries(state.phase)
    .filter((entry) => entry.type === 'diary')
    .slice(0, 4);
  setMount(
    'diary',
    diaries
      .map(
        (entry) => `
        <a class="diary-item" href="${entry.path}" data-path="${entry.path}">
          <span class="diary-item__meta">${escapeHtml(formatDate(entry.date))}${
            entry.tags && entry.tags.length ? ` · ${escapeHtml(entry.tags.join(' / '))}` : ''
          }</span>
          <span class="diary-item__title">${escapeHtml(entry.label)}</span>
          ${entry.summary ? `<span class="diary-item__summary">${escapeHtml(entry.summary)}</span>` : ''}
        </a>
      `,
      )
      .join(''),
    diaries.length > 0,
  );

  const savedPath = normalizeStoredPath(localStorage.getItem(STORAGE_KEYS.path));
  const savedEntry = savedPath && savedPath !== state.currentPath ? entryByPath(savedPath) : null;
  setMount(
    'continue',
    savedEntry
      ? `
        <a class="recent-item" href="${savedEntry.path}" data-path="${savedEntry.path}">
          <span class="recent-item__date">${escapeHtml(formatDate(savedEntry.date))}</span>
          <span class="recent-item__label">${escapeHtml(savedEntry.label)}</span>
        </a>
        <p class="hero-xz">上次读到这里，滚动位置会自动恢复。</p>
      `
      : '',
    Boolean(savedEntry),
  );
}

function removeEntryChrome() {
  elements.viewer.querySelectorAll('.entry-meta, .pager, .reading-gutter').forEach((node) => node.remove());
}
function siblingEntries(entry) {
  const list = phaseEntries(entry.phase);
  const index = list.findIndex((item) => item.path === entry.path);
  return {
    prev: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
  };
}

function estimateMinutes(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return Math.max(1, Math.round((cjk + latin) / 400));
}

function renderEntryChrome(entry) {
  removeEntryChrome();
  if (!entry) {
    return;
  }

  const tags = entry.tags || [];
  const minutes = entry.minutes || estimateMinutes(elements.viewer.textContent);
  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  meta.innerHTML = `
    <span class="entry-meta__date">${escapeHtml(formatDate(entry.date))}</span>
    <span class="entry-meta__sep">/</span>
    <span>${escapeHtml(entry.category || (entry.type === 'diary' ? '手记' : '文章'))} · ${entry.type === 'diary' ? '手记' : '文章'} · 约 ${minutes} 分钟</span>
    ${tags.length ? `<span class="entry-meta__tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
  `;
  elements.viewer.prepend(meta);

  if (state.readingLayout === 'magazine' && entry.layout === 'longform') {
    const gutter = document.createElement('aside');
    gutter.className = 'reading-gutter';
    gutter.setAttribute('aria-label', '阅读信息与进度');
    gutter.innerHTML = `
      <div class="reading-gutter__line" aria-hidden="true"><i data-reading-progress-fill></i></div>
      <div class="reading-gutter__meta">
        <span>${escapeHtml(formatDate(entry.date))}</span>
        <span>约 ${minutes} 分钟</span>
        <span>${escapeHtml(entry.sectionLabel || entry.category || '阅读')}</span>
      </div>
      ${tags.length ? `<div class="reading-gutter__tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <button class="reading-gutter__top" type="button" data-reading-top>↑<span>回到顶部</span></button>
    `;
    gutter.querySelector('[data-reading-top]').addEventListener('click', () => {
      elements.main.scrollTo({ top: 0, behavior: 'smooth' });
    });
    elements.viewer.append(gutter);
  }

  if (state.readingLayout === 'magazine' && entry.layout === 'event') {
    const gutter = document.createElement('aside');
    gutter.className = 'reading-gutter reading-gutter--edge';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.innerHTML = '<div class="reading-gutter__line"></div>';
    elements.viewer.append(gutter);
  }

  const { prev, next } = siblingEntries(entry);
  const pager = document.createElement('nav');
  pager.className = 'pager';
  pager.innerHTML = `
    ${prev ? `<a href="${prev.path}" data-path="${prev.path}"><span class="pager__dir">上一篇</span><span>${escapeHtml(prev.label)}</span></a>` : '<span></span>'}
    ${next ? `<a href="${next.path}" data-path="${next.path}"><span class="pager__dir">下一篇</span><span>${escapeHtml(next.label)}</span></a>` : '<span></span>'}
  `;
  elements.viewer.append(pager);
}

function updateReadingProgress() {
  const fill = elements.viewer?.querySelector('[data-reading-progress-fill]');
  const article = elements.viewer?.querySelector('.article-surface');
  if (!fill || !article) {
    return;
  }
  const mainRect = elements.main.getBoundingClientRect();
  const articleRect = article.getBoundingClientRect();
  const start = articleRect.top - mainRect.top + elements.main.scrollTop;
  const end = start + article.offsetHeight - elements.main.clientHeight * 0.72;
  const denominator = Math.max(1, end - start);
  const ratio = Math.max(0, Math.min(1, (elements.main.scrollTop - start) / denominator));
  fill.style.setProperty('--reading-progress', `${(ratio * 100).toFixed(2)}%`);
}

function onDocumentClick(event) {
  const routeLink = event.target.closest('[data-path]');
  if (!routeLink) {
    return;
  }

  event.preventDefault();
  openRoute(routeLink.dataset.path);
}

function onKeyDown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!elements.commandOverlay.classList.contains('is-active')) {
      openCommandOverlay();
    }
    return;
  }

  if (event.key === 'Escape') {
    closeCommandOverlay();
  }
}

function onCommandKeyDown(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!state.paletteItems.length) {
      return;
    }

    const delta = event.key === 'ArrowDown' ? 1 : -1;
    state.paletteIndex = (state.paletteIndex + delta + state.paletteItems.length) % state.paletteItems.length;
    updatePaletteActive();
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }

  const activeItem = state.paletteItems[state.paletteIndex];
  if (activeItem) {
    activatePaletteItem(state.paletteIndex);
    return;
  }

  const command = elements.commandInput.value.trim().toLowerCase();
  elements.commandInput.value = '';
  closeCommandOverlay();

  const nextPhase = COMMAND_PHASES[command];
  if (nextPhase) {
    switchPhase(nextPhase);
  }
}

function openCommandOverlay() {
  elements.commandOverlay.classList.add('is-active');
  elements.commandInput.value = '';
  renderPaletteResults('');
  window.setTimeout(() => elements.commandInput.focus(), 0);
}

function closeCommandOverlay() {
  elements.commandOverlay.classList.remove('is-active');
}

function renderPaletteResults(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  state.paletteItems = collectPaletteItems(query);
  state.paletteIndex = 0;

  if (!state.paletteItems.length) {
    elements.commandResults.innerHTML = '<p class="command-empty">没有匹配的内容。</p>';
    return;
  }

  elements.commandResults.innerHTML = state.paletteItems
    .map((item, index) => {
      const label = item.kind === 'entry' ? item.entry.label : item.label;
      const hint = item.kind === 'entry' ? paletteEntryHint(item.entry) : item.hint;
      return `
      <a class="command-item${index === 0 ? ' is-active' : ''}" data-palette-index="${index}">
        <span class="command-item__label">${escapeHtml(label)}</span>
        <span class="command-item__hint">${escapeHtml(hint)}</span>
      </a>
    `;
    })
    .join('');
}

function paletteEntryHint(entry) {
  return [formatDate(entry.date), PHASES[entry.phase]?.label, ...(entry.tags || []).slice(0, 2)]
    .filter(Boolean)
    .join(' · ');
}

function collectPaletteItems(query) {
  const items = [];

  if (!query) {
    // 顺序跟随默认相位：进入站点默认是 Logic，列表也以 Logic 打头
    items.push({ kind: 'phase', phase: 'logic', label: '切换到 Logic 位面', hint: '输入 logic' });
    items.push({ kind: 'phase', phase: 'fantasy', label: '切换到 Fantasy 位面', hint: '输入 fantasy' });
    return items;
  }

  Object.keys(PUBLIC_COMMANDS).forEach((name) => {
    if (!name.includes(query)) {
      return;
    }
    const phase = PUBLIC_COMMANDS[name];
    if (!items.some((item) => item.kind === 'phase' && item.phase === phase)) {
      items.push({
        kind: 'phase',
        phase,
        label: `切换到 ${phase === 'fantasy' ? 'Fantasy 位面' : 'Logic 位面'}`,
        hint: `输入 ${name}`,
      });
    }
  });

  state.entries
    .filter((entry) => entry.phase === state.phase && paletteEntryMatches(entry, query))
    .slice(0, 8)
    .forEach((entry) => items.push({ kind: 'entry', entry }));

  return items.slice(0, 9);
}

function paletteEntryMatches(entry, query) {
  const haystack = [entry.label, entry.summary, (entry.tags || []).join(' '), entry.path]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function updatePaletteActive() {
  elements.commandResults.querySelectorAll('.command-item').forEach((node, index) => {
    node.classList.toggle('is-active', index === state.paletteIndex);
  });

  const active = elements.commandResults.querySelector('.command-item.is-active');
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

async function activatePaletteItem(index) {
  const item = state.paletteItems[index];
  if (!item) {
    return;
  }

  closeCommandOverlay();

  if (item.kind === 'phase') {
    await switchPhase(item.phase);
    return;
  }

  const entry = item.entry;
  if (entry.phase !== state.phase) {
    await switchPhase(entry.phase);
  }
  await openRoute(entry.path);
}

async function switchPhase(nextPhase) {
  if (state.phase === nextPhase) {
    return;
  }

  const previousPhase = state.phase;
  const bridge = playBridgeTransition(nextPhase);

  const commit = async () => {
    state.phase = nextPhase;
    applyPhase(nextPhase);
    localStorage.removeItem(STORAGE_KEYS.path);

    try {
      renderNavigation();
      await openDashboard({ pushState: true, remember: false });
    } catch (_error) {
      state.phase = previousPhase;
      applyPhase(previousPhase);
      elements.viewer.innerHTML = renderError('位面暂时切换失败，请稍后再试。');
    }
  };

  if (bridge) {
    window.setTimeout(() => {
      void commit();
    }, 360);
    return;
  }

  await commit();
}

function playBridgeTransition(nextPhase) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return null;
  }

  const bridge = document.createElement('div');
  bridge.className = 'bridge-overlay';
  bridge.style.setProperty('--bridge-color', PHASES[nextPhase].bridgeColor);
  document.body.appendChild(bridge);
  window.setTimeout(() => bridge.remove(), 1080);
  return bridge;
}

async function openDashboard(options = {}) {
  const dashboardPath = PHASES[state.phase].dashboardUrl;
  return openRoute(dashboardPath, { ...options, remember: false });
}

let routeToken = 0;

async function openRoute(path, options = {}) {
  const normalizedPath = normalizePath(path);
  const token = ++routeToken;
  let response;
  window.BifrostMediaPreview?.clear();
  window.BifrostPublicationReader?.clear();

  try {
    response = await fetch(normalizedPath);
  } catch (_error) {
    if (token === routeToken) {
      elements.viewer.innerHTML = renderError('这一页暂时没有打开，请稍后再试。');
    }
    return;
  }

  if (token !== routeToken) {
    return;
  }

  if (!response.ok) {
    elements.viewer.innerHTML = renderError('这一页暂时没有打开，请稍后再试。');
    return;
  }

  const rawHtml = await response.text();
  if (token !== routeToken) {
    return;
  }

  const html = rewriteRelativePaths(rawHtml, normalizedPath);
  elements.viewer.innerHTML = html;
  state.currentPath = normalizedPath;

  const isDashboard = normalizedPath.includes('/content/dashboards/');
  const entry = entryByPath(normalizedPath);
  elements.viewer.dataset.entryType = isDashboard ? '' : entry ? entry.type || 'article' : '';
  elements.viewer.dataset.entryKind = isDashboard ? '' : entry ? entry.kind || 'standard' : '';
  elements.viewer.dataset.entryLayout = isDashboard ? '' : entry ? entry.layout || 'longform' : '';
  elements.main.dataset.entryLayout = elements.viewer.dataset.entryLayout;
  window.BifrostMediaPreview?.mount(elements.viewer);
  window.BifrostPublicationReader?.mount(elements.viewer);
  if (isDashboard) {
    hydrateDashboard();
    removeComments();
  } else {
    renderEntryChrome(entry);
    mountComments(entry);
    if (entry?.kind === 'pdf' && new URL(window.location.href).searchParams.get('view') === 'spread') {
      window.BifrostPublicationReader?.openFromViewer(elements.viewer);
    }
  }

  restoreScrollPosition(normalizedPath);
  updateTreeActive(normalizedPath);
  playContentEnter();
  window.requestAnimationFrame(updateReadingProgress);

  if (options.remember !== false && !isDashboard) {
    localStorage.setItem(STORAGE_KEYS.path, normalizedPath);
  }

  if (options.pushState !== false) {
    syncUrl({ path: isDashboard ? '' : normalizedPath });
  }

  updateDocumentMeta(normalizedPath);
}

function updateTreeActive(path) {
  elements.tree.querySelectorAll('.tree__link').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.path === path);
  });
  const active = Array.from(elements.tree.querySelectorAll('.tree__link'))
    .find((link) => link.dataset.path === path);
  if (active) {
    active.closest('details')?.setAttribute('open', '');
  }
}

function playContentEnter() {
  elements.viewer.classList.remove('is-entering');
  void elements.viewer.offsetWidth;
  elements.viewer.classList.add('is-entering');
}

function normalizePath(path) {
  if (!path) {
    return PHASES[state.phase].dashboardUrl;
  }

  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  return path.startsWith('/') ? path : `/${path}`;
}

function rewriteRelativePaths(html, sourcePath) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const basePath = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  const selectors = ['img[src]', 'source[src]', 'audio[src]', 'video[src]', 'iframe[src]', 'a[href]'];

  selectors.forEach((selector) => {
    doc.querySelectorAll(selector).forEach((node) => {
      const attr = node.hasAttribute('src') ? 'src' : 'href';
      const value = node.getAttribute(attr);
      if (!value || /^(https?:|mailto:|tel:|data:|#|\/)/i.test(value)) {
        return;
      }

      const resolved = new URL(value, `${window.location.origin}${basePath}`).pathname;
      node.setAttribute(attr, resolved);
    });
  });

  doc.querySelectorAll('img[srcset], source[srcset]').forEach((node) => {
    const value = node.getAttribute('srcset');
    if (!value) {
      return;
    }

    const rewritten = value.split(',').map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) {
        return trimmed;
      }

      const [url, ...descriptors] = trimmed.split(/\s+/);
      if (!url || /^(https?:|mailto:|tel:|data:|#|\/)/i.test(url)) {
        return trimmed;
      }

      const resolved = new URL(url, `${window.location.origin}${basePath}`).pathname;
      return [resolved, ...descriptors].join(' ');
    }).join(', ');

    node.setAttribute('srcset', rewritten);
  });

  return doc.body.innerHTML;
}

function renderError(message) {
  return `
    <section class="article-surface">
      <p class="hero__eyebrow">BIFROST</p>
      <h1 class="hero__title">这一页暂时没有打开</h1>
      <p class="hero__text">${escapeHtml(message)}</p>
      <div class="article-actions">
        <a class="button button--primary" href="/content/dashboards/${state.phase}-dash.html" data-path="/content/dashboards/${state.phase}-dash.html">返回总览</a>
      </div>
    </section>
  `;
}
function updateDocumentMeta(path) {
  const entry = entryByPath(path);
  const pageName = entry
    ? entry.label
    : path.split('/').pop().replace(/\.html?$/i, '').replace(/[-_]/g, ' ');
  document.title = `${pageName || 'BIFROST'} · ${PHASES[state.phase].label}`;

  let image = document.querySelector('meta[property="og:image"]');
  const twitterCard = document.querySelector('meta[name="twitter:card"]');
  if (!image) {
    image = document.createElement('meta');
    image.setAttribute('property', 'og:image');
    document.head.append(image);
  }
  if (entry?.cover) {
    image.setAttribute('content', entry.cover);
    twitterCard?.setAttribute('content', 'summary_large_image');
  } else {
    image.remove();
    twitterCard?.setAttribute('content', 'summary');
  }
}

function syncUrl(options = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set('phase', state.phase);

  if (options.path) {
    url.searchParams.set('path', options.path);
  } else {
    url.searchParams.delete('path');
  }

  if (options.replace) {
    history.replaceState({ phase: state.phase, path: options.path || '' }, '', url);
    return;
  }

  history.pushState({ phase: state.phase, path: options.path || '' }, '', url);
}

function onPopState() {
  const url = new URL(window.location.href);
  const phase = normalizePhase(url.searchParams.get('phase')) || 'logic';
  const path = normalizeStoredPath(url.searchParams.get('path'));

  state.phase = phase;
  applyPhase(phase);
  state.treeQuery = '';
  renderNavigation();
  if (path) {
    openRoute(path, { pushState: false, remember: false }).catch(() => {
      elements.viewer.innerHTML = renderError('历史记录恢复失败。');
    });
    return;
  }
  openDashboard({ pushState: false }).catch(() => {
    elements.viewer.innerHTML = renderError('历史记录恢复失败。');
  });
}

function playBootSequence() {
  if (state.bootPlayed) {
    return;
  }

  state.bootPlayed = true;
  elements.bootOverlay.classList.add('is-active');
  const lines = PHASES[state.phase].boot;

  elements.bootLog.innerHTML = '';
  lines.forEach((line, index) => {
    const node = document.createElement('div');
    node.className = 'boot-log__line';
    node.style.animationDelay = `${index * 180}ms`;
    node.textContent = line;
    elements.bootLog.appendChild(node);
  });

  if (elements.bootBar) {
    window.requestAnimationFrame(() => {
      elements.bootBar.style.width = '100%';
    });
  }

  window.setTimeout(() => {
    elements.bootOverlay.classList.remove('is-active');
  }, 1500);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
