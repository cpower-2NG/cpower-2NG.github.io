#!/usr/bin/env node
// 按设计文档「主查询映射」逐条验证新容器能否支撑真实查询。
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';

const client = () => (process.env.COSMOS_KEY
  ? new CosmosClient({ endpoint: ENDPOINT, key: process.env.COSMOS_KEY })
  : new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() }));

function line(label, value) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

async function main() {
  const db = client().database(DATABASE);

  console.log('\n[1] 条目总数与分类分布（content-articles / entry）');
  const entries = await db.container('content-articles').items
    .query("SELECT c.id, c.title, c.section, c.kind, c.path, c.seriesId FROM c WHERE c.type = 'entry'")
    .fetchAll();
  line('条目数', entries.resources.length);
  const bySection = entries.resources.reduce((acc, item) => {
    acc[item.section] = (acc[item.section] || 0) + 1;
    return acc;
  }, {});
  line('按分区', Object.entries(bySection).map(([k, v]) => `${k}=${v}`).join('  '));

  console.log('\n[2] 打开一篇文章（同分区读 entry + body）');
  const target = entries.resources.find((item) => item.section === 'activity');
  const entry = (await db.container('content-articles').item(target.id, target.id).read()).resource;
  const body = (await db.container('content-articles').item('body', target.id).read()).resource;
  line('条目', entry.title);
  line('正文 markdown', `${body.markdown.length} 字符`);
  line('渲染 HTML', `${body.html.length} 字符`);
  line('字段 text 是否落库', body.text ? '是' : '否');

  console.log('\n[3] 路径解析（routes：path → entryId）');
  const route = (await db.container('routes').item('route', entry.path).read()).resource;
  line(`/content/… 解析`, `${route.path} → ${route.entryId}`);
  line('与条目一致', route.entryId === entry.id ? '是' : '否');

  console.log('\n[4] 检索投影（search-docs：按标签筛选 + 分面计数）');
  const tagged = await db.container('search-docs').items
    .query({
      query: "SELECT c.title, c.section, c.tags FROM c WHERE ARRAY_CONTAINS(c.tags, @tag)",
      parameters: [{ name: '@tag', value: '漫评' }],
    })
    .fetchAll();
  line('标签=漫评 命中', `${tagged.resources.length} 篇`);
  for (const item of tagged.resources) line(`  · ${item.section}`, item.title);
  const facets = await db.container('search-docs').items
    .query('SELECT VALUE COUNT(1) FROM c')
    .fetchAll();
  line('投影总数', facets.resources[0]);

  console.log('\n[5] 系列（taxonomy + seriesId）');
  const series = entries.resources.filter((item) => item.seriesId);
  line('系列成员', `${series.length} 篇 / ${new Set(series.map((s) => s.seriesId)).size} 个系列`);
  line('系列 id', [...new Set(series.map((s) => s.seriesId))].join('、'));

  console.log('\n[6] 标签登记表（taxonomy / kind=tag）');
  const tags = await db.container('taxonomy').items
    .query("SELECT c.label FROM c WHERE c.kind = 'tag'")
    .fetchAll();
  line('标签数', tags.resources.length);
  line('标签', tags.resources.map((t) => t.label).join('、'));

  console.log('\n[7] 媒体（assets）');
  const assetTotal = await db.container('assets').items
    .query('SELECT VALUE COUNT(1) FROM c')
    .fetchAll();
  const assetOriginals = await db.container('assets').items
    .query('SELECT VALUE COUNT(1) FROM c WHERE c.assetClass = "original"')
    .fetchAll();
  line('媒体文档总数', assetTotal.resources[0]);
  line('其中原件', assetOriginals.resources[0]);
  const withUrl = await db.container('assets').items
    .query('SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.blobUrl) AND c.blobUrl != ""')
    .fetchAll();
  line('已上传（有 blobUrl）', withUrl.resources[0]);
  const sample = await db.container('assets').items
    .query('SELECT TOP 2 c.kind, c.blobUrl FROM c WHERE c.blobUrl != ""')
    .fetchAll();
  for (const asset of sample.resources) line(`  · ${asset.kind}`, asset.blobUrl);

  console.log('\n[8] 出版物（kind=pdf）');
  const pubs = await db.container('content-articles').items
    .query("SELECT c.title, c.publication FROM c WHERE c.type = 'entry' AND IS_DEFINED(c.publication) AND NOT IS_NULL(c.publication)")
    .fetchAll();
  for (const pub of pubs.resources) {
    line(pub.title, `${pub.publication.pageCount} 页，pdf=${pub.publication.pdfAssetId}`);
  }

  console.log('\n[9] 媒体公网可达性（HEAD 抽查）');
  const probes = await db.container('assets').items
    .query('SELECT TOP 3 c.kind, c.blobUrl FROM c WHERE c.blobUrl != "" ORDER BY c.kind')
    .fetchAll();
  for (const probe of probes.resources) {
    try {
      const response = await fetch(probe.blobUrl, { method: 'HEAD' });
      line(`${probe.kind} → ${response.status}`, response.headers.get('content-type') || '');
    } catch (error) {
      line(`${probe.kind} → 失败`, error.message);
    }
  }

  console.log('\n[10] 动态时间流（content-moments，按月分桶）');
  const moments = await db.container('content-moments').items
    .query('SELECT c.id, c.month, c.publishedAt, c.entryType, c.summary FROM c ORDER BY c.publishedAt DESC')
    .fetchAll();
  line('动态总数', moments.resources.length);
  const byMonth = moments.resources.reduce((acc, item) => {
    acc[item.month] = (acc[item.month] || 0) + 1;
    return acc;
  }, {});
  line('按月份', Object.entries(byMonth).map(([k, v]) => `${k}=${v}`).join('  '));
  for (const item of moments.resources.slice(0, 3)) {
    line(`  · ${item.month}`, item.summary);
  }

  console.log('\n[11] 统一检索（文章 + 动态同表）');
  const byType = await db.container('search-docs').items
    .query('SELECT c.entryType, COUNT(1) AS n FROM c GROUP BY c.entryType')
    .fetchAll();
  for (const row of byType.resources) line(row.entryType, `${row.n} 条`);

  console.log('\n[12] 旧容器现状（迁移前先别删）');
  for (const name of ['comments', 'activity', 'state', 'rate-limits']) {
    const count = await db.container(name).items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
    line(name, `${count.resources[0]} 条`);
  }
}

main().catch((error) => {
  console.error(`[cosmos-verify] ${error.message}`);
  process.exitCode = 1;
});
