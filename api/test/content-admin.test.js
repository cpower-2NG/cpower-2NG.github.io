import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReorderOf,
  countTagUsage,
  diffTags,
  normalizeTags,
  pickCoverCandidates,
  planSeriesMembers,
  planTagReplace,
  slugify,
} from '../src/lib/content-admin.js';

test('normalizeTags 去空白并去重', () => {
  assert.deepEqual(normalizeTags([' 冬滚滚 ', '漫评', '冬滚滚', '']), ['冬滚滚', '漫评']);
  assert.deepEqual(normalizeTags('不是数组'), []);
});

test('diffTags 区分新增与移除', () => {
  const { added, removed } = diffTags(['a', 'b'], ['b', 'c']);
  assert.deepEqual(added, ['c']);
  assert.deepEqual(removed, ['a']);
});

test('planTagReplace 只改带源标签的条目并把目标并入', () => {
  const entries = [
    { id: 'e1', tags: ['冬滚滚', '漫评'] },
    { id: 'e2', tags: ['冬暮川滚滚'] },
    { id: 'e3', tags: [] },
  ];
  const plan = planTagReplace(entries, '冬滚滚', ' 冬暮川滚滚 ');
  assert.equal(plan.from, '冬滚滚');
  assert.equal(plan.to, '冬暮川滚滚');
  assert.deepEqual(plan.updates, [
    { entryId: 'e1', tags: ['漫评', '冬暮川滚滚'] },
  ]);
});

test('planTagReplace 拒绝空标签与相同标签', () => {
  const entries = [{ id: 'e1', tags: ['a'] }];
  assert.throws(() => planTagReplace(entries, '', 'b'), /缺少/);
  assert.throws(() => planTagReplace(entries, 'a', 'a'), /相同/);
});

test('countTagUsage 按使用数降序排列', () => {
  const usage = countTagUsage([
    { tags: ['a', 'b'] },
    { tags: ['a'] },
    { tags: [] },
  ]);
  assert.deepEqual(usage, [{ label: 'a', count: 2 }, { label: 'b', count: 1 }]);
});

test('assertReorderOf 接受重排，拒绝增删', () => {
  assert.deepEqual(assertReorderOf(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
  assert.throws(() => assertReorderOf(['a', 'b'], ['a']), /重排/);
  assert.throws(() => assertReorderOf(['a'], ['a', 'b']), /重排/);
});

test('planSeriesMembers 输出顺序赋值与移除列表', () => {
  const plan = planSeriesMembers('series:x', ['a', 'b', 'c'], ['c', 'a']);
  assert.deepEqual(plan.assignments, [
    { entryId: 'c', seriesId: 'series:x', seriesOrder: 1 },
    { entryId: 'a', seriesId: 'series:x', seriesOrder: 2 },
  ]);
  assert.deepEqual(plan.removals, ['b']);
});

test('pickCoverCandidates 当前封面排最前并带标记', () => {
  const assets = [
    { id: 'ast_b', blobUrl: 'b', mime: 'image/png', width: 10, height: 10 },
    { id: 'ast_a', blobUrl: 'a', mime: 'image/png', width: 20, height: 20 },
  ];
  const list = pickCoverCandidates(assets, 'ast_b');
  assert.equal(list[0].assetId, 'ast_b');
  assert.equal(list[0].isCurrent, true);
  assert.equal(list[1].assetId, 'ast_a');
  assert.equal(list[1].isCurrent, undefined);
});

test('slugify 保留 CJK 并折叠分隔符', () => {
  assert.equal(slugify('纸上魔法使'), '纸上魔法使');
  assert.equal(slugify('  Hello World!!  '), 'hello-world');
  assert.equal(slugify('a//b'), 'a-b');
});
