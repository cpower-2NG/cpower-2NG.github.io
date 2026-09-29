#!/usr/bin/env node
// 核对内容库的容器是否与设计一致（分区键）。
// 建容器属于控制面操作：Cosmos 的 SQL 角色只管数据面，因此本脚本只核对，
// 缺少的容器会打印对应的 az 创建命令；权威定义在 infra/main.bicep。
// 用法：node tools/cosmos-setup.mjs
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';

// 设计文档 10-data-design.md 的容器清单（本次只建内容侧新增的 7 个）
const CONTAINERS = [
  { id: 'content-articles', partitionKey: '/entryId', exclude: ['/markdown/?', '/html/?', '/text/?'] },
  { id: 'content-moments', partitionKey: '/month', exclude: ['/html/?', '/text/?'] },
  { id: 'taxonomy', partitionKey: '/kind' },
  { id: 'assets', partitionKey: '/assetId' },
  { id: 'routes', partitionKey: '/path' },
  { id: 'signals', partitionKey: '/entryId' },
  { id: 'search-docs', partitionKey: '/entryId' },
];

function indexingPolicy(exclude = []) {
  return {
    indexingMode: 'consistent',
    automatic: true,
    includedPaths: [{ path: '/*' }],
    excludedPaths: [...exclude.map((path) => ({ path })), { path: '/_etag/?' }],
  };
}

function client() {
  if (process.env.COSMOS_KEY) {
    return new CosmosClient({ endpoint: ENDPOINT, key: process.env.COSMOS_KEY });
  }
  return new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

async function main() {
  const database = client().database(DATABASE);
  const ok = [];
  const missing = [];
  const mismatch = [];
  for (const definition of CONTAINERS) {
    try {
      const { resource } = await database.container(definition.id).read();
      const actual = resource.partitionKey.paths.join(',');
      if (actual === definition.partitionKey) {
        ok.push(definition.id);
        console.log(`  ✓ ${definition.id.padEnd(17)} pk=${actual}`);
      } else {
        mismatch.push(definition.id);
        console.log(`  ✗ ${definition.id.padEnd(17)} 期望 pk=${definition.partitionKey}，实际 ${actual}`);
      }
    } catch (error) {
      if (error.code === 404) {
        missing.push(definition.id);
        console.log(`  · ${definition.id.padEnd(17)} 不存在`);
      } else {
        throw error;
      }
    }
  }

  console.log(`\n符合设计 ${ok.length} 个，缺失 ${missing.length} 个，分区键不符 ${mismatch.length} 个`);
  if (missing.length) {
    console.log('\n用以下命令创建（控制面）：');
    for (const definition of CONTAINERS.filter((item) => missing.includes(item.id))) {
      console.log(`  az cosmosdb sql container create -g rg-bifrost-prod -a cosmos-bifrost-z43zcc -d ${DATABASE} -n ${definition.id} --partition-key-path "${definition.partitionKey}"`);
    }
    process.exitCode = 1;
  }
  if (mismatch.length) {
    console.log('\n分区键不一致的容器需要人工确认；分区键无法原地修改，只能迁移数据后重建。');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[cosmos-setup] ${error.message}`);
  if (error.code === 403 || /Forbidden/i.test(String(error.message))) {
    console.error('提示：当前登录身份没有 Cosmos 数据面权限。可改用 COSMOS_KEY 环境变量，或给账号授予 Cosmos DB Operator/Data Contributor。');
  }
  process.exitCode = 1;
});
