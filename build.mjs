#!/usr/bin/env node
// BIFROST 内容构建脚本（零依赖）
// - content-src/**/*.md（带 front-matter）编译为 content/**/*.html 片段
// - content-src/imported/qq/*.json 将规范化 QQ 动态编译为 HTML 片段
// - 汇总 data/entries.json：仪表盘、命令面板、文章页导航共用的内容索引
// - 手写 HTML 长文：在片段内嵌 <script type="application/x-bifrost-meta">{...}</script> 即可入索引
// 用法：node build.mjs（或双击 build.cmd）

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SRC_DIR = join(root, 'content-src');
const CONTENT_DIR = join(root, 'content');
const DATA_FILE = join(root, 'data', 'entries.json');
const CONTENT_MANIFEST_FILE = join(root, 'data', 'content-manifest.json');
const OVERRIDES_FILE = join(root, 'data', 'content-overrides.json');
const META_SCRIPT_TYPE = 'application/x-bifrost-meta';
const PHASES = ['logic', 'fantasy'];
const KINDS = ['standard', 'video', 'pdf', 'note', 'qq-post'];
const DEFAULT_SITE_URL = 'https://cpower-2ng.github.io';
const SECTION_LABELS = {
  daily: '日常',
  activity: '活动',
  review: '评论',
  essay: '随笔',
  tech: '技术笔记',
  project: '工程记录',
  log: '开发日志',
};
const DEFAULT_SYNC_RULES_FILE = join(root, 'data', 'sync-rules.default.json');

// 构建期解析出的站点地址，用于生成片段的 canonical / og:url。
let siteOrigin = DEFAULT_SITE_URL;

// ---------- 通用工具 ----------

async function walk(dir) {
  let entries = [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      entries = entries.concat(await walk(full));
    } else if (dirent.isFile()) {
      entries.push(full);
    }
  }
  return entries;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function safeHttpsUrl(value, allowedHosts = null) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) {
      return '';
    }
    if (allowedHosts && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function safeRootPath(value) {
  const path = String(value || '').trim();
  return path.startsWith('/') && !path.startsWith('//') ? path : '';
}

function safeEmbedUrl(value) {
  return safeHttpsUrl(value, [
    'player.bilibili.com',
    'www.youtube-nocookie.com',
    'www.youtube.com',
    'v.qq.com',
  ]);
}

function stripExt(fileName) {
  return fileName.replace(/\.(md|markdown|html?)$/i, '');
}

// ---------- 本地图片尺寸（零依赖探测，用于预留版面、消除滚动抖动） ----------

const IMAGE_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);
const FRAGMENT_START = '<!--bifrost:fragment:start-->';
const FRAGMENT_END = '<!--bifrost:fragment:end-->';

function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      return null;
    }
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readImageSize(buffer) {
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buffer.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (fourcc === 'VP8L' && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') {
      return {
        width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
      };
    }
    return null;
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegSize(buffer);
  }
  if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  return null;
}

function resolveLocalAsset(ref, baseDir) {
  let decoded = String(ref || '').trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 保留原始字符串
  }
  const clean = decoded.split('#')[0].split('?')[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) {
    return null;
  }
  const absolute = clean.startsWith('/') ? resolve(root, `.${clean}`) : resolve(baseDir, clean);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || rel.includes(':')) {
    return null;
  }
  return IMAGE_EXTENSIONS.has(extname(absolute).toLowerCase()) ? absolute : null;
}

async function localImageSize(ref, baseDir) {
  const filePath = resolveLocalAsset(ref, baseDir);
  if (!filePath) {
    return null;
  }
  try {
    return readImageSize(await readFile(filePath));
  } catch {
    return null;
  }
}

// 为正文里指向本地文件的 <img> 补上宽高，让浏览器提前预留位置。
async function applyLocalImageSizes(html, baseDir) {
  const tags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  let result = html;
  for (const tag of tags) {
    if (/\bwidth=/i.test(tag) && /\bheight=/i.test(tag)) {
      continue;
    }
    const src = tag.match(/\bsrc="([^"]*)"/i)?.[1];
    if (!src) {
      continue;
    }
    const size = await localImageSize(src, baseDir);
    if (!size) {
      continue;
    }
    const patched = `${tag
      .replace(/\s*\/?>$/, '')
      .replace(/\s+width="[^"]*"/i, '')
      .replace(/\s+height="[^"]*"/i, '')} width="${size.width}" height="${size.height}" decoding="async">`;
    result = result.replace(tag, patched);
  }
  return result;
}

// ---------- 独立片段文档 ----------
//
// content/** 下的 HTML 同时承担两种角色：
// 1) SPA 用 fetch 读取的正文片段；
// 2) 直接访问 /content/... 时的落地页。
// 因此每个文件都是带 <head> 的完整文档：head 提供标题与分享元信息，
// 并带一段“非嵌入访问就跳回 SPA”的引导脚本。SPA 注入正文前会剥掉
// head 元素与脚本，所以两条路径互不影响。

function unwrapFragment(html) {
  const start = html.indexOf(FRAGMENT_START);
  const end = html.indexOf(FRAGMENT_END);
  if (start === -1 || end === -1 || end < start) {
    return html;
  }
  return html.slice(start + FRAGMENT_START.length, end).trim();
}

function renderFragmentDocument({ body, title, description, url, phase, cover = '' }) {
  const safePhase = PHASES.includes(phase) ? phase : 'fantasy';
  const ogImage = cover
    ? `\n<meta property="og:image" content="${escapeAttribute(cover)}">`
    : '';
  const twitterCard = cover ? 'summary_large_image' : 'summary';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-phase="${safePhase}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} · BIFROST</title>
<meta name="description" content="${escapeAttribute(description)}">
<link rel="canonical" href="${escapeAttribute(url)}">
<meta property="og:site_name" content="BIFROST">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeAttribute(title)}">
<meta property="og:description" content="${escapeAttribute(description)}">
<meta property="og:url" content="${escapeAttribute(url)}">${ogImage}
<meta name="twitter:card" content="${twitterCard}">
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') {
    return;
  }
  params.delete('embed');
  var extra = params.toString();
  var target = '/?phase=${safePhase}&path=' + encodeURIComponent(window.location.pathname)
    + (extra ? '&' + extra : '')
    + window.location.hash;
  window.location.replace(target);
})();
</script>
</head>
<body>
${FRAGMENT_START}
${body.trim()}
${FRAGMENT_END}
</body>
</html>
`;
}

function todayStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------- front-matter 解析（支持内联数组与块列表） ----------

function splitFrontMatter(source) {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return { meta: {}, body: text };
  }

  const closing = text.slice(4).match(/^[\s\S]*?\n---[ \t]*\n/);
  if (!closing) {
    return { meta: {}, body: text };
  }

  const block = closing[0].replace(/\n---[ \t]*\n$/, '').replace(/^---\n/, '');
  return { meta: parseMetaBlock(block), body: text.slice(4 + closing[0].length - 1) };
}

function parseMetaBlock(block) {
  const meta = {};
  let listKey = null;

  for (const raw of block.split('\n')) {
    const listItem = raw.match(/^\s+-\s+(.+)$/);
    if (listItem && listKey) {
      if (!Array.isArray(meta[listKey])) {
        meta[listKey] = [];
      }
      meta[listKey].push(parseScalar(listItem[1]));
      continue;
    }

    const kv = raw.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (!kv) {
      continue;
    }

    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = parseScalar(value);
      listKey = null;
    }
  }

  return meta;
}

function parseScalar(value) {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (/^\[.*\]$/.test(trimmed)) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

// ---------- Markdown 渲染（常用子集） ----------

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      const lang = fence[1] ? ` class="language-${fence[1]}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(buffer.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const buffer = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${buffer.map(renderInline).join('<br>')}</p></blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph();
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(header, rows));
      continue;
    }

    if (/^(\s*)([-*]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph();
  return out.join('\n');
}

function normalizeVideoMeta(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const sourceUrl = safeHttpsUrl(value.sourceUrl || value.url);
  const embedUrl = safeEmbedUrl(value.embedUrl);
  const rawCover = String(value.cover || '').trim();
  const cover = safeHttpsUrl(rawCover)
    || (rawCover.startsWith('/') && !rawCover.startsWith('//') ? rawCover : '');
  // A cover alone is not a video. Some imported articles have a cover image
  // but no video metadata; those should stay ordinary articles.
  if (!sourceUrl && !embedUrl) {
    return null;
  }

  return {
    platform: String(value.platform || '').trim(),
    title: String(value.title || '').trim(),
    author: String(value.author || '').trim(),
    embedUrl,
    sourceUrl,
    cover,
    note: String(value.note || '').trim(),
  };
}

export function renderVideoCard(video) {
  const normalized = normalizeVideoMeta(video);
  if (!normalized) {
    return '';
  }

  const cover = normalized.cover
    ? `<img class="video-card__cover" src="${escapeAttribute(normalized.cover)}" alt="" loading="lazy">`
    : '<span class="video-card__placeholder" aria-hidden="true">▶</span>';
  const playable = normalized.embedUrl
    ? `<button class="video-card__play" type="button" data-video-embed="${escapeAttribute(normalized.embedUrl)}">点击播放</button>`
    : '';
  const source = normalized.sourceUrl
    ? `<a class="video-card__source" href="${escapeAttribute(normalized.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原视频</a>`
    : '';
  const meta = [normalized.platform, normalized.author].filter(Boolean).join(' · ');

  return `<figure class="video-card">
  <div class="video-card__media">${cover}${playable}</div>
  <figcaption>
    ${normalized.title ? `<strong>${escapeHtml(normalized.title)}</strong>` : ''}
    ${meta ? `<span>${escapeHtml(meta)}</span>` : ''}
    ${normalized.note ? `<p>${escapeHtml(normalized.note)}</p>` : ''}
    ${source}
  </figcaption>
</figure>`;
}

function renderResponsiveImage(item, { className = '', alt = '' } = {}) {
  const candidates = [];
  for (const variant of item.variants || []) {
    candidates.push(`${variant.url} ${variant.width}w`);
  }
  if (item.width) {
    candidates.push(`${item.url} ${item.width}w`);
  }
  const srcset = candidates.length > 1 ? ` srcset="${escapeAttribute(candidates.join(', '))}" sizes="(max-width: 760px) 100vw, 900px"` : '';
  return `<img${className ? ` class="${escapeAttribute(className)}"` : ''} src="${escapeAttribute(item.url)}" alt="${escapeAttribute(alt || item.alt || '')}" loading="lazy" decoding="async"${srcset}${item.width ? ` width="${item.width}"` : ''}${item.height ? ` height="${item.height}"` : ''}>`;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeMediaItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const url = safeHttpsUrl(item.url || item.src);
  if (!url) {
    return null;
  }
  return {
    kind: item.kind === 'video' ? 'video' : 'image',
    url,
    width: Number(item.width) || undefined,
    height: Number(item.height) || undefined,
    alt: String(item.alt || item.name || '').trim(),
    sourceUrl: safeHttpsUrl(item.sourceUrl),
    sourceQuality: ['original', 'high', 'low'].includes(item.sourceQuality) ? item.sourceQuality : 'unknown',
    variants: Array.isArray(item.variants)
      ? item.variants
          .map((variant) => ({
            url: safeHttpsUrl(variant?.url),
            width: Number(variant?.width) || undefined,
            format: String(variant?.format || '').trim(),
          }))
          .filter((variant) => variant.url && variant.width)
      : [],
  };
}

function entryMediaMeta(source, video) {
  const normalizedVideo = normalizeVideoMeta(video);
  const media = Array.isArray(source?.media) ? source.media.map(normalizeMediaItem).filter(Boolean) : [];
  return {
    cover: safeHttpsUrl(source?.cover) || normalizedVideo?.cover || '',
    media,
    video: normalizedVideo,
  };
}

function isTableStart(lines, index) {
  const line = lines[index];
  const next = lines[index + 1] || '';
  if (!line.includes('|')) {
    return false;
  }
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(next) && next.includes('-');
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderTable(header, rows) {
  const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function parseList(lines, start) {
  const first = lines[start].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length && lines[i].trim()) {
    const m = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
    if (!m || m[1].length < baseIndent || m[1].length >= baseIndent + 2) {
      break;
    }
    items.push({ text: m[3], children: [] });
    i += 1;

    while (i < lines.length && lines[i].trim()) {
      const nested = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
      if (!nested || nested[1].length < baseIndent + 2) {
        break;
      }
      items[items.length - 1].children.push(nested[3]);
      i += 1;
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const html = `<${tag}>${items
    .map((item) => {
      const nested = item.children.length
        ? `<${tag}>${item.children.map((child) => `<li>${renderInline(child)}</li>`).join('')}</${tag}>`
        : '';
      return `<li>${renderInline(item.text)}${nested}</li>`;
    })
    .join('')}</${tag}>`;

  return { html, next: i };
}

function renderInline(text) {
  let out = escapeHtml(text);
  const codes = [];

  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);

  return out;
}

// ---------- 字数与摘要 ----------

function countWords(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

function htmlToText(html) {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readingMinutes(words) {
  return Math.max(1, Math.round(words / 400));
}

function deriveSummary(body) {
  const firstParagraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith('#') && !block.startsWith('```') && !block.startsWith('>'));
  if (!firstParagraph) {
    return '';
  }
  const plain = firstParagraph
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}

// ---------- md 条目 ----------

function dateFromName(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

function renderPublicationCard(publication) {
  if (!publication?.readerUrl) {
    return '';
  }
  const cover = publication.cover
    ? `<img class="publication-card__cover" src="${escapeAttribute(publication.cover)}" alt="" loading="lazy">`
    : '';
  const download = publication.pdfUrl
    ? `<a class="button" href="${escapeAttribute(publication.pdfUrl)}" target="_blank" rel="noopener">下载原 PDF</a>`
    : '';
  const pageCount = Number(publication.pageCount) > 0
    ? `<span class="publication-card__count">${Number(publication.pageCount)} 页</span>`
    : '';
  return `<figure class="publication-card">
  ${cover}
  <figcaption>
    <p class="hero__eyebrow">PDF PUBLICATION</p>
    <div class="publication-card__title-row">
      <strong>${escapeHtml(publication.title || '出版物阅读')}</strong>
      ${pageCount}
    </div>
    <p>${escapeHtml(publication.description || '保留原始对页排版，提供横向翻页阅读。')}</p>
    <div class="article-actions">
      <button class="button button--primary" type="button" data-publication-reader data-publication-url="${escapeAttribute(publication.readerUrl)}" data-publication-title="${escapeAttribute(publication.title || '')}">开始横向阅读</button>
      ${download}
    </div>
  </figcaption>
</figure>`;
}

// 把出版物的每一页作为普通正文图排进文章，读者可以直接滚动阅读，
// 也可以点开图片放大；横向阅读器与 PDF 下载保留为额外的进阶入口。
function resolvePublicationReader(readerUrl) {
  const clean = String(readerUrl || '').trim();
  if (!clean.startsWith('/') || clean.startsWith('//')) {
    return '';
  }
  const absolute = resolve(root, `.${clean}`);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || rel.includes(':')) {
    return '';
  }
  return extname(absolute).toLowerCase() === '.json' ? absolute : '';
}

function renderPublicationPages(publication, readerData) {
  const pages = Array.isArray(readerData?.pages) ? readerData.pages : [];
  if (!pages.length) {
    return '';
  }
  const title = publication?.title ? `${publication.title} ` : '';
  const items = pages
    .map((page) => {
      const number = Number(page.number) || 0;
      const size = `${page.width ? ` width="${Number(page.width)}"` : ''}${page.height ? ` height="${Number(page.height)}"` : ''}`;
      return `  <figure class="publication-pages__item">
    <img src="${escapeAttribute(page.src)}" alt="${escapeAttribute(`${title}第 ${number} 页`)}" loading="lazy" decoding="async"${size}>
    <figcaption>第 ${number} 页</figcaption>
  </figure>`;
    })
    .join('\n');
  return `<div class="publication-pages">\n${items}\n</div>`;
}

function sectionFor(phase, type, kind, tags, title, explicit = '') {
  if (explicit && SECTION_LABELS[explicit]) return explicit;
  if (kind === 'note' || kind === 'qq-post') return 'daily';
  if (tags.includes('活动记录')) return 'activity';
  if (phase === 'logic') {
    if (tags.some((tag) => /算法|技术|ROS|编程/.test(tag))) return 'tech';
    if (tags.some((tag) => /工程|项目/.test(tag))) return 'project';
    return 'log';
  }
  if (kind === 'pdf' || tags.includes('诗歌') || /短歌/.test(title)) return 'essay';
  return type === 'diary' ? 'essay' : 'review';
}

function layoutFor(kind, section) {
  if (kind === 'pdf') return 'publication';
  if (kind === 'note' || kind === 'qq-post') return 'note';
  if (section === 'activity') return 'event';
  return 'longform';
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadOverrides() {
  const payload = await readJsonFile(OVERRIDES_FILE, {});
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  return payload.overrides && typeof payload.overrides === 'object' ? payload.overrides : payload;
}

function applyOverride(entry, overrides) {
  const keys = [
    `id:${entry.source?.id || ''}`,
    `source:${entry.source?.provider || ''}`,
    `path:${entry.path || ''}`,
  ].filter((key) => !key.endsWith(':'));

  const override = keys.map((key) => overrides[key]).find(Boolean);
  if (!override || typeof override !== 'object') {
    return entry;
  }

  return {
    ...entry,
    ...(override.phase && PHASES.includes(override.phase) ? { phase: override.phase } : {}),
    ...(override.type === 'diary' || override.type === 'article' ? { type: override.type } : {}),
    ...(override.section && SECTION_LABELS[override.section] ? { section: override.section } : {}),
    ...(override.label ? { label: String(override.label) } : {}),
    ...(override.tags ? { tags: normalizeTags(override.tags) } : {}),
    ...(override.summary ? { summary: String(override.summary) } : {}),
    ...(typeof override.featured === 'boolean' ? { featured: override.featured } : {}),
    overrides: {
      ...(entry.overrides || {}),
      ...override,
    },
  };
}

async function collectMarkdownEntries(errors, generatedPaths, overrides) {
  const entries = [];
  const files = await walk(SRC_DIR);

  for (const filePath of files.filter((file) => /\.(md|markdown)$/i.test(file))) {
    const source = await readFile(filePath, 'utf8');
    const { meta, body } = splitFrontMatter(source);

    const relParts = relative(SRC_DIR, filePath).split(sep);
    const dirPhase = relParts[0];
    const phase = meta.phase || dirPhase;
    if (!PHASES.includes(phase)) {
      errors.push(`${relative(root, filePath)}：phase 无效（${phase || '空'}），需为 logic / fantasy。`);
      continue;
    }

    let type = meta.type === 'diary' ? 'diary' : 'article';
    if (relParts[1] === 'diary') {
      type = 'diary';
    } else if (relParts[1] === 'article') {
      type = 'article';
    }

    let title = meta.title || '';
    let markdownBody = body;
    if (!title) {
      const h1 = markdownBody.match(/^#\s+(.+)$/m);
      if (h1) {
        title = h1[1].trim();
        markdownBody = markdownBody.replace(/^#\s+.+\n?/, '');
      }
    }
    if (!title) {
      title = stripExt(basename(filePath));
    }

    const date = meta.date || dateFromName(basename(filePath)) || todayStamp();
    const video = (meta.video_embed || meta.video_url)
      ? normalizeVideoMeta({
          platform: meta.video_platform,
          title: meta.video_title || title,
          author: meta.video_author,
          embedUrl: meta.video_embed,
          sourceUrl: meta.video_url,
          cover: meta.cover,
          note: meta.video_note,
        })
      : null;
    const kind = video
      ? 'video'
      : meta.kind === 'pdf'
        ? 'pdf'
        : meta.kind === 'note'
          ? 'note'
        : meta.kind === 'qq-post'
          ? 'qq-post'
          : 'standard';
    const publication = kind === 'pdf'
      ? {
          title: String(title),
          description: meta.summary ? String(meta.summary) : '',
          cover: safeRootPath(meta.cover) || safeHttpsUrl(meta.cover),
          readerUrl: safeRootPath(meta.pdf_reader) || safeHttpsUrl(meta.pdf_reader),
          pdfUrl: safeHttpsUrl(meta.pdf_url),
          pageCount: Number(meta.pdf_page_count) || 0,
        }
      : null;
    const section = sectionFor(
      phase,
      type,
      kind,
      normalizeTags(meta.tags),
      String(title),
      meta.section,
    );
    const publicationPages = publication
      ? renderPublicationPages(publication, await readJsonFile(resolvePublicationReader(publication.readerUrl)))
      : '';
    const html = [
      renderMarkdown(markdownBody),
      video ? renderVideoCard(video) : '',
      publicationPages,
      publication ? renderPublicationCard(publication) : '',
    ].filter(Boolean).join('\n');
    const sizedHtml = await applyLocalImageSizes(html, dirname(filePath));
    const words = countWords(htmlToText(sizedHtml));

    const outputName = `${stripExt(basename(filePath))}.html`;
    const outputDir = join(CONTENT_DIR, phase, type);
    const outputPath = join(outputDir, outputName);

    await mkdir(outputDir, { recursive: true });
    const articleBody = `<article class="article-surface">\n${sizedHtml.trimEnd()}\n</article>`;
    const wrapped = renderFragmentDocument({
      body: articleBody,
      title: String(title),
      description: meta.summary ? String(meta.summary) : deriveSummary(markdownBody),
      url: pageUrl(`/${relative(root, outputPath).split(sep).join('/')}`),
      phase,
      cover: absoluteAsset(meta.cover),
    });
    await writeFile(outputPath, wrapped, 'utf8');
    generatedPaths.add(outputPath);

    const rawEntry = {
      path: `/${relative(root, outputPath).split(sep).join('/')}`,
      label: String(title),
      date,
      phase,
      type,
      kind,
      section,
      sectionLabel: SECTION_LABELS[section],
      layout: layoutFor(kind, section),
      category: SECTION_LABELS[section],
      tags: normalizeTags(meta.tags),
      summary: meta.summary ? String(meta.summary) : deriveSummary(markdownBody),
      featured: Boolean(meta.featured),
      words,
      minutes: readingMinutes(words),
      sourceFile: relative(root, filePath).split(sep).join('/'),
      source: {
        provider: meta.source_provider || 'local',
        id: meta.source_id || '',
        url: safeHttpsUrl(meta.source_url),
        state: meta.source_state === 'deleted' ? 'deleted' : 'active',
      },
      sourceState: meta.source_state === 'deleted' ? 'deleted' : 'active',
      cover: safeHttpsUrl(meta.cover) || safeRootPath(meta.cover) || video?.cover || '',
      media: [],
      video,
      publication,
      syndication: meta.syndication_author
        ? {
            author: String(meta.syndication_author),
            url: safeHttpsUrl(meta.syndication_url),
          }
        : null,
    };
    entries.push(applyOverride(rawEntry, overrides));

    console.log(`[md] ${relative(root, filePath)} -> ${relative(root, outputPath)} (${words} 字)`);
  }

  return entries;
}

// ---------- 手写 HTML 片段条目 ----------

async function collectHtmlEntries(errors, generatedPaths) {
  const entries = [];
  const files = (await walk(CONTENT_DIR))
    .filter((file) => /\.html?$/i.test(file) && !file.includes(`${sep}dashboards${sep}`))
    .filter((file) => !generatedPaths.has(file));

  for (const filePath of files) {
    const rawFile = await readFile(filePath, 'utf8');
    const html = unwrapFragment(rawFile);
    const path = `/${relative(root, filePath).split(sep).join('/')}`;
    const phase = path.startsWith('/content/fantasy/') ? 'fantasy' : 'logic';

    let meta = {};
    const metaMatch = html.match(new RegExp(`<script type="${META_SCRIPT_TYPE}">([\\s\\S]*?)</script>`));
    if (metaMatch) {
      try {
        meta = JSON.parse(metaMatch[1]);
      } catch {
        errors.push(`${relative(root, filePath)}：meta 块不是合法 JSON，已忽略。`);
        meta = {};
      }
    }

    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const fallbackTitle = h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : stripExt(basename(filePath));
    const text = htmlToText(html);
    const words = typeof meta.words === 'number' ? meta.words : countWords(text);
    const type = meta.type === 'diary' ? 'diary' : 'article';
    const kind = KINDS.includes(meta.kind) ? meta.kind : 'standard';
    const section = sectionFor(
      phase,
      type,
      kind,
      normalizeTags(meta.tags),
      String(meta.title || fallbackTitle),
      meta.section,
    );

    const title = String(meta.title || fallbackTitle);
    const description = meta.summary ? String(meta.summary) : '';
    const sizedHtml = await applyLocalImageSizes(html, dirname(filePath));

    await writeFile(
      filePath,
      renderFragmentDocument({
        body: sizedHtml.trim(),
        title,
        description,
        url: pageUrl(path),
        phase,
        cover: absoluteAsset(meta.cover),
      }),
      'utf8',
    );

    entries.push({
      path,
      label: title,
      date: meta.date ? String(meta.date) : '',
      phase,
      type,
      kind,
      section,
      sectionLabel: SECTION_LABELS[section],
      layout: layoutFor(kind, section),
      category: SECTION_LABELS[section],
      tags: normalizeTags(meta.tags),
      summary: description,
      featured: Boolean(meta.featured),
      words,
      minutes: readingMinutes(words),
      sourceFile: null,
      source: meta.source
        ? {
            provider: meta.source.provider || 'local',
            id: meta.source.id || '',
            url: safeHttpsUrl(meta.source.url),
            state: meta.source.state === 'deleted' ? 'deleted' : 'active',
          }
        : {
            provider: 'local',
            id: '',
            url: '',
            state: 'active',
          },
      sourceState: meta.source?.state === 'deleted' ? 'deleted' : 'active',
      cover: safeHttpsUrl(meta.cover) || safeRootPath(meta.cover),
      media: [],
      video: (meta.video?.embedUrl || meta.video?.sourceUrl)
        ? normalizeVideoMeta(meta.video)
        : null,
      publication: meta.publication || null,
      syndication: meta.syndication || null,
    });

    console.log(`[html] ${relative(root, filePath)}${metaMatch ? '' : '（无 meta 块，仅从标题推断）'}`);
  }

  return entries;
}

// ---------- QQ 云端同步产物 ----------

export function renderStructuredPost(record) {
  const text = String(record.text || '').trim();
  const media = Array.isArray(record.media) ? record.media.map(normalizeMediaItem).filter(Boolean) : [];
  const video = normalizeVideoMeta(record.video);
  const paragraphs = text
    ? text
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
        .join('\n')
    : '';
  const images = media
    .filter((item) => item.kind === 'image')
    .map((item) => {
      const sourceLink = item.sourceQuality === 'low'
        ? '<span class="media-quality">源图分辨率有限</span>'
        : '';
      return `<figure class="qq-media">
  ${renderResponsiveImage(item, { alt: item.alt || 'QQ 说说配图' })}
  ${sourceLink}
</figure>`;
    })
    .join('\n');
  const history = record.historicalInteractions || {};
  const comments = Array.isArray(history.comments) ? history.comments : [];
  const historyBlock = comments.length || Number(history.likeCount)
    ? `<details class="history-comments">
  <summary>QQ 历史回声 · ${comments.length} 条评论 / ${Number(history.likeCount) || 0} 个赞</summary>
  <div class="history-comments__body">
    ${comments
      .map(
        (comment) => `<article class="history-comment">
      <header>${escapeHtml(comment.authorLabel || '匿名访客')} · ${escapeHtml(formatDisplayDate(comment.createdAt))}</header>
      <p>${escapeHtml(comment.text || '').replaceAll('\n', '<br>')}</p>
    </article>`,
      )
      .join('\n')}
    ${Number(history.likeCount) ? `<p class="history-comments__likes">历史点赞 ${Number(history.likeCount)} 个，详细名单已匿名化。</p>` : ''}
  </div>
</details>`
    : '';
  const sourceUrl = safeHttpsUrl(record.source?.url);
  const sourceBlock = record.source?.state === 'deleted' || sourceUrl
    ? `<footer class="source-note">
  ${record.source?.state === 'deleted' ? '<span>原来源已删除，本页保留归档版本。</span>' : ''}
  ${sourceUrl ? `<a href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看 QQ 原帖</a>` : ''}
</footer>`
    : '';

  return `<article class="article-surface qq-post">
${paragraphs}
${images}
${video ? renderVideoCard(video) : ''}
${historyBlock}
${sourceBlock}
</article>`;
}

function formatDisplayDate(value) {
  if (!value) {
    return '时间未知';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}

async function collectQqEntries(errors, generatedPaths, overrides) {
  const entries = [];
  const qqDir = join(SRC_DIR, 'imported', 'qq');
  const files = (await walk(qqDir)).filter((file) => extname(file).toLowerCase() === '.json');

  for (const filePath of files) {
    const record = await readJsonFile(filePath);
    if (!record || typeof record !== 'object') {
      errors.push(`${relative(root, filePath)}：QQ 同步 JSON 不合法，已跳过。`);
      continue;
    }
    if (record.schemaVersion !== 1) {
      errors.push(`${relative(root, filePath)}：不支持的 QQ schemaVersion（${record.schemaVersion ?? '空'}）。`);
      continue;
    }
    if (record.publishStatus && record.publishStatus !== 'published') {
      continue;
    }

    const id = String(record.id || '').trim();
    if (!id) {
      errors.push(`${relative(root, filePath)}：QQ 条目缺少稳定 id。`);
      continue;
    }
    const sourceId = String(record.source?.id || id.replace(/^qq-/, '')).trim();

    const phase = PHASES.includes(record.phase) ? record.phase : 'fantasy';
    const type = record.type === 'article' ? 'article' : 'diary';
    const sourceState = record.source?.state === 'deleted' ? 'deleted' : 'active';
    const outputName = `${id.replace(/[^A-Za-z0-9._-]/g, '-')}.html`;
    const outputDir = join(CONTENT_DIR, phase, type);
    const outputPath = join(outputDir, outputName);
    const generatedHtml = renderStructuredPost(record);
    const sizedHtml = await applyLocalImageSizes(generatedHtml, dirname(filePath));

    await mkdir(outputDir, { recursive: true });
    const outputPublicPath = `/${relative(root, outputPath).split(sep).join('/')}`;
    const coverAsset = absoluteAsset(record.cover)
      || absoluteAsset(normalizeMediaItem(record.video)?.cover)
      || absoluteAsset(
        (Array.isArray(record.media) ? record.media.map(normalizeMediaItem).filter(Boolean) : [])
          .find((item) => item.kind === 'image')?.url,
      );
    const wrapped = renderFragmentDocument({
      body: sizedHtml.trimEnd(),
      title: String(record.title || `QQ 说说 · ${record.date || id}`),
      description: String(record.summary || deriveSummary(record.text || '')),
      url: pageUrl(outputPublicPath),
      phase,
      cover: coverAsset,
    });
    await writeFile(outputPath, wrapped, 'utf8');
    generatedPaths.add(outputPath);

    const media = Array.isArray(record.media) ? record.media.map(normalizeMediaItem).filter(Boolean) : [];
    const video = normalizeVideoMeta(record.video);
    const words = countWords(htmlToText(generatedHtml));
    const date = String(record.date || record.createdAt?.slice(0, 10) || '');
    const kind = video ? 'video' : 'note';
    const section = record.section && SECTION_LABELS[record.section]
      ? record.section
      : sectionFor(phase, type, kind, normalizeTags(record.tags || []), String(record.title || ''), 'daily');
    const rawEntry = {
      path: `/${relative(root, outputPath).split(sep).join('/')}`,
      label: String(record.title || `QQ 说说 · ${date || id}`),
      date,
      phase,
      type,
      kind,
      section,
      sectionLabel: SECTION_LABELS[section],
      layout: layoutFor(kind, section),
      category: SECTION_LABELS[section],
      tags: normalizeTags(record.tags || ['QQ空间', '自动同步']),
      summary: String(record.summary || deriveSummary(record.text || '')),
      featured: Boolean(record.featured),
      words,
      minutes: readingMinutes(words),
      sourceFile: relative(root, filePath).split(sep).join('/'),
      source: {
        provider: 'qq',
        id: sourceId,
        url: safeHttpsUrl(record.source?.url),
        state: sourceState,
        visibility: String(record.source?.visibility || 'unknown'),
        adapterVersion: Number(record.source?.adapterVersion) || 1,
      },
      sourceState,
      cover: safeHttpsUrl(record.cover) || video?.cover || media.find((item) => item.kind === 'image')?.url || '',
      media,
      video,
      syndication: record.syndication || null,
      historicalInteractions: {
        commentCount: Array.isArray(record.historicalInteractions?.comments)
          ? record.historicalInteractions.comments.length
          : 0,
        likeCount: Number(record.historicalInteractions?.likeCount) || 0,
      },
    };
    entries.push(applyOverride(rawEntry, overrides));
    console.log(`[qq] ${relative(root, filePath)} -> ${relative(root, outputPath)} (${sourceState})`);
  }

  return entries;
}

// ---------- 订阅与站点地图 ----------

const SITE_CONFIG_FILE = join(root, 'data', 'site.json');
const FEED_LIMIT = 40;

async function readSiteConfig() {
  try {
    return JSON.parse(await readFile(SITE_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function absoluteUrl(siteUrl, path) {
  const base = siteUrl.replace(/\/+$/, '');
  return path === '/' ? `${base}/` : `${base}${path}`;
}

function pageUrl(path) {
  return absoluteUrl(siteOrigin, path);
}

// 封面可能是 https 外链或站点根路径，统一转成可分享的绝对地址。
function absoluteAsset(ref) {
  const https = safeHttpsUrl(ref);
  if (https) {
    return https;
  }
  const rootPath = safeRootPath(ref);
  return rootPath ? pageUrl(rootPath) : '';
}

function rfc822(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toUTCString();
}

function buildFeed(siteUrl, entries) {
  const items = entries.slice(0, FEED_LIMIT).map((entry) => {
    const url = absoluteUrl(siteUrl, entry.path);
    const pubDate = rfc822(entry.date);
    return [
      '    <item>',
      `      <title>${escapeHtml(entry.label)}</title>`,
      `      <link>${escapeHtml(url)}</link>`,
      `      <guid isPermaLink="true">${escapeHtml(url)}</guid>`,
      pubDate ? `      <pubDate>${pubDate}</pubDate>` : '',
      `      <category>${escapeHtml(entry.phase)}</category>`,
      ...(entry.tags || []).map((tag) => `      <category>${escapeHtml(tag)}</category>`),
      entry.summary ? `      <description>${escapeHtml(entry.summary)}</description>` : '',
      '    </item>',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>BIFROST</title>
    <link>${escapeHtml(absoluteUrl(siteUrl, '/'))}</link>
    <description>Logic 与 Fantasy 双相位的个人知识界面：技术笔记、翻译随笔与项目沉淀。</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeHtml(absoluteUrl(siteUrl, '/feed.xml'))}" rel="self" type="application/rss+xml" />
${items.join('\n')}
  </channel>
</rss>
`;
}

function buildSitemap(siteUrl, entries) {
  const urls = [
    { loc: absoluteUrl(siteUrl, '/'), lastmod: entries[0] ? entries[0].date : '' },
    ...entries.map((entry) => ({ loc: absoluteUrl(siteUrl, entry.path), lastmod: entry.date })),
  ];

  const body = urls
    .map((item) =>
      [
        '  <url>',
        `    <loc>${escapeHtml(item.loc)}</loc>`,
        item.lastmod ? `    <lastmod>${escapeHtml(item.lastmod)}</lastmod>` : '',
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

function buildContentManifest(entries) {
  return {
    schemaVersion: 1,
    generated: new Date().toISOString(),
    paths: entries.map((entry) => entry.path),
  };
}

// ---------- 主流程 ----------

async function main() {
  const errors = [];
  const generatedPaths = new Set();
  const overrides = await loadOverrides();
  const siteConfig = await readSiteConfig();
  siteOrigin = String(siteConfig.siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
  const markdownEntries = await collectMarkdownEntries(errors, generatedPaths, overrides);
  const qqEntries = await collectQqEntries(errors, generatedPaths, overrides);
  const htmlEntries = await collectHtmlEntries(errors, generatedPaths);

  const entries = [...markdownEntries, ...qqEntries, ...htmlEntries].sort((a, b) => {
    if (a.date !== b.date) {
      return (b.date || '').localeCompare(a.date || '');
    }
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  });

  await mkdir(join(root, 'data'), { recursive: true });
  const payload = {
    generated: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  await writeFile(DATA_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(
    CONTENT_MANIFEST_FILE,
    `${JSON.stringify(buildContentManifest(entries), null, 2)}\n`,
    'utf8',
  );

  const siteUrl = siteConfig.siteUrl || DEFAULT_SITE_URL;
  await writeFile(join(root, 'feed.xml'), buildFeed(siteUrl, entries), 'utf8');
  await writeFile(join(root, 'sitemap.xml'), buildSitemap(siteUrl, entries), 'utf8');

  console.log(
    `\nentries.json：共 ${entries.length} 条（md ${markdownEntries.length} / qq ${qqEntries.length} / html ${htmlEntries.length}）`,
  );
  console.log(`feed.xml / sitemap.xml：站点地址 ${siteUrl}`);
  for (const error of errors) {
    console.warn(`[warn] ${error}`);
  }
  if (errors.length) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
