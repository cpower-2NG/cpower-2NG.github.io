// 端到端：验证物化后的前端能完成导航、列表、阅读、搜索、位面切换与系列。
// 站点产物由 tools/materialize-site.mjs 从数据库生成，本测试只消费产物。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// 端口必须是 API 允许来源之一，否则真实检索请求会被 CORS 拒绝
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

  let browser = null;
  try {
    await waitForServer();
    browser = await chromium.launch({ executablePath: chromiumExecutable() });
    // 宽屏：阅读信息栏只在 ≥1200px 出现
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const step = (name) => console.log(`  · ${name}`);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    // 默认位面：与旧站一致，首次进入落在 Logic
    step('默认位面与 Logic 展示页');
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.view__hero .hero__title');
    const defaultPhase = await page.evaluate(() => document.documentElement.dataset.phase);
    assert.equal(defaultPhase, 'logic', `首次进入应落在 Logic，实际 ${defaultPhase}`);
    // Logic 首页即展示页
    assert.ok(await page.locator('.home-block').count() >= 2, 'Logic 首页应有简介 / 技术栈 / 项目结构');

    // Fantasy 首页：Hero → 日常卡片 → 分区块 → 文章行
    step('Fantasy 首页结构');
    await page.goto(`${baseUrl}/?phase=fantasy`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-card');
    const heroTitle = (await page.locator('.view__hero .hero__title').first().textContent())?.trim();
    assert.equal(heroTitle, '阅读、活动与慢慢写下的文字', `首页标题应使用原文案，实际「${heroTitle}」`);

    const order = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('[data-view] > *')];
      return blocks.map((node) => ({
        hero: node.classList.contains('view__hero'),
        card: node.classList.contains('home-card'),
        tiles: node.classList.contains('home-block') && Boolean(node.querySelector('.section-tile')),
      }));
    });
    const cardIndex = order.findIndex((item) => item.card);
    const tileIndex = order.findIndex((item) => item.tiles);
    assert.ok(cardIndex >= 0 && tileIndex > cardIndex, '分区块应排在日常卡片之后');
    assert.ok(await page.locator('.section-tile').count() >= 4, '首页应有四个分区块');

    // 侧栏只放结构导航，且不展开条目
    step('侧栏结构');
    assert.equal(await page.locator('.tree__link[data-action="entry"]').count(), 0, '侧栏不应直接展开条目');
    assert.ok(await page.locator('.tree__link[data-action="section"]').count() >= 4, '侧栏应有分区入口');

    // 分区列表（杂志式）：系列收成一张卡片
    step('分区列表与系列卡片');
    await page.locator('.tree__link[data-action="section"]', { hasText: '漫评' }).first().click();
    await page.waitForSelector('.magazine .entry-card');
    assert.ok(await page.locator('.magazine .series-card__badge').count() >= 1, '漫评里应把系列收成一张卡片');
    assert.equal(await page.locator('.magazine .entry-card', { hasText: '翡翠的排挤原理' }).count(), 0, '系列成员不应再逐篇列出');

    // 卡片悬停不再出现波浪下划线
    step('卡片悬停无波浪线');
    await page.locator('.magazine .entry-card').first().hover();
    const decoration = await page.evaluate(() => {
      const card = document.querySelector('.magazine .entry-card');
      return getComputedStyle(card).textDecorationStyle;
    });
    assert.notEqual(decoration, 'wavy', '卡片悬停不应出现波浪下划线');

    // 打开文章：版式属性齐全 + 阅读信息栏 + 上下篇
    step('阅读页版式与阅读信息栏');
    await page.locator('.magazine .entry-card').first().click();
    // 宽屏下元信息行会被 CSS 隐藏，用阅读信息栏判断是否已进入阅读视图
    await page.waitForSelector('.reading-gutter');
    await page.waitForSelector('.content-viewer .article-surface');
    const attrs = await page.evaluate(() => ({
      reading: document.documentElement.dataset.readingLayout,
      image: document.documentElement.dataset.imageLayout,
      layout: document.querySelector('[data-view]').dataset.entryLayout,
      type: document.querySelector('[data-view]').dataset.entryType,
    }));
    assert.ok(['magazine', 'column'].includes(attrs.reading), `data-reading-layout 未设置：${attrs.reading}`);
    assert.ok(Boolean(attrs.image), 'data-image-layout 未设置');
    assert.ok(Boolean(attrs.layout), 'data-entry-layout 未设置');
    assert.ok(Boolean(attrs.type), 'data-entry-type 未设置');
    assert.equal(await page.locator('.reading-gutter').count(), 1, '宽屏应出现阅读信息栏');
    assert.ok(await page.locator('.pager a').count() >= 1, '应出现上一篇 / 下一篇');
    // 正文、元信息行与评论区必须左右对齐
    const boxes = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        // 宽屏有右侧栏时元信息行会被 CSS 隐藏，此时视为不可见
        return { left: Math.round(rect.left), right: Math.round(rect.right), visible: rect.width > 0 };
      };
      return {
        chrome: box('.entry-meta'),
        // 正文盒子是满列宽，真正的版心在它的段落上
        article: box('.article-surface > p') || box('.article-surface'),
        comments: box('.comments'),
      };
    });
    assert.ok(boxes.article, '缺少正文容器');
    if (boxes.chrome?.visible) {
      assert.ok(Math.abs(boxes.chrome.left - boxes.article.left) <= 2, `元信息行与正文未左对齐：${boxes.chrome.left} vs ${boxes.article.left}`);
    }
    if (boxes.comments?.visible) {
      assert.ok(Math.abs(boxes.comments.left - boxes.article.left) <= 2, `评论区与正文未左对齐：${boxes.comments.left} vs ${boxes.article.left}`);
    }

    // 系列页：默认第一篇 + 成员条
    step('系列页');
    await page.goto(`${baseUrl}/?phase=fantasy&series=${encodeURIComponent('series:纸上魔法使')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.series-nav');
    assert.equal(await page.locator('.series-nav__item').count(), 5, '系列应有 5 个成员');
    assert.equal(await page.locator('.series-nav__item.is-active').first().textContent(), '翡翠的排挤原理', '系列页应默认第一篇');
    await page.waitForSelector('.article-surface');

    // 日常：居中版心 + 条目分隔 + 内联评论
    step('日常时间流与内联评论');
    await page.goto(`${baseUrl}/?phase=fantasy&section=daily`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.moment-card');
    assert.equal(await page.locator('.moment-card').count(), 3, '日常应有 3 条动态');
    assert.equal(await page.locator('.moment-card .moment-card').count(), 0, '日常条目不应再套卡片');
    assert.equal(await page.locator('.moment-feed').evaluate((node) => getComputedStyle(node).maxWidth !== 'none'), true, '日常流应有版心宽度');
    await page.locator('.moment-action', { hasText: '评论' }).first().click();
    await page.waitForSelector('.moment-thread', { timeout: 20000 });
    assert.ok(await page.locator('.moment-thread .comment-form').count() >= 1, '展开后应有评论表单');

    // 搜索面板
    step('搜索面板');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-search-panel].is-active');
    await page.fill('[data-search-input]', '冬滚滚');
    await page.waitForSelector('.search-facets .facet');
    assert.ok(await page.locator('[data-search-results] .command-item').count() >= 1, '搜索应有命中');
    await page.keyboard.press('Escape');

    // 位面面板：方向键 + 命令输入 + 彩蛋
    step('位面面板与彩蛋');
    await page.keyboard.press('Backquote');
    await page.waitForSelector('[data-phase-panel].is-active');
    await page.fill('[data-phase-input]', 'set up!');
    await page.waitForTimeout(120);
    assert.equal(
      (await page.locator('[data-phase-panel] .command-item.is-active .command-item__label').first().textContent())?.trim(),
      'Fantasy 位面',
      '输入 set up! 应命中 Fantasy 彩蛋',
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.dataset.phase === 'fantasy', { timeout: 15000 });
    await page.waitForSelector('.home-card');

    // 封面点击只打开文章，不弹出图片预览
    step('封面点击不触发预览');
    await page.goto(`${baseUrl}/?phase=fantasy&section=activity`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lead-card__cover img');
    await page.locator('.lead-card__cover img').first().click();
    await page.waitForSelector('.reading-gutter', { timeout: 15000 });
    assert.equal(await page.locator('dialog[open]').count(), 0, '点封面不应弹出图片预览');

    // 深链：静态页自动进入阅读视图
    step('深链');
    await page.goto(`${baseUrl}/content/冬滚滚.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => location.search.includes('entry='));
    await page.waitForSelector('.article-surface');
    assert.equal(await page.locator('.reading-gutter').count(), 1, '深链后应进入阅读视图');

    // 刷新保持位面，新会话回到 Logic
    step('位面持久化');
    await page.goto(`${baseUrl}/?phase=fantasy`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-card');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home-card');
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.phase),
      'fantasy',
      '刷新后应保持当前位面',
    );
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForSelector('.view__hero .hero__title');
    assert.equal(
      await freshPage.evaluate(() => document.documentElement.dataset.phase),
      'logic',
      '新会话应回到 Logic',
    );
    await fresh.close();

    const blocking = errors.filter((message) => !/favicon|net::ERR_/i.test(message));
    assert.equal(blocking.length, 0, `控制台有错误：${blocking.slice(0, 3).join(' | ')}`);
    console.log('site-navigation: 全部通过');
  } finally {
    // 浏览器必须在 finally 里关掉：断言失败时若留着连接，进程不会退出，CI 会一直挂着
    await browser?.close().catch(() => undefined);
    server.kill();
  }
}

main().catch((error) => {
  console.error(`site-navigation 失败：${error.message}`);
  process.exitCode = 1;
});
