import { app } from '@azure/functions';
import { requireAdmin } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { DEFAULT_SYNC_RULES } from '../data/default-rules.js';
import { HttpError } from '../lib/errors.js';
import { handleError, json, readJson } from '../lib/http.js';
import { startContainerJob } from '../lib/azure-jobs.js';
import {
  listAllComments,
  readState,
  updateCommentStatus,
  writeState,
} from '../lib/repository.js';
import { exportInteractions } from '../lib/export-service.js';
import { privateReadSasUrl, readPrivateJson } from '../lib/storage.js';

async function loadRules() {
  return (await readState('sync-rules', 'settings')) || { ...DEFAULT_SYNC_RULES };
}

async function status() {
  const [qzone, sync, lastExport, lastSync] = await Promise.all([
    readState('qzone-status', 'sync'),
    readState('sync-status', 'sync'),
    readState('last-export', 'sync'),
    readState('last-sync-report', 'sync'),
  ]);
  return {
    service: 'ok',
    qzone: qzone || { state: 'not_connected' },
    sync: sync || { state: 'idle' },
    lastExport,
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

app.http('admin', {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  route: 'manage/{action}/{id?}',
  handler: async (request, context) => {
    try {
      const admin = await requireAdmin(request);
      const action = String(request.params.action || '');
      const id = request.params.id ? String(request.params.id) : '';

      if (action === 'status' && request.method === 'GET') {
        return json(request, await status());
      }

      if (action === 'comments' && request.method === 'GET') {
        return json(request, {
          items: await listAllComments({
            path: request.query.get('path') || '',
            status: request.query.get('status') || '',
          }),
        });
      }

      if (action === 'comments' && ['PATCH', 'DELETE'].includes(request.method)) {
        const body = await readJson(request);
        const path = String(body.path || '');
        if (!id || !path) {
          throw new HttpError(400, '缺少评论 id 或文章路径。', 'MISSING_COMMENT_TARGET');
        }
        const status = request.method === 'DELETE' ? 'deleted' : String(body.status || '');
        if (!['published', 'pending', 'hidden', 'deleted'].includes(status)) {
          throw new HttpError(400, '评论状态无效。', 'INVALID_STATUS');
        }
        return json(request, await updateCommentStatus(id, path, status));
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

      throw new HttpError(404, '管理操作不存在。', 'ADMIN_ACTION_NOT_FOUND');
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
