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

async function persistSession(cookies) {
  const cookieMap = cookieObject(cookies);
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
      if (loggedIn(cookies)) {
        const session = await persistSession(cookies);
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
