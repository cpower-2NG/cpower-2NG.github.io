#!/usr/bin/env node
// 本地预览补丁：把正文 searchText 写进 data/site-index.json。
// CI 物化（materialize-site.mjs）会重新生成整份索引并自带 searchText；
// 这个脚本只给没有 Cosmos 凭据的本地环境用：
//   node tools/patch-local-index.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FRAGMENT_START = '<!--bifrost:fragment:start-->';
const FRAGMENT_END = '<!--bifrost:fragment:end-->';

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const indexPath = resolve('data/site-index.json');
const index = JSON.parse(await readFile(indexPath, 'utf8'));
let patched = 0;
let missing = 0;
for (const entry of index.entries || []) {
  const html = await readFile(resolve(`.${entry.path}`), 'utf8').catch(() => '');
  const start = html.indexOf(FRAGMENT_START);
  const end = html.indexOf(FRAGMENT_END);
  if (start < 0 || end < 0) {
    missing += 1;
    continue;
  }
  entry.searchText = stripHtml(html.slice(start + FRAGMENT_START.length, end)).slice(0, 800);
  patched += 1;
}
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`patch-local-index：${patched}/${(index.entries || []).length} 条已写入 searchText${missing ? `，${missing} 条找不到物化页` : ''}`);
