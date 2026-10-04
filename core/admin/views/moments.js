// 动态（moments）置顶与精选：checkbox 即改即存，失败回滚勾选状态。

import { request } from '../api.js';
import { badge, card, h, metaLine, muted, toast } from '../ui.js';

let host = null;

export default {
  id: 'moments',
  title: '动态',
  async mount(container) {
    host = h('div', { class: 'rows' }, muted('加载中…'));
    container.append(card({
      title: '全部动态',
      eyebrow: 'MOMENTS',
      body: [muted('置顶的动态显示在动态页顶部；精选会带上精选标记。勾选即保存。'), host],
    }));
    await loadMoments();
  },
};

async function loadMoments() {
  host.replaceChildren();
  try {
    const payload = await request('/manage/moments');
    const items = payload.items || [];
    if (!items.length) {
      host.append(muted('还没有动态。动态来自站点的 moment 页面数据。'));
      return;
    }
    for (const moment of items) {
      host.append(momentRow(moment));
    }
  } catch (error) {
    host.append(muted(`加载失败：${error.message}`));
  }
}

function momentRow(moment) {
  const pinned = h('input', {
    class: 'switch__input', type: 'checkbox',
    checked: Boolean(moment.pinned),
    onchange: (event) => saveFlag(moment, 'pinned', event.target.checked, event),
  });
  const featured = h('input', {
    class: 'switch__input', type: 'checkbox',
    checked: Boolean(moment.featured),
    onchange: (event) => saveFlag(moment, 'featured', event.target.checked, event),
  });
  return h('div', { class: 'row' },
    h('div', { class: 'row__main' },
      h('div', { class: 'row__title' }, String(moment.text || moment.summary || '（无文字）').slice(0, 80)),
      metaLine('row__meta',
        String(moment.publishedAt || '').slice(0, 10),
        moment.month || '',
      ),
    ),
    h('div', { class: 'row__side' },
      moment.pinned ? badge('置顶', 'accent') : null,
      moment.featured ? badge('精选', 'warn') : null,
      h('label', { class: 'switch' }, pinned, h('span', { class: 'switch__track' }, h('span', { class: 'switch__thumb' })), h('span', { class: 'switch__label' }, '置顶')),
      h('label', { class: 'switch' }, featured, h('span', { class: 'switch__track' }, h('span', { class: 'switch__thumb' })), h('span', { class: 'switch__label' }, '精选')),
    ),
  );
}

async function saveFlag(moment, key, value, event) {
  const previous = Boolean(moment[key]);
  moment[key] = value;
  try {
    await request(`/manage/moments/${encodeURIComponent(moment.id)}`, {
      method: 'PATCH',
      body: { month: moment.month, [key]: value },
    });
    toast(value ? '已更新。' : '已取消。', 'ok');
    await loadMoments();
  } catch (error) {
    moment[key] = previous;
    if (event?.target) event.target.checked = previous;
    toast(error.message, 'error');
  }
}
