#!/usr/bin/env node
// 把内容包的媒体二进制上传到 Blob，并把 blobUrl 回填到 assets.json。
// 展示媒体进 media 容器（公开）；后续如需归档原件，可另开 private 通道。
// 用法：node tools/blob-push.mjs [批量目录]
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJson, writeJson } from './lib/content-common.mjs';

const ACCOUNT = process.env.BLOB_ACCOUNT_URL || 'https://stbifrostz43zcc.blob.core.windows.net';
const BATCH_DIR = resolve(process.argv[2] || 'imports/fantasy/derived/batch');

async function main() {
  const service = new BlobServiceClient(ACCOUNT, new DefaultAzureCredential());
  const dirs = (await readdir(BATCH_DIR, { withFileTypes: true })).filter((item) => item.isDirectory());
  let uploaded = 0;
  let skipped = 0;
  const failures = [];

  for (const dir of dirs) {
    const documentsDir = join(BATCH_DIR, dir.name, 'documents');
    const assetsPath = join(documentsDir, 'assets.json');
    const filesPath = join(documentsDir, 'asset-files.json');
    const assets = await readJson(assetsPath);
    const files = await readJson(filesPath);
    if (!assets?.items?.length || !files) continue;

    for (const asset of assets.items) {
      const localFile = files[asset.id];
      if (!localFile) {
        failures.push(`${asset.id}：缺少本地文件映射`);
        continue;
      }
      try {
        await statFile(localFile);
      } catch {
        failures.push(`${asset.id}：本地文件不存在 ${localFile}`);
        continue;
      }

      const container = asset.blobContainer || 'media';
      const blob = service.getContainerClient(container).getBlockBlobClient(asset.blobPath);
      try {
        if (await blob.exists()) {
          skipped += 1;
        } else {
          await blob.uploadData(await readFile(localFile), {
            blobHTTPHeaders: {
              blobContentType: asset.mime || 'application/octet-stream',
              blobCacheControl: 'public, max-age=31536000, immutable',
            },
          });
          uploaded += 1;
        }
        asset.blobUrl = `${ACCOUNT.replace(/\/+$/, '')}/${container}/${asset.blobPath}`;
      } catch (error) {
        failures.push(`${asset.blobPath}：${error.message.split('\n')[0]}`);
      }
    }

    await writeJson(assetsPath, assets);
  }

  console.log(`上传 ${uploaded} 个，已存在跳过 ${skipped} 个`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 个：`);
    for (const failure of failures.slice(0, 10)) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[blob-push] ${error.message}`);
  process.exitCode = 1;
});
