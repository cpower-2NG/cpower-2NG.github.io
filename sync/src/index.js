import { envConfig } from './config.js';
import { connectQzone } from './qzone-auth.js';
import { syncQzone } from './qzone-sync.js';

async function main() {
  const config = envConfig();
  const result = config.mode === 'auth' ? await connectQzone() : await syncQzone();
  process.stdout.write(`${JSON.stringify({ mode: config.mode, result }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
