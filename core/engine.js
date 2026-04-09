const STORAGE_KEYS = {
  phase: 'bifrost:phase',
  path: 'bifrost:path',
};

const PHASES = {
  logic: {
    label: 'Logic',
    title: 'SYSTEM_ARCHIVE_v1.0.4',
    subtitle: 'Theory first, practice second.',
    hint: 'Press ` to open the command palette',
    treeUrl: '/data/logic-tree.json',
    dashboardUrl: '/content/dashboards/logic-dash.html',
  },
  fantasy: {
    label: 'Fantasy',
    title: 'Personal Archive | 幻想の回廊',
    subtitle: 'Reading first, resonance second.',
    hint: 'Press ` and type set up! to switch phase',
    treeUrl: '/data/fantasy-tree.json',
    dashboardUrl: '/content/dashboards/fantasy-dash.html',
  },
};

const state = {
  phase: 'logic',
  currentPath: '',
  bootPlayed: false,
  treeData: null,
};

const elements = {};

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('popstate', onPopState);

async function init() {
  cacheElements();
  bindGlobalEvents();

  state.phase = resolvePhase();
  applyPhase(state.phase);

  if (!hasPersistentState()) {
    playBootSequence();
  }

  await loadTree(state.phase);

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

function cacheElements() {
  elements.html = document.documentElement;
  elements.body = document.body;
  elements.siteTitle = document.querySelector('[data-site-title]');
  elements.siteSubtitle = document.querySelector('[data-site-subtitle]');
  elements.phasePill = document.querySelector('[data-phase-pill]');
  elements.phaseHint = document.querySelector('[data-phase-hint]');
  elements.tree = document.querySelector('[data-tree]');
  elements.viewer = document.querySelector('[data-content-viewer]');
  elements.footerStatus = document.querySelector('[data-footer-status]');
  elements.commandOverlay = document.querySelector('[data-command-overlay]');
  elements.commandInput = document.querySelector('[data-command-input]');
  elements.bootOverlay = document.querySelector('[data-boot-overlay]');
  elements.bootLog = document.querySelector('[data-boot-log]');
}

function bindGlobalEvents() {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  elements.commandInput.addEventListener('keydown', onCommandKeyDown);
}

function resolvePhase() {
  const url = new URL(window.location.href);
  const urlPhase = normalizePhase(url.searchParams.get('phase'));
  const urlPath = normalizeStoredPath(url.searchParams.get('path'));
  const storedPhase = normalizePhase(localStorage.getItem(STORAGE_KEYS.phase));

  if (urlPhase) {
    return urlPhase;
  }

  if (urlPath) {
    return phaseFromPath(urlPath);
  }

  const storedPath = normalizeStoredPath(localStorage.getItem(STORAGE_KEYS.path));
  if (storedPath) {
    return phaseFromPath(storedPath);
  }

  return storedPhase || 'logic';
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
  elements.phasePill.textContent = config.label;
  elements.phaseHint.textContent = config.hint;
  elements.footerStatus.textContent = phase === 'logic' ? 'Logic workspace ready' : 'Fantasy workspace ready';
  localStorage.setItem(STORAGE_KEYS.phase, phase);
}

async function loadTree(phase) {
  const response = await fetch(PHASES[phase].treeUrl);
  if (!response.ok) {
    throw new Error(`Failed to load tree: ${response.status}`);
  }

  state.treeData = await response.json();
  renderTree(state.treeData);
}

function renderTree(treeData) {
  elements.tree.innerHTML = '';
  const sections = treeData.sections || [];

  sections.forEach((section, index) => {
    const details = document.createElement('details');
    details.open = index === 0;

    const summary = document.createElement('summary');
    summary.textContent = section.title;
    details.appendChild(summary);

    const itemWrap = document.createElement('div');
    itemWrap.className = 'tree__items';
    (section.items || []).forEach((item) => {
      itemWrap.appendChild(renderTreeItem(item));
    });

    details.appendChild(itemWrap);
    elements.tree.appendChild(details);
  });
}

function renderTreeItem(item) {
  if (item.children && item.children.length > 0) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = item.label;
    details.appendChild(summary);

    const itemWrap = document.createElement('div');
    itemWrap.className = 'tree__items';
    item.children.forEach((child) => {
      itemWrap.appendChild(renderTreeItem(child));
    });

    details.appendChild(itemWrap);
    return details;
  }

  if (item.path) {
    const link = document.createElement('a');
    link.href = item.path;
    link.className = 'tree__link';
    link.dataset.path = item.path;
    link.textContent = item.label;
    return link;
  }

  const leaf = document.createElement('div');
  leaf.className = 'tree__leaf';
  leaf.textContent = item.label;
  return leaf;
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
  if (event.key === '`') {
    event.preventDefault();
    openCommandOverlay();
    return;
  }

  if (event.key === 'Escape') {
    closeCommandOverlay();
  }
}

function onCommandKeyDown(event) {
  if (event.key !== 'Enter') {
    return;
  }

  const command = elements.commandInput.value.trim().toLowerCase();
  elements.commandInput.value = '';
  closeCommandOverlay();

  if (command === 'set up!' || command === 'setup') {
    switchPhase('fantasy');
    return;
  }

  if (command === 'reset' || command === 'shutdown') {
    switchPhase('logic');
  }
}

function openCommandOverlay() {
  elements.commandOverlay.classList.add('is-active');
  window.setTimeout(() => elements.commandInput.focus(), 0);
}

function closeCommandOverlay() {
  elements.commandOverlay.classList.remove('is-active');
}

async function switchPhase(nextPhase) {
  if (state.phase === nextPhase) {
    return;
  }

  state.phase = nextPhase;
  applyPhase(nextPhase);
  await loadTree(nextPhase);
  await openDashboard({ pushState: true, remember: false });
}

async function openDashboard(options = {}) {
  const dashboardPath = PHASES[state.phase].dashboardUrl;
  return openRoute(dashboardPath, { ...options, remember: false });
}

async function openRoute(path, options = {}) {
  const normalizedPath = normalizePath(path);
  const response = await fetch(normalizedPath);

  if (!response.ok) {
    elements.viewer.innerHTML = renderError(`无法加载内容：${normalizedPath}`);
    return;
  }

  const rawHtml = await response.text();
  const html = rewriteRelativePaths(rawHtml, normalizedPath);
  elements.viewer.innerHTML = html;
  state.currentPath = normalizedPath;

  const isDashboard = normalizedPath.includes('/content/dashboards/');
  if (options.remember !== false && !isDashboard) {
    localStorage.setItem(STORAGE_KEYS.path, normalizedPath);
  }

  if (options.pushState !== false) {
    syncUrl({ path: isDashboard ? '' : normalizedPath });
  }

  updateDocumentMeta(normalizedPath);
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

  return doc.body.innerHTML;
}

function renderError(message) {
  return `
    <section class="article-surface">
      <p class="hero__eyebrow">Load Error</p>
      <h1 class="hero__title">内容暂时无法加载</h1>
      <p class="hero__text">${escapeHtml(message)}</p>
      <div class="article-actions">
        <a class="button button--primary" href="/content/dashboards/${state.phase}-dash.html" data-path="/content/dashboards/${state.phase}-dash.html">返回仪表盘</a>
      </div>
    </section>
  `;
}

function updateDocumentMeta(path) {
  const pageName = path.split('/').pop().replace(/\.html?$/i, '').replace(/[-_]/g, ' ');
  document.title = `${PHASES[state.phase].label} · ${pageName || 'Dashboard'}`;
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
  loadTree(phase)
    .then(() => {
      if (path) {
        return openRoute(path, { pushState: false, remember: false });
      }

      return openDashboard({ pushState: false });
    })
    .catch(() => {
      elements.viewer.innerHTML = renderError('历史记录恢复失败。');
    });
}

function playBootSequence() {
  if (state.bootPlayed) {
    return;
  }

  state.bootPlayed = true;
  elements.bootOverlay.classList.add('is-active');
  const lines = [
    '[ OK ] Mounting knowledge partitions...',
    '[ OK ] Loading phase assets...',
    '[ OK ] Restoring dashboard shell...',
    '[ OK ] BIFROST interface ready.',
  ];

  elements.bootLog.innerHTML = '';
  lines.forEach((line, index) => {
    const node = document.createElement('div');
    node.className = 'boot-log__line';
    node.style.animationDelay = `${index * 180}ms`;
    node.textContent = line;
    elements.bootLog.appendChild(node);
  });

  window.setTimeout(() => {
    elements.bootOverlay.classList.remove('is-active');
  }, 1200);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
