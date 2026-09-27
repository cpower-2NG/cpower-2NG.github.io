import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { HttpError } from './errors.js';

const jwksCache = new Map();

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

export async function requireAdmin(request) {
  const current = config();
  if (current.adminDevBypass && current.nodeEnv !== 'production') {
    return { oid: 'local-dev', name: 'Local Admin' };
  }

  if (!current.entraTenantId || !current.entraClientId || !current.entraApiAudience) {
    throw new HttpError(503, '管理认证尚未配置。', 'ADMIN_AUTH_NOT_CONFIGURED');
  }

  const token = bearerToken(request);
  if (!token) {
    throw new HttpError(401, '需要登录后才能执行管理操作。', 'AUTH_REQUIRED');
  }

  let jwks = jwksCache.get(current.entraTenantId);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${current.entraTenantId}/discovery/v2.0/keys`),
    );
    jwksCache.set(current.entraTenantId, jwks);
  }

  let payload;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: [
        `https://login.microsoftonline.com/${current.entraTenantId}/v2.0`,
        `https://sts.windows.net/${current.entraTenantId}/`,
      ],
      audience: [current.entraClientId, current.entraApiAudience].filter(Boolean),
    });
    payload = result.payload;
  } catch {
    throw new HttpError(401, '登录状态无效或已过期。', 'INVALID_TOKEN');
  }

  const oid = String(payload.oid || '');
  if (!oid || !current.adminObjectIds.includes(oid)) {
    throw new HttpError(403, '当前账号没有管理权限。', 'ADMIN_FORBIDDEN');
  }

  return {
    oid,
    name: String(payload.name || 'Site Owner'),
  };
}

export async function optionalAdmin(request) {
  if (!bearerToken(request)) return null;
  try {
    return await requireAdmin(request);
  } catch {
    return null;
  }
}
