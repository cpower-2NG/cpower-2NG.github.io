#!/usr/bin/env node
// 把 QQ 同步产出的动态 JSON 转成 content-moments 文档（dry-run）。
// 动态是纯时间流内容：自包含文本、按月分桶、无正文版本拆分。
// 用法：node tools/import-moments.mjs [QQ JSON 目录]
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  contentHash,
  deriveSummary,
  ensureDir,
  slugify,
  ulidFrom,
  writeJson,
} from './lib/content-common.mjs';

const SOURCE_DIR = resolve(process.argv[2] || 'content-src/imported/qq');
const OUT_DIR = resolve(process.argv[3] || 'imports/fantasy/derived/moments');

/** 迁移用稳定 id：以发布时间为前缀，用来源 id 的哈希做熵，保证可复现。 */
function momentId(record) {
  const millis = Date.parse(record.createdAt || record.date || Date.now());
  const seed = `${record.source?.provider || 'qq'}:${record.source?.id || record.id}`;
  const entropy = createHash('sha256').update(seed).digest();
  return ulidFrom(millis, entropy);
}

function toHtml(text) {
  const escaped = String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.trim().replaceAll('\n', '<br>')}</p>`)
    .filter((block) => block !== '<p></p>')
    .join('\n');
}

async function main() {
  const files = (await readdir(SOURCE_DIR)).filter((name) => name.toLowerCase().endsWith('.json'));
  if (!files.length) {
    throw new Error(`没有找到动态 JSON：${SOURCE_DIR}`);
  }

  const summaryRows = [];
  for (const file of files) {
    const record = JSON.parse(await readFile(join(SOURCE_DIR, file), 'utf8'));
    const id = momentId(record);
    const text = String(record.text || '');
    const createdAt = record.createdAt || `${record.date}T00:00:00Z`;
    const month = createdAt.slice(0, 7);
    const tags = Array.isArray(record.tags) ? record.tags.map(String) : [];
    const status = record.publishStatus === 'published' ? 'published' : 'draft';

    const moment = {
      id,
      entryId: id,
      type: 'moment',
      schemaVersion: 1,
      entryType: 'moment',
      month,
      phase: record.phase || 'fantasy',
      section: record.section || 'daily',
      tags,
      title: record.title || '',
      text,
      html: toHtml(text),
      summary: record.summary || deriveSummary(text, 120),
      publishedAt: createdAt,
      createdAt,
      updatedAt: new Date().toISOString(),
      status,
      visibility: 'public',
      author: '',
      counts: {
        likes: Number(record.historicalInteractions?.likeCount) || 0,
        views: 0,
        comments: Number(record.historicalInteractions?.commentCount) || 0,
      },
      cover: null,
      media: [],
      video: record.video || null,
      contentHash: contentHash(text),
      pinned: false,
      featured: false,
      // 开发者技术溯源：不面向读者展示
      origin: {
        provider: record.source?.provider || 'qq',
        ref: record.source?.id || '',
        sourceUrl: record.source?.url || '',
        visibility: record.source?.visibility || '',
        warnings: record.source?.warnings || [],
        importedAt: new Date().toISOString(),
      },
    };

    const path = `/moment/${id}.html`;
    const searchDoc = {
      id,
      type: 'search-doc',
      schemaVersion: 1,
      entryId: id,
      entryType: 'moment',
      title: moment.title,
      summary: moment.summary,
      bodyText: text,
      phase: moment.phase,
      section: moment.section,
      tags,
      seriesId: null,
      kind: 'moment',
      publishedAt: moment.publishedAt,
      updatedAt: moment.updatedAt,
      counts: moment.counts,
      path,
      slug: slugify(`${record.date}-${text.slice(0, 24)}`),
      wordCount: text.replace(/\s/g, '').length,
      hasMedia: false,
      hasVideo: Boolean(moment.video),
      pinned: false,
      featured: false,
      coverUrl: '',
      status: 'published',
    };

    const routes = {
      type: 'routes',
      schemaVersion: 1,
      items: [{
        id: 'route',
        type: 'route',
        schemaVersion: 1,
        path,
        entryId: id,
        canonical: true,
        redirect: false,
        updatedAt: new Date().toISOString(),
      }],
    };

    const taxonomy = {
      type: 'taxonomy',
      schemaVersion: 1,
      items: tags.map((tag) => ({
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
      })),
    };

    const target = join(OUT_DIR, basename(file, '.json'), 'documents');
    await ensureDir(target);
    await writeJson(join(target, 'moment.json'), moment);
    await writeJson(join(target, 'search-doc.json'), searchDoc);
    await writeJson(join(target, 'routes.json'), routes);
    await writeJson(join(target, 'taxonomy.json'), taxonomy);

    summaryRows.push({ id, month, status, path, chars: text.length, tags: tags.join('、'), summary: moment.summary });
    console.log(`  ${status === 'published' ? '✓' : '·'} ${month}  ${id}  ${text.length} 字  ${moment.summary.slice(0, 24)}…`);
  }

  await writeJson(join(OUT_DIR, 'moments-index.json'), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: SOURCE_DIR,
    count: summaryRows.length,
    items: summaryRows,
  });
  console.log(`\n动态 ${summaryRows.length} 条 → ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(`[import-moments] ${error.message}`);
  process.exitCode = 1;
});
