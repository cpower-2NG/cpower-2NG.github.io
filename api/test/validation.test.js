import assert from 'node:assert/strict';
import test from 'node:test';
import { interactionPath, optionalWebsite, text } from '../src/lib/validation.js';

test('interaction paths reject dashboard and unsafe routes', () => {
  assert.equal(
    interactionPath('/content/fantasy/diary/2026-09-13-open-the-corridor.html'),
    '/content/fantasy/diary/2026-09-13-open-the-corridor.html',
  );
  assert.throws(() => interactionPath('/content/dashboards/fantasy-dash.html'));
});

test('text is trimmed and bounded', () => {
  assert.equal(text('  hello  ', 'name'), 'hello');
  assert.throws(() => text('x'.repeat(31), 'name', { max: 30 }));
});

test('website only permits http and https', () => {
  assert.equal(optionalWebsite('https://example.com'), 'https://example.com/');
  assert.throws(() => optionalWebsite('javascript:alert(1)'));
});
