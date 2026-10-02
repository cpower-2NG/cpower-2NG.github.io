import { createHash, createHmac, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { cosmosContainers } from './cosmos.js';
import { HttpError } from './errors.js';
import { diffTags, normalizeTags } from './content-admin.js';

function hashSecret(value) {
  const current = config();
  return createHmac('sha256', current.hashSalt || 'bifrost-dev-only').update(String(value)).digest('hex');
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function metricDocument(entryId) {
  return {
    id: 'metric',
    type: 'metric',
    entryId,
    likes: 0,
    views: 0,
    comments: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function readMetric(entryId) {
  const { signals } = cosmosContainers();
  let existing;
  try {
    existing = (await signals.item('metric', entryId).read())?.resource;
  } catch (error) {
    if (error.code !== 404) throw error;
  }
  if (existing) {
    return existing;
  }
  const metric = metricDocument(entryId);
  try {
    await signals.items.create(metric);
  } catch (createError) {
    if (createError.code !== 409) throw createError;
    return (await signals.item('metric', entryId).read())?.resource || metric;
  }
  return metric;
}

async function patchMetric(entryId, operations) {
  const { signals } = cosmosContainers();
  await readMetric(entryId);
  try {
    const result = await signals.item('metric', entryId).patch(operations);
    return result.resource;
  } catch (error) {
    if (error.code !== 404) throw error;
    return readMetric(entryId);
  }
}

export async function claimRateLimit(key, { windowSeconds, maximum }) {
  const { rateLimits } = cosmosContainers();
  const id = `rl:${shortHash(key)}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + windowSeconds;
  let record;
  try {
    record = (await rateLimits.item(id, id).read()).resource;
  } catch (error) {
    if (error.code !== 404) throw error;
    record = null;
  }
  if (!record) {
    record = {
      id,
      key: id,
      count: 0,
      expiresAt,
      ttl: windowSeconds,
    };
  }

  if (!record.expiresAt || record.expiresAt <= now) {
    record.count = 0;
    record.expiresAt = expiresAt;
    record.ttl = windowSeconds;
  }
  record.count += 1;
  record.updatedAt = new Date().toISOString();
  await rateLimits.items.upsert(record);
  return {
    allowed: record.count <= maximum,
    remaining: Math.max(0, maximum - record.count),
    retryAfter: Math.max(1, record.expiresAt - now),
  };
}

export function requestIpHash(request) {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const forwardedParts = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
  const ip = request.headers.get('x-azure-clientip')
    || forwardedParts.at(-1)
    || request.headers.get('x-real-ip')
    || 'unknown';
  return hashSecret(`ip:${ip}`);
}

export function visitorHash(visitorId) {
  return hashSecret(`visitor:${visitorId}`);
}

/**
 * 批量摘要：时间流里一次取回多条动态的计数，避免逐条请求。
 * 三条查询都是跨分区聚合，但一次搞定，比 N 次点读便宜得多。
 */
export async function getInteractionSummaries(entryIds, viewerId) {
  const ids = [...new Set((entryIds || []).filter(Boolean))].slice(0, 60);
  if (!ids.length) return [];
  const { signals, comments } = cosmosContainers();
  const viewer = visitorHash(viewerId);

  const [metrics, reactions, commentCounts] = await Promise.all([
    signals.items.query({
      query: "SELECT c.entryId, c.likes, c.views FROM c WHERE c.type = 'metric' AND ARRAY_CONTAINS(@ids, c.entryId)",
      parameters: [{ name: '@ids', value: ids }],
    }).fetchAll(),
    signals.items.query({
      query: "SELECT c.entryId, c.active FROM c WHERE c.type = 'reaction' AND c.visitorHash = @viewer AND ARRAY_CONTAINS(@ids, c.entryId)",
      parameters: [{ name: '@viewer', value: viewer }, { name: '@ids', value: ids }],
    }).fetchAll(),
    comments.items.query({
      query: "SELECT c.entryId, COUNT(1) AS n FROM c WHERE c.type = 'comment' AND c.status = 'published' AND ARRAY_CONTAINS(@ids, c.entryId) GROUP BY c.entryId",
      parameters: [{ name: '@ids', value: ids }],
    }).fetchAll(),
  ]);

  const metricByEntry = new Map(metrics.resources.map((item) => [item.entryId, item]));
  const likedByEntry = new Map(reactions.resources.map((item) => [item.entryId, Boolean(item.active)]));
  const commentsByEntry = new Map(commentCounts.resources.map((item) => [item.entryId, Number(item.n) || 0]));

  return ids.map((entryId) => ({
    entryId,
    likes: Number(metricByEntry.get(entryId)?.likes) || 0,
    views: Number(metricByEntry.get(entryId)?.views) || 0,
    commentCount: commentsByEntry.get(entryId) || 0,
    liked: likedByEntry.get(entryId) || false,
  }));
}

export async function getInteractionSummary(entryId, viewerId) {
  const { comments } = cosmosContainers();
  const metric = await readMetric(entryId);
  const viewer = visitorHash(viewerId);
  let liked = false;
  try {
    const response = await cosmosContainers().signals.item(`reaction-${viewer}`, entryId).read();
    liked = Boolean(response?.resource?.active);
  } catch (error) {
    if (error.code !== 404) throw error;
  }

  const result = await comments.items.query(
    {
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'comment' AND c.status = 'published'",
    },
    { partitionKey: entryId },
  ).fetchAll();
  const commentCount = Number(result.resources[0]) || Number(metric.comments) || 0;
  return {
    likes: Number(metric.likes) || 0,
    views: Number(metric.views) || 0,
    commentCount,
    liked,
  };
}

export async function listComments(entryId, viewerId, { limit = 100, cursor = '' } = {}) {
  const { comments } = cosmosContainers();
  const response = await comments.items.query(
    {
      query: "SELECT * FROM c WHERE c.type = 'comment' AND c.status = 'published'",
    },
    { partitionKey: entryId },
  ).fetchAll();
  const all = response.resources.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const visible = all.map((item) => ({
    id: item.id,
    entryId: item.entryId,
    nickname: item.anonymous ? '匿名用户' : item.nickname,
    avatarUrl: item.avatarUrl || '',
    website: item.website || '',
    content: item.content,
    rootId: item.rootId || null,
    replyToId: item.replyToId || null,
    isOwner: Boolean(item.isOwner),
    createdAt: item.createdAt,
  }));
  const allRoots = visible.filter((item) => !item.rootId);
  const start = cursor ? Math.max(0, allRoots.findIndex((item) => item.id === cursor) + 1) : 0;
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const roots = allRoots.slice(start, start + safeLimit);
  const nextCursor = start + safeLimit < allRoots.length ? roots.at(-1)?.id || '' : '';
  const replies = new Map();
  visible
    .filter((item) => item.rootId)
    .forEach((item) => {
      const list = replies.get(item.rootId) || [];
      list.push(item);
      replies.set(item.rootId, list);
    });
  return {
    items: roots.map((root) => ({
      ...root,
      replies: replies.get(root.id) || [],
    })),
    nextCursor,
  };
}

export async function addComment(input) {
  const { comments } = cosmosContainers();
  const id = randomUUID();
  const now = new Date().toISOString();
  let rootId = null;
  let replyToId = null;

  if (input.parentId) {
    let parent;
    try {
      parent = (await comments.item(input.parentId, input.entryId).read()).resource;
    } catch (error) {
      if (error.code === 404) {
        throw new HttpError(404, '要回复的评论不存在。', 'COMMENT_NOT_FOUND');
      }
      throw error;
    }
    if (!parent) {
      throw new HttpError(404, '要回复的评论不存在。', 'COMMENT_NOT_FOUND');
    }
    if (parent.status !== 'published') {
      throw new HttpError(404, '要回复的评论不存在。', 'COMMENT_NOT_FOUND');
    }
    rootId = parent.rootId || parent.id;
    replyToId = parent.id;
  }

  const duplicate = await comments.items.query(
    {
      query: "SELECT TOP 1 c.id FROM c WHERE c.type = 'comment' AND c.fingerprint = @fingerprint AND c.status IN ('published', 'pending')",
      parameters: [{ name: '@fingerprint', value: input.fingerprint }],
    },
    { partitionKey: input.entryId },
  ).fetchAll();
  if (duplicate.resources.length) {
    throw new HttpError(409, '这条评论已经提交过了。', 'DUPLICATE_COMMENT');
  }

  const document = {
    id,
    type: 'comment',
    entryId: input.entryId,
    parentId: input.parentId || null,
    rootId,
    replyToId,
    nickname: input.nickname,
    anonymous: input.anonymous,
    emailHash: input.emailHash,
    avatarUrl: input.avatarUrl,
    website: input.website,
    content: input.content,
    status: input.status,
    moderationReason: input.moderationReason || '',
    isOwner: input.isOwner,
    fingerprint: input.fingerprint,
    visitorHash: input.visitorHash,
    ipHash: input.ipHash,
    userAgentHash: input.userAgentHash,
    createdAt: now,
    updatedAt: now,
  };
  await comments.items.create(document);
  if (document.status === 'published') {
    await patchMetric(input.entryId, [{ op: 'incr', path: '/comments', value: 1 }]);
  }
  return {
    id,
    status: document.status,
    createdAt: now,
  };
}

export async function toggleReaction(entryId, requestKey) {
  const { signals } = cosmosContainers();
  const viewer = visitorHash(requestKey);
  const id = `reaction-${viewer}`;
  let document;
  try {
    document = (await signals.item(id, entryId).read()).resource;
  } catch (error) {
    if (error.code !== 404) throw error;
  }
  if (!document) {
    document = {
      id,
      type: 'reaction',
      entryId,
      visitorHash: viewer,
      active: false,
      createdAt: new Date().toISOString(),
    };
  }

  const active = !document.active;
  document.active = active;
  document.updatedAt = new Date().toISOString();
  await signals.items.upsert(document);
  const metric = await patchMetric(entryId, [{ op: 'incr', path: '/likes', value: active ? 1 : -1 }]);
  return {
    liked: active,
    likes: Math.max(0, Number(metric.likes) || 0),
  };
}

export async function recordView(entryId, visitorId) {
  const { signals } = cosmosContainers();
  const viewer = visitorHash(visitorId);
  const day = new Date().toISOString().slice(0, 10);
  const id = `view-${day}-${viewer}`;
  const document = {
    id,
    type: 'view',
    entryId,
    visitorHash: viewer,
    day,
    createdAt: new Date().toISOString(),
    ttl: 60 * 60 * 24 * 180,
  };
  try {
    await signals.items.create(document);
    await patchMetric(entryId, [{ op: 'incr', path: '/views', value: 1 }]);
  } catch (error) {
    if (error.code !== 409) throw error;
  }
  return getInteractionSummary(entryId, visitorId);
}

export async function listAllComments({ entryId = '', status = '' } = {}) {
  const { comments } = cosmosContainers();
  const clauses = ["c.type = 'comment'"];
  const parameters = [];
  if (entryId) {
    clauses.push('c.entryId = @entryId');
    parameters.push({ name: '@entryId', value: entryId });
  }
  if (status) {
    clauses.push('c.status = @status');
    parameters.push({ name: '@status', value: status });
  }
  const result = await comments.items.query({
    query: `SELECT * FROM c WHERE ${clauses.join(' AND ')} ORDER BY c.createdAt DESC`,
    parameters,
  }).fetchAll();
  return result.resources;
}

export async function commentStatusCounts() {
  const { comments } = cosmosContainers();
  const result = await comments.items.query({
    query: "SELECT c.status, COUNT(1) AS n FROM c WHERE c.type = 'comment' GROUP BY c.status",
  }).fetchAll();
  return Object.fromEntries(result.resources.map((item) => [item.status, Number(item.n) || 0]));
}

export async function updateCommentStatus(id, entryId, status) {
  const { comments } = cosmosContainers();
  const item = comments.item(id, entryId);
  const current = (await item.read()).resource;
  if (!current) {
    throw new HttpError(404, '评论不存在。', 'COMMENT_NOT_FOUND');
  }
  const wasVisible = current.status === 'published';
  const isVisible = status === 'published';
  const updated = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
  };
  await item.replace(updated);
  if (wasVisible !== isVisible) {
    await patchMetric(entryId, [{ op: 'incr', path: '/comments', value: isVisible ? 1 : -1 }]);
  }
  return updated;
}

export async function readState(id, partitionKey) {
  const { state } = cosmosContainers();
  try {
    return (await state.item(id, partitionKey).read()).resource || null;
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

export async function writeState(id, partitionKey, value) {
  const { state } = cosmosContainers();
  const document = {
    ...value,
    id,
    partitionKey,
    type: value.type || partitionKey,
    updatedAt: new Date().toISOString(),
  };
  await state.items.upsert(document);
  return document;
}

export async function collectExportRecords() {
  const containers = cosmosContainers();
  const comments = await containers.comments.items.query({
    query: "SELECT * FROM c WHERE c.type = 'comment' AND c.status IN ('published', 'hidden', 'pending', 'deleted')",
  }).fetchAll();
  const signals = await containers.signals.items.query({
    query: "SELECT * FROM c WHERE c.type IN ('metric', 'reaction')",
  }).fetchAll();
  return [...comments.resources, ...signals.resources].map((record) => ({
    exportedAt: new Date().toISOString(),
    ...record,
    emailHash: undefined,
    fingerprint: undefined,
    ipHash: undefined,
    visitorHash: undefined,
    userAgentHash: undefined,
  }));
}

// ---------------------------------------------------------------------------
// 内容管理（条目、系列、标签、动态）。content-articles 分区键 /entryId，
// 条目文档 id = entryId，正文文档 id 固定 'body'；taxonomy 分区键 /kind（值为 phase/section/tag/series）。
// ---------------------------------------------------------------------------

const ENTRY_SUMMARY = 'c.id, c.entryType, c.kind, c.phase, c.section, c.title, c.summary, c.slug, c.path, c.tags, c.seriesId, c.seriesOrder, c.status, c.publishedAt, c.cover, c.coverSource, c.updatedAt';

async function readEntryDoc(entryId) {
  const { contentArticles } = cosmosContainers();
  try {
    return (await contentArticles.item(entryId, entryId).read()).resource || null;
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

async function replaceEntryDoc(entry) {
  const { contentArticles } = cosmosContainers();
  const updated = { ...entry, updatedAt: new Date().toISOString() };
  await contentArticles.item(entry.id, entry.id).replace(updated);
  return updated;
}

export async function listEntries({ phase = '', section = '', status = '' } = {}) {
  const { contentArticles } = cosmosContainers();
  const clauses = ["c.type = 'entry'"];
  const parameters = [];
  if (phase) {
    clauses.push('c.phase = @phase');
    parameters.push({ name: '@phase', value: phase });
  }
  if (section) {
    clauses.push('c.section = @section');
    parameters.push({ name: '@section', value: section });
  }
  if (status) {
    clauses.push('c.status = @status');
    parameters.push({ name: '@status', value: status });
  }
  const result = await contentArticles.items.query({
    query: `SELECT ${ENTRY_SUMMARY} FROM c WHERE ${clauses.join(' AND ')} ORDER BY c.publishedAt DESC`,
    parameters,
  }).fetchAll();
  return result.resources;
}

export async function getEntryDetail(entryId) {
  const { contentArticles, assets } = cosmosContainers();
  const entry = await readEntryDoc(entryId);
  if (!entry) {
    throw new HttpError(404, '条目不存在。', 'ENTRY_NOT_FOUND');
  }
  const body = (await contentArticles.item('body', entryId).read().catch(() => null))?.resource || null;
  const candidates = await assets.items.query({
    query: 'SELECT * FROM c WHERE ARRAY_CONTAINS(c.ownerEntryIds, @entryId)',
    parameters: [{ name: '@entryId', value: entryId }],
  }).fetchAll();
  return {
    entry: {
      id: entry.id,
      title: entry.title,
      summary: entry.summary || '',
      phase: entry.phase,
      section: entry.section,
      kind: entry.kind,
      status: entry.status,
      slug: entry.slug || '',
      path: entry.path || '',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      seriesId: entry.seriesId || null,
      seriesOrder: entry.seriesOrder ?? null,
      cover: entry.cover || null,
      coverSource: entry.coverSource || '',
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
      wordCount: body?.wordCount || 0,
    },
    coverCandidates: candidates.resources,
  };
}

export async function updateEntryCover(entryId, assetId) {
  const { assets } = cosmosContainers();
  const entry = await readEntryDoc(entryId);
  if (!entry) {
    throw new HttpError(404, '条目不存在。', 'ENTRY_NOT_FOUND');
  }
  if (!assetId) {
    return replaceEntryDoc({ ...entry, cover: null, coverSource: 'text' });
  }
  let asset;
  try {
    asset = (await assets.item(assetId, assetId).read()).resource;
  } catch (error) {
    if (error.code === 404) throw new HttpError(404, '封面媒体不存在。', 'ASSET_NOT_FOUND');
    throw error;
  }
  if (!asset) {
    throw new HttpError(404, '封面媒体不存在。', 'ASSET_NOT_FOUND');
  }
  return replaceEntryDoc({ ...entry, cover: { assetId }, coverSource: 'manual' });
}

export async function updateEntryTags(entryId, tags) {
  const entry = await readEntryDoc(entryId);
  if (!entry) {
    throw new HttpError(404, '条目不存在。', 'ENTRY_NOT_FOUND');
  }
  const next = normalizeTags(tags);
  const { added } = diffTags(entry.tags, next);
  for (const tag of added) {
    await ensureTagDoc(tag);
  }
  return replaceEntryDoc({ ...entry, tags: next });
}

export async function setEntrySeries(entryId, seriesId, seriesOrder) {
  const entry = await readEntryDoc(entryId);
  if (!entry) {
    throw new HttpError(404, '条目不存在。', 'ENTRY_NOT_FOUND');
  }
  return replaceEntryDoc({
    ...entry,
    seriesId: seriesId || null,
    seriesOrder: seriesId ? (Number(seriesOrder) || null) : null,
  });
}

export async function listMoments() {
  const { contentMoments } = cosmosContainers();
  const result = await contentMoments.items.query({
    query: 'SELECT c.id, c.month, c.section, c.phase, c.summary, c.text, c.publishedAt, c.pinned, c.featured, c.status FROM c ORDER BY c.publishedAt DESC',
  }).fetchAll();
  return result.resources;
}

export async function updateMomentFlags(id, month, flags) {
  const { contentMoments, searchDocs } = cosmosContainers();
  let moment;
  try {
    moment = (await contentMoments.item(id, month).read()).resource;
  } catch (error) {
    if (error.code === 404) throw new HttpError(404, '动态不存在。', 'MOMENT_NOT_FOUND');
    throw error;
  }
  if (!moment) {
    throw new HttpError(404, '动态不存在。', 'MOMENT_NOT_FOUND');
  }
  const updated = { ...moment, ...flags, updatedAt: new Date().toISOString() };
  await contentMoments.item(id, month).replace(updated);
  // 检索投影同步两个字段，避免发布前搜索面板读到旧值。
  try {
    const { resource: doc } = await searchDocs.item(id, id).read();
    if (doc) {
      await searchDocs.item(id, id).replace({ ...doc, ...flags });
    }
  } catch (error) {
    if (error.code !== 404) throw error;
  }
  return { id, month, ...flags };
}

async function readTaxonomyDoc(id, kind) {
  const { taxonomy } = cosmosContainers();
  try {
    return (await taxonomy.item(id, kind).read()).resource || null;
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

async function ensureTagDoc(label) {
  const { taxonomy } = cosmosContainers();
  const id = `tag:${label}`;
  const existing = await readTaxonomyDoc(id, 'tag');
  if (existing) return existing;
  const doc = {
    id,
    type: 'taxonomy',
    schemaVersion: 1,
    kind: 'tag',
    label,
    description: '',
    parentId: '',
    order: 0,
    aliases: [],
    status: 'active',
  };
  await taxonomy.items.upsert(doc);
  return doc;
}

export async function listSeries() {
  const { taxonomy } = cosmosContainers();
  const result = await taxonomy.items.query(
    { query: 'SELECT * FROM c WHERE c.status = \'active\'' },
    { partitionKey: 'series' },
  ).fetchAll();
  return result.resources;
}

export async function createSeries({ label, description = '', slug, coverAssetId = '' }) {
  const { taxonomy } = cosmosContainers();
  const id = `series:${slug}`;
  if (await readTaxonomyDoc(id, 'series')) {
    throw new HttpError(409, '同名系列已存在。', 'SERIES_EXISTS');
  }
  const doc = {
    id,
    type: 'taxonomy',
    schemaVersion: 1,
    kind: 'series',
    label,
    description,
    cover: coverAssetId ? { assetId: coverAssetId } : null,
    parentId: '',
    order: 0,
    aliases: [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  await taxonomy.items.upsert(doc);
  return doc;
}

export async function updateSeries(id, { label, description, coverAssetId } = {}) {
  const existing = await readTaxonomyDoc(id, 'series');
  if (!existing) {
    throw new HttpError(404, '系列不存在。', 'SERIES_NOT_FOUND');
  }
  const updated = {
    ...existing,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(coverAssetId !== undefined ? { cover: coverAssetId ? { assetId: coverAssetId } : null } : {}),
    updatedAt: new Date().toISOString(),
  };
  const { taxonomy } = cosmosContainers();
  await taxonomy.item(id, 'series').replace(updated);
  return updated;
}

export async function deleteSeries(id) {
  const { taxonomy } = cosmosContainers();
  try {
    await taxonomy.item(id, 'series').delete();
  } catch (error) {
    if (error.code === 404) throw new HttpError(404, '系列不存在。', 'SERIES_NOT_FOUND');
    throw error;
  }
}

/**
 * 标签重命名/合并落地：确保目标 tag 文档存在，批量改条目，再删除源 tag 文档。
 * 条目更新使用点读+替换，条目数量级（几十）下足够，且每条都幂等。
 */
export async function applyTagReplace({ from, to, updates }) {
  await ensureTagDoc(to);
  let updated = 0;
  for (const update of updates) {
    const entry = await readEntryDoc(update.entryId);
    if (!entry) continue;
    await replaceEntryDoc({ ...entry, tags: update.tags });
    updated += 1;
  }
  const { taxonomy } = cosmosContainers();
  try {
    await taxonomy.item(`tag:${from}`, 'tag').delete();
  } catch (error) {
    if (error.code !== 404) throw error;
  }
  return { updated, to };
}
