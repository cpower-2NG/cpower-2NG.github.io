#!/usr/bin/env node
// 诊断：确认当前凭据能否在数据面读写（先用只读，再试创建临时容器）。
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';

async function main() {
  const client = process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() });

  console.log(`凭据：${process.env.COSMOS_KEY ? '账户密钥' : 'AAD (DefaultAzureCredential)'}`);
  const database = client.database(DATABASE);

  try {
    const { resource } = await database.read();
    console.log(`库读取：OK  id=${resource.id}`);
  } catch (error) {
    console.log(`库读取：失败  ${error.code} ${error.message.split('\n')[0]}`);
  }

  try {
    const { resource } = await database.container('state').read();
    console.log(`容器读取(state)：OK  pk=${resource.partitionKey.paths.join(',')}`);
  } catch (error) {
    console.log(`容器读取(state)：失败  ${error.code} ${error.message.split('\n')[0]}`);
  }

  try {
    const container = database.container('state');
    const { resources } = await container.items
      .query('SELECT TOP 1 c.id FROM c', { partitionKey: 'sync' })
      .fetchAll();
    console.log(`查询(state)：OK  命中 ${resources.length} 条`);
  } catch (error) {
    console.log(`查询(state)：失败  ${error.code} ${error.message.split('\n')[0]}`);
  }
}

main().catch((error) => {
  console.error(`[cosmos-check] ${error.message}`);
  process.exitCode = 1;
});
