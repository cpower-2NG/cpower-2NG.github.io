// 端到端：管理台登录门禁、账密登录与页面路由冒烟。
// 管理 API 用 Playwright 路由拦截模拟，不需要真实的 Azure Function。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = 8126;
const baseUrl = `http://127.0.0.1:${port}`;
const requireFromSync = createRequire(join(root, 'sync', 'package.json'));
const { chromium } = requireFromSync('playwright');

/** CI 装的是 headless shell；本机可能只有完整 Chromium，两种都兼容。 */
function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  const candidates = [
    join(base, 'chromium-1243', 'chrome-win64', 'chrome.exe'),
    join(base, 'chromium-1200', 'chrome-win64', 'chrome.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('预览服务没有就绪');
}

async function main() {
  const server = spawn(process.execPath, [join(root, 'preview-server.mjs'), String(port), '--no-open'], {
    cwd: root,
    stdio: 'ignore',
  });

  let browser = null;
  try {
    await waitForServer();
    const apiBase = JSON.parse(await (await fetch(`${baseUrl}/data/site.json`)).text())
      .interactions.apiBaseUrl.replace(/\/+$/, '');

    browser = await chromium.launch({ executablePath: chromiumExecutable() });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    // 兜底：其余管理端点一律回空列表。
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders(baseUrl) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: corsHeaders(baseUrl),
        body: JSON.stringify({ items: [] }),
      });
    });

    await page.route(`${apiBase}/manage/auth/login`, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders(baseUrl) });
        return;
      }
      const body = request.postDataJSON();
      const ok = body?.username === 'site-admin' && body?.password === 'correct-horse';
      await route.fulfill({
        status: ok ? 200 : 401,
        contentType: 'application/json; charset=utf-8',
        headers: corsHeaders(baseUrl),
        body: JSON.stringify(ok
          ? {
              token: `bfs_mock-${randomUUID().replaceAll('-', '')}`,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              name: 'site-admin',
              method: 'password',
            }
          : { error: 'INVALID_CREDENTIALS', message: '账号或口令不正确。' }),
      });
    });

    const step = (name) => console.log(`  · ${name}`);

    step('门禁显示，管理台隐藏');
    await page.goto(`${baseUrl}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-gate]:not([hidden])');
    assert.equal(await page.locator('[data-shell]').isHidden(), true, '登录前管理台应隐藏');

    step('MSAL 库从本地 vendor 加载');
    await page.waitForFunction(() => Boolean(window.msal), null, { timeout: 15000 });

    step('错误口令在门禁内提示，不进入管理台');
    await page.fill('[data-gate-user]', 'site-admin');
    await page.fill('[data-gate-pass]', 'wrong-password');
    await page.click('[data-gate-submit]');
    await page.waitForFunction(
      () => /账号或口令不正确/.test(document.querySelector('[data-gate-message]')?.textContent || ''),
      null,
      { timeout: 15000 },
    );
    assert.equal(await page.locator('[data-shell]').isHidden(), true, '登录失败后管理台仍应隐藏');

    step('正确口令进入管理台');
    await page.fill('[data-gate-pass]', 'correct-horse');
    await page.click('[data-gate-submit]');
    await page.waitForSelector('[data-shell]:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('.nav__item--active');
    assert.match(
      (await page.locator('[data-account]').textContent())?.trim() || '',
      /site-admin/,
      '侧栏应显示登录账号',
    );
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('bifrost:admin:session') || 'null'));
    assert.match(String(session?.token || ''), /^bfs_/, '会话令牌应存入 sessionStorage');

    step('概览页渲染状态卡与发布条');
    await page.waitForSelector('.status-grid .status-card', { timeout: 15000 });
    await page.waitForSelector('[data-view-title]');

    step('侧栏导航切换页面（条目 / QQ 空间同步）');
    await page.click('[data-nav-item="entries"]');
    await page.waitForFunction(
      () => document.querySelector('[data-view-title]')?.textContent === '条目',
      null,
      { timeout: 15000 },
    );
    await page.waitForSelector('.split', { timeout: 15000 });
    await page.click('[data-nav-item="qzone"]');
    await page.waitForFunction(
      () => document.querySelector('[data-view-title]')?.textContent === 'QQ 空间同步',
      null,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => /连接/.test(document.querySelector('[data-view] .panel__title')?.textContent || ''),
      null,
      { timeout: 15000 },
    );

    step('hash 直达与未知路由回退概览');
    await page.goto(`${baseUrl}/admin.html#/comments`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('[data-view-title]')?.textContent === '评论',
      null,
      { timeout: 15000 },
    );
    await page.evaluate(() => { location.hash = '#/not-a-page'; });
    await page.waitForFunction(
      () => document.querySelector('[data-view-title]')?.textContent === '概览',
      null,
      { timeout: 15000 },
    );

    step('刷新后保持登录');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-shell]:not([hidden])', { timeout: 15000 });
    assert.equal(await page.locator('[data-gate]').isHidden(), true, '已登录时不应再显示门禁');

    step('退出后回到门禁');
    await page.click('[data-admin-logout]');
    await page.waitForSelector('[data-gate]:not([hidden])', { timeout: 15000 });
    assert.equal(await page.locator('[data-shell]').isHidden(), true, '退出后管理台应隐藏');

    const blocking = errors.filter((message) => !/favicon|net::ERR_/i.test(message));
    assert.equal(blocking.length, 0, `页面有未捕获错误：${blocking.slice(0, 3).join(' | ')}`);
    console.log('admin-login: 全部通过');
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill();
  }
}

main().catch((error) => {
  console.error(`admin-login 失败：${error.message}`);
  process.exitCode = 1;
});
