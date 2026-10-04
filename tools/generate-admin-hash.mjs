// 生成账密登录所需的环境变量值：
//   node tools/generate-admin-hash.mjs <用户名> [口令]
// 口令缺省时用随机值生成并打印（适合初始化后改掉）。
// 输出的 ADMIN_PASSWORD_HASH（自带随机盐）与 ADMIN_SESSION_SECRET
// 直接配到 Function App 应用设置或 GitHub Secrets 即可，不依赖 HASH_SALT。
import { randomBytes, scryptSync } from 'node:crypto';

const [username, passwordArg] = process.argv.slice(2);
if (!username) {
  console.error('用法：node tools/generate-admin-hash.mjs <用户名> [口令]');
  process.exit(1);
}

const password = passwordArg || randomBytes(18).toString('base64url');
const salt = randomBytes(16).toString('hex');
const derived = scryptSync(`${username.trim().toLowerCase()}::${password}`, Buffer.from(salt, 'hex'), 32);
const hash = `scrypt$${salt}$${derived.toString('hex')}`;
// 会话签名密钥独立随机生成：即使哈希泄露也不能推导出签发令牌的能力。
const secret = randomBytes(32).toString('base64url');

console.log(`ADMIN_USERNAME=${username.trim()}`);
console.log(`ADMIN_PASSWORD_HASH=${hash}`);
console.log(`ADMIN_SESSION_SECRET=${secret}`);
if (passwordArg) {
  console.log('(口令来自命令行参数，建议改用不带口令的调用方式避免留在 shell 历史。)');
} else {
  console.log(`口令：${password}`);
}
