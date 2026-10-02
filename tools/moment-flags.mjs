#!/usr/bin/env node
// 设置单条动态的置顶（pinned）与精选（featured）标记。
// 同时更新权威容器 content-moments 与检索投影 search-docs，物化后前端即可渲染徽标。
// 用法：node tools/moment-flags.mjs --id <momentId> --month <YYYY-MM> [--pinned on|off] [--featured on|off]
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';

function cosmos() {
  return process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  const value = argument(name);
  if (value === undefined) return null;
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  throw new Error(`--${name} 只接受 on 或 off。`);
}

const id = argument('id');
const month = argument('month');
if (!id || !month) {
  console.error('用法：node tools/moment-flags.mjs --id <momentId> --month <YYYY-MM> [--pinned on|off] [--featured on|off]');
  process.exit(1);
}

const pinned = flag('pinned');
const featured = flag('featured');
if (pinned === null && featured === null) {
  console.error('没有要修改的字段：至少提供 --pinned 或 --featured。');
  process.exit(1);
}

const db = cosmos().database(DATABASE);
const { resource: moment } = await db.container('content-moments').item(id, month).read();
if (!moment) {
  console.error(`动态不存在：id=${id} month=${month}`);
  process.exit(1);
}

const updated = {
  ...moment,
  pinned: pinned === null ? Boolean(moment.pinned) : pinned,
  featured: featured === null ? Boolean(moment.featured) : featured,
  updatedAt: new Date().toISOString(),
};
await db.container('content-moments').item(id, month).replace(updated);

const { resource: searchDoc } = await db.container('search-docs').item(id, id).read();
if (searchDoc) {
  await db.container('search-docs').item(id, id).replace({
    ...searchDoc,
    pinned: updated.pinned,
    featured: updated.featured,
  });
}

console.log(`已更新动态 ${id}：pinned=${updated.pinned} featured=${updated.featured}${searchDoc ? '（投影已同步）' : '（无投影，跳过）'}`);
console.log('下一步：重新物化并发布后，时间流顶部出现置顶条目、精选条目带描边。');
