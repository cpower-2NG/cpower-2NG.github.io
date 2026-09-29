// 端到端：验证物化后的新前端能完成导航、列表、阅读、搜索与位面切换。
// 站点产物由 tools/materialize-site.mjs 从数据库生成，本测试只消费产物。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = 8125;
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

  try {
    await waitForServer();
    const browser = await chromium.launch({ executablePath: chromiumExecutable() });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    // 默认位面：与旧站一致，首次进入落在 Logic
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view__hero .hero__title');
    const defaultPhase = await page.evaluate(() => document.documentElement.dataset.phase);
    assert.equal(defaultPhase, 'logic', `首次进入应落在 Logic，实际 ${defaultPhase}`);

    // Fantasy 位面：侧栏只放结构导航，且不展开具体条目
    await page.goto(`${baseUrl}/?phase=fantasy`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tree__link[data-action="section"]');
    const sectionCount = await page.locator('.tree__link[data-action="section"]').count();
    assert.ok(sectionCount >= 5, `分区入口应 >= 5，实际 ${sectionCount}`);
    assert.equal(await page.locator('.tree__link[data-action="entry"]').count(), 0, '侧栏不应直接展开条目');

    // 总览
    await page.waitForSelector('.section-card');
    const heroTitle = (await page.locator('.view__hero .hero__title').first().textContent())?.trim();
    assert.equal(
      heroTitle,
      '阅读、活动与慢慢写下的文字',
      `首页标题应使用原文案，实际「${heroTitle}」`,
    );

    // 分区列表（杂志式）
    await page.locator('.tree__link[data-action="section"]', { hasText: '漫评' }).first().click();
    await page.waitForSelector('.magazine .entry-card');
    assert.ok(await page.locator('.magazine .lead-card').count() === 1, '杂志式应有头条卡片');
    assert.ok(await page.locator('.magazine .entry-card').count() >= 5, '漫评应有若干卡片');

    // 打开一篇文章：正文来自静态产物，图片指向 Blob
    await page.locator('.magazine .entry-card').first().click();
    await page.waitForSelector('.entry-chrome');
    await page.waitForSelector('.content-viewer .article-surface');
    assert.ok(
      await page.locator('.content-viewer .article-surface').first().innerText().then((text) => text.trim().length > 0),
      '正文不应为空',
    );

    // 日常：按月分组的时间流
    await page.goto(`${baseUrl}/?phase=fantasy&section=daily`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.moment-card');
    assert.ok(await page.locator('.moment-card').count() >= 1, '日常应有动态');
    assert.ok(await page.locator('.moment-month__label').count() >= 1, '日常应按月分组');

    // 搜索面板：关键词 + 分面
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-search-panel].is-active');
    await page.fill('[data-search-input]', '冬滚滚');
    await page.waitForSelector('.search-facets .facet');
    assert.ok(await page.locator('[data-search-results] .command-item').count() >= 1, '搜索应有命中');
    await page.keyboard.press('Escape');

    // 位面面板与切换
    await page.keyboard.press('Backquote');
    await page.waitForSelector('[data-phase-panel].is-active');
    assert.equal(await page.locator('[data-phase-panel] [data-phase-id]').count(), 2);
    await page.locator('[data-phase-id="logic"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.phase === 'logic');
    await page.waitForSelector('.section-card');

    // 位面直链：?phase=logic 必须直接落在 Logic（曾因索引未就绪而失效）
    await page.goto(`${baseUrl}/?phase=logic`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view__hero .hero__title');
    const logicTitle = (await page.locator('.view__hero .hero__title').first().textContent())?.trim();
    assert.equal(logicTitle, '技术整理与项目记录', `?phase=logic 应直接进入 Logic，实际「${logicTitle}」`);

    // 深链：静态页自动进入阅读视图
    await page.goto(`${baseUrl}/content/冬滚滚.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => location.search.includes('entry='));
    await page.waitForSelector('.entry-chrome');

    assert.equal(errors.length, 0, `控制台有错误：${errors.slice(0, 3).join(' | ')}`);
    await browser.close();
    console.log('site-navigation: 全部通过');
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error(`site-navigation 失败：${error.message}`);
  process.exitCode = 1;
});
