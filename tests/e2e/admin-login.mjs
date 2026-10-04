// 端到端：管理台登录门禁与账密登录。
// 管理 API 用 Playwright 路由拦截模拟，不需要真实的 Azure Function。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
    const apiBase = JSON.parse(readFileSync(join(root, 'data', 'site.json'), 'utf8'))
      .interactions.apiBaseUrl.replace(/\/+$/, '');

    browser = await chromium.launch({ executablePath: chromiumExecutable() });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    // 兜底：其余管理端点一律回空列表（先注册，后注册的登录路由优先匹配）
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

    step('门禁显示，管理面板隐藏');
    await page.goto(`${baseUrl}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-login-gate]:not([hidden])');
    assert.equal(await page.locator('[data-admin-app]').isHidden(), true, '登录前管理面板应隐藏');

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
    assert.equal(await page.locator('[data-admin-app]').isHidden(), true, '登录失败后管理面板仍应隐藏');

    step('正确口令进入管理台');
    await page.fill('[data-gate-pass]', 'correct-horse');
    await page.click('[data-gate-submit]');
    await page.waitForSelector('[data-admin-app]:not([hidden])', { timeout: 15000 });
    assert.match(
      (await page.locator('[data-admin-account]').textContent())?.trim() || '',
      /site-admin/,
      '头部应显示登录账号',
    );
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('bifrost:admin:session') || 'null'));
    assert.match(String(session?.token || ''), /^bfs_/, '会话令牌应存入 sessionStorage');
    // 回归：.admin-button 自带 display，曾把 hidden 属性覆盖成仍然可见
    assert.equal(await page.locator('[data-admin-login]').isHidden(), true, '登录后 Microsoft 登录按钮应隐藏');

    step('刷新后保持登录');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-admin-app]:not([hidden])', { timeout: 15000 });
    assert.equal(await page.locator('[data-login-gate]').isHidden(), true, '已登录时不应再显示门禁');

    step('退出后回到门禁');
    await page.click('[data-admin-logout]');
    await page.waitForSelector('[data-login-gate]:not([hidden])', { timeout: 15000 });
    assert.equal(await page.locator('[data-admin-app]').isHidden(), true, '退出后管理面板应隐藏');

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
