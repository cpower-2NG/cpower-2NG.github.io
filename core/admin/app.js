// 管理台入口：启动引导、hash 路由、侧栏全局状态。
// 视图模块约定：{ title, mount(container, ctx) -> cleanupFn? }

import {
  adminName,
  hasIdentity,
  initAuth,
  logout,
  msalReady,
  onUnauthorized,
  request,
} from './api.js';
import { set } from './store.js';
import { clear, toast } from './ui.js';
import { QZONE_STATE } from './format.js';
import views from './views/index.js';
import { initGate, showGate } from './views/login.js';

let cleanupCurrent = null;
let currentId = '';
let shellBound = false;

async function boot() {
  let interactions = null;
  try {
    const response = await fetch('/data/site.json');
    const site = await response.json();
    interactions = site.interactions || {};
  } catch {
    showGate('站点配置加载失败，请稍后刷新重试。');
    return;
  }
  if (!interactions?.apiBaseUrl) {
    showGate('站点配置尚未接入管理接口（data/site.json 的 interactions.apiBaseUrl），请先完成 Azure 配置。');
    return;
  }
  // MSAL 初始化失败不阻断账密通道，错误延迟到点击登录按钮时提示。
  await initAuth(interactions).catch(() => undefined);
  onUnauthorized((message) => showGate(message));
  initGate({ onAuthenticated: () => enterApp() });
  if (hasIdentity()) {
    enterApp();
  } else {
    showGate();
  }
}

function enterApp() {
  hideGateIfDone();
  if (!shellBound) {
    bindShell();
    shellBound = true;
    window.addEventListener('hashchange', route);
  }
  document.querySelector('[data-account]').textContent = adminName() || '已登录';
  refreshStatus();
  route();
}

function hideGateIfDone() {
  document.querySelector('[data-gate]').hidden = true;
  document.querySelector('[data-shell]').hidden = false;
}

function bindShell() {
  document.querySelector('[data-admin-logout]').addEventListener('click', () => {
    logout()
      .then(() => showGate('已退出登录。'))
      .catch(() => location.reload());
  });
  document.querySelector('[data-refresh]').addEventListener('click', () => {
    refreshStatus();
    // 通知当前视图重拉数据：切走再切回成本高，直接触发一次路由重挂载。
    rerenderCurrent();
  });
  document.querySelector('[data-menu]').addEventListener('click', () => {
    document.querySelector('[data-sidebar]').classList.toggle('sidebar--open');
  });
}

function rerenderCurrent() {
  cleanupCurrent?.();
  cleanupCurrent = null;
  clear(document.querySelector('[data-view]'));
  const view = views[currentId] || views.overview;
  Promise.resolve(view.mount(document.querySelector('[data-view]'), ctx()))
    .then((fn) => { cleanupCurrent = fn || null; })
    .catch((error) => toast(error.message, 'error'));
}

function ctx() {
  return { refreshStatus };
}

function route() {
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'overview';
  const view = views[id] || views.overview;
  if (view.id !== id) {
    history.replaceState(null, '', `#/${view.id}`);
  }
  if (currentId === view.id) return;
  cleanupCurrent?.();
  cleanupCurrent = null;
  currentId = view.id;
  document.querySelectorAll('[data-nav-item]').forEach((el) => {
    el.classList.toggle('nav__item--active', el.dataset.navItem === view.id);
  });
  document.querySelector('[data-view-title]').textContent = view.title;
  document.querySelector('[data-sidebar]').classList.remove('sidebar--open');
  const container = document.querySelector('[data-view]');
  clear(container);
  Promise.resolve(view.mount(container, ctx()))
    .then((fn) => { cleanupCurrent = fn || null; })
    .catch((error) => {
      clear(container).append(
        Object.assign(document.createElement('p'), { className: 'muted', textContent: `页面加载失败：${error.message}` }),
      );
    });
}

export async function refreshStatus() {
  try {
    const payload = await request('/manage/status');
    set('status', payload);
    renderSideStatus(payload);
    return payload;
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

function renderSideStatus(payload) {
  const qzoneState = payload.qzone?.state || 'not_connected';
  const dot = document.querySelector('[data-side-qzone-dot]');
  const text = document.querySelector('[data-side-qzone-text]');
  if (dot) dot.className = `dot dot--${qzoneState === 'connected' ? 'ok' : qzoneState === 'auth_failed' ? 'danger' : 'muted'}`;
  if (text) text.textContent = `QQ ${QZONE_STATE[qzoneState] || qzoneState}`;

  const publish = document.querySelector('[data-side-publish]');
  if (publish) publish.hidden = !payload.publish?.dirty;

  const pending = Number(payload.commentCounts?.pending) || 0;
  const badgeEl = document.querySelector('[data-nav-count="pendingComments"]');
  if (badgeEl) {
    badgeEl.textContent = String(pending);
    badgeEl.hidden = pending === 0;
  }
}

boot();
