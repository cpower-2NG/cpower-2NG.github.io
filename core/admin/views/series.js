// 系列管理：新建、内联编辑名称简介、成员排序/移出、删除（带影响面确认）。

import { request } from '../api.js';
import { button, card, confirmDialog, h, muted, textInput, toast, withBusy } from '../ui.js';

let host = null;

export default {
  id: 'series',
  title: '系列',
  async mount(container) {
    const labelInput = textInput({ placeholder: '新系列名称' });
    const descInput = textInput({ placeholder: '简介（可选）' });
    host = h('div', { class: 'stack' }, muted('加载中…'));

    container.append(
      card({
        title: '新建系列',
        eyebrow: 'SERIES',
        body: [
          h('div', { class: 'inline' },
            labelInput, descInput,
            button('新建', {
              kind: 'primary',
              onclick: (event) => withBusy(event.currentTarget, async () => {
                const payload = await request('/manage/series', {
                  method: 'POST',
                  body: { label: labelInput.value.trim(), description: descInput.value.trim() },
                });
                labelInput.value = '';
                descInput.value = '';
                toast(`系列「${payload.series.label}」已创建。`, 'ok');
                await loadSeries();
              }, '创建失败'),
            }),
          ),
        ],
      }),
      card({ title: '全部系列', eyebrow: 'MANAGE', body: [host] }),
    );

    await loadSeries();
  },
};

async function loadSeries() {
  host.replaceChildren();
  try {
    const payload = await request('/manage/series');
    const items = payload.items || [];
    if (!items.length) {
      host.append(muted('还没有系列。上面的表单可以创建第一个。'));
      return;
    }
    for (const series of items) {
      host.append(seriesCard(series));
    }
  } catch (error) {
    host.append(muted(`加载失败：${error.message}`));
  }
}

function seriesCard(series) {
  const labelInput = textInput({ value: series.label });
  const descInput = textInput({ value: series.description || '' });
  const members = (series.memberIds || []).map((member) => ({ ...member }));

  const memberList = h('div', { class: 'stack' });
  function renderMembers() {
    memberList.replaceChildren();
    if (!members.length) {
      memberList.append(muted('暂无成员。到「条目」页把条目加入该系列。'));
      return;
    }
    members.forEach((member, index) => {
      memberList.append(h('div', { class: 'row' },
        h('div', { class: 'row__main' },
          h('div', { class: 'row__title' }, member.title || member.entryId),
        ),
        h('div', { class: 'row__side' },
          button('↑', {
            size: 'sm', disabled: index === 0, title: '上移',
            onclick: () => swapMembers(members, index, index - 1, series, renderMembers),
          }),
          button('↓', {
            size: 'sm', disabled: index === members.length - 1, title: '下移',
            onclick: () => swapMembers(members, index, index + 1, series, renderMembers),
          }),
          button('移出', {
            size: 'sm',
            onclick: (event) => withBusy(event.currentTarget, async () => {
              await request(`/manage/entries/${encodeURIComponent(member.entryId)}`, {
                method: 'PATCH',
                body: { seriesId: '' },
              });
              members.splice(index, 1);
              toast('成员已移出系列。', 'ok');
              renderMembers();
            }, '移出失败'),
          }),
        ),
      ));
    });
  }
  renderMembers();

  return card({
    title: series.label,
    eyebrow: `SERIES · ${String(series.id).replace(/^series:/, '')}`,
    body: [
      h('div', { class: 'inline' },
        h('div', { class: 'grow' }, labelInput),
        h('div', { class: 'grow' }, descInput),
        button('保存信息', {
          size: 'sm',
          onclick: (event) => withBusy(event.currentTarget, async () => {
            await request(`/manage/series/${encodeURIComponent(series.id)}`, {
              method: 'PATCH',
              body: { label: labelInput.value.trim(), description: descInput.value.trim() },
            });
            toast('系列信息已保存。', 'ok');
            await loadSeries();
          }, '保存失败'),
        }),
        button('删除系列', {
          size: 'sm', kind: 'danger',
          onclick: () => deleteSeries(series, members.length),
        }),
      ),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, `成员（${members.length}）· 顺序即站内展示顺序`),
        memberList,
      ),
    ],
  });
}

async function swapMembers(members, from, to, series, rerender) {
  const [moved] = members.splice(from, 1);
  members.splice(to, 0, moved);
  rerender();
  try {
    await request(`/manage/series/${encodeURIComponent(series.id)}`, {
      method: 'PATCH',
      body: { memberIds: members.map((member) => member.entryId) },
    });
  } catch (error) {
    toast(error.message, 'error');
    await loadSeries();
  }
}

async function deleteSeries(series, memberCount) {
  const ok = await confirmDialog({
    title: '删除系列',
    danger: true,
    confirmLabel: '删除',
    body: [
      h('p', {}, `确定删除系列「${series.label}」？`),
      h('p', { class: 'muted' }, memberCount
        ? `该系列还有 ${memberCount} 个成员，需要先移出成员才能删除。`
        : '删除后不可恢复，条目本身不受影响。'),
    ],
  });
  if (!ok) return;
  try {
    await request(`/manage/series/${encodeURIComponent(series.id)}`, { method: 'DELETE' });
    toast('系列已删除。', 'ok');
    await loadSeries();
  } catch (error) {
    toast(error.message, 'error');
  }
}
