#!/usr/bin/env node
// 把阶段与分区写进 taxonomy 容器（幂等 upsert）。
// 分区与主题细分分离：主题（评论/随笔/短歌…）一律是标签，见 docs/design/10-data-design.md。
// 用法：node tools/seed-taxonomy.mjs
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { slugify } from './lib/content-common.mjs';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';

const PHASES = [
  { id: 'phase:logic', label: 'Logic', order: 1 },
  { id: 'phase:fantasy', label: 'Fantasy', order: 2 },
];

// 分区名以功能名先行；description 用于首页的分区块说明
const SECTIONS = [
  { phase: 'fantasy', id: 'daily', label: '日常', order: 1, layout: 'timeline', description: '短动态与转发，按月份往回翻' },
  { phase: 'fantasy', id: 'review', label: '漫评', order: 2, layout: 'magazine', description: '动画、游戏、企划与萌属性' },
  { phase: 'fantasy', id: 'activity', label: '活动纪录', order: 3, layout: 'magazine', description: 'FMT 与出游见闻' },
  { phase: 'fantasy', id: 'essay', label: '杂记', order: 4, layout: 'magazine', description: '随想、反思与观察' },
  { phase: 'fantasy', id: 'archive', label: '档案馆', order: 5, layout: 'magazine', description: '翻译与过程文档' },
  { phase: 'logic', id: 'showcase', label: '展示', order: 1, layout: 'showcase', description: '简介、技术栈与项目' },
  { phase: 'logic', id: 'docs', label: '技术文档', order: 2, layout: 'compact', description: '学习与应用某个技术的记录' },
  { phase: 'logic', id: 'notes', label: '心得', order: 3, layout: 'magazine', description: '更抽象的技术杂谈' },
  { phase: 'logic', id: 'algo', label: '算法', order: 4, layout: 'compact', description: '代码型模板与整理' },
];

/** 系列：标题与简介入库管理，成员由条目上的 seriesId 关联。 */
const SERIES = [
  {
    label: '纸上魔法使',
    description: '五篇短歌，围绕五位魔法使与各自的宝石展开。',
  },
];

function client() {
  return process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

async function main() {
  const container = client().database(DATABASE).container('taxonomy');
  let count = 0;
  for (const phase of PHASES) {
    await container.items.upsert({
      id: phase.id,
      type: 'taxonomy',
      schemaVersion: 1,
      kind: 'phase',
      label: phase.label,
      description: '',
      parentId: '',
      phase: phase.id.replace('phase:', ''),
      order: phase.order,
      aliases: [],
      status: 'active',
    });
    count += 1;
  }
  for (const section of SECTIONS) {
    await container.items.upsert({
      id: `section:${section.phase}:${section.id}`,
      type: 'taxonomy',
      schemaVersion: 1,
      kind: 'section',
      label: section.label,
      description: section.description || '',
      parentId: `phase:${section.phase}`,
      phase: section.phase,
      section: section.id,
      layout: section.layout,
      order: section.order,
      aliases: [],
      status: 'active',
    });
    count += 1;
  }
  for (const series of SERIES) {
    await container.items.upsert({
      id: `series:${slugify(series.label)}`,
      type: 'taxonomy',
      schemaVersion: 1,
      kind: 'series',
      label: series.label,
      description: series.description,
      parentId: '',
      phase: 'fantasy',
      order: 1,
      aliases: [],
      status: 'active',
    });
    count += 1;
  }
  console.log(`已写入 ${count} 条分类法记录（阶段 ${PHASES.length} / 分区 ${SECTIONS.length}）`);
}

main().catch((error) => {
  console.error(`[seed-taxonomy] ${error.message}`);
  process.exitCode = 1;
});
