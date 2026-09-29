import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(path);
  }
  return files;
}

test('public HTML avoids implementation-facing copy', async () => {
  const files = [
    join(root, 'index.html'),
    join(root, '404.html'),
    join(root, 'content', 'dashboards', 'logic-dash.html'),
    join(root, 'content', 'dashboards', 'fantasy-dash.html'),
    ...await walk(join(root, 'content')),
  ];
  const forbidden = [
    'data/entries.json',
    'Bootstrap',
    '[ OK ]',
    '占位',
    '手工维护',
    '写作流水线',
    '重建目录索引',
  ];
  const violations = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const phrase of forbidden) {
      if (text.includes(phrase)) {
        violations.push(`${relative(root, file)}: ${phrase}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('removed development and placeholder entries stay out of the public index', async () => {
  const payload = JSON.parse(await readFile(join(root, 'data', 'entries.json'), 'utf8'));
  const publicPaths = payload.entries.map((entry) => entry.path);
  const removed = [
    'brief.html',
    'path-planning.html',
    'segment-tree.html',
    'markdown-writing-guide.html',
    'build-log-001.html',
    'essay-placeholder.html',
    'producers-note.html',
    'translation-draft.html',
  ];
  const leaked = publicPaths.filter((path) => removed.some((name) => path.endsWith(name)));
  assert.deepEqual(leaked, []);
});
