#!/usr/bin/env node
// 把内容包（staging package）打包成设计文档定义的那几份记录，作为 dry-run 产物。
// 不写入任何云资源，只产出 JSON，用于校验数据结构。
// 用法：node tools/build-documents.mjs <内容包目录> [--out <目录>]
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { renderMarkdown } from './lib/markdown.mjs';
import {
  contentHash,
  countWords,
  ensureDir,
  markdownToText,
  readJson,
  readingMinutes,
  sha256,
  slugify,
  writeJson,
} from './lib/content-common.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function positional() {
  const values = process.argv.slice(2);
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].startsWith('--')) {
      index += 1;
      continue;
    }
    result.push(values[index]);
  }
  return result;
}

function assetId(sha) {
  return `ast_${sha.slice(0, 16)}`;
}

function mimeFor(file) {
  switch (basename(file).split('.').pop().toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

async function main() {
  const [workDirArg] = positional();
  if (!workDirArg) {
    throw new Error('用法：node tools/build-documents.mjs <内容包目录> [--out <目录>]');
  }

  const workDir = resolve(workDirArg);
  const pkg = await readJson(join(workDir, 'package.json'));
  if (!pkg) {
    throw new Error(`${workDir} 下没有 package.json。`);
  }

  const markdown = await readFile(join(workDir, 'content.md'), 'utf8');
  const html = renderMarkdown(markdown);
  const text = markdownToText(markdown);
  const words = countWords(text);
  const minutes = readingMinutes(words);

  const sourcePath = pkg.source?.file ? join(workDir, pkg.source.file) : '';
  let sourceHash = '';
  try {
    sourceHash = sha256(await readFile(sourcePath));
  } catch {
    sourceHash = '';
  }

  const inlineCandidates = pkg.coverCandidates || [];
  const publication = pkg.publication || null;
  const assetByFile = new Map();

  function makeAsset(file, source, extra) {
    const asset = {
      id: assetId(source.sha256),
      assetId: assetId(source.sha256),
      type: 'asset',
      schemaVersion: 1,
      ...extra,
      sourceFile: file,
      bytes: source.bytes,
      sha256: source.sha256,
      width: source.width || 0,
      height: source.height || 0,
      variants: [],
      ownerEntryIds: [pkg.entryId],
      alt: '',
      caption: '',
      status: 'active',
    };
    assetByFile.set(file, asset);
    return asset;
  }

  const inlineAssets = inlineCandidates.map((candidate) => makeAsset(candidate.file, candidate, {
    assetClass: 'original',
    kind: 'image',
    blobContainer: 'media',
    blobPath: `content/${pkg.entryId}/${basename(candidate.file)}`,
    blobUrl: '',
    mime: mimeFor(candidate.file),
    derivedFrom: null,
  }));

  const pdfAsset = publication
    ? makeAsset(publication.pdfFile, {
      bytes: publication.pdfBytes,
      sha256: publication.pdfSha256,
      width: 0,
      height: 0,
    }, {
      assetClass: 'original',
      kind: 'pdf',
      blobContainer: 'media',
      blobPath: `content/${pkg.entryId}/publication.pdf`,
      blobUrl: '',
      mime: 'application/pdf',
      derivedFrom: null,
    })
    : null;

  const pageAssets = publication
    ? publication.pages.map((page) => makeAsset(page.file, page, {
      assetClass: 'derived',
      kind: 'image',
      blobContainer: 'media',
      blobPath: `content/${pkg.entryId}/${basename(page.file)}`,
      blobUrl: '',
      mime: 'image/webp',
      derivedFrom: pdfAsset ? pdfAsset.id : null,
      caption: `第 ${page.order} 页`,
    }))
    : [];

  const assets = [...inlineAssets, ...(pdfAsset ? [pdfAsset] : []), ...pageAssets];

  const fallbackCover = inlineCandidates[0]?.file || publication?.pages?.[0]?.file || '';
  const coverAsset = assetByFile.get(pkg.cover) || assetByFile.get(fallbackCover) || null;
  const coverSource = assets.length ? (pkg.coverSource === 'manual' ? 'manual' : 'auto-first') : 'text';

  const media = inlineCandidates.map((candidate) => ({
    assetId: assetByFile.get(candidate.file).id,
    role: coverAsset && assetByFile.get(candidate.file).id === coverAsset.id ? 'cover' : 'inline',
    kind: 'image',
    order: candidate.order,
    caption: '',
  }));

  const publicationBlock = publication ? {
    pageCount: publication.pageCount,
    pdfAssetId: pdfAsset ? pdfAsset.id : '',
    pageAssetIds: pageAssets.map((asset) => asset.id),
    renderer: publication.renderer || '',
  } : null;

  const now = new Date().toISOString();
  const entry = {
    id: pkg.entryId,
    entryId: pkg.entryId,
    type: 'entry',
    schemaVersion: 1,
    entryType: pkg.entryType || 'article',
    kind: pkg.kind || 'standard',
    phase: pkg.phase,
    section: pkg.section,
    tags: pkg.tags || [],
    seriesId: pkg.seriesId || null,
    slug: pkg.slug || slugify(pkg.title),
    path: pkg.path,
    title: pkg.title,
    subtitle: pkg.subtitle || '',
    summary: pkg.summary || '',
    publishedAt: `${pkg.date}T00:00:00+08:00`,
    createdAt: now,
    updatedAt: now,
    status: pkg.status || 'draft',
    visibility: 'public',
    author: pkg.author || '',
    counts: { likes: 0, views: 0, comments: 0 },
    cover: coverAsset ? { assetId: coverAsset.id } : null,
    coverSource,
    media,
    publication: publicationBlock,
    contentHash: contentHash(markdown),
    currentRevision: 1,
    origin: {
      provider: 'upload',
      ref: pkg.source?.file ? basename(pkg.source.file) : '',
      importedAt: pkg.source?.importedAt || now,
      sourceHash,
    },
  };

  const body = {
    id: 'body',
    type: 'entry-body',
    schemaVersion: 1,
    entryId: pkg.entryId,
    format: 'markdown',
    markdown,
    html,
    text,
    wordCount: words,
    readingMinutes: minutes,
    revision: 1,
    contentHash: contentHash(markdown),
    updatedAt: now,
  };

  const routes = [
    {
      // Cosmos 的文档 id 不允许含 "/"，路径放在 path 字段（也是分区键）
      id: 'route',
      type: 'route',
      schemaVersion: 1,
      path: pkg.path,
      entryId: pkg.entryId,
      canonical: true,
      redirect: false,
      updatedAt: now,
    },
  ];

  const searchDoc = {
    id: pkg.entryId,
    type: 'search-doc',
    schemaVersion: 1,
    entryId: pkg.entryId,
    entryType: entry.entryType,
    title: entry.title,
    summary: entry.summary,
    bodyText: text,
    phase: entry.phase,
    section: entry.section,
    tags: entry.tags,
    seriesId: entry.seriesId,
    kind: entry.kind,
    publishedAt: entry.publishedAt,
    updatedAt: now,
    counts: entry.counts,
    path: entry.path,
    slug: entry.slug,
    wordCount: words,
    hasMedia: media.length > 0,
    hasVideo: false,
    pinned: false,
    featured: false,
    coverUrl: '',
    status: 'published',
  };

  const taxonomy = (entry.tags || []).map((tag) => ({
    id: `tag:${slugify(tag)}`,
    type: 'taxonomy',
    schemaVersion: 1,
    kind: 'tag',
    label: tag,
    description: '',
    parentId: '',
    order: 0,
    aliases: [],
    status: 'active',
  }));

  const outDir = resolve(argument('out', join(workDir, 'documents')));
  await ensureDir(outDir);
  await writeJson(join(outDir, 'entry.json'), entry);
  await writeJson(join(outDir, 'body.json'), body);
  await writeJson(join(outDir, 'assets.json'), { type: 'assets', schemaVersion: 1, items: assets });
  // 供上传工具使用的本地文件索引（不是权威数据，不入库）
  const assetFiles = {};
  for (const candidate of inlineCandidates) {
    assetFiles[assetId(candidate.sha256)] = join(workDir, candidate.file);
  }
  if (publication) {
    assetFiles[assetId(publication.pdfSha256)] = join(workDir, publication.pdfFile);
    for (const page of publication.pages) {
      assetFiles[assetId(page.sha256)] = join(workDir, page.file);
    }
  }
  await writeJson(join(outDir, 'asset-files.json'), assetFiles);
  await writeJson(join(outDir, 'routes.json'), { type: 'routes', schemaVersion: 1, items: routes });
  await writeJson(join(outDir, 'search-doc.json'), searchDoc);
  await writeJson(join(outDir, 'taxonomy.json'), { type: 'taxonomy', schemaVersion: 1, items: taxonomy });

  const report = [
    `# 打包报告：${entry.title}`,
    '',
    `- entryId：\`${entry.id}\``,
    `- 路径：\`${entry.path}\``,
    `- 分类：${entry.phase} / ${entry.section} / ${entry.kind}`,
    `- 状态：${entry.status}`,
    `- 字数：${words}　阅读时长：约 ${minutes} 分钟`,
    `- 封面：${entry.cover ? `\`${entry.cover.assetId}\`（${coverSource === 'manual' ? '手动指定' : '默认首图'}）` : '文字封面'}`,
    `- 图片：${assets.length} 张`,
    `- 标签：${entry.tags.length ? entry.tags.join('、') : '（无）'}`,
    '',
    '## 产出文件',
    '',
    '| 文件 | 内容 |',
    '|---|---|',
    '| `entry.json` | 条目元数据与媒体引用 |',
    '| `body.json` | 正文：Markdown 源 + 渲染 HTML + 纯文本 |',
    '| `assets.json` | 媒体元数据（原件） |',
    '| `routes.json` | 路径映射 |',
    '| `search-doc.json` | 检索投影 |',
    '| `taxonomy.json` | 本次新增的标签登记 |',
    '',
  ].join('\n');
  await writeFileReport(join(outDir, 'report.md'), report);

  console.log(`打包完成：${outDir}`);
  console.log(`  条目   ${entry.path}  状态=${entry.status}`);
  console.log(`  正文   ${words} 字 / 约 ${minutes} 分钟，HTML ${html.length} 字符`);
  console.log(`  封面   ${entry.cover ? entry.cover.assetId : '（文字封面）'} (${coverSource})`);
  console.log(`  媒体   ${assets.length} 张`);
  console.log(`  标签   ${entry.tags.length ? entry.tags.join('、') : '（无）'}`);
  console.log(`  检索   bodyText ${text.length} 字符，hasMedia=${media.length > 0}`);
}

async function writeFileReport(path, content) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, content, 'utf8');
}

main().catch((error) => {
  console.error(`[build-documents] ${error.message}`);
  process.exitCode = 1;
});
