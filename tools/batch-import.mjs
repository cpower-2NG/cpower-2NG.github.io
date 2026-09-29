#!/usr/bin/env node
// 按清单批量跑导入 + 打包，产出一张供人工确认的内容清单。
// 用法：node tools/batch-import.mjs [清单路径]
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ensureDir, readJson } from './lib/content-common.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(join(import.meta.dirname, '..'));

async function run(script, args) {
  return execFileAsync(process.execPath, [join(root, 'tools', script), ...args], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function importArgs(item) {
  const args = [
    item.source,
    '--out', item.out,
    '--force',
    '--phase', item.phase || 'fantasy',
    '--section', item.section || 'essay',
    '--title', item.title || '',
    '--date', item.date || '',
    '--tags', item.tags || '',
  ];
  // 批量迁移的是线上已有内容，默认按已发布处理
  args.push('--status', item.status || 'published');
  if (item.kind) args.push('--kind', item.kind);
  if (item.pdf) args.push('--pdf', item.pdf);
  if (item.author) args.push('--author', item.author);
  if (item.series) args.push('--series', item.series);
  if (item.cover) args.push('--cover', String(item.cover));
  return args;
}

async function main() {
  const manifestPath = resolve(process.argv[2] || 'imports/fantasy/batch-manifest.json');
  const manifest = await readJson(manifestPath);
  if (!manifest?.items?.length) {
    throw new Error(`清单为空或无法解析：${manifestPath}`);
  }

  const rows = [];
  for (const [index, item] of manifest.items.entries()) {
    const label = item.title || item.source;
    process.stdout.write(`[${index + 1}/${manifest.items.length}] ${label} … `);
    try {
      await run('import-content.mjs', importArgs(item));
      await run('build-documents.mjs', [item.out]);
      const pkg = await readJson(join(root, item.out, 'package.json'));
      const entry = await readJson(join(root, item.out, 'documents', 'entry.json'));
      const searchDoc = await readJson(join(root, item.out, 'documents', 'search-doc.json'));
      const assets = await readJson(join(root, item.out, 'documents', 'assets.json'));
      rows.push({
        index: index + 1,
        ok: true,
        title: entry.title,
        path: entry.path,
        section: entry.section,
        kind: entry.kind,
        seriesId: entry.seriesId || '',
        tags: (entry.tags || []).join('、'),
        words: searchDoc.wordCount,
        images: (assets.items || []).length,
        cover: entry.cover ? `${entry.cover.assetId}（${entry.coverSource === 'manual' ? '手动' : '首图'}）` : '文字封面',
        summary: entry.summary,
        warnings: pkg.coverCandidates?.length ? '' : '无图片',
      });
      process.stdout.write('完成\n');
    } catch (error) {
      rows.push({ index: index + 1, ok: false, title: label, error: String(error.stderr || error.message).trim().split('\n').slice(-1)[0] });
      process.stdout.write(`失败：${error.message}\n`);
    }
  }

  const ok = rows.filter((row) => row.ok);
  const failed = rows.filter((row) => !row.ok);
  const lines = [
    '# 批量导入清单',
    '',
    `- 清单：\`${manifestPath.replace(root + '\\', '').replaceAll('\\', '/')}\``,
    `- 结果：成功 ${ok.length} / 失败 ${failed.length}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '> 说明：字数按去空白字符统计；封面「首图」表示未手动指定，取的是正文第一张图。',
    '',
    '| # | 标题 | 分类 | 形态 | 系列 | 标签 | 字数 | 图 | 封面 |',
    '|---|---|---|---|---|---|---:|---:|---|',
    ...ok.map((row) => `| ${row.index} | ${row.title} | ${row.section} | ${row.kind} | ${row.seriesId ? row.seriesId.replace('series:', '') : '—'} | ${row.tags || '—'} | ${row.words} | ${row.images} | ${row.cover} |`),
    '',
  ];

  if (ok.some((row) => row.seriesId)) {
    lines.push('## 系列候选', '');
    const series = new Map();
    for (const row of ok.filter((r) => r.seriesId)) {
      const list = series.get(row.seriesId) || [];
      list.push(row.title);
      series.set(row.seriesId, list);
    }
    for (const [id, titles] of series) {
      lines.push(`- \`${id}\`：${titles.join(' / ')}`);
    }
    lines.push('');
  }

  if (failed.length) {
    lines.push('## 失败项', '');
    for (const row of failed) {
      lines.push(`- ${row.title}：${row.error}`);
    }
    lines.push('');
  }

  lines.push('## 需要你确认的三件事', '', '1. 分类（section）是否合适。', '2. 标签是否要合并或增补。', '3. 封面是否要换成别的图（`--cover N`）。', '');

  const reportPath = join(dirname(manifestPath), 'batch-report.md');
  await ensureDir(dirname(reportPath));
  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(`\n成功 ${ok.length} / 失败 ${failed.length}`);
  console.log(`清单已写入：${reportPath}`);
}

main().catch((error) => {
  console.error(`[batch-import] ${error.message}`);
  process.exitCode = 1;
});
