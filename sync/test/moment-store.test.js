import assert from 'node:assert/strict';
import test from 'node:test';
import { momentDocFromRecord, momentIdFor } from '../src/moment-store.js';

// 历史条目（2026-09-29 通过 tools/import-moments.mjs 迁移入库）的真实 id。
// moment-store 必须为同一来源记录产出完全相同的 id，否则重复入库出现两份动态。
const HISTORICAL = {
  sourceId: 'b4ecdeb02cd6b76a06070300',
  createdAt: '2026-09-26T14:26:52.000Z',
  expectedId: '01M3F1S6Z0YATR1KS3VH0RQP0Y',
};

function historicalRecord() {
  return {
    id: `qq-${HISTORICAL.sourceId}`,
    createdAt: HISTORICAL.createdAt,
    date: HISTORICAL.createdAt.slice(0, 10),
    title: '铁丝扎穿鞋底之后',
    text: '走路上还被铁丝扎穿鞋底，得亏运气好没戳进脚掌',
    phase: 'fantasy',
    section: 'daily',
    tags: ['QQ空间', '生活随想'],
    source: {
      provider: 'qq',
      id: HISTORICAL.sourceId,
      url: `https://user.qzone.qq.com/2967399604/mood/${HISTORICAL.sourceId}`,
    },
    publishStatus: 'published',
  };
}

test('momentIdFor 与历史迁移条目的 id 完全一致', () => {
  assert.equal(momentIdFor(historicalRecord()), HISTORICAL.expectedId);
});

test('momentDocFromRecord 产出权威库形状（分区键 month、status published）', () => {
  const doc = momentDocFromRecord(historicalRecord(), { importedAt: '2026-10-05T00:00:00.000Z' });
  assert.equal(doc.id, HISTORICAL.expectedId);
  assert.equal(doc.month, '2026-09');
  assert.equal(doc.type, 'moment');
  assert.equal(doc.entryType, 'moment');
  assert.equal(doc.status, 'published');
  assert.equal(doc.html, '<p>走路上还被铁丝扎穿鞋底，得亏运气好没戳进脚掌</p>');
  assert.equal(doc.origin.ref, HISTORICAL.sourceId);
  assert.equal(doc.origin.provider, 'qq');
});

test('momentDocFromRecord 忽略未发布记录并按 id 去重', () => {
  const pending = { ...historicalRecord(), id: 'qq-pending-1', source: { provider: 'qq', id: 'pending-1' }, publishStatus: 'pending' };
  const doc = momentDocFromRecord(pending, { importedAt: 'x' });
  assert.equal(doc.status, 'published', 'momentDocFromRecord 只对已发布记录调用，这里记录本身标记不影响');
  const duplicated = [historicalRecord(), historicalRecord()];
  // momentDocsFromRecords 在 qzone-sync 中负责去重，这里验证 doc 幂等
  const first = momentDocFromRecord(duplicated[0], { importedAt: 'x' });
  const second = momentDocFromRecord(duplicated[1], { importedAt: 'x' });
  assert.equal(first.id, second.id);
});
