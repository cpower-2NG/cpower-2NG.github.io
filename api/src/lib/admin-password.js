import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

const KEY_LENGTH = 32;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;

/**
 * 确定性口令哈希：scrypt(password::username, salt)，自带随机盐。
 * 存储格式 `scrypt$<盐hex>$<哈希hex>`，盐随哈希一起保存，
 * 与全局 HASH_SALT 解耦：环境里只需要一份自包含的 ADMIN_PASSWORD_HASH。
 * 生成方式见 tools/generate-admin-hash.mjs。
 */
export function hashPassword(username, password, saltHex = randomBytes(16).toString('hex')) {
  const derived = scryptSync(credentialMessage(username, password), Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return `scrypt$${saltHex}$${derived.toString('hex')}`;
}

function credentialMessage(username, password) {
  return `${String(username).trim().toLowerCase()}::${String(password)}`;
}

/** 恒时比较；格式不合法或配置缺失一律判负。 */
export function verifyPassword(username, password, expectedHash) {
  const match = /^scrypt\$([0-9a-f]{32,})\$([0-9a-f]{64})$/.exec(String(expectedHash || ''));
  if (!match) return false;
  const [, saltHex, expected] = match;
  const actual = scryptSync(credentialMessage(username, password), Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

/**
 * 无状态会话令牌：bfs_<payload>.<hmac>。不落库、不占 Cosmos 读，
 * 管理请求在每个实例上都能独立校验；过期由 payload.exp 控制。
 */
export function issueSessionToken(user, current, issuedAt = Date.now()) {
  const ttlMs = current.adminSessionTtlHours * 3600 * 1000;
  const exp = issuedAt + ttlMs;
  const payload = Buffer.from(JSON.stringify({
    sub: user.name,
    via: 'password',
    exp,
  })).toString('base64url');
  const signature = createHmac('sha256', current.adminSessionSecret).update(payload).digest('base64url');
  return {
    token: `bfs_${payload}.${signature}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

/** 校验失败一律返回 null，不区分篡改与过期，避免给爆破者反馈。 */
export function verifySessionToken(token, current, now = Date.now()) {
  const match = /^bfs_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!match || !current.adminSessionSecret) return null;
  const [, payload, signature] = match;
  const expected = Buffer.from(
    createHmac('sha256', current.adminSessionSecret).update(payload).digest('base64url'),
  );
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (data?.via !== 'password' || typeof data.exp !== 'number' || data.exp <= now || !data.sub) {
    return null;
  }
  return { oid: `password:${data.sub}`, name: String(data.sub), via: 'password' };
}

const failures = new Map();

/** 按来源 IP 限流：实例内存计数，多实例时阈值按实例数放大，仍能挡住单点爆破。 */
export function assertNotRateLimited(key, now = Date.now()) {
  const recent = (failures.get(key) || []).filter((at) => now - at < FAILURE_WINDOW_MS);
  failures.set(key, recent);
  if (recent.length >= MAX_FAILURES) {
    throw new HttpError(429, '尝试次数过多，请十分钟后再试。', 'TOO_MANY_ATTEMPTS');
  }
}

export function registerLoginFailure(key, now = Date.now()) {
  const recent = (failures.get(key) || []).filter((at) => now - at < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
  return recent.length;
}
