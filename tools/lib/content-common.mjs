import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 用给定的毫秒时间与 10 字节熵拼出 ULID（48 位时间 + 80 位熵）。
 * 传入确定性熵即可得到可复现的 id，用于迁移已有内容。
 */
export function ulidFrom(millis, bytes) {
  let encoded = '';
  let value = Number(millis);
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD[value % 32] + encoded;
    value = Math.floor(value / 32);
  }

  let bits = 0n;
  for (const byte of bytes.slice(0, 10)) {
    bits = (bits << 8n) | BigInt(byte);
  }

  let suffix = '';
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(bits & 31n)] + suffix;
    bits >>= 5n;
  }

  return `${encoded}${suffix}`;
}

/** ULID：48 位时间 + 80 位随机。 */
export function ulid(now = Date.now()) {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return ulidFrom(now, bytes);
}

/** 保留字母、数字与汉字，其余折叠为连字符。 */
export function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();
  return slug || 'untitled';
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function contentHash(text) {
  return sha256(Buffer.from(String(text), 'utf8'));
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 去掉 Markdown 标记，得到用于检索与字数统计的纯文本。 */
export function markdownToText(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text) {
  const cjk = (String(text || '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (String(text || '').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

export function readingMinutes(words) {
  return Math.max(1, Math.round(Number(words || 0) / 400));
}

export function deriveSummary(text, limit = 120) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}…`;
}
