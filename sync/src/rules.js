import { createHash } from 'node:crypto';
import { clients } from './clients.js';
import { readState } from './state.js';

export const FALLBACK_RULES = {
  schemaVersion: 1,
  autoPublish: false,
  scope: 'self',
  initialBackfillDays: 31,
  defaultPhase: 'fantasy',
  include: {
    originalText: true,
    imagePosts: true,
    videoReposts: true,
    historicalInteractions: true,
  },
  exclude: {
    emptyPosts: true,
    checkIns: true,
    applicationShares: true,
    duplicateMedia: true,
    keywords: [],
  },
  media: {
    preferOriginal: true,
    minimumImageArea: 160000,
    displayWidths: [480, 960, 1600],
  },
  safety: {
    quarantineUnknownVisibility: true,
    quarantineParseWarnings: true,
    confirmedMissingChecks: 2,
  },
};

export async function loadRules() {
  const stored = await readState('sync-rules', 'settings');
  return {
    ...FALLBACK_RULES,
    ...(stored || {}),
    include: { ...FALLBACK_RULES.include, ...(stored?.include || {}) },
    exclude: { ...FALLBACK_RULES.exclude, ...(stored?.exclude || {}) },
    media: { ...FALLBACK_RULES.media, ...(stored?.media || {}) },
    safety: { ...FALLBACK_RULES.safety, ...(stored?.safety || {}) },
  };
}

export function isSensitiveText(text) {
  return /(?:身份证|银行卡|手机号|手机号码|家庭住址|收货地址|密码|验证码)/i.test(String(text || ''));
}

export function evaluatePost(post, rules, mediaConfidence = 'complete') {
  const text = String(post.content || '').trim();
  const media = Array.isArray(post.media) ? post.media : [];
  const reasons = [];

  if (!rules.autoPublish) reasons.push('AUTO_PUBLISH_DISABLED');
  if (rules.exclude.emptyPosts && !text && !media.length) reasons.push('EMPTY_POST');
  if (rules.exclude.checkIns && String(post.kind || '').toLowerCase().includes('checkin')) reasons.push('CHECK_IN');
  if (rules.exclude.applicationShares && String(post.kind || '').toLowerCase().includes('app')) reasons.push('APP_SHARE');
  const keywords = Array.isArray(rules.exclude.keywords) ? rules.exclude.keywords : [];
  if (keywords.some((keyword) => keyword && text.includes(String(keyword)))) reasons.push('EXCLUDED_KEYWORD');
  if (rules.safety.quarantineUnknownVisibility && !['public', 'private', 'friends'].includes(post.visibility)) {
    reasons.push('UNKNOWN_VISIBILITY');
  }
  if (rules.safety.quarantineParseWarnings && mediaConfidence !== 'complete') {
    reasons.push('MEDIA_INCOMPLETE');
  }
  if (isSensitiveText(text)) reasons.push('SENSITIVE_TEXT');

  const hasImages = media.some((item) => item.kind === 'image');
  const hasVideos = media.some((item) => item.kind === 'video') || Boolean(post.video);
  if (!text && hasImages && !rules.include.imagePosts) reasons.push('IMAGE_POST_DISABLED');
  if (!text && hasVideos && !rules.include.videoReposts) reasons.push('VIDEO_REPOST_DISABLED');

  const hardFailures = reasons.filter(
    (reason) => !['AUTO_PUBLISH_DISABLED', 'UNKNOWN_VISIBILITY', 'MEDIA_INCOMPLETE'].includes(reason),
  );
  const reviewRequired = hardFailures.length > 0 || reasons.length > 0 || !rules.autoPublish;
  return {
    eligible: hardFailures.length === 0,
    publishStatus: reviewRequired ? 'pending' : 'published',
    reasons: [...new Set(reasons)],
  };
}

export function stableAnonymousLabel(accountId, salt) {
  const digest = createHash('sha256')
    .update(`${salt}:${accountId}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return `匿名访客 ${digest}`;
}

export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function safeRecordId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 160);
}

export async function hashSalt() {
  const { secrets } = clients();
  const secret = await secrets.getSecret('interaction-hash-salt');
  return secret.value || 'bifrost-qzone-anonymizer';
}
