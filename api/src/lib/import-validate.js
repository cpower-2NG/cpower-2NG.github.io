// 上传导入的输入校验（纯函数）：扩展名白名单、体积上限与表单字段规范化。
import { HttpError, assert } from './errors.js';

export const ALLOWED_UPLOAD_EXTENSIONS = ['docx', 'doc', 'pdf', 'txt', 'md', 'markdown', 'html', 'htm'];

export const IMPORT_PHASES = ['logic', 'fantasy'];

export const IMPORT_SECTIONS = [
  'review', 'activity', 'essay', 'archive', // fantasy
  'docs', 'notes', 'algo', // logic（showcase 是页面，不允许上传目标）
];

export function fileExtension(filename) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

/** 上传文件的白名单与体积校验，返回去掉路径成分的安全文件名。 */
export function assertUploadable({ filename, bytes, maxBytes, allowedExtensions = ALLOWED_UPLOAD_EXTENSIONS }) {
  const safeName = String(filename || '').split(/[\\/]/).pop() || '';
  assert(safeName && safeName !== '.' && safeName !== '..', 400, '文件名无效。', 'INVALID_UPLOAD');
  const ext = fileExtension(safeName);
  assert(
    allowedExtensions.includes(ext),
    400,
    `不支持的文件类型 .${ext || '(无后缀)'}，允许：${allowedExtensions.join(' / ')}`,
    'UNSUPPORTED_UPLOAD_TYPE',
  );
  assert(Number(bytes) > 0, 400, '上传文件为空。', 'INVALID_UPLOAD');
  assert(
    Number(bytes) <= maxBytes,
    413,
    `文件超过体积上限（${Math.round(maxBytes / 1024 / 1024)}MB）。`,
    'UPLOAD_TOO_LARGE',
  );
  return { safeName, ext };
}

/** 导入表单字段规范化：标题、位面、分区、标签、封面序号。 */
export function parseImportForm(fields = {}) {
  const title = String(fields.title ?? '').trim().slice(0, 200);
  const phase = String(fields.phase ?? 'fantasy').trim();
  assert(IMPORT_PHASES.includes(phase), 400, '位面只能是 logic 或 fantasy。', 'INVALID_INPUT');
  const section = String(fields.section ?? (phase === 'logic' ? 'docs' : 'essay')).trim();
  assert(IMPORT_SECTIONS.includes(section), 400, `分区无效，允许：${IMPORT_SECTIONS.join(' / ')}`, 'INVALID_INPUT');
  const tags = String(fields.tags ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 20);
  const coverIndexRaw = String(fields.coverIndex ?? '').trim();
  const coverIndex = coverIndexRaw ? Number(coverIndexRaw) : 0;
  assert(Number.isInteger(coverIndex) && coverIndex >= 0, 400, '封面序号必须是非负整数。', 'INVALID_INPUT');
  return { title, phase, section, tags, coverIndex };
}

/** 导入任务文档的状态机取值。 */
export function assertTaskStatus(status) {
  assert(
    ['queued', 'running', 'succeeded', 'failed'].includes(status),
    400,
    '导入任务状态无效。',
    'INVALID_INPUT',
  );
  return status;
}

export function taskNotFoundError() {
  return new HttpError(404, '导入任务不存在。', 'IMPORT_TASK_NOT_FOUND');
}
