// 条目管理：左侧筛选列表，右侧详情（元信息、标题/摘要、封面、标签、系列）。
// 页面内数据自治（local state），修改后局部更新列表与详情，不整页重绘。

import { request } from '../api.js';
import { PHASE_LABEL, COVER_SOURCE } from '../format.js';
import { badge, button, card, chipInput, clear, h, metaLine, muted, select, setMessage, textInput, toast, withBusy } from '../ui.js';

const local = {
  filters: { phase: '', section: '', q: '' },
  items: [],
  series: [],
  selectedId: '',
  detail: null,
};

let listHost = null;
let detailHost = null;

export default {
  id: 'entries',
  title: '条目',
  async mount(container) {
    local.items = [];
    local.series = [];
    local.selectedId = '';
    local.detail = null;

    const phaseSelect = select(
      [{ value: '', label: '全部位面' }, { value: 'logic', label: 'Logic' }, { value: 'fantasy', label: 'Fantasy' }],
      local.filters.phase,
      (value) => { local.filters.phase = value; loadEntries(); },
    );
    const sectionInput = textInput({
      placeholder: '分区，如 essay',
      value: local.filters.section,
      size: 'sm',
      onEnter: (value) => { local.filters.section = value.trim(); loadEntries(); },
    });
    const queryInput = textInput({
      placeholder: '搜索标题或摘要',
      value: local.filters.q,
      size: 'sm',
      onEnter: (value) => { local.filters.q = value.trim(); loadEntries(); },
    });

    listHost = h('div', { class: 'rows' }, muted('加载中…'));
    detailHost = h('div', {}, muted('从左侧选择一个条目。'));

    container.append(
      h('div', { class: 'split' },
        card({
          title: '条目列表',
          eyebrow: 'ENTRIES',
          body: [
            h('div', { class: 'inline' },
              phaseSelect,
              sectionInput,
              queryInput,
              button('筛选', { size: 'sm', onclick: () => loadEntries() }),
            ),
            listHost,
          ],
        }),
        detailHost,
      ),
    );

    await Promise.all([loadEntries(), loadSeries()]);
  },
};

async function loadEntries() {
  const params = new URLSearchParams();
  if (local.filters.phase) params.set('phase', local.filters.phase);
  if (local.filters.section) params.set('section', local.filters.section);
  if (local.filters.q) params.set('q', local.filters.q);
  const query = params.toString();
  try {
    const payload = await request(`/manage/entries${query ? `?${query}` : ''}`);
    local.items = payload.items || [];
    if (local.selectedId && !local.items.some((item) => item.id === local.selectedId)) {
      local.selectedId = '';
      local.detail = null;
    }
    renderList();
    renderDetail();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadSeries() {
  try {
    const payload = await request('/manage/series');
    local.series = payload.items || [];
  } catch {
    local.series = [];
  }
}

function renderList() {
  clear(listHost);
  if (!local.items.length) {
    listHost.append(muted('当前筛选条件下没有条目。'));
    return;
  }
  for (const entry of local.items) {
    listHost.append(h('button', {
      class: `row row--clickable ${entry.id === local.selectedId ? 'row--active' : ''}`,
      type: 'button',
      onclick: () => selectEntry(entry.id),
    },
    h('div', { class: 'row__main' },
      h('div', { class: 'row__title' }, entry.title || entry.slug || entry.id),
      metaLine('row__meta',
        entry.publishedAt ? String(entry.publishedAt).slice(0, 10) : '日期未知',
        entry.phase ? PHASE_LABEL[entry.phase] || entry.phase : '',
        entry.section ? `#${entry.section}` : '',
        entry.seriesId ? `系列 ${String(entry.seriesId).replace(/^series:/, '')}` : '',
      ),
    ),
    h('span', { class: 'row__side' }, badge(COVER_SOURCE[entry.coverSource] || '无封面')),
    ));
  }
}

async function selectEntry(id) {
  local.selectedId = id;
  local.detail = null;
  renderList();
  renderDetail();
  try {
    local.detail = await request(`/manage/entries/${encodeURIComponent(id)}`);
    renderDetail();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderDetail() {
  detailHost.replaceChildren();
  const detail = local.detail;
  if (!detail) {
    detailHost.append(local.selectedId
      ? card({ title: '条目详情', body: [muted('加载中…')] })
      : card({ title: '条目详情', body: [muted('从左侧选择一个条目。')] }));
    return;
  }
  const entry = detail.entry;
  detailHost.append(
    card({
      title: entry.title || entry.id,
      eyebrow: 'ENTRY',
      body: [
        h('div', { class: 'inline' },
          badge(PHASE_LABEL[entry.phase] || entry.phase, 'accent'),
          entry.section ? badge(`#${entry.section}`) : null,
          badge(entry.status || 'published'),
          badge(`发布于 ${String(entry.publishedAt || '').slice(0, 10)}`),
          badge(`${entry.wordCount || 0} 字`),
        ),
        renderMetaEditor(entry),
        renderCoverSection(entry, detail.coverCandidates || []),
        renderTagsSection(entry),
        renderSeriesSection(entry),
      ],
    }),
  );
}

function renderMetaEditor(entry) {
  const titleInput = textInput({ value: entry.title || '' });
  const summaryInput = h('textarea', { class: 'input', rows: '3' });
  summaryInput.value = entry.summary || '';
  const msg = h('p', { class: 'msg' });
  const save = button('保存标题与摘要', {
    kind: 'primary',
    size: 'sm',
    onclick: (event) => withBusy(event.currentTarget, async () => {
      await request(`/manage/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        body: { title: titleInput.value, summary: summaryInput.value },
      });
      entry.title = titleInput.value.trim();
      entry.summary = summaryInput.value.trim();
      const listed = local.items.find((item) => item.id === entry.id);
      if (listed) listed.title = entry.title;
      setMessage(msg, '已保存，站点在下次发布后生效。', 'ok');
      renderList();
      renderDetail();
    }, '保存失败'),
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, '标题'), titleInput),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, '摘要'), summaryInput,
      h('span', { class: 'field__hint' }, '留空表示无摘要；最长 400 字。')),
    h('div', { class: 'inline' }, save, msg),
  );
}

function renderCoverSection(entry, candidates) {
  const msg = h('p', { class: 'msg' });
  const grid = h('div', { class: 'cover-grid' });
  const currentAssetId = entry.cover?.assetId || '';
  if (!candidates.length) {
    grid.append(muted('正文没有可用图片，当前使用文字封面。'));
  } else {
    for (const candidate of candidates) {
      grid.append(h('button', {
        class: `cover ${candidate.isCurrent ? 'cover--current' : ''}`,
        type: 'button',
        title: candidate.sourceName || candidate.assetId,
        onclick: (event) => withBusy(event.currentTarget, async () => {
          await patchEntry(entry, { cover: { assetId: candidate.assetId } });
          setMessage(msg, '封面已更新。', 'ok');
        }, '设置封面失败'),
      }, h('img', { src: candidate.blobUrl, alt: candidate.sourceName || '封面候选', loading: 'lazy' })));
    }
  }
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' },
      h('span', { class: 'field__label' }, '封面'),
      currentAssetId ? button('改用文字封面', {
        size: 'sm',
        onclick: (event) => withBusy(event.currentTarget, async () => {
          await patchEntry(entry, { cover: null });
          setMessage(msg, '已改用文字封面。', 'ok');
        }, '操作失败'),
      }) : null,
    ),
    grid,
    msg,
  );
}

function renderTagsSection(entry) {
  const tags = Array.isArray(entry.tags) ? [...entry.tags] : [];
  return h('div', { class: 'field' },
    h('span', { class: 'field__label' }, '标签'),
    chipInput(tags, (next) => {
      withBusy(null, async () => {
        await patchEntry(entry, { tags: next });
        toast('标签已更新。', 'ok');
      }, '标签保存失败');
    }),
  );
}

function renderSeriesSection(entry) {
  const options = [
    { value: '', label: '不属于任何系列' },
    ...local.series.map((series) => ({ value: series.id, label: series.label })),
  ];
  const selectEl = select(options, entry.seriesId || '', () => undefined);
  const msg = h('p', { class: 'msg' });
  return h('div', { class: 'stack' },
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, '系列归属'),
      h('div', { class: 'inline' },
        selectEl,
        button('保存', {
          size: 'sm',
          onclick: (event) => withBusy(event.currentTarget, async () => {
            await patchEntry(entry, { seriesId: selectEl.value });
            setMessage(msg, '系列归属已更新。', 'ok');
          }, '保存失败'),
        }),
      ),
    ),
    msg,
  );
}

/** PATCH 后同步本地列表与详情数据，避免整页重拉。 */
async function patchEntry(entry, body) {
  const payload = await request(`/manage/entries/${encodeURIComponent(entry.id)}`, { method: 'PATCH', body });
  if (payload?.updated?.cover !== undefined) {
    entry.cover = payload.updated.cover;
    entry.coverSource = payload.updated.cover?.assetId ? 'manual' : 'text';
  }
  if (payload?.updated?.tags) entry.tags = payload.updated.tags;
  if (payload?.updated?.series !== undefined) {
    entry.seriesId = payload.updated.series?.seriesId || null;
  }
  const listed = local.items.find((item) => item.id === entry.id);
  if (listed) {
    listed.tags = entry.tags;
    listed.seriesId = entry.seriesId;
    listed.coverSource = entry.coverSource;
  }
  toast('已保存，站点在下次发布后生效。', 'ok');
  renderList();
  await selectEntryRefresh(entry.id);
}

async function selectEntryRefresh(id) {
  try {
    local.detail = await request(`/manage/entries/${encodeURIComponent(id)}`);
    renderDetail();
  } catch (error) {
    toast(error.message, 'error');
  }
}
