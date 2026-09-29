#!/usr/bin/env node
// 把阶段与分区写进 taxonomy 容器（幂等 upsert）。
// 分区与主题细分分离：主题（评论/随笔/短歌…）一律是标签，见 docs/design/10-data-design.md。
// 用法：node tools/seed-taxonomy.mjs
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';

const PHASES = [
  { id: 'phase:logic', label: 'Logic', order: 1 },
  { id: 'phase:fantasy', label: 'Fantasy', order: 2 },
];

// 分区名以功能名先行；最终命名见 00-overview.md 的开放问题
const SECTIONS = [
  { phase: 'fantasy', id: 'daily', label: '日常', order: 1, layout: 'timeline' },
  { phase: 'fantasy', id: 'review', label: '漫评', order: 2, layout: 'magazine' },
  { phase: 'fantasy', id: 'activity', label: '活动纪录', order: 3, layout: 'magazine' },
  { phase: 'fantasy', id: 'essay', label: '杂记', order: 4, layout: 'magazine' },
  { phase: 'fantasy', id: 'archive', label: '档案馆', order: 5, layout: 'magazine' },
  { phase: 'logic', id: 'showcase', label: '展示', order: 1, layout: 'showcase' },
  { phase: 'logic', id: 'docs', label: '技术文档', order: 2, layout: 'compact' },
  { phase: 'logic', id: 'notes', label: '心得', order: 3, layout: 'magazine' },
  { phase: 'logic', id: 'algo', label: '算法', order: 4, layout: 'compact' },
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
      description: '',
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
  console.log(`已写入 ${count} 条分类法记录（阶段 ${PHASES.length} / 分区 ${SECTIONS.length}）`);
}

main().catch((error) => {
  console.error(`[seed-taxonomy] ${error.message}`);
  process.exitCode = 1;
});
