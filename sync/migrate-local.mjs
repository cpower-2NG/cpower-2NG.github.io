// QQ 空间全量搬迁（本地运行版）。
//
// 与云端 qzone-sync 的区别：跑在家庭宽带 IP 上（数据中心 IP 是 QQ 风控的主要
// 识别特征）、直连列表分页跳过逐条详情、媒体转存并发化。1513 条说说预计 20-30
// 分钟一次跑完；中断重跑安全（已入库条目按 id 跳过）。
//
// 用法：cd sync && node migrate-local.mjs [--limit-pages N] [--dry-run]
// 会话来源：Key Vault 的 qzone-session（管理台重新扫码后即最新）。
// 本地凭据：az login（DefaultAzureCredential），需要 Cosmos/Blob/KeyVault 读权限。
import { writeFileSync } from 'node:fs';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { clients } from './src/clients.js';
import { loadRules, evaluatePost, contentHash } from './src/rules.js';
import { applyOverride, normalizePost } from './src/qzone-sync.js';
import { buildShareRecords, extractWupShares, fetchWupShareEntries, gtkFromCookies } from './src/qzone-shares.js';
import { momentDocsFromRecords, upsertMomentDocs } from './src/moment-store.js';
import { listContentRecords, commitRecords, publishQuarantineRecords } from './src/github.js';
import { storeImage } from './src/media.js';
import { hashSalt } from './src/rules.js';

// ---- 本地运行环境（与容器任务同值） ----
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

const args = process.argv.slice(2);
const LIMIT_PAGES = Number(args[args.indexOf('--limit-pages') + 1]) || Infinity;
const DRY_RUN = args.includes('--dry-run');
const PAGE_SLEEP_MS = 2500;
const MEDIA_CONCURRENCY = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** msglist 原始条目 → SDK 风格 post（normalizePost 的输入形状）。 */
function rawMsgToPost(msg, accountUin) {
  const media = (msg.pic || [])
    .map((pic) => ({
      kind: 'image',
      // msglist 的图片地址是 http，QQ 图床支持 https，media 白名单要求 https。
      url: String(pic.url3 || pic.url2 || pic.url1 || pic.smallurl || '').replace(/^http:/, 'https:'),
      width: Number(pic.width) || undefined,
      height: Number(pic.height) || undefined,
    }))
    .filter((item) => item.url);
  const comments = [];
  for (const raw of msg.commentlist || []) {
    comments.push({
      id: `${raw.uin}_${raw.create_time || raw.createTime2 || comments.length}`,
      author: { id: String(raw.uin || ''), nickname: String(raw.name || '') },
      content: String(raw.content || ''),
      createdAt: raw.create_time ? new Date(raw.create_time * 1000).toISOString() : null,
      kind: 'comment',
    });
    for (const reply of raw.list_3 || []) {
      comments.push({
        id: `${reply.uin}_${reply.create_time || comments.length}`,
        author: { id: String(reply.uin || ''), nickname: String(reply.name || '') },
        content: String(reply.content || ''),
        createdAt: reply.create_time ? new Date(reply.create_time * 1000).toISOString() : null,
        kind: 'reply',
      });
    }
  }
  return {
    id: String(msg.tid),
    authorId: String(msg.uin || accountUin),
    author: { id: String(msg.uin || accountUin), nickname: String(msg.name || '') },
    content: String(msg.content || ''),
    createdAt: msg.created_time ? new Date(msg.created_time * 1000).toISOString() : null,
    likeCount: 0,
    commentCount: Number(msg.cmtnum) || comments.length,
    liked: false,
    media,
    comments,
    commentsComplete: comments.length >= (Number(msg.cmtnum) || 0),
  };
}

async function main() {
  const secrets = new SecretClient(process.env.KEY_VAULT_URI, new DefaultAzureCredential());
  const session = JSON.parse((await secrets.getSecret('qzone-session')).value);
  console.log('会话账号:', session.accountId, '| cookie 数:', Object.keys(session.cookies || {}).length);

  // 模块级 clients() 单例读上面注入的 env。
  const rules = await loadRules();
  const salt = await hashSalt();
  const overridesDoc = await clients().cosmos
    .container('state')
    .item('content-overrides', 'settings').read().then((r) => r.resource).catch(() => null);
  const overrides = overridesDoc?.overrides && typeof overridesDoc.overrides === 'object' ? overridesDoc.overrides : {};
  const cookies = session.cookies || {};

  // 0. 已入库条目集合（跳过重复）
  console.log('读取已入库记录清单…');
  const existing = await listContentRecords();
  const doneIds = new Set(existing.map(({ record }) => record.id));
  console.log(`已入库 ${doneIds.size} 条。`);

  // 1. 直连 msglist_v6 分页（SDK 的 token 前置页被风控挡住，该接口本身可用；
  //    每页 1 次请求拿到正文/图片/评论，不再逐条详情）。
  const posts = [];
  let pages = 0;
  let stopped = '';
  let fstart = 0;
  const fcount = 20;
  const accountUin = String(session.accountId || '').replace(/^o/, '');
  const gtk = gtkFromCookies(cookies);
  const cookieHeader = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  for (;;) {
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`
      + `?uin=${accountUin}&fstart=${fstart}&fcount=${fcount}&sort=0&g_tk=${gtk}`;
    let payload;
    try {
      const response = await fetch(url, {
        headers: {
          cookie: cookieHeader,
          referer: `https://user.qzone.qq.com/${accountUin}/main`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        },
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      payload = JSON.parse(text.replace(/^_Callback\(/, '').replace(/\);\s*$/, ''));
    } catch (error) {
      stopped = `第 ${fstart} 条起分页失败：${error.message.slice(0, 80)}`;
      console.log(stopped);
      break;
    }
    if (payload.code !== 0) {
      stopped = `第 ${fstart} 条起接口错误 code=${payload.code} ${payload.message || ''}`;
      console.log(stopped);
      break;
    }
    pages += 1;
    const list = payload.msglist || [];
    for (const msg of list) posts.push(rawMsgToPost(msg, accountUin));
    if (pages % 10 === 0) console.log(`  已拉取 ${pages} 页 / ${posts.length} 条（total ${payload.total}）`);
    fstart += list.length;
    if (!list.length || fstart >= (Number(payload.total) || Infinity)) break;
    if (pages >= LIMIT_PAGES) { stopped = `达到页数上限 ${LIMIT_PAGES}`; break; }
    await sleep(PAGE_SLEEP_MS);
  }
  console.log(`说说分页完成：${pages} 页 ${posts.length} 条 ${stopped}`);

  // 2. 转发视频卡片
  let shareEntries = [];
  try {
    shareEntries = await fetchWupShareEntries(session, { uin: session.accountId });
  } catch (error) {
    console.log('转发视频抓取失败（跳过）:', error.message);
  }
  console.log('转发视频条目:', shareEntries.length);

  // 3. 归一化 + 媒体转存（并发）+ 审查
  // 分页窗口可能有重叠，按 id 去重。
  const postById = new Map();
  for (const post of posts) {
    if (!postById.has(post.id)) postById.set(post.id, post);
  }
  const newPosts = [...postById.values()].filter((post) => !doneIds.has(`qq-${String(post.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 160)}`));
  console.log(`新说说 ${newPosts.length} 条（其余 ${posts.length - newPosts.length} 条已入库/重复跳过）。`);

  // 全量搬迁语义：QQ 不返回可见性字段，「可见性未知」不作为搬迁的拦截条件
  // （仅作用于本次脚本；日常增量同步的全局规则不受影响）。敏感词仍照常隔离。
  const migrationBenign = (reasons) => (reasons || []).every(
    (reason) => reason === 'AUTO_PUBLISH_DISABLED' || reason === 'UNKNOWN_VISIBILITY',
  );

  const published = [];
  const quarantined = [];
  const pendingReview = [];
  let processed = 0;

  async function processOne(post) {
    let record;
    try {
      record = applyOverride(
        await normalizePost(post, rules, salt, cookies, { allowPublicMedia: false }),
        overrides,
      );
    } catch (error) {
      console.log(`  归一化失败 ${post.id}: ${error.message}`);
      return;
    }
    if (record.publishStatus !== 'published'
      && !overrides[record.source?.id ? `id:${record.source.id}` : `path:${record.id}`]
      && migrationBenign(record.reviewReasons)) {
      record.publishStatus = 'published';
      record.reviewReasons = (record.reviewReasons || []).filter((reason) => reason !== 'UNKNOWN_VISIBILITY');
      record.source.warnings.push('MIGRATION_VISIBILITY_BYPASS');
    }
    // 媒体转存（QQ CDN 链接会过期，必须落到自有 Blob）。
    if (record.publishStatus === 'published') {
      for (const item of record.media || []) {
        if (!item.sourceUrl && !item.url) continue;
        try {
          const stored = await storeImage(item.sourceUrl || item.url, cookies);
          Object.assign(item, stored, { sourceUrl: item.sourceUrl || stored.sourceUrl });
        } catch (error) {
          record.source.warnings.push(`MEDIA:image:${error.message.slice(0, 60)}`);
        }
      }
      if (record.video?.cover) {
        try {
          const stored = await storeImage(record.video.cover, cookies);
          record.video.cover = stored.url;
        } catch { /* 封面失败不阻塞 */ }
      }
      if (record.cover) {
        const bySource = (record.media || []).find((item) => item.sourceUrl === record.cover);
        if (bySource) record.cover = bySource.url;
      }
      record.contentHash = contentHash({ text: record.text, media: record.media, video: record.video });
    }
    processed += 1;
    if (processed % 25 === 0) {
      console.log(`  已处理 ${processed}/${newPosts.length}（发布 ${published.length}，隔离 ${quarantined.length}）`);
    }
    if (record.publishStatus === 'published') published.push(record);
    else if (record.reviewReasons?.length && record.reviewReasons.every((reason) => reason === 'AUTO_PUBLISH_DISABLED')) pendingReview.push(record);
    else quarantined.push(record);
  }

  // 简单并发池
  const queue = [...newPosts];
  async function worker() {
    for (;;) {
      const post = queue.shift();
      if (!post) return;
      await processOne(post);
      await sleep(300);
    }
  }
  await Promise.all(Array.from({ length: MEDIA_CONCURRENCY }, worker));
  console.log(`说说处理完成：发布 ${published.length}，待审 ${pendingReview.length}，隔离 ${quarantined.length}。`);

  // 4. 转发视频记录
  const shareRecords = await buildShareRecords(shareEntries, { cookies, coverTransfer: 'store' });
  for (const rawRecord of shareRecords) {
    if (doneIds.has(rawRecord.id)) continue;
    const decision = evaluatePost({
      content: rawRecord.text, media: rawRecord.media, video: rawRecord.video, visibility: 'unknown',
    }, rules, 'complete');
    const record = applyOverride({ ...rawRecord, publishStatus: decision.publishStatus, reviewReasons: decision.reasons }, overrides);
    if (record.publishStatus !== 'published' && migrationBenign(record.reviewReasons)) {
      record.publishStatus = 'published';
      record.reviewReasons = (record.reviewReasons || []).filter((reason) => reason !== 'UNKNOWN_VISIBILITY');
      record.source.warnings.push('MIGRATION_VISIBILITY_BYPASS');
    }
    if (record.publishStatus === 'published') published.push(record);
    else quarantined.push(record);
  }
  console.log('转发视频新增:', shareRecords.filter((record) => !doneIds.has(record.id)).length);

  if (DRY_RUN) {
    console.log('DRY-RUN 结束，未写任何数据。发布', published.length, '隔离', quarantined.length);
    writeFileSync(new URL('./.migrate-preview.json', import.meta.url), JSON.stringify({
      published: published.map((record) => ({ id: record.id, date: record.date, title: record.title })),
      quarantined: quarantined.map((record) => ({ id: record.id, reasons: record.reviewReasons })),
    }, null, 1));
    return;
  }

  // 5. 提交 Git（分批，每批 400 条）
  for (let i = 0; i < published.length; i += 400) {
    const batch = published.slice(i, i + 400);
    process.stdout.write(`提交 Git ${i + 1}-${i + batch.length}/${published.length}…`);
    const commit = await commitRecords(batch);
    console.log(` ${commit.changed ? 'ok' : '无变化'} files=${commit.files}`);
    await sleep(2000);
  }

  // 6. 写权威库
  const docs = momentDocsFromRecords(published);
  for (let i = 0; i < docs.length; i += 200) {
    process.stdout.write(`入库 ${i + 1}-${Math.min(i + 200, docs.length)}/${docs.length}…`);
    await upsertMomentDocs(docs.slice(i, i + 200));
    console.log(' ok');
  }

  // 7. 隔离区
  if (quarantined.length) {
    const path = await publishQuarantineRecords(quarantined);
    console.log(`隔离 ${quarantined.length} 条 -> ${path}`);
  }

  console.log(`\nRESULT: 迁移完成。发布 ${published.length}，待审 ${pendingReview.length}，隔离 ${quarantined.length}。${stopped ? ` 注意：${stopped}` : ''}`);
  console.log('下一步：az containerapp job start --name content-publish --resource-group rg-bifrost-prod 触发上线。');
}

main().catch((error) => {
  console.error('MIGRATE FAILED:', error.message);
  process.exitCode = 1;
});
