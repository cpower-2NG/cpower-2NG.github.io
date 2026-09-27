import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePost, FALLBACK_RULES } from '../src/rules.js';

test('unknown visibility quarantines content by default', () => {
  const decision = evaluatePost(
    {
      content: '一条正常说说',
      media: [],
      visibility: 'unknown',
    },
    { ...FALLBACK_RULES, autoPublish: true },
  );
  assert.equal(decision.publishStatus, 'pending');
  assert.ok(decision.reasons.includes('UNKNOWN_VISIBILITY'));
});

test('empty posts and excluded keywords never publish', () => {
  const decision = evaluatePost(
    {
      content: '内部广告',
      media: [],
      visibility: 'public',
    },
    {
      ...FALLBACK_RULES,
      autoPublish: true,
      exclude: {
        ...FALLBACK_RULES.exclude,
        keywords: ['广告'],
      },
    },
  );
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes('EXCLUDED_KEYWORD'));
});
