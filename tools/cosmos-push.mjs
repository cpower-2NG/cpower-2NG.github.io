#!/usr/bin/env node
// 把内容包产出的文档写入 Cosmos（AAD 认证，数据面）。
// 容器本身由控制面创建（az），本脚本只写数据。
// 用法：node tools/cosmos-push.mjs [批量目录]
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';
const BATCH_DIR = resolve(process.argv[2] || 'imports/fantasy/derived/batch');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function client() {
  if (process.env.COSMOS_KEY) {
    return new CosmosClient({ endpoint: ENDPOINT, key: process.env.COSMOS_KEY });
  }
  return new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

async function main() {
  const database = client().database(DATABASE);
  const entries = (await readdir(BATCH_DIR, { withFileTypes: true })).filter((item) => item.isDirectory());
  if (!entries.length) {
    throw new Error(`没有找到内容包：${BATCH_DIR}`);
  }

  const counts = { entry: 0, body: 0, moment: 0, asset: 0, route: 0, search: 0, tag: 0 };
  const tags = new Map();
  const failures = [];

  for (const dir of entries) {
    const base = join(BATCH_DIR, dir.name, 'documents');
    const entry = await readJson(join(base, 'entry.json'));
    const body = await readJson(join(base, 'body.json'));
    const assets = await readJson(join(base, 'assets.json'));
    const routes = await readJson(join(base, 'routes.json'));
    const search = await readJson(join(base, 'search-doc.json'));
    const taxonomy = await readJson(join(base, 'taxonomy.json'));
    const moment = await readJson(join(base, 'moment.json'));
    if (!moment && (!entry || !body)) {
      failures.push(`${dir.name}：缺少 entry/body 或 moment`);
      continue;
    }
    const label = moment ? moment.id : entry.path;

    const writes = [
      ...(entry && body
        ? [
          { container: 'content-articles', doc: entry, counter: 'entry' },
          { container: 'content-articles', doc: body, counter: 'body' },
        ]
        : []),
      ...(moment ? [{ container: 'content-moments', doc: moment, counter: 'moment' }] : []),
      ...(assets?.items || []).map((doc) => ({ container: 'assets', doc, counter: 'asset' })),
      ...(routes?.items || []).map((doc) => ({ container: 'routes', doc, counter: 'route' })),
      ...(search ? [{ container: 'search-docs', doc: search, counter: 'search' }] : []),
    ];

    let failed = 0;
    for (const write of writes) {
      try {
        await database.container(write.container).items.upsert(write.doc);
        counts[write.counter] += 1;
      } catch (error) {
        failed += 1;
        failures.push(`${label} → ${write.container}：${error.message.split('\n')[0]}`);
      }
    }
    for (const tag of taxonomy?.items || []) {
      tags.set(tag.id, tag);
    }
    console.log(`  ${failed ? '✗' : '✓'} ${label}${failed ? `（${failed} 处失败）` : ''}`);
  }

  for (const tag of tags.values()) {
    await database.container('taxonomy').items.upsert(tag);
    counts.tag += 1;
  }

  console.log(`\n写入：条目 ${counts.entry} / 正文 ${counts.body} / 动态 ${counts.moment} / 媒体 ${counts.asset} / 路由 ${counts.route} / 检索 ${counts.search} / 标签 ${counts.tag}`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 条：`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[cosmos-push] ${error.message}`);
  process.exitCode = 1;
});
