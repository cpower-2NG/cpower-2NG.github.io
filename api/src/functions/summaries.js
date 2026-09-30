import { app } from '@azure/functions';
import { config } from '../lib/config.js';
import { handleError, json } from '../lib/http.js';
import { getInteractionSummaries } from '../lib/repository.js';
import { identifier } from '../lib/validation.js';

/** 时间流里一次取回多条动态的互动计数（评论数 / 点赞数 / 是否已赞）。 */
app.http('summaries', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'summaries',
  handler: async (request, context) => {
    try {
      if (!config().interactionsEnabled) {
        return json(request, { enabled: false, items: [] });
      }
      const entryIds = String(request.query.get('entryIds') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 60)
        .map((value) => identifier(value, '内容标识'));
      const visitorId = identifier(request.query.get('visitorId') || 'anonymous-reader', '访客标识');
      return json(request, { enabled: true, items: await getInteractionSummaries(entryIds, visitorId) });
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
