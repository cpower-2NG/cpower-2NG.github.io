import { app } from '@azure/functions';
import { exportInteractions } from '../lib/export-service.js';
import { writeState } from '../lib/repository.js';

app.timer('exportDaily', {
  schedule: '0 0 18 * * *',
  handler: async (_timer, context) => {
    try {
      const result = await exportInteractions({ reason: 'scheduled' });
      await writeState('last-export', 'sync', result);
      context.log(`互动数据已导出：${result.paths.join(', ')}`);
    } catch (error) {
      context.error(error);
      throw error;
    }
  },
});
