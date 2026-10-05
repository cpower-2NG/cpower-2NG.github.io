import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { QzoneClient } from 'qzone-sdk';
import { clients } from './clients.js';
import { setQzoneStatus, writeState } from './state.js';

function cookieObject(cookies) {
  return Object.fromEntries(
    cookies
      .filter((cookie) => cookie.domain.endsWith('qq.com'))
      .map((cookie) => [cookie.name, cookie.value]),
  );
}

function loggedIn(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return (names.has('p_skey') || names.has('skey')) && (names.has('uin') || names.has('p_uin'));
}

/**
 * 扫码后 ptlogin 先种 skey，完整登录闭环（跳转进空间）才种 p_skey。
 * 说说接口的 g_tk 只认 p_skey 派生值：只拿 skey 就 persist 会话，
 * 会在服务端表现为"请先登录空间"（QQ 302 清 cookie）。因此必须等 p_skey。
 */
function loginClosedLoop(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has('p_skey') && names.has('uin');
}

/** 用候选会话实测一次接口可用性，避免把 QQ 不认的半截会话存进 Key Vault。 */
async function sessionActuallyWorks(cookieMap) {
  const client = new QzoneClient({
    session: { cookies: cookieMap },
    onSessionChange: async () => {},
  });
  try {
    const page = await client.listFeeds({ scope: 'self', limit: 1 });
    return Array.isArray(page.items);
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function qrLocator(page) {
  const candidates = [
    page.locator('img[src*="ptqrshow"], #qlogin_qr, canvas').first(),
  ];
  for (const frame of page.frames()) {
    candidates.push(frame.locator('img[src*="ptqrshow"], #qlogin_qr, canvas').first());
  }
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/** 入参已是「cookie 名 → 值」对象（调用方负责从 Playwright cookie 数组转换）。 */
async function persistSession(cookieMap) {
  const client = new QzoneClient({ session: { cookies: cookieMap } });
  const snapshot = client.exportSession();
  await clients().secrets.setSecret('qzone-session', JSON.stringify(snapshot));
  await client.close();
  return snapshot;
}

export async function connectQzone() {
  const { config, private: privateContainer } = clients();
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const authId = randomUUID();
  const qrBlobName = `qzone-auth/${authId}.png`;
  const expiresAt = Date.now() + 10 * 60 * 1000;
  let warnedHalfLogin = false;

  try {
    await page.goto('https://i.qq.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(2500);
    const locator = await qrLocator(page);
    if (!locator) {
      throw new Error('无法定位 QQ 登录二维码，页面结构可能已经变化。');
    }
    const screenshot = await locator.screenshot({ type: 'png' });
    await privateContainer.getBlockBlobClient(qrBlobName).uploadData(screenshot, {
      blobHTTPHeaders: { blobContentType: 'image/png' },
      metadata: { expiresAt: String(expiresAt) },
    });
    await writeState('qzone-auth-request', {
      type: 'qzone-auth-request',
      state: 'waiting_for_scan',
      message: '请使用手机 QQ 扫描二维码。',
      qrBlobName,
      expiresAt,
      startedAt: new Date().toISOString(),
    });
    await setQzoneStatus('auth_required', '等待扫码登录。');

    while (Date.now() < expiresAt) {
      const cookies = await context.cookies();
      if (loginClosedLoop(cookies)) {
        const cookieMap = cookieObject(cookies);
        // 服务端实测通过才保存；QQ 跳转闭环有延迟，未通过则继续轮询。
        if (await sessionActuallyWorks(cookieMap)) {
          const session = await persistSession(cookieMap);
          await setQzoneStatus('connected', 'QQ 登录会话已更新。', {
            accountId: session.accountId,
          });
          await writeState('qzone-auth-request', {
            type: 'qzone-auth-request',
            state: 'connected',
            message: '扫码登录成功。',
            connectedAt: new Date().toISOString(),
          });
          await privateContainer.getBlockBlobClient(qrBlobName).deleteIfExists();
          return { connected: true };
        }
      } else if (loggedIn(cookies) && !warnedHalfLogin) {
        warnedHalfLogin = true;
        await writeState('qzone-auth-request', {
          type: 'qzone-auth-request',
          state: 'waiting_for_scan',
          message: '已扫码，正在完成登录跳转…',
          qrBlobName,
          expiresAt,
        });
      }
      await page.waitForTimeout(2000);
    }

    await writeState('qzone-auth-request', {
      type: 'qzone-auth-request',
      state: 'expired',
      message: '二维码已过期，请重新发起登录。',
      expiredAt: new Date().toISOString(),
    });
    await setQzoneStatus('auth_required', '二维码已过期。');
    await privateContainer.getBlockBlobClient(qrBlobName).deleteIfExists();
    return { connected: false, reason: 'expired' };
  } catch (error) {
    await privateContainer.getBlockBlobClient(qrBlobName).deleteIfExists().catch(() => undefined);
    await writeState('qzone-auth-request', {
      type: 'qzone-auth-request',
      state: 'failed',
      message: error.message,
      failedAt: new Date().toISOString(),
    });
    await setQzoneStatus('auth_failed', error.message);
    throw error;
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
