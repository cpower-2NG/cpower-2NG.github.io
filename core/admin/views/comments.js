// 评论管理：按状态筛选，卡片内完成状态流转；删除需要确认。

import { request } from '../api.js';
import { COMMENT_STATUS, fmtDateTime } from '../format.js';
import { badge, button, card, confirmDialog, h, metaLine, muted, select, toast, withBusy } from '../ui.js';

const local = { filter: '', items: [] };
let host = null;

const STATUS_BADGE = {
  published: ['已发布', 'ok'],
  pending: ['待审核', 'warn'],
  hidden: ['已隐藏', 'danger'],
  deleted: ['已删除', 'muted'],
};

/** 每种状态可流转到的目标状态。 */
const TRANSITIONS = {
  published: ['pending', 'hidden', 'deleted'],
  pending: ['published', 'hidden', 'deleted'],
  hidden: ['published', 'pending', 'deleted'],
  deleted: ['published', 'hidden'],
};

export default {
  id: 'comments',
  title: '评论',
  async mount(container) {
    host = h('div', { class: 'rows' }, muted('加载中…'));
    container.append(card({
      title: '评论审核',
      eyebrow: 'COMMENTS',
      actions: [
        select(
          [
            { value: '', label: '全部状态' },
            { value: 'published', label: '已发布' },
            { value: 'pending', label: '待审核' },
            { value: 'hidden', label: '已隐藏' },
            { value: 'deleted', label: '已删除' },
          ],
          local.filter,
          (value) => { local.filter = value; loadComments(); },
        ),
      ],
      body: [
        muted('规则：正常评论直接发布；正文含链接转待审核；触发蜜罐或提交过快的直接拒绝。'),
        host,
      ],
    }));
    await loadComments();
  },
};

async function loadComments() {
  host.replaceChildren(muted('加载中…'));
  try {
    const payload = await request(`/manage/comments${local.filter ? `?status=${encodeURIComponent(local.filter)}` : ''}`);
    local.items = payload.items || [];
    host.replaceChildren();
    if (!local.items.length) {
      host.append(muted('当前筛选条件下没有评论。'));
      return;
    }
    for (const comment of local.items) {
      host.append(commentCard(comment));
    }
  } catch (error) {
    host.replaceChildren(muted(`加载失败：${error.message}`));
  }
}

function commentCard(comment) {
  const [statusLabel, statusKind] = STATUS_BADGE[comment.status] || [comment.status, 'muted'];
  return h('div', { class: 'review-card' },
    h('div', { class: 'review-card__head' },
      h('div', { class: 'inline' },
        h('strong', {}, comment.nickname || '匿名用户'),
        badge(statusLabel, statusKind),
      ),
      h('span', { class: 'muted mono' }, comment.entryId),
    ),
    h('p', { class: 'review-card__text' }, comment.content || '（无内容）'),
    metaLine('review-card__meta',
      comment.createdAt ? fmtDateTime(comment.createdAt) : '',
      comment.updatedAt && comment.updatedAt !== comment.createdAt ? `更新于 ${fmtDateTime(comment.updatedAt)}` : '',
    ),
    h('div', { class: 'inline' }, transitionButtons(comment)),
  );
}

function transitionButtons(comment) {
  const buttons = [];
  for (const target of TRANSITIONS[comment.status] || []) {
    if (target === comment.status) continue;
    const labels = { published: '发布', pending: '转待审', hidden: '隐藏', deleted: '删除' };
    const isDelete = target === 'deleted';
    buttons.push(button(labels[target], {
      size: 'sm',
      kind: isDelete ? 'danger' : target === 'published' ? 'primary' : '',
      onclick: (event) => withBusy(event.currentTarget, () => changeStatus(comment, target), '操作失败'),
    }));
  }
  if (!buttons.length) buttons.push(muted('没有可执行的操作。'));
  return buttons;
}

async function changeStatus(comment, target) {
  if (target === 'deleted') {
    const ok = await confirmDialog({
      title: '删除评论',
      danger: true,
      confirmLabel: '删除',
      body: [
        h('p', {}, '确定删除这条评论？'),
        h('p', { class: 'muted' }, String(comment.content || '').slice(0, 120) || '（无内容）'),
        h('p', { class: 'muted' }, '删除后仍可在「已删除」筛选中看到并恢复。'),
      ],
    });
    if (!ok) return;
  }
  try {
    await request(`/manage/comments/${encodeURIComponent(comment.id)}`, {
      method: target === 'deleted' ? 'DELETE' : 'PATCH',
      body: { entryId: comment.entryId, status: target },
    });
    toast(`评论已${COMMENT_STATUS[target] || target}。`, 'ok');
    await loadComments();
  } catch (error) {
    toast(error.message, 'error');
  }
}
