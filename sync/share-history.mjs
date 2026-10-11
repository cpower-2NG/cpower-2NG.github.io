// QQ 历史转发视频补抓（本地运行）：
// walk feeds_html_act_all（start 翻页），extractWupShares 提取外链卡片转发（appid 202），
// 走同一套审查/媒体转存/Git/权威库管线。幂等：已入库的按 origin.ref 跳过。
// 用法：cd sync && node share-history.mjs
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { QzoneClient } from 'qzone-sdk';
import { clients } from './src/clients.js';
import { loadRules, evaluatePost } from './src/rules.js';
import { applyOverride } from './src/qzone-sync.js';
import {
  buildShareRecords,
  extractWupShares,
  gtkFromCookies,
} from './src/qzone-shares.js';
import { momentDocsFromRecords, upsertMomentDocs } from './src/moment-store.js';
import { commitRecords, publishQuarantineRecords } from './src/github.js';

process.env.COSMOS_ENDPOINT ||= 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
process.env.COSMOS_DATABASE ||= 'bifrost';
process.env.BLOB_ACCOUNT_URL ||= 'https://stbifrostz43zcc.blob.core.windows.net/';
process.env.MEDIA_CONTAINER ||= 'media';
process.env.PRIVATE_CONTAINER ||= 'private';
process.env.KEY_VAULT_URI ||= 'https://kv-bifrost-z43zcc.vault.azure.net/';
process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME ||= 'github-app-private-key';
process.env.GITHUB_APP_ID ||= '5095307';
process.env.GITHUB_APP_INSTALLATION_ID ||= '165407698';
process.env.GITHUB_REPOSITORY ||= 'cpower-2NG/cpower-2NG.github.io';
process.env.GITHUB_BRANCH ||= 'main';
process.env.CONTENT_COMMIT_PREFIX ||= 'content-src/imported/qq';
process.env.QZONE_STATE_PARTITION ||= 'sync';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const secrets = new SecretClient(process.env.KEY_VAULT_URI, new DefaultAzureCredential());
  const session = JSON.parse((await secrets.getSecret('qzone-session')).value);
  const cookies = session.cookies || {};
  const accountUin = String(session.accountId || '').replace(/^o/, '');
  const rules = await loadRules();
  const overridesDoc = await clients().cosmos
    .container('state')
    .item('content-overrides', 'settings').read().then((r) => r.resource).catch(() => null);
  const overrides = overridesDoc?.overrides && typeof overridesDoc.overrides === 'object' ? overridesDoc.overrides : {};

  // 已入库的转发（按 origin.ref）
  const { resources: existingShareMoments } = await clients().cosmos.container('content-moments').items
    .query('SELECT c.origin.ref FROM c WHERE c.origin.provider = "qq" AND IS_DEFINED(c.video)')
    .fetchAll();
  const existingRefs = new Set(existingShareMoments.map((doc) => doc.origin?.ref).filter(Boolean));
  console.log('已入库转发:', existingRefs.size);

  // walk act_all（start 翻页）
  const gtk = gtkFromCookies(cookies);
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const HEADERS = {
    cookie: cookieHeader,
    referer: `https://user.qzone.qq.com/${accountUin}/main`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  };
  const seenFkeys = new Set();
  const entries = [];
  let pos = 0;
  let stale = 0;
  const pageSize = 10;
  const startedAt = Date.now();
  for (let page = 0; page < 400; page += 1) {
    const url = `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds_html_act_all`
      + `?uin=${accountUin}&hostuin=${accountUin}&scope=0&filter=all&flag=1&refresh=0&firstGetGroup=0`
      + `&mixnocache=0&scene=0&sidomain=qzonestyle.gtimg.cn&useutf8=1&outputhtmlfeed=1&refer=2`
      + `&start=${pos}&count=${pageSize}&g_tk=${gtk}`;
    let text = '';
    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      text = await response.text();
    } catch (error) {
      console.log(`pos=${pos} 拉取失败：${error.message.slice(0, 60)}`);
      break;
    }
    const pageEntries = extractWupShares(text);
    const novel = pageEntries.filter((entry) => !seenFkeys.has(entry.shareId)).length;
    for (const entry of pageEntries) {
      seenFkeys.add(entry.shareId);
      entries.push(entry);
    }
    if (page % 10 === 0) console.log(`pos=${pos}: 卡片累计 ${entries.length}（新 ${novel}）`);
    if (!pageEntries.length) break;
    if (novel === 0) {
      stale += 1;
      if (stale >= 2) { console.log(`pos=${pos} 连续两页无新增，停止`); break; }
    } else {
      stale = 0;
    }
    pos += pageSize;
    await sleep(2200);
  }
  console.log(`act_all walk 完成：卡片 ${entries.length} 张，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`);

  // 未入库的转发
  const newEntries = entries.filter((entry) => {
    return !existingRefs.has(entry.shareId) && !existingRefs.has(`qq-share-${entry.bvid || ''}`);
  });
  console.log('未入库转发:', newEntries.length);
  if (!newEntries.length) {
    console.log('RESULT: 无新增转发，无需发布');
    return;
  }

  const newRecords = await buildShareRecords(newEntries, { cookies, coverTransfer: 'store' });
  const approved = [];
  const quarantined = [];
  for (const rawRecord of newRecords) {
    const decision = evaluatePost({
      content: rawRecord.text, media: rawRecord.media, video: rawRecord.video, visibility: 'unknown',
    }, rules, 'complete');
    const record = applyOverride({ ...rawRecord, publishStatus: decision.publishStatus, reviewReasons: decision.reasons }, overrides);
    // 全量搬迁语义：纯"可见性未知"不拦截——与 migrate-local 一致。敏感词仍隔离待审。
    if (record.publishStatus !== 'published'
      && (record.reviewReasons || []).every(
        (reason) => reason === 'AUTO_PUBLISH_DISABLED' || reason === 'UNKNOWN_VISIBILITY',
      )) {
      record.publishStatus = 'published';
      record.reviewReasons = (record.reviewReasons || []).filter((reason) => reason !== 'UNKNOWN_VISIBILITY');
      record.source.warnings.push('MIGRATION_VISIBILITY_BYPASS');
    }
    if (record.publishStatus === 'published') approved.push(record);
    else quarantined.push(record);
  }
  console.log(`通过审查 ${approved.length}，隔离 ${quarantined.length}`);

  if (quarantined.length) {
    const path = await publishQuarantineRecords(quarantined);
    console.log(`隔离 ${quarantined.length} 条留档：${path}`);
  }

  if (approved.length) {
    for (let i = 0; i < approved.length; i += 400) {
      await commitRecords(approved.slice(i, i + 400));
      console.log(`Git 批次 ${i + 1}-${Math.min(i + 400, approved.length)} 提交完成`);
    }
    const docs = momentDocsFromRecords(approved);
    await upsertMomentDocs(docs);
    console.log(`权威库入库 ${docs.length} 条`);
  }
  console.log(`RESULT: 历史转发补抓完成（新增 ${approved.length} 条，隔离 ${quarantined.length} 条）。下一步触发 content-publish 上线。`);
}

main().catch((error) => {
  console.error('SHARE-HISTORY FAILED:', error.message);
  process.exitCode = 1;
});
