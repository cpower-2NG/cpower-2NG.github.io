import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRecheckBatch, rotateQueue } from '../src/recheck-queue.js';

test('首轮：空队列 + 全新记录 → 取前 N 条，其余进 rest', () => {
  const { batch, rest, total } = nextRecheckBatch([], ['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(batch, ['a', 'b']);
  assert.deepEqual(rest, ['c', 'd', 'e']);
  assert.equal(total, 5);
});

test('轮转：取过的批次挪到队尾，实现严格轮转', () => {
  const first = nextRecheckBatch([], ['a', 'b', 'c', 'd'], 2);
  const second = nextRecheckBatch(rotateQueue(first.rest, first.batch), ['a', 'b', 'c', 'd'], 2);
  assert.deepEqual(second.batch, ['c', 'd']);
  assert.deepEqual(second.rest, ['a', 'b']);
});

test('仓库里已删除的记录从队列剔除', () => {
  const { batch, rest, total } = nextRecheckBatch(['a', 'ghost', 'b'], new Set(['a', 'b']), 10);
  assert.deepEqual(batch, ['a', 'b']);
  assert.deepEqual(rest, []);
  assert.equal(total, 2);
  assert.ok(!batch.includes('ghost'));
});

test('仓库新增的记录追加到队尾（不插队已有轮转顺序）', () => {
  const { batch, rest } = nextRecheckBatch(['a', 'b'], new Set(['a', 'b', 'new1', 'new2']), 2);
  assert.deepEqual(batch, ['a', 'b']);
  assert.deepEqual(rest, ['new1', 'new2']);
});

test('rotateQueue 跳过本轮缺失/剔除的 id', () => {
  const queue = rotateQueue(['c', 'd'], ['a', 'b'], ['b']);
  assert.deepEqual(queue, ['c', 'd', 'a']);
});

test('批大小大于队列长度：全部进 batch，rest 为空', () => {
  const { batch, rest, total } = nextRecheckBatch(['a'], new Set(['a']), 20);
  assert.deepEqual(batch, ['a']);
  assert.deepEqual(rest, []);
  assert.equal(total, 1);
});

test('非数组队列（文档缺失/损坏）按空队列处理', () => {
  const { batch, total } = nextRecheckBatch(undefined, new Set(['x']), 5);
  assert.deepEqual(batch, ['x']);
  assert.equal(total, 1);
});
