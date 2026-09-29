#!/usr/bin/env node
// 创建或更新检索索引（幂等）。用法：node tools/search-setup.mjs
import { SearchIndexClient } from '@azure/search-documents';
import { INDEX_DEFINITION, INDEX_NAME, SEARCH_ENDPOINT, searchCredential } from './lib/search-config.mjs';

const client = new SearchIndexClient(SEARCH_ENDPOINT, searchCredential());
try {
  await client.createOrUpdateIndex(INDEX_DEFINITION);
  console.log(`索引已就绪：${INDEX_NAME}（${INDEX_DEFINITION.fields.length} 个字段）`);
  console.log(`服务地址：${SEARCH_ENDPOINT}`);
} catch (error) {
  console.error(`[search-setup] ${error.message}`);
  process.exitCode = 1;
}
