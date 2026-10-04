// 临时脚本：把账密登录配置写入云端 Function App 应用设置。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auth = JSON.parse(readFileSync(join(process.env.TEMP, 'admin-auth.json'), 'utf8'));

const result = execFileSync('az', [
  'functionapp', 'config', 'appsettings', 'set',
  '--name', 'func-bifrost-z43zcc',
  '--resource-group', 'rg-bifrost-prod',
  '--settings',
  `ADMIN_USERNAME=${auth.username}`,
  `ADMIN_PASSWORD_HASH=${auth.hash}`,
  `ADMIN_SESSION_SECRET=${auth.secret}`,
  'ADMIN_SESSION_TTL_HOURS=72',
], { encoding: 'utf8', shell: true });

JSON.parse(result);

// 回读云端实际值确认写入成功（哈希与密钥只显示前几位）
const listed = JSON.parse(execFileSync('az', [
  'functionapp', 'config', 'appsettings', 'list',
  '--name', 'func-bifrost-z43zcc',
  '--resource-group', 'rg-bifrost-prod',
], { encoding: 'utf8', shell: true }));
for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'ADMIN_SESSION_TTL_HOURS']) {
  const found = listed.find((s) => s.name === key);
  const value = String(found?.value ?? '(缺失)');
  console.log(`${key}=${value.slice(0, 16)}${value.length > 16 ? '…' : ''}`);
}
