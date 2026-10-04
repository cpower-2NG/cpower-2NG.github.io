// 标签管理：改名与合并共用一条路径（POST /manage/tags/rename），操作前确认影响面。

import { request } from '../api.js';
import { badge, button, card, confirmDialog, h, muted, textInput, toast, withBusy } from '../ui.js';

let host = null;

export default {
  id: 'tags',
  title: '标签',
  async mount(container) {
    host = h('div', { class: 'rows' }, muted('加载中…'));
    container.append(card({
      title: '全部标签',
      eyebrow: 'TAGS',
      body: [
        muted('改名与合并是同一条路径：填入目标标签名并确认，原标签在所有条目上的使用会全部转移过去。'),
        host,
      ],
    }));
    await loadTags();
  },
};

async function loadTags() {
  host.replaceChildren();
  try {
    const payload = await request('/manage/tags');
    const items = payload.items || [];
    if (!items.length) {
      host.append(muted('还没有任何标签。'));
      return;
    }
    for (const item of items) {
      host.append(tagRow(item));
    }
  } catch (error) {
    host.append(muted(`加载失败：${error.message}`));
  }
}

function tagRow(item) {
  const input = textInput({ placeholder: '改为 / 合并到…', size: 'sm' });
  const submit = button('转移', {
    size: 'sm',
    onclick: (event) => withBusy(event.currentTarget, () => renameTag(item, input.value, input), '操作失败'),
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      withBusy(submit, () => renameTag(item, input.value, input), '操作失败');
    }
  });
  return h('div', { class: 'row' },
    h('div', { class: 'row__main' },
      h('div', { class: 'row__title' }, item.label),
    ),
    h('div', { class: 'row__side' },
      badge(item.count ? `${item.count} 篇` : '未使用'),
      input,
      submit,
    ),
  );
}

async function renameTag(item, to, input) {
  const target = String(to || '').trim();
  if (!target) {
    toast('请填入目标标签名。', 'error');
    return;
  }
  if (target === item.label) {
    toast('目标标签与当前标签相同。', 'error');
    return;
  }
  const ok = await confirmDialog({
    title: item.count ? `合并标签「${item.label}」` : `转移标签「${item.label}」`,
    confirmLabel: '确认转移',
    body: [
      h('p', {}, `「${item.label}」${item.count ? `（${item.count} 篇条目）` : '（未使用）'} 将全部转移到「${target}」。`),
      h('p', { class: 'muted' }, item.count
        ? `若「${target}」已存在，两个标签会合并为一个。`
        : '未使用的标签转移后仅在 taxonomy 中登记目标标签。'),
    ],
  });
  if (!ok) return;
  try {
    const payload = await request('/manage/tags/rename', {
      method: 'POST',
      body: { from: item.label, to: target },
    });
    toast(`已转移 ${payload.updated} 篇条目到「${payload.to}」。`, 'ok');
    await loadTags();
  } catch (error) {
    toast(error.message, 'error');
    input.value = '';
  }
}
