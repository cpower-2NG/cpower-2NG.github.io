#!/usr/bin/env node
// 云端发布任务（content-publish Container Apps Job 的入口，MODE=publish 语义）：
//   1. 全量重建 search-docs 投影（权威容器 + signals 计数 → search-docs）
//   2. 物化静态站点到 site-build/
//   3. 产物以单个 commit 回写 GitHub，push 到 main 自动触发 Pages
//   4. search-docs 推送到 AI Search
//   5. 写 last-publish 状态并清除待发布标记
// 任何一步失败都会在 last-publish 里留下原因，并以非零码退出让 Job 显示失败。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { commitFiles, listBlobPaths } from '../sync/src/github.js';

const run = promisify(execFile);
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';
const OUT_DIR = process.env.PUBLISH_OUT_DIR || 'site-build';
// 物化产物里需要提交的部分；index.html/core 等源码本就在仓库，不在此列。
const ARTIFACT_ROOTS = ['content', 'moment', 'series'];
const ARTIFACT_FILES = ['data/site-index.json', 'data/site.json', 'feed.xml', 'sitemap.xml'];

function cosmos() {
  return process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

function now() {
  return new Date().toISOString();
}

async function recordPublish(status, extra = {}) {
  const db = cosmos().database(DATABASE);
  const document = {
    ...extra,
    id: 'last-publish',
    partitionKey: 'sync',
    type: 'publish-state',
    status,
    publishedAt: now(),
  };
  await db.container('state').items.upsert(document);
  if (status === 'succeeded') {
    await db.container('state').items.upsert({
      id: 'publish-state',
      partitionKey: 'sync',
      type: 'publish-state',
      dirty: false,
      clearedAt: now(),
    });
  }
  return document;
}

/**
 * 全量重建检索投影：可随时重跑（幂等 upsert）。
 * 计数取自 signals 的 metric 文档，替代旧内容包里硬编码为 0 的 counts，
 * 并顺带修复旧投影 coverUrl 恒空、pinned/featured 恒 false 的问题。
 */
async function rebuildSearchDocs() {
  const db = cosmos().database(DATABASE);
  const [entries, bodies, moments, assets, metrics] = await Promise.all([
    db.container('content-articles').items.query("SELECT * FROM c WHERE c.type = 'entry' AND c.status = 'published'").fetchAll(),
    db.container('content-articles').items.query("SELECT * FROM c WHERE c.type = 'entry-body'").fetchAll(),
    db.container('content-moments').items.query('SELECT * FROM c').fetchAll(),
    db.container('assets').items.query('SELECT * FROM c').fetchAll(),
    db.container('signals').items.query("SELECT c.entryId, c.likes, c.views, c.comments FROM c WHERE c.type = 'metric'").fetchAll(),
  ]);

  const assetsById = new Map(assets.resources.map((asset) => [asset.id, asset]));
  const bodiesByEntry = new Map(bodies.resources.map((body) => [body.entryId, body]));
  const countsByEntry = new Map(metrics.resources.map((metric) => [metric.entryId, {
    likes: Number(metric.likes) || 0,
    views: Number(metric.views) || 0,
    comments: Number(metric.comments) || 0,
  }]));
  const zeroCounts = { likes: 0, views: 0, comments: 0 };
  const docs = [];

  for (const entry of entries.resources) {
    const body = bodiesByEntry.get(entry.id);
    const cover = entry.cover?.assetId ? assetsById.get(entry.cover.assetId) : null;
    const media = Array.isArray(entry.media) ? entry.media : [];
    docs.push({
      id: entry.id,
      type: 'search-doc',
      schemaVersion: 1,
      entryId: entry.id,
      entryType: 'article',
      title: entry.title || '',
      summary: entry.summary || '',
      bodyText: body?.text || '',
      phase: entry.phase || '',
      section: entry.section || '',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      seriesId: entry.seriesId || '',
      kind: entry.kind || 'standard',
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt || entry.publishedAt,
      counts: countsByEntry.get(entry.id) || zeroCounts,
      path: entry.path || '',
      slug: entry.slug || '',
      wordCount: body?.wordCount || 0,
      hasMedia: media.length > 0 || Boolean(cover),
      hasVideo: media.some((ref) => ref.kind === 'video'),
      pinned: false,
      featured: false,
      coverUrl: cover?.blobUrl || '',
      status: 'published',
    });
  }

  for (const moment of moments.resources) {
    if (moment.status !== 'published') continue;
    docs.push({
      id: moment.id,
      type: 'search-doc',
      schemaVersion: 1,
      entryId: moment.id,
      entryType: 'moment',
      title: moment.title || '',
      summary: moment.summary || '',
      bodyText: moment.text || '',
      phase: moment.phase || '',
      section: moment.section || '',
      tags: Array.isArray(moment.tags) ? moment.tags : [],
      seriesId: '',
      kind: 'moment',
      publishedAt: moment.publishedAt,
      updatedAt: moment.updatedAt || moment.publishedAt,
      counts: countsByEntry.get(moment.id) || zeroCounts,
      path: `/moment/${moment.id}.html`,
      slug: moment.slug || '',
      wordCount: String(moment.text || '').replace(/\s/g, '').length,
      hasMedia: false,
      hasVideo: Boolean(moment.video),
      pinned: Boolean(moment.pinned),
      featured: Boolean(moment.featured),
      coverUrl: '',
      status: 'published',
    });
  }

  const container = db.container('search-docs');
  for (let index = 0; index < docs.length; index += 50) {
    await Promise.all(docs.slice(index, index + 50).map((doc) => container.items.upsert(doc)));
  }
  return docs.length;
}

async function walkFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(join(root, entry.name), relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

async function collectArtifacts() {
  const files = [];
  for (const root of ARTIFACT_ROOTS) {
    for (const relative of await walkFiles(join(OUT_DIR, root), root)) {
      files.push(relative);
    }
  }
  for (const name of ARTIFACT_FILES) {
    files.push(name);
  }
  return Promise.all(files.map(async (relative) => ({
    path: relative,
    content: await readFile(join(OUT_DIR, relative), 'utf8'),
  })));
}

async function main() {
  console.log('[publish] 重建检索投影…');
  const projected = await rebuildSearchDocs();
  console.log(`[publish] 投影重建完成：${projected} 条`);

  console.log('[publish] 物化静态站点…');
  await run(process.execPath, ['tools/materialize-site.mjs', '--out', OUT_DIR], { stdio: 'inherit' });

  console.log('[publish] 收集产物并提交到 GitHub…');
  const files = await collectArtifacts();
  const produced = new Set(files.map((file) => file.path));
  const removePaths = (await listBlobPaths())
    .filter((path) => (ARTIFACT_ROOTS.some((root) => path.startsWith(`${root}/`)) || ARTIFACT_FILES.includes(path))
      && !produced.has(path));
  const commit = await commitFiles(files, {
    removePaths,
    message: `publish(bifrost): materialize ${files.length} artifact(s)`,
  });
  if (commit.changed) {
    console.log(`[publish] 已提交 ${commit.files} 个文件：${commit.commit}`);
  } else {
    console.log('[publish] 产物无变化，未产生提交。');
  }

  console.log('[publish] 推送 AI Search 索引…');
  await run(process.execPath, ['tools/search-push.mjs'], { stdio: 'inherit' });

  await recordPublish('succeeded', {
    commit: commit.commit || '',
    counts: { artifacts: files.length, removed: removePaths.length, projected },
  });
  console.log('[publish] 完成。');
}

main().catch(async (error) => {
  console.error('[publish] 失败：', error?.message || error);
  try {
    await recordPublish('failed', { error: String(error?.message || error).slice(0, 500) });
  } catch (recordError) {
    console.error('[publish] 状态写入也失败：', recordError?.message || recordError);
  }
  process.exitCode = 1;
});
