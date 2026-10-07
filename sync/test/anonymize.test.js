import assert from 'node:assert/strict';
import test from 'node:test';
import { anonymizeComment, stripPrivateReferences } from '../src/anonymize.js';

test('mentions render as @nick, uin/links/numbers are removed', () => {
  const value = stripPrivateReferences(
    '@{uin:953260048,nick:RB,who:1} 看看 https://example.com 号码 123456789 @张三 @{uin:42}'
  );
  assert.equal(value.includes('953260048'), false, 'uin 必须移除');
  assert.equal(value.includes('nick:'), false, '结构化标记必须移除');
  assert.equal(value.includes('https://'), false);
  assert.equal(value.includes('123456789'), false);
  assert.equal(value.includes('@RB'), true, '结构化 @ 渲染为 @昵称');
  assert.equal(value.includes('@张三'), true, '裸 @昵称保留');
  assert.equal(value.includes('@好友'), true, '无昵称的标记降级为 @好友');
});

test('anonymous labels are stable for the same account', () => {
  const first = anonymizeComment({ id: '1', author: { id: '10001' }, content: '你好' }, 'salt');
  const second = anonymizeComment({ id: '2', author: { id: '10001' }, content: '再见' }, 'salt');
  assert.equal(first.authorLabel, second.authorLabel);
  assert.match(first.authorLabel, /^匿名访客 [A-F0-9]{6}$/);
});
