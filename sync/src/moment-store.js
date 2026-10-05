// QQ 同步记录 → content-moments 权威库。
// 缺口背景：qzone-sync 只把记录提交到 Git（content-src/imported/qq），而发布物化
// 读的是 Cosmos 的 content-moments——历史上靠 tools/import-moments.mjs 手工迁移，
// 同步的新内容永远到不了站点。本模块把已发布的记录直接 upsert 进权威库。
// id 算法与 import-moments 完全一致（同一条说说不会因重复导入而出现两份）。
import { createHash } from 'node:crypto';
import { clients } from './clients.js';
import { contentHash } from './rules.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidFrom(millis, bytes) {
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

/** 与 tools/import-moments.mjs 的 momentId 同算法，保证 id 稳定可复现。 */
export function momentIdFor(record) {
  const millis = Date.parse(record.createdAt || record.date || Date.now());
  const seed = `${record.source?.provider || 'qq'}:${record.source?.id || record.id}`;
  const entropy = createHash('sha256').update(seed).digest();
  return ulidFrom(millis, entropy);
}

export function momentDocFromRecord(record, { importedAt }) {
  const id = momentIdFor(record);
  const text = String(record.text || '');
  const createdAt = record.createdAt || `${record.date}T00:00:00Z`;
  const month = createdAt.slice(0, 7);
  return {
    id,
    entryId: id,
    type: 'moment',
    schemaVersion: 1,
    entryType: 'moment',
    month,
    phase: record.phase || 'fantasy',
    section: record.section || 'daily',
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    title: record.title || '',
    text,
    html: toHtml(text),
    summary: record.summary || text.replace(/\s+/g, ' ').slice(0, 120),
    publishedAt: createdAt,
    createdAt,
    updatedAt: new Date().toISOString(),
    status: 'published',
    visibility: 'public',
    author: '',
    counts: {
      likes: Number(record.historicalInteractions?.likeCount) || 0,
      views: 0,
      comments: Number(record.historicalInteractions?.commentCount)
        || (record.historicalInteractions?.comments?.length ?? 0),
    },
    cover: record.cover || null,
    media: Array.isArray(record.media) ? record.media : [],
    video: record.video || null,
    contentHash: contentHash(text),
    pinned: false,
    featured: false,
    origin: {
      provider: record.source?.provider || 'qq',
      ref: record.source?.id || '',
      sourceUrl: record.source?.url || '',
      visibility: record.source?.visibility || 'unknown',
      warnings: record.source?.warnings || [],
      importedAt,
    },
  };
}

export function momentDocsFromRecords(records) {
  const importedAt = new Date().toISOString();
  const docs = new Map();
  for (const record of records || []) {
    if (record.publishStatus && record.publishStatus !== 'published') continue;
    const doc = momentDocFromRecord(record, { importedAt });
    docs.set(doc.id, doc);
  }
  return [...docs.values()];
}

/** upsert 到 content-moments（分区键 /month）。返回写入条数。 */
export async function upsertMomentDocs(docs) {
  if (!docs?.length) return 0;
  const container = clients().cosmos.container('content-moments');
  let written = 0;
  for (const doc of docs) {
    await container.items.upsert(doc, { partitionKey: doc.month });
    written += 1;
  }
  return written;
}
