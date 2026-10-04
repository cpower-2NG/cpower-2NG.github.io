import { randomUUID } from 'node:crypto';
import { app } from '@azure/functions';
import { requireAdmin } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { cosmosContainers } from '../lib/cosmos.js';
import { DEFAULT_SYNC_RULES } from '../data/default-rules.js';
import { HttpError, assert } from '../lib/errors.js';
import { handleError, json, readJson } from '../lib/http.js';
import { startContainerJob } from '../lib/azure-jobs.js';
import { entryId as parseEntryId, text } from '../lib/validation.js';
import {
  assertNotRateLimited,
  registerLoginFailure,
  issueSessionToken,
  verifyPassword,
} from '../lib/admin-password.js';
import {
  assertUploadable,
  parseImportForm,
} from '../lib/import-validate.js';
import {
  assertReorderOf,
  countTagUsage,
  normalizeMomentFlags,
  normalizeTags,
  pickCoverCandidates,
  planSeriesMembers,
  planTagReplace,
  slugify,
} from '../lib/content-admin.js';
import {
  applyTagReplace,
  commentStatusCounts,
  createSeries,
  deleteSeries,
  getEntryDetail,
  listAllComments,
  listEntries,
  listMoments,
  listSeries,
  readState,
  setEntrySeries,
  updateCommentStatus,
  updateEntryCover,
  updateEntryTags,
  updateMomentFlags,
  updateSeries,
  writeState,
} from '../lib/repository.js';
import { exportInteractions } from '../lib/export-service.js';
import { privateReadSasUrl, readPrivateJson, uploadPrivateBlob } from '../lib/storage.js';

async function loadRules() {
  return (await readState('sync-rules', 'settings')) || { ...DEFAULT_SYNC_RULES };
}

/** 内容或导入改动都会让静态产物过期；发布按钮统一消费这个标记。 */
async function markPublishDirty(actor, note = '') {
  await writeState('publish-state', 'sync', {
    dirty: true,
    note,
    markedBy: actor,
    markedAt: new Date().toISOString(),
    type: 'publish-state',
  });
}

/** 系列/标签的 taxonomy 文档 id 形如 series:纸上魔法使，允许 CJK，但不允许斜杠。 */
function taxonomyId(value, field) {
  const normalized = text(value, field, { min: 2, max: 120, required: true });
  assert(!normalized.includes('/'), 400, `${field}不能包含斜杠。`, 'INVALID_INPUT');
  return normalized;
}

/** multipart 上传：原件落私有 Blob，建导入任务文档，由 content-import Job 消费。 */
async function createImportTask(request, admin) {
  const current = config();
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, '请求必须是 multipart/form-data。', 'INVALID_UPLOAD');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    throw new HttpError(400, '缺少上传文件（字段名 file）。', 'INVALID_UPLOAD');
  }
  const meta = parseImportForm({
    title: form.get('title'),
    phase: form.get('phase'),
    section: form.get('section'),
    tags: form.get('tags'),
    coverIndex: form.get('coverIndex'),
  });
  const { safeName, ext } = assertUploadable({
    filename: file.name,
    bytes: file.size,
    maxBytes: current.maxUploadBytes,
  });

  const taskKey = randomUUID().replaceAll('-', '');
  const blobName = `originals/${taskKey}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadPrivateBlob(blobName, buffer, file.type || 'application/octet-stream');

  const task = {
    id: `import:${taskKey}`,
    partitionKey: 'imports',
    type: 'import-task',
    taskKey,
    status: 'queued',
    fileName: safeName,
    ext,
    bytes: buffer.length,
    blobName,
    ...meta,
    requestedBy: admin.oid,
    requestedAt: new Date().toISOString(),
    stages: [],
  };
  await writeState(task.id, 'imports', task);
  return { ...task, blobName: '' };
}

async function listImportTasks() {
  const { state } = cosmosContainers();
  const result = await state.items.query(
    { query: "SELECT * FROM c WHERE c.type = 'import-task' ORDER BY c.requestedAt DESC" },
    { partitionKey: 'imports' },
  ).fetchAll();
  return result.resources
    .slice(0, 20)
    .map((task) => ({
      id: task.taskKey,
      status: task.status,
      fileName: task.fileName,
      title: task.title || '',
      section: task.section,
      phase: task.phase,
      bytes: task.bytes,
      requestedAt: task.requestedAt,
      updatedAt: task.updatedAt,
      entryId: task.entryId || '',
      error: task.error || '',
      counts: task.counts || null,
    }));
}

async function status() {
  const [qzone, sync, lastExport, lastSync, commentCounts, publishState, lastPublish] = await Promise.all([
    readState('qzone-status', 'sync'),
    readState('sync-status', 'sync'),
    readState('last-export', 'sync'),
    readState('last-sync-report', 'sync'),
    commentStatusCounts().catch(() => ({})),
    readState('publish-state', 'sync'),
    readState('last-publish', 'sync'),
  ]);
  return {
    service: 'ok',
    qzone: qzone || { state: 'not_connected' },
    sync: sync || { state: 'idle' },
    lastExport,
    commentCounts,
    publish: {
      dirty: Boolean(publishState?.dirty),
      markedAt: publishState?.markedAt || '',
      lastPublish: lastPublish
        ? {
            publishedAt: lastPublish.publishedAt,
            status: lastPublish.status,
            commit: lastPublish.commit,
            counts: lastPublish.counts,
            error: lastPublish.error || '',
          }
        : null,
    },
    lastSync: lastSync
      ? {
          generatedAt: lastSync.generatedAt,
          dryRun: lastSync.dryRun,
          counts: lastSync.counts,
          reportPath: lastSync.reportPath,
          quarantinePath: lastSync.quarantinePath,
          commit: lastSync.commit,
        }
      : null,
  };
}

/** 账密登录：单管理员 + 环境变量哈希；失败计数按来源 IP 限流。 */
async function authLogin(request, context) {
  const current = config();
  if (!current.adminUsername || !current.adminPasswordHash || !current.adminSessionSecret) {
    throw new HttpError(503, '账密登录尚未配置。', 'ADMIN_AUTH_NOT_CONFIGURED');
  }
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  assertNotRateLimited(ip);
  const body = await readJson(request);
  const username = String(body.username || '');
  const password = String(body.password || '');
  const ok = Boolean(username) && Boolean(password)
    && verifyPassword(username, password, current.adminPasswordHash);
  if (!ok) {
    registerLoginFailure(ip);
    context.warn(`账密登录失败（来源 ${ip}）`);
    throw new HttpError(401, '账号或口令不正确。', 'INVALID_CREDENTIALS');
  }
  const session = issueSessionToken({ name: current.adminUsername }, current);
  return json(request, {
    token: session.token,
    expiresAt: session.expiresAt,
    name: current.adminUsername,
    method: 'password',
  });
}

app.http('admin', {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  route: 'manage/{action}/{id?}',
  handler: async (request, context) => {
    try {
      const action = String(request.params.action || '');
      const id = request.params.id ? String(request.params.id) : '';

      if (action === 'auth' && request.method === 'POST') {
        return await authLogin(request, context);
      }

      const admin = await requireAdmin(request);

      if (action === 'status' && request.method === 'GET') {
        return json(request, await status());
      }

      if (action === 'comments' && request.method === 'GET') {
        return json(request, {
          items: await listAllComments({
            entryId: request.query.get('entryId') || '',
            status: request.query.get('status') || '',
          }),
        });
      }

      if (action === 'comments' && ['PATCH', 'DELETE'].includes(request.method)) {
        const body = await readJson(request);
        const entryId = String(body.entryId || '');
        if (!id || !entryId) {
          throw new HttpError(400, '缺少评论 id 或内容标识。', 'MISSING_COMMENT_TARGET');
        }
        const status = request.method === 'DELETE' ? 'deleted' : String(body.status || '');
        if (!['published', 'pending', 'hidden', 'deleted'].includes(status)) {
          throw new HttpError(400, '评论状态无效。', 'INVALID_STATUS');
        }
        return json(request, await updateCommentStatus(id, entryId, status));
      }

      if (action === 'settings' && request.method === 'GET') {
        return json(request, { rules: await loadRules() });
      }

      if (action === 'settings' && request.method === 'PUT') {
        const body = await readJson(request);
        const rules = body.rules && typeof body.rules === 'object' ? body.rules : body;
        const saved = await writeState('sync-rules', 'settings', {
          ...DEFAULT_SYNC_RULES,
          ...rules,
          schemaVersion: 1,
          type: 'sync-rules',
        });
        return json(request, { rules: saved });
      }

      if (action === 'overrides' && request.method === 'GET') {
        return json(request, {
          overrides: (await readState('content-overrides', 'settings')) || {
            schemaVersion: 1,
            overrides: {},
          },
        });
      }

      if (action === 'overrides' && request.method === 'PUT') {
        const body = await readJson(request);
        const overrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
        return json(request, await writeState('content-overrides', 'settings', {
          schemaVersion: 1,
          overrides,
          type: 'content-overrides',
        }));
      }

      if (action === 'sync' && request.method === 'POST') {
        const body = await readJson(request);
        await writeState('sync-request', 'sync', {
          requestedAt: new Date().toISOString(),
          requestedBy: admin.oid,
          mode: body.mode === 'backfill' ? 'backfill' : 'incremental',
          backfillDays: Number(body.backfillDays) || 31,
          dryRun: body.dryRun !== false,
          type: 'sync-request',
        });
        await startContainerJob(config().syncJobName);
        return json(request, { started: true, job: config().syncJobName });
      }

      if (action === 'sync' && id === 'report' && request.method === 'GET') {
        const record = await readState('last-sync-report', 'sync');
        if (!record?.reportPath && !record?.quarantinePath) {
          return json(request, { report: null });
        }
        if (record.reportPath) {
          return json(request, { report: await readPrivateJson(record.reportPath) });
        }
        const records = await readPrivateJson(record.quarantinePath);
        return json(request, {
          report: {
            schemaVersion: 1,
            generatedAt: record.generatedAt,
            dryRun: false,
            counts: record.counts,
            records,
          },
        });
      }

      if (action === 'qzone' && id === 'reconnect' && request.method === 'POST') {
        await writeState('qzone-auth-request', 'sync', {
          requestedAt: new Date().toISOString(),
          requestedBy: admin.oid,
          state: 'starting',
          type: 'qzone-auth-request',
        });
        await startContainerJob(config().syncAuthJobName);
        return json(request, { started: true, job: config().syncAuthJobName });
      }

      if (action === 'qzone' && id === 'status' && request.method === 'GET') {
        const auth = (await readState('qzone-auth-request', 'sync')) || null;
        let qrUrl = '';
        if (auth?.qrBlobName && auth.state === 'waiting_for_scan' && auth.expiresAt > Date.now()) {
          qrUrl = await privateReadSasUrl(auth.qrBlobName, 10);
        }
        return json(request, {
          status: (await readState('qzone-status', 'sync')) || { state: 'not_connected' },
          auth: auth ? { ...auth, qrUrl } : null,
        });
      }

      if (action === 'export' && request.method === 'POST') {
        const result = await exportInteractions({ reason: `manual:${admin.oid}` });
        await writeState('last-export', 'sync', result);
        return json(request, result);
      }

      // ---- 内容管理：条目 ----

      if (action === 'entries' && request.method === 'GET' && !id) {
        const phase = text(request.query.get('phase'), '位面', { max: 20 });
        const section = text(request.query.get('section'), '分区', { max: 40 });
        const q = text(request.query.get('q'), '关键词', { max: 60 }).toLowerCase();
        const status = text(request.query.get('status'), '状态', { max: 20 });
        let items = await listEntries({ phase, section, status });
        if (q) {
          items = items.filter((entry) =>
            String(entry.title || '').toLowerCase().includes(q)
            || String(entry.summary || '').toLowerCase().includes(q));
        }
        return json(request, { items });
      }

      if (action === 'entries' && request.method === 'GET' && id) {
        const detail = await getEntryDetail(parseEntryId(id));
        return json(request, {
          ...detail,
          coverCandidates: pickCoverCandidates(detail.coverCandidates, detail.entry.cover?.assetId || ''),
        });
      }

      if (action === 'entries' && request.method === 'PATCH' && id) {
        const body = await readJson(request);
        const entryId = parseEntryId(id);
        const results = {};
        if (body.cover !== undefined) {
          const assetId = body.cover?.assetId ? text(body.cover.assetId, '封面媒体', { max: 120 }) : '';
          results.cover = await updateEntryCover(entryId, assetId);
        }
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags)) {
            throw new HttpError(400, 'tags 必须是数组。', 'INVALID_INPUT');
          }
          results.tags = normalizeTags(body.tags);
          await updateEntryTags(entryId, results.tags);
        }
        if (body.seriesId !== undefined) {
          const seriesId = body.seriesId ? taxonomyId(body.seriesId, '系列标识') : '';
          if (seriesId && !String(seriesId).startsWith('series:')) {
            throw new HttpError(400, '系列标识必须以 series: 开头。', 'INVALID_INPUT');
          }
          results.series = await setEntrySeries(entryId, seriesId, body.seriesOrder);
        }
        if (!Object.keys(results).length) {
          throw new HttpError(400, '没有要更新的字段。', 'EMPTY_UPDATE');
        }
        await markPublishDirty(admin.oid, `条目 ${entryId}`);
        return json(request, { updated: results });
      }

      // ---- 内容管理：系列 ----

      if (action === 'series' && request.method === 'GET' && !id) {
        const [seriesDocs, entries] = await Promise.all([listSeries(), listEntries({})]);
        const items = seriesDocs.map((doc) => ({
          id: doc.id,
          label: doc.label,
          description: doc.description || '',
          cover: doc.cover || null,
          memberIds: entries
            .filter((entry) => entry.seriesId === doc.id)
            .sort((a, b) => (a.seriesOrder || 0) - (b.seriesOrder || 0))
            .map((entry) => ({ entryId: entry.id, title: entry.title, seriesOrder: entry.seriesOrder || null })),
        }));
        return json(request, { items });
      }

      if (action === 'series' && request.method === 'POST' && !id) {
        const body = await readJson(request);
        const label = text(body.label, '系列名称', { min: 1, max: 80, required: true });
        const description = text(body.description, '系列简介', { max: 400 });
        const slug = slugify(body.slug || label);
        assert(slug, 400, '无法从名称生成 slug，请手动指定。', 'INVALID_INPUT');
        const doc = await createSeries({ label, description, slug, coverAssetId: body.coverAssetId || '' });
        await markPublishDirty(admin.oid, `新建系列 ${doc.id}`);
        return json(request, { series: doc }, 201);
      }

      if (action === 'series' && ['PATCH', 'DELETE'].includes(request.method) && id) {
        const seriesId = taxonomyId(id, '系列标识');
        if (request.method === 'DELETE') {
          const entries = await listEntries({});
          const inUse = entries.filter((entry) => entry.seriesId === seriesId);
          if (inUse.length) {
            throw new HttpError(409, `还有 ${inUse.length} 篇条目属于该系列，请先移出成员。`, 'SERIES_IN_USE');
          }
          await deleteSeries(seriesId);
          await markPublishDirty(admin.oid, `删除系列 ${seriesId}`);
          return json(request, { deleted: seriesId });
        }
        const body = await readJson(request);
        const updated = await updateSeries(seriesId, {
          ...(body.label !== undefined ? { label: text(body.label, '系列名称', { min: 1, max: 80 }) } : {}),
          ...(body.description !== undefined ? { description: text(body.description, '系列简介', { max: 400 }) } : {}),
          ...(body.coverAssetId !== undefined ? { coverAssetId: String(body.coverAssetId || '') } : {}),
        });
        if (body.memberIds !== undefined) {
          const entries = await listEntries({});
          const currentMemberIds = entries
            .filter((entry) => entry.seriesId === seriesId)
            .map((entry) => entry.id);
          const ordered = assertReorderOf(currentMemberIds, body.memberIds);
          const plan = planSeriesMembers(seriesId, currentMemberIds, ordered);
          for (const assignment of plan.assignments) {
            await setEntrySeries(assignment.entryId, assignment.seriesId, assignment.seriesOrder);
          }
          for (const entryId of plan.removals) {
            await setEntrySeries(entryId, '', null);
          }
        }
        await markPublishDirty(admin.oid, `更新系列 ${seriesId}`);
        return json(request, { series: updated });
      }

      // ---- 内容管理：标签 ----

      if (action === 'tags' && request.method === 'GET' && !id) {
        const entries = await listEntries({});
        const usage = countTagUsage(entries);
        const used = new Set(usage.map((item) => item.label));
        // taxonomy 里登记但当前无条目使用的标签也列出（count 为 0），便于清理。
        const { taxonomy } = cosmosContainers();
        const docs = await taxonomy.items.query(
          { query: 'SELECT c.label FROM c' },
          { partitionKey: 'tag' },
        ).fetchAll();
        const extras = docs.resources
          .map((doc) => String(doc.label || ''))
          .filter((label) => label && !used.has(label))
          .map((label) => ({ label, count: 0 }));
        return json(request, { items: [...usage, ...extras] });
      }

      if (action === 'tags' && request.method === 'POST' && ['rename', 'merge'].includes(id)) {
        const body = await readJson(request);
        const entries = await listEntries({});
        const plan = planTagReplace(entries, body.from, body.to);
        const result = await applyTagReplace(plan);
        await markPublishDirty(admin.oid, `标签 ${plan.from} → ${plan.to}（${id}）`);
        return json(request, { ...result, action: id });
      }

      // ---- 内容管理：动态 ----

      if (action === 'moments' && request.method === 'GET' && !id) {
        const items = await listMoments();
        return json(request, { items: items.map((moment) => ({
          ...moment,
          text: String(moment.text || '').slice(0, 120),
        })) });
      }

      if (action === 'moments' && request.method === 'PATCH' && id) {
        const body = await readJson(request);
        const month = text(body.month, '动态月份', { min: 7, max: 7, required: true });
        const flags = normalizeMomentFlags(body);
        const result = await updateMomentFlags(parseEntryId(id), month, flags);
        await markPublishDirty(admin.oid, `动态 ${id} 置顶/精选`);
        return json(request, result);
      }

      // ---- 发布与导入 ----

      if (action === 'publish' && request.method === 'POST') {
        await writeState('publish-request', 'sync', {
          requestedAt: new Date().toISOString(),
          requestedBy: admin.oid,
          type: 'publish-request',
        });
        await startContainerJob(config().publishJobName);
        return json(request, { started: true, job: config().publishJobName });
      }

      if (action === 'import' && request.method === 'POST' && !id) {
        const task = await createImportTask(request, admin);
        await startContainerJob(config().importJobName);
        return json(request, { task }, 201);
      }

      if (action === 'import' && request.method === 'GET' && !id) {
        const items = await listImportTasks();
        return json(request, { items });
      }

      if (action === 'import' && request.method === 'GET' && id) {
        const task = await readState(`import:${parseEntryId(id)}`, 'imports');
        if (!task) {
          throw new HttpError(404, '导入任务不存在。', 'IMPORT_TASK_NOT_FOUND');
        }
        return json(request, { task });
      }

      throw new HttpError(404, '管理操作不存在。', 'ADMIN_ACTION_NOT_FOUND');
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
