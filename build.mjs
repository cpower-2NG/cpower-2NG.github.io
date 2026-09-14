#!/usr/bin/env node
// BIFROST 内容构建脚本（零依赖）
// - content-src/**/*.md（带 front-matter）编译为 content/**/*.html 片段
// - 汇总 data/entries.json：仪表盘、命令面板、文章页导航共用的内容索引
// - 手写 HTML 长文：在片段内嵌 <script type="application/x-bifrost-meta">{...}</script> 即可入索引
// 用法：node build.mjs（或双击 build.cmd）

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SRC_DIR = join(root, 'content-src');
const CONTENT_DIR = join(root, 'content');
const DATA_FILE = join(root, 'data', 'entries.json');
const META_SCRIPT_TYPE = 'application/x-bifrost-meta';
const PHASES = ['logic', 'fantasy'];

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

function stripExt(fileName) {
  return fileName.replace(/\.(md|markdown|html?)$/i, '');
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

async function collectMarkdownEntries(errors, generatedPaths) {
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
    const html = renderMarkdown(markdownBody);
    const words = countWords(htmlToText(html));

    const outputName = `${stripExt(basename(filePath))}.html`;
    const outputDir = join(CONTENT_DIR, phase, type);
    const outputPath = join(outputDir, outputName);

    await mkdir(outputDir, { recursive: true });
    const wrapped = `<article class="article-surface">\n${html.trimEnd()}\n</article>\n`;
    await writeFile(outputPath, wrapped, 'utf8');
    generatedPaths.add(outputPath);

    entries.push({
      path: `/${relative(root, outputPath).split(sep).join('/')}`,
      label: String(title),
      date,
      phase,
      type,
      tags: normalizeTags(meta.tags),
      summary: meta.summary ? String(meta.summary) : deriveSummary(markdownBody),
      featured: Boolean(meta.featured),
      words,
      minutes: readingMinutes(words),
      source: relative(root, filePath).split(sep).join('/'),
    });

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
    const html = await readFile(filePath, 'utf8');
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

    entries.push({
      path,
      label: String(meta.title || fallbackTitle),
      date: meta.date ? String(meta.date) : '',
      phase,
      type: meta.type === 'diary' ? 'diary' : 'article',
      tags: normalizeTags(meta.tags),
      summary: meta.summary ? String(meta.summary) : '',
      featured: Boolean(meta.featured),
      words,
      minutes: readingMinutes(words),
      source: null,
    });

    console.log(`[html] ${relative(root, filePath)}${metaMatch ? '' : '（无 meta 块，仅从标题推断）'}`);
  }

  return entries;
}

// ---------- 订阅与站点地图 ----------

const SITE_CONFIG_FILE = join(root, 'data', 'site.json');
const DEFAULT_SITE_URL = 'https://cpower-2NG.github.io';
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

// ---------- 主流程 ----------

async function main() {
  const errors = [];
  const generatedPaths = new Set();
  const markdownEntries = await collectMarkdownEntries(errors, generatedPaths);
  const htmlEntries = await collectHtmlEntries(errors, generatedPaths);

  const entries = [...markdownEntries, ...htmlEntries].sort((a, b) => {
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

  const siteConfig = await readSiteConfig();
  const siteUrl = siteConfig.siteUrl || DEFAULT_SITE_URL;
  await writeFile(join(root, 'feed.xml'), buildFeed(siteUrl, entries), 'utf8');
  await writeFile(join(root, 'sitemap.xml'), buildSitemap(siteUrl, entries), 'utf8');

  console.log(`\nentries.json：共 ${entries.length} 条（md ${markdownEntries.length} / html ${htmlEntries.length}）`);
  console.log(`feed.xml / sitemap.xml：站点地址 ${siteUrl}`);
  for (const error of errors) {
    console.warn(`[warn] ${error}`);
  }
  if (errors.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
