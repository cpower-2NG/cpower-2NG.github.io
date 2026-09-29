import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { collectExportRecords } from './repository.js';
import { blobService } from './storage.js';

const gzipAsync = promisify(gzip);

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(records) {
  const columns = [
    'exportedAt',
    'type',
    'id',
    'entryId',
    'status',
    'nickname',
    'content',
    'rootId',
    'replyToId',
    'likes',
    'views',
    'comments',
    'createdAt',
    'updatedAt',
  ];
  return [
    columns.join(','),
    ...records.map((record) => columns.map((column) => csvCell(record[column])).join(',')),
  ].join('\n');
}

export async function exportInteractions({ reason = 'scheduled' } = {}) {
  const records = await collectExportRecords();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const prefix = `exports/interactions/${day}`;
  const ndjson = records.map((record) => JSON.stringify(record)).join('\n');
  const csv = toCsv(records);
  const container = blobService().private;

  const outputs = [
    { name: `${prefix}/bifrost-interactions-${stamp}.ndjson.gz`, data: await gzipAsync(ndjson), contentType: 'application/gzip' },
    { name: `${prefix}/bifrost-interactions-${stamp}.csv`, data: Buffer.from(csv, 'utf8'), contentType: 'text/csv; charset=utf-8' },
  ];

  for (const output of outputs) {
    const block = container.getBlockBlobClient(output.name);
    await block.uploadData(output.data, {
      blobHTTPHeaders: { blobContentType: output.contentType },
      metadata: { schema: '1', reason },
    });
  }

  return {
    exportedAt: now.toISOString(),
    count: records.length,
    paths: outputs.map((output) => output.name),
  };
}
