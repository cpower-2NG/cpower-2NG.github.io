import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractBilibiliShares,
} from '../src/qzone-shares.js';

// 合成的 getActiveFeeds 风格响应：结构与 QQ 真实响应同形（vFeeds 嵌套 feedinfo/common/userinfo），
// 字段名按多候选约定覆盖（feedid/createtime/content）。
function feedResponse(feeds) {
  return JSON.stringify({ code: 0, data: { vFeeds: feeds } });
}

function shareFeed(overrides = {}) {
  return {
    common: { appid: 311, createtime: overrides.time ?? 1727000000 },
    feedinfo: {
      feedid: overrides.id ?? 'share-abc123',
      content: overrides.content ?? '推荐个视频 https://b23.tv/abcDEF',
      summary: { summary: overrides.summary ?? '' },
    },
    userinfo: { nick: '站长' },
  };
}

test('extractBilibiliShares 从聚合流 JSON 提取含 B 站链接的条目', () => {
  const payload = feedResponse([
    shareFeed(),
    { common: { appid: 311 }, feedinfo: { feedid: 'plain-1', content: '普通说说没有链接' } },
  ]);
  const shares = extractBilibiliShares(payload);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].shareId, 'share-abc123');
  assert.match(shares[0].url, /b23\.tv\/abcDEF/);
  assert.equal(shares[0].createdAt, new Date(1727000000 * 1000).toISOString());
  assert.match(shares[0].text, /推荐个视频/);
});

test('extractBilibiliShares 识别 bilibili.com 视频链接并提取 BV 号', () => {
  const payload = feedResponse([
    shareFeed({ id: 'share-bv', content: '看这个 https://www.bilibili.com/video/BV1GJ411x7h7', time: 1727000100 }),
  ]);
  const shares = extractBilibiliShares(payload);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].bvid, 'BV1GJ411x7h7');
  assert.match(shares[0].url, /bilibili\.com\/video\/BV1GJ411x7h7/);
});

test('extractBilibiliShares 按 feedid 去重', () => {
  const payload = feedResponse([shareFeed(), shareFeed()]);
  assert.equal(extractBilibiliShares(payload).length, 1);
});

test('extractBilibiliShares 忽略没有 B 站链接的条目与空输入', () => {
  assert.deepEqual(extractBilibiliShares(feedResponse([
    { feedinfo: { feedid: 'x1', content: 'https://example.com/video/BV1234567890' } },
  ])), []);
  assert.deepEqual(extractBilibiliShares(''), []);
  assert.deepEqual(extractBilibiliShares('不是 JSON'), []);
});

test('extractBilibiliShares 对毫秒时间戳与秒级时间戳都归一化为 ISO', () => {
  const payload = feedResponse([
    shareFeed({ id: 'sec', time: 1727000000 }),
    shareFeed({ id: 'ms', time: 1727000000000 }),
  ]);
  const shares = extractBilibiliShares(payload);
  const isoSet = new Set(shares.map((share) => share.createdAt));
  assert.equal(isoSet.size, 1);
  assert.equal([...isoSet][0], new Date(1727000000 * 1000).toISOString());
});
