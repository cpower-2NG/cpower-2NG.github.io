// 内容管理的纯函数层：标签计划、封面候选、系列排序与动态开关。
// 不接触 Cosmos，全部输入输出都是普通数据，便于单测。
import { HttpError } from './errors.js';

export function normalizeTag(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function normalizeTags(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const tag = normalizeTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** 条目 tags 前后差异，新增项要登记进 taxonomy（D-27），移除项不删文档（可能仍被其他条目使用）。 */
export function diffTags(current, next) {
  const before = new Set(current || []);
  const after = new Set(next || []);
  return {
    added: [...after].filter((tag) => !before.has(tag)),
    removed: [...before].filter((tag) => !after.has(tag)),
  };
}

/**
 * 标签重命名与合并共用一条路径：把条目上的 from 换成 to。
 * rename 与 merge 的区别只在调用方是否先建目标 tag 文档。
 */
export function planTagReplace(entries, from, to) {
  const source = normalizeTag(from);
  const target = normalizeTag(to);
  if (!source) throw new HttpError(400, '缺少要改名或合并的标签。', 'MISSING_TAG');
  if (!target) throw new HttpError(400, '缺少目标标签。', 'MISSING_TAG');
  if (source === target) {
    throw new HttpError(400, '源标签与目标标签相同。', 'SAME_TAG');
  }
  const updates = [];
  for (const entry of entries || []) {
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (!tags.includes(source)) continue;
    updates.push({
      entryId: entry.id,
      tags: normalizeTags([...tags.filter((tag) => tag !== source), target]),
    });
  }
  return { from: source, to: target, updates };
}

/** 从条目列表汇总标签使用计数，按数量降序。 */
export function countTagUsage(entries) {
  const counts = new Map();
  for (const entry of entries || []) {
    for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

/** 系列成员排序：nextIds 必须是 currentIds 的完整重排，不允许增删成员。 */
export function assertReorderOf(currentIds, nextIds) {
  const current = (currentIds || []).filter(Boolean);
  const next = (nextIds || []).filter(Boolean);
  const sameSet = current.length === next.length && new Set(current).size === new Set(next).size
    && next.every((id) => current.includes(id));
  if (!sameSet) {
    throw new HttpError(400, '成员列表必须是现有成员的重排，增删成员请改条目的系列归属。', 'INVALID_MEMBER_ORDER');
  }
  return next;
}

/** 系列成员应用计划：按 nextIds 顺序写 seriesOrder，不在列表里的现有成员被移出系列。 */
export function planSeriesMembers(seriesId, currentMemberIds, nextMemberIds) {
  const ordered = (nextMemberIds || []).filter(Boolean);
  const current = new Set(currentMemberIds || []);
  const assignments = ordered.map((entryId, index) => ({ entryId, seriesId, seriesOrder: index + 1 }));
  const removals = [...current].filter((entryId) => !ordered.includes(entryId));
  return { assignments, removals };
}

/**
 * 封面候选：当前封面排最前并标记，其余按导入顺序。
 * assets 是归属该条目的 asset 文档列表。
 */
export function pickCoverCandidates(assets, currentAssetId) {
  const list = (assets || []).map((asset) => ({
    assetId: asset.id,
    blobUrl: asset.blobUrl || '',
    mime: asset.mime || '',
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    sourceName: asset.sourceFile || asset.alt || '',
  }));
  list.sort((a, b) => a.assetId.localeCompare(b.assetId));
  if (currentAssetId) {
    const index = list.findIndex((asset) => asset.assetId === currentAssetId);
    if (index > 0) {
      const [current] = list.splice(index, 1);
      list.unshift({ ...current, isCurrent: true });
    } else if (index === 0) {
      list[0].isCurrent = true;
    }
  }
  return list;
}

export function normalizeMomentFlags(input = {}) {
  const flags = {};
  if (input.pinned !== undefined) flags.pinned = Boolean(input.pinned);
  if (input.featured !== undefined) flags.featured = Boolean(input.featured);
  if (!Object.keys(flags).length) {
    throw new HttpError(400, '没有要修改的置顶或精选字段。', 'EMPTY_FLAGS');
  }
  return flags;
}

/** 与 tools/lib/content-common.mjs 的 slugify 同约定：NFKC、保留 CJK 字母、其余折叠为连字符。 */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** 条目标题/摘要编辑补丁：title 必填非空、summary 允许空串清空，其余字段不接受。 */
export function parseEntryMetaPatch(body) {
  const patch = {};
  if (body?.title !== undefined) {
    const title = String(body.title ?? '').trim();
    if (!title) throw new HttpError(400, '标题不能为空。', 'INVALID_INPUT');
    if (title.length > 200) throw new HttpError(400, '标题不能超过 200 个字符。', 'INVALID_INPUT');
    patch.title = title;
  }
  if (body?.summary !== undefined) {
    const summary = String(body.summary ?? '').trim();
    if (summary.length > 400) throw new HttpError(400, '摘要不能超过 400 个字符。', 'INVALID_INPUT');
    patch.summary = summary;
  }
  return patch;
}
