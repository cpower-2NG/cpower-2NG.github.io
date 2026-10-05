// QQ 空间同步：连接（扫码自动轮询）→ 自动发布开关 → 同步任务 → 审查队列闭环。
// 审查闭环：验收预览的报告记录可直接「放行 / 排除」，累积成覆盖草稿，一键保存后跑真实同步生效。

import { request } from '../api.js';
import { get } from '../store.js';
import {
  PUBLISH_STATUS,
  REVIEW_REASON,
  fmtDateTime,
  fmtCountdown,
  overrideKeyFor,
} from '../format.js';
import {
  badge,
  button,
  card,
  collapse,
  confirmDialog,
  h,
  metaLine,
  muted,
  setMessage,
  switchControl,
  toast,
  withBusy,
} from '../ui.js';

const QR_POLL_MS = 3000;
const SYNC_POLL_MS = 5000;
const SYNC_POLL_MAX = 240; // 5s × 240 = 20 分钟上限

const local = {
  ctx: null,
  backfillDays: 31,
  autoPublish: false,
  auth: null,          // /manage/qzone/status 的 auth 段
  qzoneState: 'not_connected',
  syncState: 'idle',
  lastSync: null,
  report: null,
  overrides: {},       // 已保存的覆盖文档（key → override）
  draft: new Map(),    // 覆盖草稿（overrideKey → { publishStatus }）
  queueFilter: 'pending',
};

let qrTimer = null;
let countdownTimer = null;
let syncTimer = null;
let syncPollTicks = 0;
let awaitingSyncStart = false;

let hosts = null;

export default {
  id: 'qzone',
  title: 'QQ 空间同步',
  async mount(container, ctx) {
    local.ctx = ctx;
    local.draft = new Map();
    local.queueFilter = 'pending';
    awaitingSyncStart = false;
    syncPollTicks = 0;

    const connectionBody = h('div', { class: 'stack' });
    const autoPublishBody = h('div', { class: 'stack' });
    const taskBody = h('div', { class: 'stack' });
    const queueBody = h('div', { class: 'stack' });
    const overridesBody = h('div', { class: 'stack' });
    hosts = { connectionBody, autoPublishBody, taskBody, queueBody, overridesBody };

    container.append(
      card({ title: '连接', eyebrow: 'CONNECTION', body: [connectionBody] }),
      card({ title: '自动发布', eyebrow: 'AUTO PUBLISH', body: [autoPublishBody] }),
      card({ title: '同步任务', eyebrow: 'SYNC', body: [taskBody] }),
      card({ title: '审查队列', eyebrow: 'REVIEW QUEUE', body: [queueBody] }),
      card({
        title: '高级',
        eyebrow: 'ADVANCED',
        body: [collapse('人工覆盖 JSON（审查队列操作会自动写入）', overridesBody)],
      }),
    );

    renderAllPlaceholder();
    await Promise.all([refreshConnection(), loadAutoPublish(), refreshTaskInfo(), loadReport(), loadOverrides()]);

    startQzonePolling();
    startSyncPollingIfNeeded();

    return () => {
      window.clearInterval(qrTimer);
      window.clearInterval(countdownTimer);
      window.clearInterval(syncTimer);
      qrTimer = countdownTimer = syncTimer = null;
    };
  },
};

function renderAllPlaceholder() {
  for (const body of Object.values(hosts)) {
    body.replaceChildren(muted('加载中…'));
  }
}

// ---------- 连接卡 ----------

async function refreshConnection() {
  try {
    const payload = await request('/manage/qzone/status');
    local.auth = payload.auth || null;
    local.qzoneState = payload.status?.state || 'not_connected';
    renderConnection();
  } catch (error) {
    hosts.connectionBody.replaceChildren(muted(`加载失败：${error.message}`));
  }
}

function renderConnection() {
  const body = hosts.connectionBody;
  const stateLabel = { connected: '已连接', not_connected: '未连接', auth_required: '需要扫码', auth_failed: '登录失败' }[local.qzoneState] || local.qzoneState;
  const kind = local.qzoneState === 'connected' ? 'ok' : local.qzoneState === 'auth_failed' ? 'danger' : 'warn';

  const parts = [
    h('div', { class: 'inline' },
      badge(stateLabel, kind),
      local.auth?.state ? badge(`登录流程：${authStateLabel(local.auth.state)}`, 'muted') : null,
      h('span', { class: 'grow' }),
      button('重新连接 QQ', {
        onclick: (event) => reconnect(event.currentTarget),
      }),
    ),
    muted('扫码成功后会话保存在服务端 Key Vault，浏览器不会拿到 Cookie；二维码只在等待扫码的 10 分钟内可读。'),
  ];

  const auth = local.auth;
  if (auth?.qrUrl && auth.state === 'waiting_for_scan' && auth.expiresAt > Date.now()) {
    const countdown = h('span', { class: 'mono' });
    const tick = () => {
      const remaining = auth.expiresAt - Date.now();
      countdown.textContent = remaining > 0 ? `二维码 ${fmtCountdown(remaining)} 后过期` : '二维码已过期，请重新连接。';
      if (remaining <= 0) window.clearInterval(countdownTimer);
    };
    window.clearInterval(countdownTimer);
    tick();
    countdownTimer = window.setInterval(tick, 1000);
    parts.push(h('div', { class: 'qr' },
      h('img', { src: auth.qrUrl, alt: 'QQ 登录二维码' }),
      h('div', { class: 'stack' },
        h('strong', {}, '请使用手机 QQ 扫码'),
        muted('扫码成功后本页会自动更新连接状态，无需刷新。'),
        countdown,
      ),
    ));
  } else if (auth?.message && auth.state !== 'connected') {
    parts.push(muted(auth.message));
  }

  if (local.qzoneState === 'connected') {
    parts.push(h('p', { class: 'muted' },
      `会话检查于 ${local.auth?.connectedAt ? fmtDateTime(local.auth.connectedAt) : (get('status')?.qzone?.checkedAt ? fmtDateTime(get('status').qzone.checkedAt) : '未知时间')}。`,
    ));
  }

  body.replaceChildren(...parts);
}

function authStateLabel(state) {
  return {
    starting: '启动中',
    waiting_for_scan: '等待扫码',
    connected: '扫码成功',
    expired: '二维码过期',
    failed: '失败',
  }[state] || state;
}

async function reconnect(btn) {
  const ok = await confirmDialog({
    title: '重新连接 QQ',
    confirmLabel: '启动扫码',
    body: [
      h('p', {}, '将启动云端浏览器生成新的登录二维码。'),
      h('p', { class: 'muted' }, '若当前有等待扫码的二维码，会被作废。已保存的会话在过期前不受影响。'),
    ],
  });
  if (!ok) return;
  await withBusy(btn, async () => {
    await request('/manage/qzone/reconnect', { method: 'POST' });
    toast('扫码任务已启动，二维码生成后会自动显示。', 'ok');
    await refreshConnection();
    startQzonePolling();
  }, '启动失败');
}

/** 等待扫码期间每 3 秒轮询一次，直到连接成功 / 过期 / 失败。 */
function startQzonePolling() {
  window.clearInterval(qrTimer);
  const shouldPoll = local.auth?.state === 'starting' || local.auth?.state === 'waiting_for_scan';
  if (!shouldPoll) return;
  qrTimer = window.setInterval(async () => {
    try {
      const payload = await request('/manage/qzone/status');
      const before = local.auth?.state;
      local.auth = payload.auth || null;
      const newState = payload.status?.state || 'not_connected';
      const stateChanged = newState !== local.qzoneState;
      local.qzoneState = newState;
      renderConnection();
      if (newState === 'connected' && (before !== 'connected' || stateChanged)) {
        window.clearInterval(qrTimer);
        qrTimer = null;
        toast('QQ 登录会话已更新。', 'ok');
        local.ctx?.refreshStatus?.();
      } else if (['expired', 'failed'].includes(payload.auth?.state)) {
        window.clearInterval(qrTimer);
        qrTimer = null;
      }
    } catch {
      // 轮询失败静默重试，避免网络抖动打断扫码流程。
    }
  }, QR_POLL_MS);
}

// ---------- 自动发布卡 ----------

async function loadAutoPublish() {
  try {
    const payload = await request('/manage/settings');
    local.autoPublish = Boolean(payload.rules?.autoPublish);
    renderAutoPublish();
  } catch (error) {
    hosts.autoPublishBody.replaceChildren(muted(`加载失败：${error.message}`));
  }
}

function renderAutoPublish() {
  const body = hosts.autoPublishBody;
  body.replaceChildren(
    h('div', { class: 'inline' },
      switchControl(local.autoPublish, (checked) => saveAutoPublish(checked), '自动发布'),
      badge(local.autoPublish ? '开启：干净内容直接发布' : '关闭：所有内容只进审查队列', local.autoPublish ? 'ok' : 'warn'),
    ),
    muted(local.autoPublish
      ? '真实同步时，未触发任何隔离条件的内容会直接提交到公开内容仓库。隔离与待审内容仍需人工放行。'
      : '推荐首次使用时保持关闭：先跑验收预览，在下方审查队列逐条放行，再跑真实同步。'),
  );
}

async function saveAutoPublish(checked) {
  try {
    const payload = await request('/manage/settings');
    const rules = { ...payload.rules, autoPublish: checked };
    await request('/manage/settings', { method: 'PUT', body: { rules } });
    local.autoPublish = checked;
    toast('自动发布设置已保存。', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
  renderAutoPublish();
}

// ---------- 同步任务卡 ----------

async function refreshTaskInfo() {
  const payload = local.ctx?.refreshStatus ? await local.ctx.refreshStatus() : get('status');
  if (!payload) {
    hosts.taskBody.replaceChildren(muted('状态加载失败，请点右上角「刷新」。'));
    return;
  }
  local.syncState = payload.sync?.state || 'idle';
  local.lastSync = payload.lastSync || null;
  renderTask();
}

function renderTask() {
  const running = local.syncState === 'running';
  const last = local.lastSync;
  const watermark = get('status')?.watermark || null;
  const daysInput = h('input', { class: 'input input--sm input--select', type: 'number', min: '1', max: '365', value: String(local.backfillDays) });
  daysInput.addEventListener('change', () => {
    const value = Number(daysInput.value);
    if (Number.isFinite(value) && value >= 1 && value <= 365) local.backfillDays = value;
    daysInput.value = String(local.backfillDays);
  });

  const start = (mode, dryRun) => (event) => withBusy(event.currentTarget, async () => {
    await request('/manage/sync', {
      method: 'POST',
      body: { mode, dryRun, backfillDays: local.backfillDays },
    });
    toast(dryRun ? '验收预览已启动，完成后审查队列自动更新。' : '同步任务已启动，运行中按钮会保持禁用。', 'ok');
    awaitingSyncStart = true;
    syncPollTicks = 0;
    local.syncState = 'running';
    renderTask();
    startSyncPolling();
  }, '启动失败');

  const startFull = (event) => withBusy(event.currentTarget, async () => {
    const ok = await confirmDialog({
      title: '全量搬迁 QQ 空间',
      confirmLabel: '开始全量',
      body: [
        h('p', {}, '将抓取空间内全部历史动态（说说 + 转发视频），预计需要 1 小时以上。'),
        h('p', { class: 'muted' }, '自动发布开启时，未触发隔离条件的内容（含敏感信息的会被隔离）会随本次同步直接发布到站点。任务超时中断可再次执行，已发布内容不会重复。'),
      ],
    });
    if (!ok) return;
    await request('/manage/sync', {
      method: 'POST',
      body: { mode: 'full', dryRun: false, backfillDays: local.backfillDays },
    });
    toast('全量搬迁已启动，预计 1 小时以上，页面可关闭，任务在云端进行。', 'ok');
    awaitingSyncStart = true;
    syncPollTicks = 0;
    local.syncState = 'running';
    renderTask();
    startSyncPolling();
  }, '启动失败');

  hosts.taskBody.replaceChildren(
    h('div', { class: 'inline' },
      button('同步新动态（从上次开始）', {
        kind: 'primary', disabled: running,
        onclick: start('since', false),
      }),
      button('验收预览', { disabled: running, onclick: start('since', true) }),
      h('span', { class: 'grow' }),
      watermark
        ? h('span', { class: 'muted' }, `上次同步水位：${fmtDateTime(watermark.lastRunStartedAt)}`)
        : h('span', { class: 'muted' }, '尚无水位：首次同步将回看 7 天。'),
    ),
    muted([
      '「同步新动态」从上次成功同步的时间点开始抓取（自动含 2 小时缓冲），日常点这一个即可；',
      '每天凌晨 2 点云端也会自动同步一次，02:30 自动发布上线。',
      running ? ' 同步任务运行中，请稍候。' : '',
    ].join(' ')),
    collapse('高级：历史回填与全量搬迁',
      h('div', { class: 'inline' },
        h('span', { class: 'field__label' }, '回填天数'),
        daysInput,
        button('回填同步（指定天数）', { disabled: running, onclick: start('backfill', false) }),
        h('span', { class: 'grow' }),
        button('全量搬迁（全部历史）', { kind: 'danger', disabled: running, onclick: startFull }),
      ),
      muted('回填：抓最近 N 天。全量：抓取空间内全部历史动态，预计 1 小时以上，中断可重复执行（已发布内容按内容哈希去重，不会重复出现）。「验收预览」同样从上次水位开始、只出报告不发布。'),
    ),
    last ? h('div', { class: 'inline' },
      badge(last.dryRun ? '上次为验收预览' : '上次为真实同步', last.dryRun ? 'accent' : 'ok'),
      badge(`候选 ${last.counts?.publishedCandidate || 0}`),
      badge(`待审查 ${last.counts?.pendingReview || 0}`, 'warn'),
      badge(`隔离 ${last.counts?.quarantined || 0}`, 'danger'),
      h('span', { class: 'muted' }, fmtDateTime(last.generatedAt)),
    ) : muted('还没有同步记录。'),
  );
}

/** 任务运行期间轮询，直到回到非 running 状态后刷新报告。 */
function startSyncPollingIfNeeded() {
  if (local.syncState === 'running') startSyncPolling();
}

function startSyncPolling() {
  window.clearInterval(syncTimer);
  syncTimer = window.setInterval(async () => {
    syncPollTicks += 1;
    try {
      const payload = await request('/manage/status');
      local.syncState = payload.sync?.state || 'idle';
      local.lastSync = payload.lastSync || null;
      if (awaitingSyncStart && local.syncState === 'running') awaitingSyncStart = false;
      const settled = !awaitingSyncStart && local.syncState !== 'running';
      if (settled || syncPollTicks >= SYNC_POLL_MAX) {
        window.clearInterval(syncTimer);
        syncTimer = null;
        awaitingSyncStart = false;
        renderTask();
        await loadReport();
        toast(syncPollTicks >= SYNC_POLL_MAX ? '同步任务耗时较长，请稍后手动刷新查看结果。' : '同步任务结束，报告已刷新。', 'ok');
        local.ctx?.refreshStatus?.();
      }
    } catch {
      // 静默重试。
    }
  }, SYNC_POLL_MS);
}

// ---------- 审查队列 ----------

async function loadReport() {
  try {
    const payload = await request('/manage/sync/report');
    local.report = payload.report || null;
  } catch (error) {
    local.report = null;
    if (hosts) hosts.queueBody.replaceChildren(muted(`报告加载失败：${error.message}`));
    return;
  }
  renderQueue();
}

async function loadOverrides() {
  try {
    const payload = await request('/manage/overrides');
    local.overrides = payload.overrides?.overrides || {};
  } catch {
    local.overrides = {};
  }
  renderOverridesEditor();
  renderQueue();
}

function savedOverrideFor(record) {
  return local.overrides[overrideKeyFor(record)] || null;
}

function renderQueue() {
  const body = hosts.queueBody;
  if (!local.report) {
    body.replaceChildren(muted('还没有验收报告。先在上方跑一次「验收预览（不发布）」。'));
    return;
  }
  const records = Array.isArray(local.report.records) ? local.report.records : [];
  const actionable = records.filter((record) => {
    const saved = savedOverrideFor(record);
    const dismissed = saved && ['published', 'excluded'].includes(String(saved.publishStatus || ''));
    if (local.queueFilter === 'pending') {
      return record.publishStatus !== 'published' && !dismissed;
    }
    return !dismissed || local.draft.has(overrideKeyFor(record));
  });

  const filterButtons = h('div', { class: 'inline' },
    button(`待处理（${records.filter((r) => r.publishStatus !== 'published').length}）`, {
      size: 'sm', kind: local.queueFilter === 'pending' ? 'primary' : '',
      onclick: () => { local.queueFilter = 'pending'; renderQueue(); },
    }),
    button(`全部记录（${records.length}）`, {
      size: 'sm', kind: local.queueFilter === 'all' ? 'primary' : '',
      onclick: () => { local.queueFilter = 'all'; renderQueue(); },
    }),
  );

  const allUnknownVisibility = records.length > 0
    && records.every((record) => (record.reviewReasons || []).every(
      (reason) => reason === 'AUTO_PUBLISH_DISABLED' || reason === 'UNKNOWN_VISIBILITY',
    ));
  const visibilityHint = allUnknownVisibility
    ? h('div', { class: 'collapse' },
        h('summary', {}, '为什么每条都是「可见性未知」？'),
        h('div', { class: 'collapse__body' },
          muted('QQ 空间接口不返回每条说说的可见性字段，所以开启「可见性未知时隔离」后，全部内容都会进审查队列。两种用法：'),
          muted('① 保持现状逐条放行（最稳）；② 到「同步规则」页关闭「可见性未知时隔离」，干净内容将随真实同步直接发布——注意「仅自己可见」的说说也会一并公开发布，敏感词内容仍会被隔离。'),
        ),
      )
    : null;

  const draftItems = [...local.draft.entries()];
  const draftBar = draftItems.length
    ? h('div', { class: 'inline' },
        badge(`草稿：放行 ${draftItems.filter(([, ov]) => ov.publishStatus === 'published').length} 条 · 排除 ${draftItems.filter(([, ov]) => ov.publishStatus === 'excluded').length} 条`, 'accent'),
        h('span', { class: 'grow' }),
        button('保存覆盖', {
          kind: 'primary', size: 'sm',
          onclick: (event) => withBusy(event.currentTarget, saveDraftOverrides, '保存失败'),
        }),
        button('放弃草稿', {
          size: 'sm',
          onclick: () => { local.draft.clear(); renderQueue(); },
        }),
      )
    : muted('点击记录上的「放行 / 排除」累积为覆盖草稿，再一键保存。放行在下次真实同步时生效——增量同步只抓最近 7 天，更早的内容请用「回填同步」并保证天数覆盖其日期。');

  const cards = actionable.slice(0, 200).map(reviewCard);
  body.replaceChildren(
    filterButtons,
    visibilityHint,
    muted(`报告生成于 ${fmtDateTime(local.report.generatedAt)}${local.report.dryRun ? '（验收预览）' : ''}。报告反映的是本次同步时的状态；保存放行后需要再跑一次真实同步，记录才会真正发布。`),
    draftBar,
    cards.length ? h('div', { class: 'stack' }, cards) : muted('没有待处理的记录。'),
  );
}

function reviewCard(record) {
  const key = overrideKeyFor(record);
  const draft = local.draft.get(key);
  const saved = savedOverrideFor(record);
  const savedKind = String(saved?.publishStatus || '');
  const reasons = (record.reviewReasons || []).map((reason) => REVIEW_REASON[reason] || reason);
  const statusLabel = draft?.publishStatus === 'published' ? '草稿：放行'
    : draft?.publishStatus === 'excluded' ? '草稿：排除'
    : savedKind === 'published' ? '已放行'
    : savedKind === 'excluded' ? '已排除'
    : PUBLISH_STATUS[record.publishStatus] || record.publishStatus;
  const statusKind = draft?.publishStatus === 'published' || savedKind === 'published' ? 'ok'
    : draft?.publishStatus === 'excluded' ? 'muted'
    : savedKind === 'excluded' ? 'muted' : 'warn';
  const cardClass = draft?.publishStatus === 'published' ? 'review-card--draft-approved'
    : draft?.publishStatus === 'excluded' ? 'review-card--draft-excluded' : '';

  const mediaLink = record.media?.[0]?.sourceUrl || record.media?.[0]?.url || '';

  return h('div', { class: `review-card ${cardClass}`.trim() },
    h('div', { class: 'review-card__head' },
      h('div', { class: 'inline' },
        h('strong', {}, record.title || record.id),
        badge(statusLabel, statusKind),
      ),
      h('div', { class: 'inline' },
        draft ? button('撤销草稿', {
          size: 'sm',
          onclick: () => {
            local.draft.delete(key);
            renderQueue();
          },
        }) : null,
        button('放行', {
          size: 'sm', kind: 'primary',
          onclick: () => { local.draft.set(key, { publishStatus: 'published' }); renderQueue(); },
        }),
        button('排除', {
          size: 'sm',
          onclick: () => { local.draft.set(key, { publishStatus: 'excluded' }); renderQueue(); },
        }),
      ),
    ),
    h('p', { class: 'review-card__text' }, String(record.text || '').slice(0, 300) || '（无文字）'),
    metaLine('review-card__meta',
      record.date || '日期未知',
      `可见性 ${record.source?.visibility || 'unknown'}`,
      `${record.media?.length || 0} 个媒体`,
      reasons.length ? `原因：${reasons.join('、')}` : '无风险标记',
    ),
    mediaLink ? h('a', { href: mediaLink, target: '_blank', rel: 'noopener noreferrer' }, '打开首个源媒体检查') : null,
  );
}

async function saveDraftOverrides() {
  const payload = await request('/manage/overrides');
  const doc = payload.overrides || { schemaVersion: 1, overrides: {} };
  const merged = { ...(doc.overrides || {}) };
  for (const [key, value] of local.draft) {
    merged[key] = { ...merged[key], ...value };
  }
  await request('/manage/overrides', {
    method: 'PUT',
    body: { overrides: merged },
  });
  const approved = [...local.draft.values()].filter((ov) => ov.publishStatus === 'published').length;
  local.draft.clear();
  await loadOverrides();
  toast(`覆盖已保存（放行 ${approved} 条）。运行一次「回填同步」生效：天数需覆盖这些内容的日期（增量只抓最近 7 天）。`, 'ok');
}

// ---------- 高级：人工覆盖 JSON ----------

function renderOverridesEditor() {
  const body = hosts.overridesBody;
  const area = h('textarea', { class: 'code', spellcheck: 'false' });
  area.value = JSON.stringify({ schemaVersion: 1, overrides: local.overrides }, null, 2);
  const msg = h('p', { class: 'msg' });
  body.replaceChildren(
    muted('键格式：id:<QQ动态ID> 或 path:<记录ID>，值可包含 publishStatus / title / tags / phase 等。审查队列的放行/排除会自动维护这个文档。'),
    area,
    h('div', { class: 'inline' },
      button('保存覆盖 JSON', {
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const parsed = JSON.parse(area.value);
            const saved = await request('/manage/overrides', { method: 'PUT', body: { overrides: parsed.overrides || parsed } });
            local.overrides = saved.overrides || {};
            setMessage(msg, '覆盖已保存。', 'ok');
            renderQueue();
          } catch (error) {
            setMessage(msg, error.message, 'error');
          } finally {
            event.currentTarget.disabled = false;
          }
        },
      }),
      msg,
    ),
  );
}
