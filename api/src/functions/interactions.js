import { app } from '@azure/functions';
import { config } from '../lib/config.js';
import { handleError, json } from '../lib/http.js';
import { getInteractionSummary, listComments } from '../lib/repository.js';
import { entryId as parseEntryId, identifier } from '../lib/validation.js';

app.http('interactions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'interactions',
  handler: async (request, context) => {
    try {
      if (!config().interactionsEnabled) {
        return json(request, { enabled: false });
      }
      const entryId = parseEntryId(request.query.get('entryId'));
      const visitorId = identifier(request.query.get('visitorId') || 'anonymous-reader', '访客标识');
      const [summary, commentsPage] = await Promise.all([
        getInteractionSummary(entryId, visitorId),
        listComments(entryId, visitorId, {
          cursor: request.query.get('cursor') || '',
          limit: Number(request.query.get('limit')) || 100,
        }),
      ]);
      return json(request, {
        enabled: true,
        entryId,
        comments: commentsPage.items,
        nextCursor: commentsPage.nextCursor,
        ...summary,
      });
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
