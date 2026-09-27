import { assert, HttpError } from './errors.js';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function text(value, field, { min = 0, max = 2000, required = false } = {}) {
  const normalized = String(value ?? '').replace(CONTROL_CHARACTERS, '').trim();
  if (required) {
    assert(normalized.length >= min, 400, `${field}不能为空。`, 'INVALID_INPUT');
  }
  assert(normalized.length <= max, 400, `${field}不能超过 ${max} 个字符。`, 'INVALID_INPUT');
  return normalized;
}

export function optionalWebsite(value) {
  const raw = text(value, '个人网站', { max: 200 });
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, '个人网站必须是合法的 HTTP 或 HTTPS 地址。', 'INVALID_URL');
  }
  assert(['http:', 'https:'].includes(url.protocol), 400, '个人网站必须是 HTTP 或 HTTPS 地址。', 'INVALID_URL');
  return url.toString();
}

export function interactionPath(value) {
  const path = text(value, '文章路径', { min: 8, max: 240, required: true });
  assert(
    /^\/content\/(?:logic|fantasy)\/(?:article|diary)\/[A-Za-z0-9._/-]+\.html$/.test(path),
   400,
    '文章路径无效。',
   'INVALID_PATH',
  );
  return path;
}

export function identifier(value, field, max = 120) {
  const normalized = text(value, field, { min: 1, max, required: true });
  assert(/^[A-Za-z0-9._:-]+$/.test(normalized), 400, `${field}格式无效。`, 'INVALID_INPUT');
  return normalized;
}

export function email(value) {
  const normalized = text(value, '邮箱', { max: 200 }).toLowerCase();
  if (!normalized) return '';
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized), 400, '邮箱格式无效。', 'INVALID_EMAIL');
  return normalized;
}

export function enumValue(value, allowed, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value);
  assert(allowed.includes(normalized), 400, '请求参数无效。', 'INVALID_INPUT');
  return normalized;
}
