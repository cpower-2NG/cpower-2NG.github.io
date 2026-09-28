import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requireFromSync = createRequire(resolve(root, 'sync', 'package.json'));
const { CosmosClient } = requireFromSync('@azure/cosmos');
const { DefaultAzureCredential } = requireFromSync('@azure/identity');
const site = JSON.parse(await readFile(resolve(root, 'data', 'site.json'), 'utf8'));
const entries = JSON.parse(await readFile(resolve(root, 'data', 'entries.json'), 'utf8'));
const apiBase = String(site.interactions?.apiBaseUrl || '').replace(/\/+$/, '');
const testPath = '/content/fantasy/article/__interaction-live-test__.html';
const confirm = process.argv.includes('--confirm=WRITE');
const cosmosEndpoint = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const cosmosDatabase = process.env.COSMOS_DATABASE || 'bifrost';
const visitorId = `live-check-${Date.now()}`;
const runId = Date.now().toString(36);
const created = {
  comments: [],
  activity: [],
};

if (!confirm) {
  throw new Error('真实写入检查必须显式传入 --confirm=WRITE。');
}
if (entries.entries.some((entry) => entry.path === testPath)) {
  throw new Error(`测试路径已存在于公开内容索引：${testPath}`);
}

async function api(route, options = {}) {
  const response = await fetch(`${apiBase}${route}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${route} 返回 ${response.status}: ${payload.message || payload.error || '未知错误'}`);
  }
  return payload;
}

async function cleanup() {
  const client = new CosmosClient(
    process.env.COSMOS_KEY
      ? { endpoint: cosmosEndpoint, key: process.env.COSMOS_KEY }
      : { endpoint: cosmosEndpoint, aadCredentials: new DefaultAzureCredential() },
  );
  const database = client.database(cosmosDatabase);
  const results = { deleted: 0 };
  for (const containerName of ['comments', 'activity']) {
    const container = database.container(containerName);
    const query = await container.items.query(
      {
        query: 'SELECT * FROM c WHERE c.path = @path',
        parameters: [{ name: '@path', value: testPath }],
      },
      { partitionKey: testPath },
    ).fetchAll();
    for (const item of query.resources) {
      await container.item(item.id, testPath).delete();
      results.deleted += 1;
    }
  }
  const remaining = [];
  for (const containerName of ['comments', 'activity']) {
    const container = database.container(containerName);
    const query = await container.items.query(
      {
        query: 'SELECT VALUE COUNT(1) FROM c WHERE c.path = @path',
        parameters: [{ name: '@path', value: testPath }],
      },
      { partitionKey: testPath },
    ).fetchAll();
    remaining.push({ container: containerName, count: Number(query.resources[0]) || 0 });
  }
  return { ...results, remaining };
}

let report = null;
let failure = null;
try {
  const baseline = await api(`/interactions?path=${encodeURIComponent(testPath)}&visitorId=${encodeURIComponent(visitorId)}`);
  const rootComment = await api('/comments', {
    method: 'POST',
    body: {
      path: testPath,
      visitorId,
      content: `BIFROST 写入检查 ${runId}：根评论`,
      parentId: null,
      anonymous: false,
      nickname: 'BIFROST 自动检查',
      email: '',
      website: '',
      honeypot: '',
      elapsedMs: 2500,
    },
  });
  created.comments.push(rootComment.id);

  const reply = await api('/comments', {
    method: 'POST',
    body: {
      path: testPath,
      visitorId,
      content: `BIFROST 写入检查 ${runId}：回复`,
      parentId: rootComment.id,
      anonymous: true,
      nickname: '',
      email: '',
      website: '',
      honeypot: '',
      elapsedMs: 2500,
    },
  });
  created.comments.push(reply.id);

  await api('/reactions', {
    method: 'POST',
    body: { path: testPath, visitorId },
  });
  const unliked = await api('/reactions', {
    method: 'POST',
    body: { path: testPath, visitorId },
  });
  assert.equal(unliked.liked, false);
  assert.equal(Number(unliked.likes), Number(baseline.likes));

  const firstView = await api('/views', {
    method: 'POST',
    body: { path: testPath, visitorId },
  });
  const secondView = await api('/views', {
    method: 'POST',
    body: { path: testPath, visitorId },
  });
  assert.equal(Number(secondView.views), Number(firstView.views), '同一访客同一天的阅读数被重复累加。');

  const after = await api(`/interactions?path=${encodeURIComponent(testPath)}&visitorId=${encodeURIComponent(visitorId)}`);
  assert.equal(Number(after.commentCount), 2);
  assert.equal(Number(after.likes), Number(baseline.likes));
  assert.equal(Number(after.views), Number(baseline.views) + 1);
  report = {
    ok: true,
    path: testPath,
    baseline,
    after,
    rootCommentId: rootComment.id,
    replyId: reply.id,
  };
} catch (error) {
  failure = error;
} finally {
  try {
    report = { ...(report || {}), cleanup: await cleanup() };
  } catch (cleanupError) {
    failure = failure
      ? new Error(`${failure.message}\n清理失败：${cleanupError.message}`)
      : cleanupError;
  }
}

if (failure) {
  process.stderr.write(`${failure.stack || failure.message}\n`);
  if (report?.cleanup) {
    process.stderr.write(`${JSON.stringify(report.cleanup, null, 2)}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
