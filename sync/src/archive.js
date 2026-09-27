import { randomUUID } from 'node:crypto';
import { clients } from './clients.js';

export function createRawArchive() {
  const id = randomUUID();
  const records = [];
  return {
    add(post) {
      records.push({
        capturedAt: new Date().toISOString(),
        post,
      });
    },
    async save() {
      if (!records.length) return '';
      const day = new Date().toISOString().slice(0, 10);
      const name = `raw/qzone/${day}/${id}.json`;
      const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
      await clients().private.getBlockBlobClient(name).uploadData(Buffer.from(body, 'utf8'), {
        blobHTTPHeaders: { blobContentType: 'application/x-ndjson; charset=utf-8' },
        metadata: { schema: '1', sensitivity: 'private' },
      });
      return name;
    },
    get count() {
      return records.length;
    },
  };
}
