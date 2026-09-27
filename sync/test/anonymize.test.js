import assert from 'node:assert/strict';
import test from 'node:test';
import { anonymizeComment, stripPrivateReferences } from '../src/anonymize.js';

test('private references and links are removed', () => {
  const value = stripPrivateReferences('@张三 看看 https://example.com 号码 123456789');
  assert.equal(value.includes('张三'), false);
  assert.equal(value.includes('https://'), false);
  assert.equal(value.includes('123456789'), false);
});

test('anonymous labels are stable for the same account', () => {
  const first = anonymizeComment({ id: '1', author: { id: '10001' }, content: '你好' }, 'salt');
  const second = anonymizeComment({ id: '2', author: { id: '10001' }, content: '再见' }, 'salt');
  assert.equal(first.authorLabel, second.authorLabel);
  assert.match(first.authorLabel, /^匿名访客 [A-F0-9]{6}$/);
});
