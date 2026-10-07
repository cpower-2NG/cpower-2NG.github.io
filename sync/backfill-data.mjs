// QQ 历史数据回补（本地运行，一次性/可重复）：
//   1. 评论回填：msglist 带 need_comment 重拉，匿名化写入 historicalInteractions
//   2. html 重渲染：[em]eXXX[/em] → QQ 表情图片；@{uin,nick} → @nick
//   3. 失效图片重抓：media/cover 里的 QQ 签名直链用新鲜签名重转存
//   4. 转发视频封面回填：B 站公开 API
// 用法：cd sync && node backfill-data.mjs
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { QzoneClient } from 'qzone-sdk';
import { clients } from './src/clients.js';
import { hashSalt, contentHash } from './src/rules.js';
import { anonymizeComment, renderMentions } from './src/anonymize.js';
import { gtkFromCookies } from './src/qzone-shares.js';
import { storeImage } from './src/media.js';
import { fetchBilibiliVideo } from './src/qzone-shares.js';

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

/** [em]eXXX[/em] → QQ 官方表情图（公开静态资源）。 */
function renderEmoticons(value) {
  return String(value || '').replace(/\[em\]e(\d+)\[\/em\]/g, (match, code) => {
    if (!/^\d{1,4}$/.test(code)) return match;
    return `<img class="moment__emoticon" src="https://qzonestyle.gtimg.cn/qzone/em/e${code}.gif" alt="[表情]">`;
  });
}

function renderHtml(text) {
  const escaped = String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const withBreaks = escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.trim().replaceAll('\n', '<br>')}</p>`)
    .filter((block) => block !== '<p></p>')
    .join('\n');
  return renderEmoticons(renderMentions(withBreaks));
}

async function main() {
  const secrets = new SecretClient(process.env.KEY_VAULT_URI, new DefaultAzureCredential());
  const session = JSON.parse((await secrets.getSecret('qzone-session')).value);
  const cookies = session.cookies || {};
  const accountUin = String(session.accountId || '').replace(/^o/, '');
  const salt = await hashSalt();
  const container = clients().cosmos.container('content-moments');

  // ---- 1. 拉全部说说（带评论）----
  const gtk = gtkFromCookies(cookies);
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const byTid = new Map();
  let pos = 0;
  let stopped = '';
  const seenTids = new Set();
  for (;;) {
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`
      + `?uin=${accountUin}&inCharset=utf-8&outCharset=utf-8&hostUin=${accountUin}&notice=0&sort=0`
      + `&pos=${pos}&num=20&replynum=100&code_version=1&format=json&need_comment=1&need_private_comment=1&g_tk=${gtk}`;
    let payload;
    try {
      const response = await fetch(url, {
        headers: {
          cookie: cookieHeader,
          referer: `https://user.qzone.qq.com/${accountUin}/311`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        },
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      payload = JSON.parse(text.replace(/^_Callback\(/, '').replace(/\);\s*$/, ''));
    } catch (error) {
      stopped = `pos=${pos}：${error.message.slice(0, 60)}`;
      break;
    }
    if (payload.code !== 0) { stopped = `code=${payload.code}`; break; }
    const list = payload.msglist || [];
    const novel = list.filter((msg) => !seenTids.has(String(msg.tid))).length;
    if (list.length && novel === 0) { stopped = '翻页失效'; break; }
    for (const msg of list) {
      seenTids.add(String(msg.tid));
      byTid.set(String(msg.tid), msg);
    }
    console.log(`msglist ${pos + list.length}/${payload.total}`);
    pos += list.length;
    if (!list.length || pos >= (Number(payload.total) || Infinity)) break;
    await sleep(2200);
  }
  console.log(`msglist 抓取：${byTid.size} 条 ${stopped}`);

  // ---- 2. 遍历权威库，逐条回补 ----
  const { resources } = await container.items
    .query('SELECT * FROM c', { maxItemCount: 1000 })
    .fetchAll();
  console.log('权威库动态:', resources.length);

  let commentsBackfilled = 0;
  let htmlUpdated = 0;
  let mediaRefreshed = 0;
  let mediaFailed = 0;
  let coversBackfilled = 0;
  let processed = 0;

  for (const doc of resources) {
    processed += 1;
    if (processed % 100 === 0) console.log(`  处理 ${processed}/${resources.length}`);
    const ref = doc.origin?.ref || '';
    const raw = ref ? byTid.get(ref) : null;
    let dirty = false;

    // 2a. 评论回填（只有说说有 raw；转发视频无评论源）
    if (raw && Array.isArray(raw.commentlist) && raw.commentlist.length) {
      const comments = [];
      for (const rawComment of raw.commentlist) {
        comments.push(anonymizeComment({
          id: `${rawComment.uin}_${rawComment.create_time || comments.length}`,
          author: { id: String(rawComment.uin || ''), nickname: String(rawComment.name || '') },
          content: String(rawComment.content || ''),
          createdAt: rawComment.create_time ? new Date(rawComment.create_time * 1000).toISOString() : null,
        }, salt));
        for (const reply of rawComment.list_3 || []) {
          comments.push(anonymizeComment({
            id: `${reply.uin}_${reply.create_time || comments.length}`,
            author: { id: String(reply.uin || ''), nickname: String(reply.name || '') },
            content: String(reply.content || ''),
            createdAt: reply.create_time ? new Date(reply.create_time * 1000).toISOString() : null,
          }, salt));
        }
      }
      if (comments.length !== (doc.historicalInteractions?.comments || []).length) {
        doc.historicalInteractions = {
          ...(doc.historicalInteractions || {}),
          likeCount: doc.historicalInteractions?.likeCount || 0,
          commentCount: Number(raw.cmtnum) || comments.length,
          comments,
        };
        doc.counts = { ...(doc.counts || {}), comments: comments.length };
        dirty = true;
        commentsBackfilled += comments.length;
      }
    }

    // 2b. html/text 重渲染（[em] 表情 + @ 昵称）
    const renderedHtml = renderHtml(doc.text);
    if (renderedHtml !== doc.html) {
      doc.html = renderedHtml;
      doc.summary = String(doc.text || '').replace(/\s+/g, ' ').slice(0, 120);
      dirty = true;
      htmlUpdated += 1;
    }

    // 2c. 失效图片重抓：media/cover 里的 QQ 签名直链（非自有 Blob）用 msglist 新鲜链接重转存
    const needsMediaRefresh = (doc.media || []).some((item) => item.url && !/stbifrostz43zcc/.test(item.url))
      || (doc.cover && !/stbifrostz43zcc/.test(doc.cover));
    if (raw && needsMediaRefresh) {
      const freshPics = (raw.pic || []).map((pic) => String(pic.url3 || pic.url2 || pic.url1 || pic.smallurl || '').replace(/^http:/, 'https:')).filter(Boolean);
      const newMedia = [];
      for (const picUrl of freshPics) {
        try {
          const stored = await storeImage(picUrl, cookies);
          newMedia.push(stored);
        } catch {
          mediaFailed += 1;
        }
        await sleep(400);
      }
      if (newMedia.length) {
        doc.media = newMedia;
        doc.cover = newMedia[0].url;
        doc.html = renderHtml(doc.text) + newMedia.map((item) => `<figure class="moment__figure"><img src="${item.url}" alt="" loading="lazy"></figure>`).join('');
        dirty = true;
        mediaRefreshed += 1;
      }
    }

    // 2d. 转发视频封面回填（B 站 API，本地网络成功率高）
    if (doc.video?.sourceUrl && !doc.video.coverUrl) {
      const bvid = doc.video.sourceUrl.match(/BV[A-Za-z0-9]{8,12}/)?.[0];
      if (bvid) {
        const video = await fetchBilibiliVideo(bvid);
        if (video?.cover) {
          try {
            const stored = await storeImage(video.cover.replace(/^http:/, 'https:'), {});
            doc.video.cover = stored.url;
            doc.video.coverUrl = stored.url;
            doc.cover = stored.url;
            dirty = true;
            coversBackfilled += 1;
          } catch { /* 封面失败不阻塞 */ }
          await sleep(1200);
        }
      }
    }

    if (dirty) {
      doc.updatedAt = new Date().toISOString();
      doc.contentHash = contentHash(doc.text);
      await container.items.upsert(doc, { partitionKey: doc.month });
    }
    await sleep(150);
  }

  console.log(`\nRESULT: 评论回填 ${commentsBackfilled} 条（${resources.filter((d) => (d.historicalInteractions?.comments || []).length).length} 条动态）, html 更新 ${htmlUpdated}, 图片重抓 ${mediaRefreshed}（失败 ${mediaFailed}）, 封面回填 ${coversBackfilled}`);
  console.log('下一步：az containerapp job start --name content-publish --resource-group rg-bifrost-prod');
}

main().catch((error) => {
  console.error('BACKFILL FAILED:', error.message);
  process.exitCode = 1;
});
