// 删除复查的轮转队列（纯函数，有单测覆盖）。
//
// 背景：删除复查需要知道"哪些内容记录最久没检查"。曾经的做法是每轮同步把仓库里
// 全部内容记录（2500+ 文件）逐个下载——单轮消耗 ~2600 个 GitHub API 请求，直接把
// App 安装的每小时配额打穿，后续同步静默失败。改为在 Cosmos 里维护一个记录 id 的
// 轮转队列：每轮只取队首 N 条下载复查，复查完的挪到队尾，严格轮转。
// 每轮 GitHub 用量 = 1 次 tree + N 次 blob ≈ 30 个请求。

/**
 * 计算本轮应复查的批次。
 * @param {string[]} queue 现存队列（上次保存的 id 顺序）。
 * @param {Iterable<string>} knownIds 仓库里当前实际存在的记录 id。
 * @param {number} size 批大小。
 * @returns {{ batch: string[], rest: string[], total: number }}
 *   batch=本轮待复查，rest=剩余队列（不含 batch），total=合并后的总队列长度。
 *   队列里已不存在的 id 被剔除；仓库新增的 id 追加到队尾。
 */
export function nextRecheckBatch(queue, knownIds, size = 20) {
  const known = new Set(knownIds);
  const kept = (Array.isArray(queue) ? queue : []).filter((id) => known.has(id));
  const appended = [...known].filter((id) => !kept.includes(id));
  const full = [...kept, ...appended];
  return {
    batch: full.slice(0, size),
    rest: full.slice(size),
    total: full.length,
  };
}

/** 批次复查完挪到队尾，实现轮转；跳过本轮缺失/损坏的 id。 */
export function rotateQueue(rest, batch, skippedIds = []) {
  const skipped = new Set(skippedIds);
  return [...rest, ...batch.filter((id) => !skipped.has(id))];
}
