import { envConfig } from './config.js';
import { connectQzone } from './qzone-auth.js';
import { syncQzone } from './qzone-sync.js';

async function main() {
  const config = envConfig();
  const result = config.mode === 'auth' ? await connectQzone() : await syncQzone();
  process.stdout.write(`${JSON.stringify({ mode: config.mode, result }, null, 2)}\n`);
}

main().catch(async (error) => {
  console.error(error);
  // 兜底把失败写进同步状态：否则初始化阶段（会话缺失、配置错误等）的崩溃
  // 在管理台表现为永远「等待云端容器就绪」。auth 模式有自己的状态文档，不混用。
  // 写状态本身失败时只能靠日志。
  try {
    if (envConfig().mode !== 'auth') {
      const { setStatus } = await import('./state.js');
      await setStatus('failed', `任务启动失败：${error.message}`);
    }
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
