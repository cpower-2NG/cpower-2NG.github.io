#!/usr/bin/env node
// 从 Cosmos 物化静态站点：阅读页、站点索引、feed 与 sitemap。
// 权威数据在 Cosmos；这里产出的都是派生品，可随时重建。
// 用法：node tools/materialize-site.mjs [--out site-build]
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDir, slugify } from './lib/content-common.mjs';

const ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://cosmos-bifrost-z43zcc.documents.azure.com:443/';
const DATABASE = process.env.COSMOS_DATABASE || 'bifrost';
const SITE_URL = (process.env.SITE_URL || 'https://cpower-2ng.github.io').replace(/\/+$/, '');
const FRAGMENT_START = '<!--bifrost:fragment:start-->';
const FRAGMENT_END = '<!--bifrost:fragment:end-->';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function client() {
  return process.env.COSMOS_KEY
    ? new CosmosClient({ endpoint: ENDPOINT, key: process.env.COSMOS_KEY })
    : new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pathToFile(outDir, path) {
  return join(outDir, String(path).replace(/^\/+/, ''));
}

/** 正文里的图片来自内容包（media/01.png），物化时换成 Blob 地址。 */
function rewriteImages(html, assetBySourceFile) {
  return String(html || '').replace(
    /(<img\b[^>]*?\ssrc=")([^"]+)(")/g,
    (match, before, src, after) => {
      const mapped = assetBySourceFile.get(src)?.blobUrl;
      return `${before}${mapped || src}${after}`;
    },
  );
}

/** 出版物只在正文顶部留一个入口，交给浏览器自带的 PDF 阅读器。 */
function renderPublicationBar(publication, assetsById) {
  if (!publication) return '';
  const pdf = assetsById.get(publication.pdfAssetId);
  return `
<div class="publication-bar">
  <p class="publication-bar__text">出版物 · 共 ${publication.pageCount} 页，保留原始排版</p>
  ${pdf ? `<a class="button button--primary" href="${escapeHtml(pdf.blobUrl)}" target="_blank" rel="noopener">打开 PDF</a>` : ''}
</div>`;
}

/** 条目正文：图片换成 Blob 地址，出版物在顶部插入入口。 */
function renderEntryInner(entry, bodyByEntry, assetsByEntry, assetsById) {
  const body = bodyByEntry.get(entry.id);
  const assetMap = assetsByEntry.get(entry.id) || new Map();
  return `${renderPublicationBar(entry.publication, assetsById)}${rewriteImages(body?.html || '', assetMap)}`;
}

function renderDocument({ body, title, description, url, phase, cover = '', entryId = '', redirectTo = '' }) {
  const ogImage = cover ? `\n<meta property="og:image" content="${escapeHtml(cover)}">` : '';
  const target = redirectTo || `/?phase=${encodeURIComponent(phase)}&entry=${encodeURIComponent(entryId)}`;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-phase="${escapeHtml(phase)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} · BIFROST</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(url)}">
<meta property="og:site_name" content="BIFROST">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">${ogImage}
<meta name="twitter:card" content="${cover ? 'summary_large_image' : 'summary'}">
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') return;
  params.delete('embed');
  var extra = params.toString();
  var target = '${target}' + (extra ? '&' + extra : '') + window.location.hash;
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

/** 本地兜底搜索用的正文纯文本（前 800 字）：去标记、去脚本、合并空白。 */
function extractSearchText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function entryCard(entry, body) {
  const tags = (entry.tags || []).slice(0, 3).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('');
  return {
    id: entry.id,
    entryId: entry.id,
    path: entry.path,
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    publishedAt: entry.publishedAt,
    date: String(entry.publishedAt || '').slice(0, 10),
    phase: entry.phase,
    section: entry.section,
    kind: entry.kind,
    tags: entry.tags || [],
    tagsHtml: tags,
    coverUrl: entry.coverUrl || '',
    wordCount: entry.wordCount || 0,
    minutes: entry.minutes || 1,
    layout: entry.layout || 'longform',
    type: entry.kind === 'note' ? 'diary' : 'article',
    seriesId: entry.seriesId || '',
    seriesOrder: entry.seriesOrder || null,
    hasPublication: Boolean(entry.publication),
    searchText: extractSearchText(body?.html),
  };
}

async function main() {
  const outDir = resolve(argument('out', 'site-build'));
  const db = client().database(DATABASE);
  await ensureDir(outDir);

  const [taxonomyRes, entriesRes, bodiesRes, assetsRes, momentsRes] = await Promise.all([
    db.container('taxonomy').items.query('SELECT * FROM c WHERE c.status = "active"').fetchAll(),
    db.container('content-articles').items.query("SELECT * FROM c WHERE c.type = 'entry' AND c.status = 'published'").fetchAll(),
    db.container('content-articles').items.query("SELECT * FROM c WHERE c.type = 'entry-body'").fetchAll(),
    db.container('assets').items.query('SELECT * FROM c').fetchAll(),
    db.container('content-moments').items.query('SELECT * FROM c').fetchAll(),
  ]);

  const assetsById = new Map(assetsRes.resources.map((asset) => [asset.id, asset]));
  const assetsByEntry = new Map();
  for (const asset of assetsRes.resources) {
    for (const entryId of asset.ownerEntryIds || []) {
      const map = assetsByEntry.get(entryId) || new Map();
      if (asset.sourceFile) map.set(asset.sourceFile, asset);
      assetsByEntry.set(entryId, map);
    }
  }
  const bodyByEntry = new Map(bodiesRes.resources.map((body) => [body.entryId, body]));

  // kind=page 是展示页等特殊页面，不进内容列表与订阅
  const pageEntries = entriesRes.resources.filter((entry) => entry.kind === 'page');
  const entries = entriesRes.resources
    .filter((entry) => entry.kind !== 'page')
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .map((entry) => {
      const cover = entry.cover?.assetId ? assetsById.get(entry.cover.assetId) : null;
      const body = bodyByEntry.get(entry.id);
      return {
        ...entry,
        coverUrl: cover?.blobUrl || '',
        wordCount: body?.wordCount || 0,
        minutes: body?.readingMinutes || 1,
      };
    });

  let pages = 0;
  for (const entry of entries) {
    const inner = renderEntryInner(entry, bodyByEntry, assetsByEntry, assetsById);
    const html = `<article class="article-surface">${inner}</article>`;
    const document = renderDocument({
      body: html,
      title: entry.title,
      description: entry.summary || '',
      url: `${SITE_URL}${entry.path}`,
      phase: entry.phase,
      cover: entry.coverUrl,
      entryId: entry.id,
    });
    const file = pathToFile(outDir, entry.path);
    await ensureDir(file.replace(/[^\\/]+$/, ''));
    await writeFile(file, document, 'utf8');
    pages += 1;
  }

  const moments = momentsRes.resources
    .filter((moment) => moment.status === 'published')
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  for (const moment of moments) {
    const mediaHtml = (moment.media || [])
      .filter((item) => item.kind === 'image' && item.url)
      .map((item) => `<figure class="moment__figure"><img src="${escapeHtml(item.url)}" alt="" loading="lazy"></figure>`)
      .join('');
    const document = renderDocument({
      body: `<article class="article-surface moment"><div class="moment__meta">${escapeHtml(String(moment.publishedAt).slice(0, 10))}</div>${moment.html || ''}${mediaHtml}</article>`,
      title: moment.summary?.slice(0, 30) || '动态',
      description: moment.summary || '',
      url: `${SITE_URL}/moment/${moment.id}.html`,
      phase: moment.phase || 'fantasy',
      entryId: moment.id,
    });
    const file = pathToFile(outDir, `/moment/${moment.id}.html`);
    await ensureDir(file.replace(/[^\\/]+$/, ''));
    await writeFile(file, document, 'utf8');
    pages += 1;
  }

  const sections = taxonomyRes.resources
    .filter((item) => item.kind === 'section')
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const phases = taxonomyRes.resources
    .filter((item) => item.kind === 'phase')
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  // 系列：成员来自条目上的 seriesId，标题与简介来自 taxonomy
  const seriesDocs = taxonomyRes.resources.filter((item) => item.kind === 'series');
  const seriesGroups = new Map();
  for (const entry of entries) {
    if (!entry.seriesId) continue;
    const list = seriesGroups.get(entry.seriesId) || [];
    list.push(entry);
    seriesGroups.set(entry.seriesId, list);
  }
  const series = [...seriesGroups.entries()].map(([id, list]) => {
    const doc = seriesDocs.find((item) => item.id === id);
    const slug = slugify(id.replace(/^series:/, ''));
    const members = list.slice().sort((a, b) => (a.seriesOrder || 999) - (b.seriesOrder || 999));
    return {
      id,
      slug,
      path: `/series/${slug}.html`,
      title: doc?.label || id.replace(/^series:/, ''),
      description: doc?.description || '',
      memberIds: members.map((item) => item.id),
    };
  });

  for (const item of series) {
    const members = item.memberIds.map((id) => entries.find((entry) => entry.id === id)).filter(Boolean);
    const first = members[0];
    if (!first) continue;
    const nav = members
      .map((member, index) => `<span class="series-nav__item${index === 0 ? ' is-active' : ''}">${escapeHtml(member.title)}</span>`)
      .join('');
    const body = `
<article class="article-surface series-page">
  <p class="hero__eyebrow">系列 · ${members.length} 篇</p>
  <h1 class="hero__title">${escapeHtml(item.title)}</h1>
  ${item.description ? `<p class="hero__text">${escapeHtml(item.description)}</p>` : ''}
  <nav class="series-nav">${nav}</nav>
  ${renderEntryInner(first, bodyByEntry, assetsByEntry, assetsById)}
</article>`;
    const document = renderDocument({
      body,
      title: item.title,
      description: item.description,
      url: `${SITE_URL}${item.path}`,
      phase: first.phase,
      cover: first.coverUrl,
      redirectTo: `/?phase=${encodeURIComponent(first.phase)}&series=${encodeURIComponent(item.id)}&entry=${encodeURIComponent(first.id)}`,
    });
    const file = pathToFile(outDir, item.path);
    await ensureDir(file.replace(/[^\\/]+$/, ''));
    await writeFile(file, document, 'utf8');
    pages += 1;
  }

  // Logic 展示页：kind=page 的条目承载简介与技术栈
  const showcaseEntry = pageEntries.find((entry) => entry.phase === 'logic');
  const showcase = showcaseEntry
    ? {
      entryId: showcaseEntry.id,
      intro: showcaseEntry.intro || '',
      techStack: showcaseEntry.techStack || [],
      projectIds: showcaseEntry.projects || [],
    }
    : null;

  const tagCounts = new Map();
  for (const item of [...entries, ...moments]) {
    for (const tag of item.tags || []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  const index = {
    schemaVersion: 1,
    generated: new Date().toISOString(),
    siteUrl: SITE_URL,
    phases: phases.map((phase, index_) => ({
      id: phase.phase || phase.id.replace('phase:', ''),
      label: phase.label,
      order: phase.order ?? index_,
      sections: sections
        .filter((section) => section.phase === (phase.phase || phase.id.replace('phase:', '')))
        .map((section) => ({ id: section.section, label: section.label, layout: section.layout || 'magazine' })),
    })),
    sections: Object.fromEntries(sections.map((section) => [section.section, {
      id: section.section,
      label: section.label,
      phase: section.phase,
      layout: section.layout || 'magazine',
      description: section.description || '',
    }])),
    series,
    showcase,
    tags: [...tagCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN')),
    entries: entries.map((entry) => entryCard(entry, bodyByEntry.get(entry.id))),
    moments: moments.map((moment) => ({
      id: moment.id,
      path: `/moment/${moment.id}.html`,
      month: moment.month,
      publishedAt: moment.publishedAt,
      phase: moment.phase,
      section: moment.section,
      text: moment.text,
      html: moment.html,
      summary: moment.summary,
      tags: moment.tags || [],
      media: (moment.media || [])
        .filter((item) => item.kind === 'image' && item.url)
        .map((item) => ({ url: item.url, width: item.width || 0, height: item.height || 0 })),
      video: moment.video || null,
      counts: moment.counts || { likes: 0, views: 0, comments: 0 },
      pinned: Boolean(moment.pinned),
      featured: Boolean(moment.featured),
    })),
  };

  await ensureDir(join(outDir, 'data'));
  await writeFile(join(outDir, 'data', 'site-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await copyFile(resolve('data/site.json'), join(outDir, 'data', 'site.json'));

  // 壳层与资源：index.html 与 core/ 是手写源码。
  // 输出到仓库根目录时它们已在原位，避免自己复制自己。
  if (outDir !== resolve('.')) {
    await cp(resolve('core'), join(outDir, 'core'), { recursive: true });
    await copyFile(resolve('index.html'), join(outDir, 'index.html'));
    await copyFile(resolve('404.html'), join(outDir, '404.html'));
    await copyFile(resolve('robots.txt'), join(outDir, 'robots.txt'));
    await mkdir(join(outDir, 'assets'), { recursive: true });
    await cp(resolve('assets/favicon.svg'), join(outDir, 'assets/favicon.svg'));
  }

  const items = [
    ...entries.map((entry) => ({ path: entry.path, date: entry.publishedAt, title: entry.title })),
    ...series.map((item) => ({ path: item.path, date: new Date().toISOString(), title: item.title })),
    ...moments.map((moment) => ({ path: `/moment/${moment.id}.html`, date: moment.publishedAt, title: moment.summary?.slice(0, 30) || '动态' })),
  ];
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>BIFROST</title>
<link>${SITE_URL}/</link>
<description>BIFROST 更新</description>
${items.slice(0, 40).map((item) => `<item><title>${escapeHtml(item.title)}</title><link>${SITE_URL}${item.path}</link><pubDate>${new Date(item.date).toUTCString()}</pubDate></item>`).join('\n')}
</channel></rss>
`;
  await writeFile(join(outDir, 'feed.xml'), rss, 'utf8');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE_URL}/</loc></url>
${items.map((item) => `<url><loc>${SITE_URL}${item.path}</loc></url>`).join('\n')}
</urlset>
`;
  await writeFile(join(outDir, 'sitemap.xml'), sitemap, 'utf8');

  console.log(`物化完成：${outDir}`);
  console.log(`  阅读页 ${pages}（文章 ${entries.length} + 动态 ${moments.length}）`);
  console.log(`  索引 data/site-index.json：条目 ${index.entries.length} / 动态 ${index.moments.length} / 阶段 ${index.phases.length} / 分区 ${sections.length} / 标签 ${index.tags.length}`);
  console.log(`  feed.xml ${items.slice(0, 40).length} 条，sitemap.xml ${items.length + 1} 条`);
}

main().catch((error) => {
  console.error(`[materialize-site] ${error.message}`);
  process.exitCode = 1;
});
