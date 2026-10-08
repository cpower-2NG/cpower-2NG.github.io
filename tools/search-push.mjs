#!/usr/bin/env node
// 把 search-docs 投影推送到 AI Search 索引（幂等 upsert）。
// 采用推送而非索引器：与现有发布流程一致，且不必把 Cosmos 密钥交给搜索服务。
// 用法：node tools/search-push.mjs
import { SearchClient } from '@azure/search-documents';
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { INDEX_NAME, SEARCH_ENDPOINT, searchCredential } from './lib/search-config.mjs';

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';
const BATCH_SIZE = 100;

function cosmos() {
  return process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

/** 把检索投影展平成索引文档：counts 这类嵌套对象要拆成独立字段。 */
function toIndexDoc(doc) {
  return {
    entryId: doc.entryId,
    entryType: doc.entryType || 'article',
    title: doc.title || '',
    summary: doc.summary || '',
    bodyText: doc.bodyText || '',
    phase: doc.phase || '',
    section: doc.section || '',
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    seriesId: doc.seriesId || '',
    kind: doc.kind || '',
    publishedAt: doc.publishedAt,
    updatedAt: doc.updatedAt || doc.publishedAt,
    likes: Number(doc.counts?.likes) || 0,
    views: Number(doc.counts?.views) || 0,
    comments: Number(doc.counts?.comments) || 0,
    pinned: Boolean(doc.pinned),
    featured: Boolean(doc.featured),
    hasMedia: Boolean(doc.hasMedia),
    hasVideo: Boolean(doc.hasVideo),
    wordCount: Number(doc.wordCount) || 0,
    path: doc.path || '',
    slug: doc.slug || '',
    coverUrl: doc.coverUrl || '',
    status: doc.status || 'published',
  };
}

const search = new SearchClient(SEARCH_ENDPOINT, INDEX_NAME, searchCredential());
const result = await cosmos().database(DATABASE).container('search-docs').items
  .query('SELECT * FROM c')
  .fetchAll();

const docs = result.resources.map(toIndexDoc);

// 动态不再进检索索引（主搜索面板只覆盖文章条目）：清掉历史遗留的 moment 文档。
const staleMoments = await search.search('*', {
  filter: "entryType eq 'moment'",
  select: ['entryId'],
  top: 5000,
});
const staleKeys = [];
for await (const item of staleMoments.results) {
  staleKeys.push({ entryId: item.document.entryId });
}
if (staleKeys.length) {
  const deleteResponse = await search.deleteDocuments(staleKeys);
  const deleted = deleteResponse.results.filter((item) => item.succeeded).length;
  console.log(`已从检索索引移除动态文档：${deleted} / ${staleKeys.length}`);
}

let uploaded = 0;
for (let index = 0; index < docs.length; index += BATCH_SIZE) {
  const batch = docs.slice(index, index + BATCH_SIZE);
  const response = await search.uploadDocuments(batch);
  uploaded += response.results.filter((item) => item.succeeded).length;
  const failed = response.results.filter((item) => !item.succeeded);
  for (const item of failed) {
    console.error(`  失败 ${item.key}：${item.errorMessage}`);
  }
}

console.log(`已推送到检索索引：${uploaded} / ${docs.length} 条 → ${INDEX_NAME}`);
