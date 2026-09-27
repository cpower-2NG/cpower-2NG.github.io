import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(path);
  }
  return out;
}

test('local images referenced by source content exist after build', async () => {
  const files = await walk(join(root, 'content-src'));
  const missing = [];
  for (const file of files) {
    const sourceParts = relative(join(root, 'content-src'), file).split(/[\\/]/);
    const phase = sourceParts[0];
    const type = sourceParts[1] === 'diary' ? 'diary' : 'article';
    const outputDir = join(root, 'content', phase, type);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const url = match[1];
      if (/^(?:https?:|data:)/i.test(url)) continue;
      const target = resolve(outputDir, url);
      try {
        await access(target);
      } catch {
        missing.push(`${relative(root, file)} -> ${url}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
