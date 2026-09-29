import { createHash } from 'node:crypto';
import { app } from '@azure/functions';
import { optionalAdmin } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import { handleError, json, readJson } from '../lib/http.js';
import { commentFingerprint, moderateComment } from '../lib/moderation.js';
import {
  addComment,
  claimRateLimit,
  getInteractionSummary,
  listComments,
  requestIpHash,
  visitorHash,
} from '../lib/repository.js';
import { email as parseEmail, entryId as parseEntryId, identifier, optionalWebsite, text } from '../lib/validation.js';

function avatarUrlForEmail(emailHash) {
  return emailHash ? `https://gravatar.com/avatar/${emailHash}?d=identicon&s=96` : '';
}

app.http('comments', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'comments',
  handler: async (request, context) => {
    try {
      if (!config().interactionsEnabled) {
        throw new HttpError(503, '评论功能暂时关闭。', 'INTERACTIONS_DISABLED');
      }
      const body = await readJson(request);
      const entryId = parseEntryId(body.entryId);
      const visitorId = identifier(body.visitorId, '访客标识');
      const admin = await optionalAdmin(request);
      const anonymous = Boolean(body.anonymous);
      const nickname = anonymous ? '匿名用户' : text(body.nickname, '昵称', { min: 1, max: 30, required: true });
      const content = text(body.content, '评论', { min: 1, max: 2000, required: true });
      const normalizedEmail = parseEmail(body.email);
      const emailHash = normalizedEmail
        ? createHash('sha256').update(normalizedEmail).digest('hex')
        : '';
      const website = anonymous ? '' : optionalWebsite(body.website);
      const parentId = body.parentId ? identifier(body.parentId, '回复目标') : null;
      const elapsedMs = Number(body.elapsedMs);
      const moderation = moderateComment({
        content,
        honeypot: String(body.honeypot || ''),
        elapsedMs,
      });
      if (moderation.rejected) {
        throw new HttpError(400, '评论提交未通过安全检查。', moderation.reason);
      }

      const ipHash = requestIpHash(request);
      const visitor = visitorHash(visitorId);
      const limits = await Promise.all([
        claimRateLimit(`comment:hour:${ipHash}`, { windowSeconds: 3600, maximum: 5 }),
        claimRateLimit(`comment:day:${ipHash}`, { windowSeconds: 86400, maximum: 20 }),
        claimRateLimit(`comment:visitor:${visitor}`, { windowSeconds: 3600, maximum: 5 }),
      ]);
      const blocked = limits.find((limit) => !limit.allowed);
      if (blocked) {
        throw new HttpError(429, `评论过于频繁，请在 ${blocked.retryAfter} 秒后重试。`, 'RATE_LIMITED');
      }

      const result = await addComment({
        entryId,
        parentId,
        nickname,
        anonymous,
        emailHash,
        avatarUrl: avatarUrlForEmail(emailHash),
        website,
        content,
        status: moderation.status,
        moderationReason: moderation.reason,
        isOwner: Boolean(admin),
        fingerprint: commentFingerprint(entryId, nickname, content),
        visitorHash: visitor,
        ipHash,
        userAgentHash: createHash('sha256').update(request.headers.get('user-agent') || '').digest('hex'),
      });

      const [summary, commentsPage] = await Promise.all([
        getInteractionSummary(entryId, visitorId),
        listComments(entryId, visitorId),
      ]);
      return json(request, {
        ...result,
        comments: commentsPage.items,
        nextCursor: commentsPage.nextCursor,
        ...summary,
      }, 201);
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
