#!/usr/bin/env node
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase() || 'untitled';
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function renderText(text, title) {
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (body.startsWith('---\n')) return body;
  return `---
title: ${title}
date: ${dateStamp()}
type: ${argument('type', 'article')}
kind: standard
tags: 本地导入
---

# ${title}

${body}
`;
}

function sanitizeHtml(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:iframe|object|embed)\b[\s\S]*?<\/(?:iframe|object)>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, ' $1="#"');
}

function htmlWrapper(html, meta) {
  return `<script type="application/x-bifrost-meta">${JSON.stringify(meta)}</script>
${sanitizeHtml(html)}
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function main() {
  const input = resolve(process.argv[2] || '');
  if (!process.argv[2]) {
    throw new Error('用法：node tools/import-local.mjs <文件> --phase fantasy --type article [--title 标题]');
  }
  const info = await stat(input);
  if (!info.isFile()) throw new Error('输入必须是单个文件。');

  const phase = ['logic', 'fantasy'].includes(argument('phase')) ? argument('phase') : 'fantasy';
  const type = argument('type') === 'diary' ? 'diary' : 'article';
  const title = argument('title') || parse(basename(input)).name;
  const extension = extname(input).toLowerCase();
  const slug = argument('slug') || slugify(title);
  const stem = `${argument('date', dateStamp())}-${slug}`;
  let output;

  if (['.md', '.markdown', '.txt'].includes(extension)) {
    const source = await readFile(input, 'utf8');
    output = join(root, 'content-src', phase, type, `${stem}.md`);
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, renderText(source, title), 'utf8');
  } else if (['.html', '.htm'].includes(extension)) {
    const source = await readFile(input, 'utf8');
    output = join(root, 'content', phase, `${stem}.html`);
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, htmlWrapper(source, {
      title,
      date: argument('date', dateStamp()),
      type,
      kind: 'standard',
      tags: ['本地导入'],
      summary: argument('summary', ''),
    }), 'utf8');
  } else if (extension === '.pdf') {
    const docsDir = join(root, 'assets', 'docs');
    const mediaDir = join(root, 'assets', 'media', 'docs');
    await mkdir(docsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    const documentName = `${stem}${extension}`;
    await copyFile(input, join(docsDir, documentName));
    output = join(root, 'content', phase, `${stem}.html`);
    const body = `<article class="article-surface pdf-entry">
<script type="application/x-bifrost-meta">${JSON.stringify({
      title,
      date: argument('date', dateStamp()),
      type,
      kind: 'pdf',
      tags: ['PDF', '本地导入'],
      summary: argument('summary', ''),
    })}</script>
<p class="hero__eyebrow">PDF ARCHIVE</p>
<h1>${escapeHtml(title)}</h1>
<p>本文保留出版物原始排版，并提供浏览器阅读与下载入口。</p>
<div class="article-actions">
  <a class="button button--primary" href="/assets/docs/${encodeURIComponent(documentName)}" target="_blank" rel="noopener">打开 PDF</a>
  <a class="button" href="/assets/docs/${encodeURIComponent(documentName)}" download>下载原件</a>
</div>
</article>`;
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, `${body}\n`, 'utf8');
  } else {
    throw new Error(`暂不支持的文件格式：${extension || '无扩展名'}`);
  }

  console.log(`[local-import] ${input} -> ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
