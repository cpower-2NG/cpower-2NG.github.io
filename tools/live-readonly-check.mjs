import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const site = JSON.parse(await readFile(resolve(root, 'data', 'site.json'), 'utf8'));
const apiBase = String(site.interactions?.apiBaseUrl || '').replace(/\/+$/, '');
const siteUrl = String(site.siteUrl || 'https://cpower-2NG.github.io').replace(/\/+$/, '');
const origin = new URL(siteUrl).origin;
// 互动以 entryId 归属；用索引里的第一条真实内容做只读探测
const index = JSON.parse(await readFile(resolve(root, 'data', 'site-index.json'), 'utf8'));
const testEntryId = (index.entries?.[0] || index.moments?.[0])?.entryId
  || (index.moments?.[0]?.id);
assert.ok(testEntryId, 'data/site-index.json 里没有可用于探测的内容。');
const staticAssetPath = '/data/site-index.json';

async function request(url, options = {}, timeoutMs = 8000) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    response,
    elapsedMs: Date.now() - startedAt,
  };
}

assert.ok(apiBase, 'data/site.json 缺少互动 API 地址。');

async function checkStaticAsset() {
  try {
    const result = await request(`${siteUrl}${staticAssetPath}`, { method: 'HEAD' });
    assert.equal(result.response.status, 200, '站点静态资源不可访问。');
    assert.match(result.response.headers.get('content-type') || '', /json/);
    return { status: result.response.status, source: 'github-pages' };
  } catch (error) {
    // Some local networks cannot reach GitHub Pages' Fastly IPs. In that case,
    // verify the same artifact through the GitHub Contents API instead.
    const host = new URL(siteUrl).hostname;
    const owner = host.split('.')[0];
    const repository = host.endsWith('.github.io') ? host : host.split('.')[0];
    const result = await request(
      `https://api.github.com/repos/${owner}/${repository}/contents${staticAssetPath}?ref=main`,
      { headers: { accept: 'application/vnd.github+json', 'user-agent': 'bifrost-readonly-check' } },
    );
    assert.equal(result.response.status, 200, `静态资源检查失败：${error.message}`);
    const payload = await result.response.json();
    assert.equal(payload.type, 'file');
    assert.ok(Number(payload.size) > 0);
    return { status: result.response.status, source: 'github-contents-api', bytes: Number(payload.size) };
  }
}

const interactions = await request(
  `${apiBase}/interactions?entryId=${encodeURIComponent(testEntryId)}&visitorId=readonly-check`,
  { headers: { origin, accept: 'application/json' } },
);
assert.equal(interactions.response.status, 200, '互动接口未返回 200。');
assert.equal(
  interactions.response.headers.get('access-control-allow-origin'),
  origin,
  '互动接口没有为 GitHub Pages 返回正确的 CORS 响应。',
);
const payload = await interactions.response.json();
assert.equal(payload.enabled, true, '互动接口已关闭。');
assert.ok(interactions.elapsedMs < 8000, `互动接口响应超时：${interactions.elapsedMs}ms`);

const staticAsset = await checkStaticAsset();

const admin = await request(`${apiBase}/manage/status`, {
  headers: { origin, accept: 'application/json' },
});
assert.equal(admin.response.status, 401, '未登录的管理接口没有返回 401。');
const adminPayload = await admin.response.json().catch(() => ({}));
assert.equal(adminPayload.error, 'AUTH_REQUIRED');

process.stdout.write(`${JSON.stringify({
  ok: true,
  apiBase,
  siteUrl,
  interactionsMs: interactions.elapsedMs,
  interactions: {
    likes: payload.likes,
    views: payload.views,
    comments: payload.commentCount,
  },
  staticAsset,
  adminUnauthorized: admin.response.status,
}, null, 2)}\n`);
