// 展示层格式化与状态中文映射。所有面向用户的枚举翻译集中在这里。

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/** 剩余毫秒转 mm:ss 倒计时文案。 */
export function fmtCountdown(remainingMs) {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export const QZONE_STATE = {
  connected: '已连接',
  not_connected: '未连接',
  auth_required: '需要扫码',
  auth_failed: '登录失败',
};

export const SYNC_STATE = {
  idle: '空闲',
  running: '同步进行中',
  dry_run_complete: '验收完成',
  failed: '同步失败',
};

/** 同步审查原因 → 中文说明（与 sync/src/rules.js 的枚举对应）。 */
export const REVIEW_REASON = {
  AUTO_PUBLISH_DISABLED: '未开启自动发布',
  EMPTY_POST: '空内容',
  CHECK_IN: '签到记录',
  APP_SHARE: '应用分享',
  EXCLUDED_KEYWORD: '命中排除词',
  UNKNOWN_VISIBILITY: '可见性未知',
  MEDIA_INCOMPLETE: '媒体抓取不完整',
  SENSITIVE_TEXT: '含敏感信息',
  IMAGE_POST_DISABLED: '图片内容未启用',
  VIDEO_REPOST_DISABLED: '视频内容未启用',
};

export const PUBLISH_STATUS = {
  published: '可发布',
  pending: '待审查',
  quarantined: '已隔离',
};

export const IMPORT_STATUS = {
  queued: '排队中',
  running: '转换中',
  succeeded: '已入库',
  failed: '失败',
};

export const COMMENT_STATUS = {
  published: '已发布',
  pending: '待审核',
  hidden: '已隐藏',
  deleted: '已删除',
};

export const COVER_SOURCE = {
  manual: '手动封面',
  'auto-first': '首图封面',
  text: '文字封面',
};

/** 与 api/src/lib/import-validate.js 的 IMPORT_SECTIONS 保持一致。 */
export const UPLOAD_SECTIONS = {
  fantasy: ['essay', 'review', 'activity', 'archive'],
  logic: ['docs', 'notes', 'algo'],
};

export const PHASE_LABEL = { fantasy: 'Fantasy', logic: 'Logic' };

/** 同步报告把待审/隔离记录混在 records 里，这里按状态分桶。 */
export function bucketReportRecords(report) {
  const records = Array.isArray(report?.records) ? report.records : [];
  return {
    pending: records.filter((record) => record.publishStatus !== 'published'),
    published: records.filter((record) => record.publishStatus === 'published'),
  };
}

/** 一条记录的覆盖键：优先 QQ 动态源 id，其次记录 id。 */
export function overrideKeyFor(record) {
  const sourceId = record?.source?.id || '';
  return sourceId ? `id:${sourceId}` : `path:${record.id}`;
}
