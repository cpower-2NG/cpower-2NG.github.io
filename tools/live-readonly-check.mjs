import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const site = JSON.parse(await readFile(resolve(root, 'data', 'site.json'), 'utf8'));
const apiBase = String(site.interactions?.apiBaseUrl || '').replace(/\/+$/, '');
const siteUrl = String(site.siteUrl || 'https://cpower-2NG.github.io').replace(/\/+$/, '');
const origin = new URL(siteUrl).origin;
const testPath = '/content/fantasy/article/2026-09-28-dongungun-publication.html';

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

const interactions = await request(
  `${apiBase}/interactions?path=${encodeURIComponent(testPath)}&visitorId=readonly-check`,
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

const cover = await request(`${siteUrl}/assets/publications/dongungun/page-1.webp`, { method: 'HEAD' });
assert.equal(cover.response.status, 200, 'PDF 页面静态资源不可访问。');
assert.match(cover.response.headers.get('content-type') || '', /image\/webp/);

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
  staticImage: cover.response.status,
  adminUnauthorized: admin.response.status,
}, null, 2)}\n`);
