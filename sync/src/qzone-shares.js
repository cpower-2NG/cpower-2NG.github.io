// 分享/转发动态抓取层。
//
// 背景：qzone-sdk 0.3.x 的动态模型只保留"有 id+authorId 的说说条目"，且媒体归属
// 校验会丢弃非本人（如 B 站封面）的媒体；QQ 空间的"分享"类动态（B 站视频分享）
// 在 SDK 的解析中被整体丢弃。本模块的做法：
//   1. 注入捕获 fetch，抄录 SDK 调用聚合动态流（getActiveFeeds / get_feeds）的原始响应；
//   2. 对原始 JSON 做结构无关的深度遍历，提取含 B 站视频链接的条目；
//   3. 用 B 站公开接口补全标题/封面/UP 主，组装成与 normalizePost 同构的内容记录。
// 纯函数（extractBilibiliShares 等）与网络函数分离，前者有单测覆盖。
import { QzoneClient } from 'qzone-sdk';
import { storeImage } from './media.js';
import { contentHash, safeRecordId } from './rules.js';

const BILIBILI_URL = /https?:\/\/(?:b23\.tv\/[A-Za-z0-9]+|(?:(?:www|m)\.)?bilibili\.com\/(?:video|festival)\/[A-Za-z0-9_\-./?=&]+)/i;
const BVID = /(BV[A-Za-z0-9]{8,12})/;

/** 分享条目的字段多候选：QQ 协议响应结构随端点/版本变化，不赌单一字段名。 */
const ID_KEYS = ['feedid', 'feedsid', 'id', 'key', 'cellid', 'cell_id'];
const TEXT_KEYS = ['content', 'summary', 'title', 'feedinfo_summary', 'desc'];
const TIME_KEYS = ['createtime', 'create_time', 'pubtime', 'pub_time', 'time', 'timestamp'];

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstOwnString(record, keys) {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const nested = asRecord(value);
      if (nested) {
        const inner = firstOwnString(nested, keys);
        if (inner) return inner;
      }
    }
  }
  // 兄弟子对象的字段（如 feed 项下 common.createtime）。
  for (const value of Object.values(record)) {
    const nested = asRecord(value);
    if (nested) {
      for (const key of keys) {
        if (Object.hasOwn(nested, key)) {
          const inner = nested[key];
          if (typeof inner === 'string' && inner.trim()) return inner.trim();
          if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
        }
      }
    }
  }
  return null;
}

/**
 * 从原始响应文本提取含 B 站链接的分享条目（结构无关）。
 * 返回 [{ shareId, text, createdAt(ISO|null), url, bvid|null, raw }]。
 */
export function extractBilibiliShares(payloadText) {
  const text = String(payloadText || '');
  if (!text) return [];
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    // HTML/JS 响应：退化为文本扫描，至少抽出链接（无可靠上下文，仅在有 JSON 失败时使用）。
    return scanTextOnly(text);
  }
  const found = [];
  const seenIds = new Set();
  walk(root, []);
  return found;

  function walk(node, ancestors) {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, ancestors);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    // 自身属性值（不含嵌套对象）里出现 B 站链接才算命中，避免聚合父节点整棵命中。
    const ownValues = Object.values(record).filter((value) => typeof value === 'string');
    const hit = ownValues.find((value) => BILIBILI_URL.test(value));
    if (hit) {
      // 元数据可能在命中节点的祖先层（如 common.createtime），沿祖先链查找。
      const lookup = (keys) => {
        for (const level of [record, ...ancestors]) {
          const value = firstOwnString(level, keys);
          if (value !== null && value !== undefined && value !== '') return value;
        }
        return null;
      };
      const shareId = lookup(ID_KEYS) ?? `url:${hit}`;
      const key = String(shareId);
      if (!seenIds.has(key)) {
        seenIds.add(key);
        const text = String(lookup(TEXT_KEYS) || '');
        const urlMatch = [hit, ...ownValues].map((value) => value.match(BILIBILI_URL)).find(Boolean);
        const bvidMatch = ownValues.map((value) => value.match(BVID)).find(Boolean);
        found.push({
          shareId: key,
          text,
          createdAt: normalizeTime(lookup(TIME_KEYS)),
          url: urlMatch ? urlMatch[0] : '',
          bvid: bvidMatch ? bvidMatch[1] : null,
          raw: record,
        });
      }
    }
    for (const child of Object.values(record)) {
      if (asRecord(child) || Array.isArray(child)) walk(child, [record, ...ancestors].slice(0, 6));
    }
  }
}

/** JSON 解析失败时的兜底：只抽链接，无法关联元数据的条目用链接自身当 id。 */
function scanTextOnly(text) {
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(new RegExp(BILIBILI_URL.source, 'gi'))) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const bvidMatch = url.match(BVID);
    found.push({
      shareId: `url:${url}`,
      text: '',
      createdAt: null,
      url,
      bvid: bvidMatch ? bvidMatch[1] : null,
      raw: null,
    });
  }
  return found;
}

/** QQ 时间戳是秒或毫秒；ISO 字符串直接透传。 */
function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /[a-z]/i.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const ms = number < 1e12 ? number * 1000 : number;
  return new Date(ms).toISOString();
}

/** b23.tv 短链跟随 302 解析出真实视频地址。 */
export async function resolveBilibiliUrl(url) {
  if (!/b23\.tv/i.test(url)) return url;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 BIFROST-QZone-Sync/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    return response.url || url;
  } catch {
    return url;
  }
}

/** B 站公开接口补全视频元数据（免登录，低频）。 */
export async function fetchBilibiliVideo(bvid, fetchImpl = fetch) {
  if (!bvid) return null;
  try {
    const response = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 BIFROST-QZone-Sync/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();
    if (payload?.code !== 0 || !payload?.data) return null;
    const data = payload.data;
    return {
      bvid: data.bvid || bvid,
      title: String(data.title || '').trim(),
      desc: String(data.desc || '').trim(),
      cover: String(data.pic || '').trim(),
      owner: String(data.owner?.name || '').trim(),
      durationSeconds: Number(data.duration) || 0,
      pubdate: Number(data.pubdate) || 0,
      link: `https://www.bilibili.com/video/${data.bvid || bvid}`,
    };
  } catch {
    return null;
  }
}

/**
 * 把解析出的分享条目组装成内容记录。
 * coverTransfer: 'store'（真实同步：封面转存自有 Blob）| 'raw'（验收预览：先用 B 站原始 URL）。
 */
export async function buildShareRecords(shares, { cookies, coverTransfer }) {
  const records = [];
  for (const share of shares) {
    try {
      let url = share.url;
      if (url && /b23\.tv/i.test(url)) url = await resolveBilibiliUrl(url);
      const bvid = share.bvid || url.match(BVID)?.[1] || url.match(/bvid=([A-Za-z0-9]+)/)?.[1] || null;
      if (!bvid && !url) continue;
      const video = await fetchBilibiliVideo(bvid);
      if (!video && !bvid) continue;

      const sourceUrl = video?.link || `https://www.bilibili.com/video/${bvid}`;
      const embedUrl = bvid ? `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&danmaku=0` : '';
      const title = video?.title || share.text || '分享的视频';
      const reason = share.text ? `${share.text}\n\n` : '';
      const meta = video ? `视频：${title}${video.owner ? `（UP 主：${video.owner}）` : ''}` : `视频：${sourceUrl}`;
      const coverUrl = video?.cover || '';

      let cover = coverUrl;
      const media = [];
      if (coverUrl && coverTransfer === 'store') {
        try {
          const stored = await storeImage(coverUrl, cookies);
          cover = stored.url;
          media.push(stored);
        } catch {
          // 封面转存失败不阻塞记录，保留 B 站原始地址。
        }
      } else if (coverUrl) {
        media.push({ kind: 'image', url: coverUrl, sourceUrl: coverUrl, sourceQuality: 'high', variants: [] });
      }

      const record = {
        id: `qq-share-${safeRecordId(bvid || share.shareId)}`,
        schemaVersion: 1,
        title: `分享 · ${title.slice(0, 60)}`,
        date: (share.createdAt || '').slice(0, 10),
        createdAt: share.createdAt || null,
        phase: 'fantasy',
        type: 'diary',
        section: 'daily',
        tags: ['QQ空间', '自动同步', '分享'],
        category: '分享',
        summary: (share.text || title).replace(/\s+/g, ' ').slice(0, 80),
        text: `${reason}${meta}`,
        media,
        video: {
          platform: '哔哩哔哩',
          sourceUrl,
          embedUrl,
          cover,
          note: '转发视频，内嵌 B 站播放器。',
        },
        cover: cover || '',
        historicalInteractions: {
          likeCount: 0,
          commentCount: 0,
          comments: [],
        },
        source: {
          provider: 'qq',
          id: String(share.shareId),
          authorId: '',
          url: sourceUrl,
          state: 'active',
          visibility: 'unknown',
          adapterVersion: 1,
          warnings: video ? [] : ['BILIBILI_META_MISSING'],
          missingChecks: 0,
        },
        syndication: {
          author: video?.owner || '',
          source: '哔哩哔哩',
        },
      };
      record.contentHash = contentHash({ text: record.text, media: record.media, video: record.video });
      records.push(record);
    } catch {
      // 单条失败不阻塞其余分享。
    }
  }
  return records;
}

/**
 * 创建捕获 fetch：抄录聚合动态流的原始响应供分享解析使用。
 * 其余响应只透传。仅记录 URL 与正文，不记录 Cookie/请求头。
 */
export function createShareCapture() {
  const payloads = [];
  return {
    async fetch(url, options = {}) {
      const response = await fetch(url, options);
      try {
        const target = String(url);
        if (/getActiveFeeds|get_feeds|feeds3_html_more/i.test(target)) {
          const text = await response.clone().text();
          payloads.push({ url: target, text });
        }
      } catch {
        // 捕获失败不影响主流程。
      }
      return response;
    },
    get payloadCount() {
      return payloads.length;
    },
    get payloads() {
      return payloads;
    },
  };
}

/**
 * 便捷入口：用现有会话抓取全部聚合流响应（独立于主同步流程使用）。
 * 主同步流程应使用 createShareCapture 注入既有 client，避免重复请求。
 */
export async function captureSelfFeedPayloads(session, { pages = 3 } = {}) {
  const capture = createShareCapture();
  const client = new QzoneClient({
    session,
    fetch: capture.fetch,
    onSessionChange: async () => {},
  });
  try {
    let cursor = null;
    let page = 0;
    do {
      const result = await client.listFeeds({ scope: 'self', limit: 20, cursor });
      page += 1;
      cursor = result.nextCursor;
      await new Promise((done) => setTimeout(done, 1500));
    } while (cursor && page < pages);
  } finally {
    await client.close().catch(() => undefined);
  }
  return capture.payloads;
}
