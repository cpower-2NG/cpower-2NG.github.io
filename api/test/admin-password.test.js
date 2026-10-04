import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNotRateLimited,
  hashPassword,
  issueSessionToken,
  registerLoginFailure,
  verifyPassword,
  verifySessionToken,
} from '../src/lib/admin-password.js';
import { config } from '../src/lib/config.js';

test('hashPassword 自带随机盐，区分用户名、口令且每次盐不同', () => {
  const hash = hashPassword('Admin', 'pw');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(hashPassword(' admin ', 'pw') === hash, false, '每次生成应使用新随机盐');
  assert.notEqual(hashPassword('admin', 'pw'), hashPassword('root', 'pw'));
  assert.notEqual(hashPassword('admin', 'pw'), hashPassword('admin', 'pw2'));
});

test('verifyPassword 只接受正确口令，格式不合法一律拒绝', () => {
  const hash = hashPassword('admin', '正确口令');
  assert.equal(verifyPassword('admin', '正确口令', hash), true);
  assert.equal(verifyPassword('Admin', '正确口令', hash), true, '用户名大小写不敏感');
  assert.equal(verifyPassword('admin', '错误口令', hash), false);
  assert.equal(verifyPassword('root', '正确口令', hash), false);
  assert.equal(verifyPassword('admin', '正确口令', 'scrypt$deadbeef$deadbeef'), false);
  assert.equal(verifyPassword('admin', '正确口令', ''), false);
  assert.equal(verifyPassword('admin', '正确口令', 'plain-hash'), false);
});

test('会话令牌签发后可校验，载荷携带用户名与通道', () => {
  const current = config({ adminSessionSecret: 'secret', adminSessionTtlHours: 1 });
  const issued = issueSessionToken({ name: 'admin' }, current, 1_000_000);
  assert.match(issued.token, /^bfs_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(new Date(issued.expiresAt).getTime(), 1_000_000 + 3600_000);
  const session = verifySessionToken(issued.token, current, 1_000_500);
  assert.equal(session.name, 'admin');
  assert.equal(session.via, 'password');
  assert.equal(session.oid, 'password:admin');
});

test('过期、篡改与换密钥的令牌一律拒绝', () => {
  const current = config({ adminSessionSecret: 'secret', adminSessionTtlHours: 1 });
  const issued = issueSessionToken({ name: 'admin' }, current, 0);
  assert.equal(verifySessionToken(issued.token, current, 3600_001), null);
  assert.equal(verifySessionToken(`${issued.token}x`, current), null);
  assert.equal(verifySessionToken(issued.token.replace('bfs_', 'bfe_'), current), null);
  assert.equal(verifySessionToken(issued.token, config({ adminSessionSecret: 'other', adminSessionTtlHours: 1 })), null);
  assert.equal(verifySessionToken('', current), null);
});

test('登录失败限流：连续失败达到阈值后 429，窗口过后恢复', () => {
  const key = `ip-${Math.random()}`;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    registerLoginFailure(key, attempt * 1000);
  }
  assertNotRateLimited(key, 10_000);
  registerLoginFailure(key, 11_000);
  assert.throws(() => assertNotRateLimited(key, 12_000), /尝试次数过多/);
  assertNotRateLimited(key, 10 * 60_000 + 20_000);
});
