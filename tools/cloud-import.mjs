#!/usr/bin/env node
// 云端导入任务（content-import Container Apps Job 的入口）：
//   取 state 里最旧的 queued 导入任务 → 从私有 Blob 下载原件 →
//   复用本目录的 import-content / build-documents / blob-push / cosmos-push 完成入库 →
//   任务文档记录 succeeded（条目 id、媒体数、字数）或 failed（失败阶段与原因）。
// 幂等边界（设计文档留待后续，本期最简）：任务被置 running 后不会被重复拾取；
// 失败后不自动重试，重新上传即生成新任务。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient } from '@azure/cosmos';

const run = promisify(execFile);
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';
const BLOB_ACCOUNT_URL = process.env.BLOB_ACCOUNT_URL || 'https://stbifrostz43zcc.blob.core.windows.net';
const PRIVATE_CONTAINER = process.env.PRIVATE_CONTAINER || 'private';
const WORK_ROOT = resolve('.import-tmp');

function cosmos() {
  return process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

function stateContainer() {
  return cosmos().database(DATABASE).container('state');
}

async function readTask(id) {
  return (await stateContainer().item(id, 'imports').read()).resource || null;
}

async function patchTask(id, patch) {
  const container = stateContainer();
  const current = await readTask(id);
  if (!current) throw new Error(`导入任务丢失：${id}`);
  const updated = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await container.item(id, 'imports').replace(updated);
  return updated;
}

async function pickQueuedTask() {
  const result = await stateContainer().items.query(
    {
      query: "SELECT * FROM c WHERE c.type = 'import-task' AND c.status = 'queued' ORDER BY c.requestedAt ASC",
    },
    { partitionKey: 'imports' },
  ).fetchAll();
  return result.resources[0] || null;
}

/** 崩溃残留的 running 任务超过 2 小时视为死任务，放回队列避免永久卡住。 */
async function reclaimStaleRunningTasks() {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const result = await stateContainer().items.query(
    {
      query: "SELECT * FROM c WHERE c.type = 'import-task' AND c.status = 'running' AND c.updatedAt < @cutoff",
      parameters: [{ name: '@cutoff', value: cutoff }],
    },
    { partitionKey: 'imports' },
  ).fetchAll();
  for (const task of result.resources) {
    await patchTask(task.id, {
      status: 'queued',
      error: '任务超时被回收，重新排队。',
      stages: [...(task.stages || []), '超时回收'],
    });
    console.log(`[import] 回收超时任务 ${task.id}`);
  }
}

async function downloadOriginal(blobName, destFile) {
  const container = new BlobServiceClient(BLOB_ACCOUNT_URL, new DefaultAzureCredential())
    .getContainerClient(PRIVATE_CONTAINER);
  const response = await container.getBlockBlobClient(blobName).download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.from(chunk));
  }
  await mkdir(dirname(destFile), { recursive: true });
  await writeFile(destFile, Buffer.concat(chunks));
}

async function readPackageSummary(pkgDir) {
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  let mediaCount = 0;
  try {
    const assets = JSON.parse(await readFile(join(pkgDir, 'documents', 'assets.json'), 'utf8'));
    mediaCount = (assets.items || []).length;
  } catch {
    mediaCount = 0;
  }
  return {
    entryId: manifest.entryId || '',
    title: manifest.title || '',
    slug: manifest.slug || '',
    path: manifest.path || '',
    section: manifest.section || '',
    phase: manifest.phase || '',
    wordCount: Number(manifest.wordCount) || 0,
    mediaCount,
  };
}

let activeTaskId = '';

async function main() {
  await reclaimStaleRunningTasks();
  const task = await pickQueuedTask();
  if (!task) {
    console.log('[import] 没有待处理的导入任务。');
    return;
  }
  activeTaskId = task.id;
  const workDir = join(WORK_ROOT, task.taskKey);
  const pkgDir = join(workDir, 'batch', 'pkg');
  const originalFile = join(workDir, 'originals', task.fileName);
  console.log(`[import] 开始处理 ${task.id}（${task.fileName}）`);

  await patchTask(task.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    stages: ['已领取任务'],
  });

  await downloadOriginal(task.blobName, originalFile);
  console.log('[import] 原件已下载。');

  const importArgs = [
    'tools/import-content.mjs',
    originalFile,
    '--out', pkgDir,
    '--phase', task.phase,
    '--section', task.section,
    '--status', 'published',
  ];
  if (task.title) importArgs.push('--title', task.title);
  if (task.tags?.length) importArgs.push('--tags', task.tags.join(','));
  if (task.coverIndex > 0) importArgs.push('--cover', String(task.coverIndex));
  await patchTask(task.id, { stages: [...(await readTask(task.id)).stages, '转换中（pandoc）'] });
  await run(process.execPath, importArgs, { stdio: 'inherit' });

  await patchTask(task.id, { stages: [...(await readTask(task.id)).stages, '生成文档记录'] });
  await run(process.execPath, ['tools/build-documents.mjs', pkgDir], { stdio: 'inherit' });

  await patchTask(task.id, { stages: [...(await readTask(task.id)).stages, '媒体上传 Blob'] });
  await run(process.execPath, ['tools/blob-push.mjs', join(workDir, 'batch')], { stdio: 'inherit' });

  await patchTask(task.id, { stages: [...(await readTask(task.id)).stages, '写入权威容器'] });
  await run(process.execPath, ['tools/cosmos-push.mjs', join(workDir, 'batch')], { stdio: 'inherit' });

  const summary = await readPackageSummary(pkgDir);
  await patchTask(task.id, {
    status: 'succeeded',
    finishedAt: new Date().toISOString(),
    entryId: summary.entryId,
    counts: {
      mediaCount: summary.mediaCount,
      wordCount: summary.wordCount,
    },
    stages: [...(await readTask(task.id)).stages, '完成（发布仍需在管理台手动触发）'],
  });
  console.log(`[import] 完成：${summary.title || summary.slug} → ${summary.entryId}`);
  await rm(workDir, { recursive: true, force: true });
}

main().catch(async (error) => {
  console.error('[import] 失败：', error?.message || error);
  try {
    if (activeTaskId) {
      const current = await readTask(activeTaskId);
      await patchTask(activeTaskId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 500),
        stages: [...(current?.stages || []), '失败'],
      });
    }
  } catch (recordError) {
    console.error('[import] 状态写入也失败：', recordError?.message || recordError);
  }
  process.exitCode = 1;
});
