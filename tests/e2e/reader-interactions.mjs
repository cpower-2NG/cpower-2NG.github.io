import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = 8125;
const baseUrl = `http://127.0.0.1:${port}`;
const requireFromSync = createRequire(join(root, 'sync', 'package.json'));
const { chromium } = requireFromSync('playwright');

function findChromiumExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) {
    return configured;
  }
  const expected = chromium.executablePath();
  if (expected && existsSync(expected)) {
    return expected;
  }
  const playrightRoot = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!existsSync(playrightRoot)) {
    return expected;
  }
  const candidates = readdirSync(playrightRoot)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(playrightRoot, name, 'chrome-win64', 'chrome.exe'),
      join(playrightRoot, name, 'chrome-linux', 'chrome'),
      join(playrightRoot, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]);
  return candidates.find((candidate) => existsSync(candidate)) || expected;
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/.bifrost-ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  throw new Error('预览服务器未能在 15 秒内启动。');
}

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error('等待条件超时。');
}

function articleUrl(path, extra = {}) {
  const url = new URL('/', baseUrl);
  url.searchParams.set('phase', path.includes('/logic/') ? 'logic' : 'fantasy');
  url.searchParams.set('path', path);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function createMockedPage(browser, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const state = {
    comments: [],
    likes: 0,
    liked: false,
    views: 0,
    viewPosts: 0,
    commentPosts: 0,
  };

  await page.route('https://func-bifrost-z43zcc.azurewebsites.net/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': baseUrl };
    if (pathname.endsWith('/api/interactions')) {
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          comments: state.comments,
          likes: state.likes,
          views: state.views,
          liked: state.liked,
        }),
      });
    }
    if (pathname.endsWith('/api/comments')) {
      state.commentPosts += 1;
      const body = request.postDataJSON();
      const id = `comment-${state.commentPosts}`;
      const comment = {
        id,
        path: body.path,
        nickname: body.anonymous ? '匿名用户' : body.nickname,
        anonymous: Boolean(body.anonymous),
        content: body.content,
        website: '',
        createdAt: new Date().toISOString(),
        replies: [],
      };
      if (body.parentId) {
        const root = state.comments.find((item) => item.id === body.parentId);
        if (root) root.replies.push({ ...comment, rootId: root.id, replyToId: root.id });
      } else {
        state.comments.push(comment);
      }
      return route.fulfill({
        status: 201,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({
          id,
          status: 'published',
          comments: state.comments,
          likes: state.likes,
          views: state.views,
          liked: state.liked,
        }),
      });
    }
    if (pathname.endsWith('/api/reactions')) {
      state.liked = !state.liked;
      state.likes += state.liked ? 1 : -1;
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ liked: state.liked, likes: Math.max(0, state.likes) }),
      });
    }
    if (pathname.endsWith('/api/views')) {
      state.views += 1;
      state.viewPosts += 1;
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ views: state.views }),
      });
    }
    return route.fulfill({ status: 404, headers, contentType: 'application/json', body: '{}' });
  });

  return { context, page, state };
}

async function testNavigation(page) {
  await page.goto(`${baseUrl}/?phase=fantasy`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-tree-search]');
  assert.equal(await page.locator('.tree__section').count(), 5);
  const counts = await page.locator('.tree__count').allTextContents();
  assert.deepEqual(counts, ['3', '3', '6', '6']);
  const visibleText = await page.locator('body').innerText();
  assert.doesNotMatch(visibleText, /entries\.json|构建|索引|占位|手工维护|Bootstrap|\[ OK \]/);

  await page.locator('[data-tree-search]').fill('冬暮');
  assert.equal(await page.locator('.tree__link--result').count(), 1);
  assert.match(await page.locator('.tree__link--result').innerText(), /冬暮川滚滚/);

  await page.locator('[data-tree-search]').fill('2025');
  assert.equal(await page.locator('.tree__link--result').count(), 3);
  await page.locator('[data-tree-search]').fill('');
  assert.equal(await page.locator('.tree__section').count(), 5);
}

async function testLightbox(page) {
  await page.goto(
    articleUrl('/content/fantasy/article/2025-11-24-幸运小特种兵的中村先生fmt见闻.html'),
    { waitUntil: 'domcontentloaded' },
  );
  const first = page.locator('.article-surface img.media-preview-trigger').first();
  await first.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.article-surface img.media-preview-trigger');
    return Boolean(image?.dataset.imageShape);
  });
  assert.equal(await first.getAttribute('data-image-shape'), 'portrait');
  await first.click();
  assert.equal(await page.locator('.media-preview__counter').innerText(), '1 / 5');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.media-preview__counter').innerText(), '2 / 5');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.media-preview').getAttribute('open'), null);
}

async function testPublicationReader(page, mobile = false) {
  if (mobile) {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.goto(
    articleUrl('/content/fantasy/article/2026-09-28-dongungun-publication.html'),
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('[data-publication-reader]').click();
  await page.locator('.publication-reader__page').first().waitFor();
  assert.equal(await page.locator('.publication-reader__page').count(), 1);
  assert.equal(await page.locator('[data-reader-counter]').innerText(), '1 / 5');
  await page.keyboard.press('ArrowRight');
  if (mobile) {
    assert.equal(await page.locator('.publication-reader__page').count(), 1);
    assert.equal(await page.locator('[data-reader-counter]').innerText(), '2 / 5');
  } else {
    assert.equal(await page.locator('.publication-reader__page').count(), 2);
    assert.equal(await page.locator('[data-reader-counter]').innerText(), '2–3 / 5');
  }
  await page.keyboard.press('Escape');
}

async function testInteractions(page, state) {
  await page.goto(
    articleUrl('/content/fantasy/article/2026-09-27-dong-muchuan-review.html'),
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('.comments').waitFor();
  assert.equal(await page.locator('.comment-form input[name="nickname"]').inputValue(), '');

  await page.locator('.comment-form input[name="nickname"]').fill('测试访客');
  await page.locator('.comment-form__textarea').fill('第一条真实流程评论');
  await page.waitForTimeout(1300);
  await page.locator('.comment-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.comment__body')?.textContent.includes('第一条真实流程评论'));
  assert.equal(await page.locator('.comment__body').first().innerText(), '第一条真实流程评论');

  await page.locator('.comment-form input[name="anonymous"]').check();
  assert.equal(await page.locator('.comment-form input[name="nickname"]').isDisabled(), true);
  await page.locator('.comment-form__textarea').fill('匿名测试评论');
  await page.locator('.comment-form button[type="submit"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.comment__body')].some((node) => node.textContent.includes('匿名测试评论')));
  assert.match(await page.locator('.comment').last().innerText(), /匿名用户/);

  await page.locator('.comment__reply').first().click();
  await page.locator('.comment-reply-form textarea').fill('一条回复');
  await page.locator('.comment-reply-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.comment__replies .comment__body')?.textContent.includes('一条回复'));

  await page.locator('.interaction-like').click();
  await page.waitForFunction(() => document.querySelector('.interaction-like')?.textContent.includes('1 赞'));
  assert.equal(await page.locator('.interaction-like').getAttribute('aria-pressed'), 'true');
  await waitFor(() => state.viewPosts >= 1);
  assert.ok(state.commentPosts >= 3);
  assert.equal(state.viewPosts, 1);
}

async function testFailureDegradation(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://func-bifrost-z43zcc.azurewebsites.net/**', (route) => route.abort());
  await page.goto(
    articleUrl('/content/fantasy/article/2026-09-27-dong-muchuan-review.html'),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForTimeout(400);
  assert.match(await page.locator('.article-surface').innerText(), /冬暮川滚滚/);
  assert.equal(await page.locator('.comments').count(), 0);
  await context.close();
}

async function testControlsAndReadingLayouts(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.route('https://func-bifrost-z43zcc.azurewebsites.net/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"enabled":true,"comments":[],"likes":0,"views":0,"liked":false}',
    }),
  );

  await page.goto(`${baseUrl}/?phase=fantasy`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-tree-search]');
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--grid-line').trim()),
    'transparent',
  );
  await page.keyboard.press('`');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-command-overlay]').evaluate((node) => node.classList.contains('is-active')), false);
  await page.keyboard.press('Control+K');
  assert.equal(await page.locator('[data-command-overlay]').evaluate((node) => node.classList.contains('is-active')), true);
  const commandHelp = await page.locator('.command-help').innerText();
  assert.doesNotMatch(commandHelp, /set up|reset|shutdown|彩蛋/);
  await page.locator('[data-command-input]').fill('reset');
  assert.equal(await page.locator('.command-item').count(), 0);
  await page.keyboard.press('Escape');

  await page.goto(
    articleUrl('/content/fantasy/article/2026-09-27-dong-muchuan-review.html', { reading: 'column' }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('.article-surface h1');
  assert.equal(await page.locator('.reading-gutter').count(), 0);

  await page.goto(
    articleUrl('/content/fantasy/article/2026-09-27-dong-muchuan-review.html', { reading: 'magazine' }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('.reading-gutter');
  const magazine = await page.evaluate(() => {
    const article = document.querySelector('.article-surface').getBoundingClientRect();
    const gutter = document.querySelector('.reading-gutter').getBoundingClientRect();
    return {
      articleWidth: article.width,
      gutterLeft: gutter.left,
      articleRight: article.right,
    };
  });
  assert.ok(magazine.articleWidth > 800);
  assert.ok(magazine.gutterLeft > magazine.articleRight);

  await page.goto(
    articleUrl('/content/fantasy/article/2025-11-24-幸运小特种兵的中村先生fmt见闻.html', { reading: 'magazine' }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('.article-surface h1');
  assert.equal(await page.locator('.reading-gutter').count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    articleUrl('/content/fantasy/article/2026-09-27-dong-muchuan-review.html', { reading: 'magazine' }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('.article-surface h1');
  assert.equal(await page.locator('.reading-gutter').isVisible(), false);

  await page.goto(`${baseUrl}/?phase=logic`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-tree-search]');
  const logicGrid = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--grid-line').trim(),
  );
  assert.notEqual(logicGrid, 'transparent');
  await context.close();
}

const server = spawn(process.execPath, ['preview-server.mjs', String(port), '--no-open'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let browser;

try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    executablePath: findChromiumExecutable(),
  });

  const navigation = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const navigationPage = await navigation.newPage();
  await testNavigation(navigationPage);
  await testLightbox(navigationPage);
  await testPublicationReader(navigationPage, false);
  await navigation.close();

  await testControlsAndReadingLayouts(browser);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  await testPublicationReader(mobilePage, true);
  await mobile.close();

  const mocked = await createMockedPage(browser, { viewport: { width: 1280, height: 900 } });
  await testInteractions(mocked.page, mocked.state);
  await mocked.context.close();

  await testFailureDegradation(browser);
  process.stdout.write('E2E reader/interaction checks passed.\n');
} finally {
  await browser?.close().catch(() => undefined);
  server.kill();
}
