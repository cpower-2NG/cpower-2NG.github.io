// 数据导出：手动触发互动数据快照（NDJSON + CSV），状态取自全局 status。

import { request } from '../api.js';
import { createSubscriptions, get } from '../store.js';
import { button, card, h, muted } from '../ui.js';
import { fmtDateTime } from '../format.js';

export default {
  id: 'export',
  title: '数据导出',
  async mount(container, ctx) {
    const subs = createSubscriptions();
    const msg = h('p', { class: 'msg' });
    const lastBox = h('div', { class: 'stack' });

    function renderLast() {
      const status = get('status');
      const last = status?.lastExport;
      lastBox.replaceChildren(
        last?.exportedAt
          ? [
              h('p', { class: 'muted' }, `上次导出：${fmtDateTime(last.exportedAt)} · ${last.count || 0} 条记录`),
              Array.isArray(last.paths) && last.paths.length
                ? h('div', { class: 'mono' }, last.paths.join('\n'))
                : null,
            ]
          : muted('还没有导出记录。'),
      );
    }

    const exportButton = button('立即导出', {
      kind: 'primary',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        msg.textContent = '正在导出…';
        try {
          const payload = await request('/manage/export', { method: 'POST' });
          msg.textContent = `已导出 ${payload.count} 条数据到私有 Blob。`;
          await ctx.refreshStatus();
        } catch (error) {
          msg.textContent = error.message;
        } finally {
          event.currentTarget.disabled = false;
        }
      },
    });

    container.append(card({
      title: '导出与迁移',
      eyebrow: 'PORTABILITY',
      body: [
        muted('每日自动生成 NDJSON 与 CSV 快照；这里可以随时手动补一次。快照写入私有 Blob，公开文章不依赖 Azure，可独立继续部署。'),
        h('div', { class: 'inline' }, exportButton, msg),
        lastBox,
      ],
    }));

    subs.watch('status', renderLast);
    renderLast();
    await ctx.refreshStatus();
    return () => subs.dispose();
  },
};
