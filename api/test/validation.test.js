import assert from 'node:assert/strict';
import test from 'node:test';
import { entryId, optionalWebsite, text } from '../src/lib/validation.js';

test('entry ids accept ULID style ids and reject paths', () => {
  assert.equal(entryId('01M3PF9QCGS7FMTCMMKDYTAQ68'), '01M3PF9QCGS7FMTCMMKDYTAQ68');
  assert.equal(entryId('qq-b4ecdeb0e701b16a0da80800'), 'qq-b4ecdeb0e701b16a0da80800');
  assert.throws(() => entryId('/content/fantasy/article/foo.html'));
  assert.throws(() => entryId('short'));
});

test('text is trimmed and bounded', () => {
  assert.equal(text('  hello  ', 'name'), 'hello');
  assert.throws(() => text('x'.repeat(31), 'name', { max: 30 }));
});

test('website only permits http and https', () => {
  assert.equal(optionalWebsite('https://example.com'), 'https://example.com/');
  assert.throws(() => optionalWebsite('javascript:alert(1)'));
});
