import { config } from './config.js';
import { HttpError } from './errors.js';

export function corsHeaders(request, overrides = {}) {
  const current = config();
  const origin = request.headers.get('origin') || '';
  const allowed = current.allowedOrigins.includes(origin)
    || (current.nodeEnv !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin));
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    ...overrides,
  };
}

export function json(request, body, status = 200, headers = {}) {
  return {
    status,
    headers: corsHeaders(request, headers),
    jsonBody: body,
  };
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, '请求体必须是合法 JSON。', 'INVALID_JSON');
  }
}

export function handleError(request, error, context) {
  if (error instanceof HttpError) {
    return json(request, { error: error.code, message: error.message }, error.status);
  }
  context.error(error);
  return json(request, { error: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }, 500);
}
