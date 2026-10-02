import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  assertUploadable,
  fileExtension,
  parseImportForm,
} from '../src/lib/import-validate.js';

const MAX = 100 * 1024 * 1024;

test('fileExtension 取小写后缀', () => {
  assert.equal(fileExtension('冬滚滚.DOCX'), 'docx');
  assert.equal(fileExtension('no-ext'), '');
});

test('assertUploadable 接受白名单类型并剥掉路径成分', () => {
  const { safeName, ext } = assertUploadable({
    filename: 'C:\\Users\\test\\冬滚滚.docx',
    bytes: 1024,
    maxBytes: MAX,
  });
  assert.equal(safeName, '冬滚滚.docx');
  assert.equal(ext, 'docx');
});

test('assertUploadable 拒绝不支持类型与超大文件', () => {
  assert.throws(() => assertUploadable({ filename: 'a.exe', bytes: 1, maxBytes: MAX }), /不支持的文件类型/);
  assert.throws(() => assertUploadable({ filename: 'a.pdf', bytes: MAX + 1, maxBytes: MAX }), /体积上限/);
  assert.throws(() => assertUploadable({ filename: 'a.pdf', bytes: 0, maxBytes: MAX }), /为空/);
  assert.deepEqual(ALLOWED_UPLOAD_EXTENSIONS.slice(0, 3), ['docx', 'doc', 'pdf']);
});

test('parseImportForm 规范化字段并校验位面分区', () => {
  const meta = parseImportForm({ title: ' 冬滚滚 ', phase: 'fantasy', section: 'review', tags: 'a, b ,c', coverIndex: '2' });
  assert.deepEqual(meta, { title: '冬滚滚', phase: 'fantasy', section: 'review', tags: ['a', 'b', 'c'], coverIndex: 2 });
  assert.equal(parseImportForm({}).phase, 'fantasy');
  assert.equal(parseImportForm({ phase: 'logic' }).section, 'docs');
  assert.throws(() => parseImportForm({ phase: 'chaos' }), /位面/);
  assert.throws(() => parseImportForm({ section: 'showcase' }), /分区无效/);
  assert.throws(() => parseImportForm({ coverIndex: '-1' }), /封面序号/);
});
