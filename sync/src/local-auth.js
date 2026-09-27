import { chromium } from 'playwright';
import { QzoneClient } from 'qzone-sdk';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

const KEY_VAULT_URI = process.env.KEY_VAULT_URI || 'https://kv-bifrost-z43zcc.vault.azure.net/';

if (process.platform === 'win32') {
  const azureCliPath = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin';
  process.env.Path = `${azureCliPath};${process.env.Path || ''}`;
}

function cookieObject(cookies) {
  return Object.fromEntries(
    cookies
      .filter((cookie) => cookie.domain.endsWith('qq.com'))
      .map((cookie) => [cookie.name, cookie.value]),
  );
}

function hasLoginCookies(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has('p_skey') && (names.has('uin') || names.has('p_uin'));
}

async function launchVisibleBrowser() {
  for (const options of [
    { headless: false, channel: 'msedge' },
    { headless: false, channel: 'chrome' },
    { headless: false },
  ]) {
    try {
      return await chromium.launch(options);
    } catch {
      // Try the next locally installed browser.
    }
  }
  throw new Error('找不到可用的 Chrome、Edge 或 Playwright Chromium。');
}

async function main() {
  const browser = await launchVisibleBrowser();
  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto('https://i.qq.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    console.log('QQ 登录窗口已打开，请在浏览器中扫码。窗口保留 10 分钟。');

    const deadline = Date.now() + 10 * 60 * 1000;
    let cookies = [];
    while (Date.now() < deadline) {
      cookies = await context.cookies();
      if (hasLoginCookies(cookies)) break;
      await page.waitForTimeout(2000);
    }

    if (!hasLoginCookies(cookies)) {
      throw new Error('等待扫码超时。');
    }

    const cookieMap = cookieObject(cookies);
    const client = new QzoneClient({ session: { cookies: cookieMap } });
    const session = client.exportSession();
    await client.close();

    const secrets = new SecretClient(KEY_VAULT_URI, new DefaultAzureCredential());
    await secrets.setSecret('qzone-session', JSON.stringify(session));
    console.log(`QQ 会话已写入 Key Vault，账号 ${String(session.accountId).replace(/\d(?=\d{4})/g, '*')}。`);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
