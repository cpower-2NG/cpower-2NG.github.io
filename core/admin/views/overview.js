// 概览：全局状态卡 + 发布条 + 最近同步摘要 + 待办快捷入口。
// 数据来自全局 status（app.refreshStatus 写入 store），订阅自动重渲。

import { request } from '../api.js';
import { createSubscriptions, get, set } from '../store.js';
import { badge, button, card, h, muted, toast } from '../ui.js';
import { fmtDateTime, QZONE_STATE, SYNC_STATE } from '../format.js';

let publishTimer = null;

export default {
  id: 'overview',
  title: '概览',
  async mount(container) {
    const subs = createSubscriptions();
    container.append(
      renderPublishBar(),
      renderStatusGrid(),
      renderSyncAndTodos(),
    );
    subs.watch('status', () => {
      container.replaceChildren(renderPublishBar(), renderStatusGrid(), renderSyncAndTodos());
    });
    return () => {
      subs.dispose();
      window.clearTimeout(publishTimer);
    };
  },
};

function renderStatusGrid() {
  const status = get('status');
  const cards = [];
  if (!status) {
    cards.push(h('div', { class: 'status-card' }, h('strong', {}, '状态'), h('span', {}, '加载中…')));
  } else {
    const pending = Number(status.commentCounts?.pending) || 0;
    cards.push(
      statusCard('API', status.service === 'ok' ? '正常' : String(status.service || '—')),
      statusCard('QQ 会话', QZONE_STATE[status.qzone?.state] || '未连接', status.qzone?.checkedAt ? `检查于 ${fmtDateTime(status.qzone.checkedAt)}` : ''),
      statusCard('同步任务', SYNC_STATE[status.sync?.state] || '空闲', status.sync?.updatedAt ? fmtDateTime(status.sync.updatedAt) : ''),
      statusCard('待审核评论', pending ? `${pending} 条` : '无', pending ? '到「评论」页处理' : ''),
      statusCard('最近导出', status.lastExport?.exportedAt ? fmtDateTime(status.lastExport.exportedAt) : '尚未导出', `${status.lastExport?.count || 0} 条`),
    );
  }
  return h('div', { class: 'status-grid' }, cards);
}

function statusCard(label, value, detail = '') {
  return h('div', { class: 'status-card' },
    h('strong', {}, label),
    h('span', {}, value),
    detail ? h('small', {}, detail) : null,
  );
}

function renderPublishBar() {
  const status = get('status');
  const publish = status?.publish;
  const dirty = Boolean(publish?.dirty);
  const last = publish?.lastPublish;
  const lines = [dirty
    ? `数据库有改动，静态站点待更新（标记于 ${fmtDateTime(publish?.markedAt)}）。`
    : '数据库与静态产物一致，无需发布。'];
  if (last) {
    lines.push(last.status === 'succeeded'
      ? `上次发布成功：${fmtDateTime(last.publishedAt)}${last.commit ? ` · commit ${String(last.commit).slice(0, 7)}` : ''}`
      : `上次发布未成功：${last.error || '原因未知'}`);
  }
  const buttonEl = button(dirty ? '发布站点' : '暂无待发布', {
    kind: 'primary',
    disabled: !dirty,
    onclick: (event) => publishNow(event.currentTarget),
  });
  return card({
    title: '发布',
    eyebrow: 'PUBLISH',
    body: [
      h('div', { class: 'inline' },
        h('span', { class: 'grow muted' }, lines.join(' ')),
        buttonEl,
      ),
    ],
  });
}

async function publishNow(btn) {
  btn.disabled = true;
  try {
    await request('/manage/publish');
    toast('发布任务已提交，物化与检索推送在云端进行，几分钟后站点更新。', 'ok');
    pollUntilSettled();
  } catch (error) {
    toast(error.message, 'error');
    btn.disabled = false;
  }
}

/** 发布任务在云端跑，这里轮询到脏标记清掉（或超时）为止。 */
function pollUntilSettled() {
  window.clearTimeout(publishTimer);
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    const payload = await request('/manage/status').catch(() => null);
    if (payload) set('status', payload);
    if (!payload?.publish?.dirty || attempts >= 12) return;
    publishTimer = window.setTimeout(tick, 5000);
  };
  publishTimer = window.setTimeout(tick, 5000);
}

function renderSyncAndTodos() {
  const status = get('status');
  const todos = [];
  if (status) {
    const qzoneState = status.qzone?.state || 'not_connected';
    if (qzoneState !== 'connected') {
      todos.push(quickTodo('QQ 会话未连接', 'QQ 空间同步需要先扫码登录。', '#/qzone'));
    }
    const pendingComments = Number(status.commentCounts?.pending) || 0;
    if (pendingComments) {
      todos.push(quickTodo(`${pendingComments} 条评论待审核`, '正常评论直接发布，带链接的转入待审。', '#/comments'));
    }
    if (status.lastSync?.counts?.quarantined) {
      todos.push(quickTodo(`${status.lastSync.counts.quarantined} 条内容被隔离`, '到 QQ 同步页的审查队列逐条放行或排除。', '#/qzone'));
    }
    if (!todos.length) {
      todos.push(muted('没有需要处理的事项。'));
    }
  } else {
    todos.push(muted('加载中…'));
  }

  const lastSync = status?.lastSync;
  const syncSummary = lastSync
    ? [
        h('p', { class: 'muted' },
          lastSync.dryRun ? '最近一次为验收预览' : '最近一次为发布同步',
          ` · ${fmtDateTime(lastSync.generatedAt)}`,
        ),
        h('div', { class: 'inline' },
          badge(`候选 ${lastSync.counts?.publishedCandidate || 0}`, 'accent'),
          badge(`待审查 ${lastSync.counts?.pendingReview || 0}`, 'warn'),
          badge(`隔离 ${lastSync.counts?.quarantined || 0}`, 'danger'),
          lastSync.commit ? badge(`commit ${String(lastSync.commit).slice(0, 7)}`, 'ok') : null,
        ),
      ]
    : [muted('还没有同步记录。到「QQ 空间同步」页执行验收预览。')];

  return h('div', { class: 'split' },
    card({ title: '待处理', eyebrow: 'TODO', body: todos }),
    card({
      title: '最近同步',
      eyebrow: 'LAST SYNC',
      actions: [button('查看审查队列', { onclick: () => { location.hash = '#/qzone'; } })],
      body: syncSummary,
    }),
  );
}

function quickTodo(title, description, hash) {
  return h('button', {
    class: 'row row--clickable',
    type: 'button',
    onclick: () => { location.hash = hash; },
  },
  h('div', { class: 'row__main' },
    h('div', { class: 'row__title' }, title),
    h('div', { class: 'row__meta' }, description),
  ),
  h('span', { class: 'row__side muted' }, '→'),
  );
}
