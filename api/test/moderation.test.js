import assert from 'node:assert/strict';
import test from 'node:test';
import { countLinks, moderateComment } from '../src/lib/moderation.js';

test('countLinks recognizes common link forms', () => {
  assert.equal(countLinks('查看 https://example.com 和 www.example.org'), 2);
});

test('honeypot and fast submissions are rejected', () => {
  assert.equal(moderateComment({ content: 'hello', honeypot: 'bot', elapsedMs: 5000 }).rejected, true);
  assert.equal(moderateComment({ content: 'hello', honeypot: '', elapsedMs: 100 }).rejected, true);
});

test('normal comments publish and high-link comments enter moderation', () => {
  assert.equal(moderateComment({ content: '正常留言', honeypot: '', elapsedMs: 2000 }).status, 'published');
  assert.equal(
    moderateComment({
      content: 'https://a.example https://b.example https://c.example',
      honeypot: '',
      elapsedMs: 2000,
    }).status,
    'pending',
  );
});
