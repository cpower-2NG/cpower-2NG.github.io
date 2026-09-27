import { app } from '@azure/functions';
import { config } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import { handleError, json, readJson } from '../lib/http.js';
import { recordView } from '../lib/repository.js';
import { identifier, interactionPath } from '../lib/validation.js';

app.http('views', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'views',
  handler: async (request, context) => {
    try {
      if (!config().interactionsEnabled) {
        throw new HttpError(503, '阅读计数暂时关闭。', 'INTERACTIONS_DISABLED');
      }
      const body = await readJson(request);
      const path = interactionPath(body.path);
      const visitorId = identifier(body.visitorId, '访客标识');
      return json(request, await recordView(path, visitorId));
    } catch (error) {
      return handleError(request, error, context);
    }
  },
});
