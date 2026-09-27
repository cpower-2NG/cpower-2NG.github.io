#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = resolve(process.argv[2] || join(root, 'imports', 'fantasy', 'source-manifest.json'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const baseDir = resolve(manifestPath, '..', 'raw');
let failed = 0;

for (const file of manifest.files || []) {
  const target = join(baseDir, ...String(file.path).split('/'));
  try {
    const info = await stat(target);
    const bytes = await readFile(target);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (info.size !== file.size || digest !== file.sha256) {
      console.error(`MISMATCH ${file.path}`);
      failed += 1;
    } else {
      console.log(`OK ${file.path}`);
    }
  } catch (error) {
    console.error(`MISSING ${file.path}: ${error.message}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} source file(s) failed verification.`);
  process.exitCode = 1;
} else {
  console.log(`\n${manifest.files.length} source files verified.`);
}
