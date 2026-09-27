import { app } from '@azure/functions';
import { config } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import { handleError, json, readJson } from '../lib/http.js';
import { claimRateLimit, toggleReaction } from '../lib/repository.js';
import { identifier, interactionPath } from '../lib/validation.js';

app.http('reactions', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'reactions',
  handler: async (request, context) => {
    try {
      if (!config().interactionsEnabled) {
        throw new HttpError(503, '点赞功能暂时关闭。', 'INTERACTIONS_DISABLED');
      }
      const body = await readJson(request);
      const path = interactionPath(body.path);
      const visitorId = identifier(body.visitorId, '访客标识');
      const limit = await claimRateLimit(`reaction:hour:${visitorId}`, {
        windowSeconds: 3600,
        maximum: 30,
      });
      if (!limit.allowed) {
        throw new HttpError(429, '操作过于频繁，请稍后再试。', 'RATE_LIMITED');
      }
      return json(request, await toggleReaction(path, visitorId));
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
