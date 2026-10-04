// 上传文章：拖拽/点选文件，表单校验后走 multipart 导入；任务列表自动轮询到全部结束。

import { request } from '../api.js';
import { PHASE_LABEL, UPLOAD_SECTIONS, IMPORT_STATUS, fmtBytes, fmtDateTime } from '../format.js';
import { badge, button, card, chipInput, collapse, h, metaLine, muted, select, textInput, toast, withBusy } from '../ui.js';

let tasksHost = null;
let pollTimer = null;
let tags = [];

export default {
  id: 'upload',
  title: '上传导入',
  async mount(container) {
    tags = [];
    let file = null;

    const fileInput = h('input', { type: 'file', accept: '.docx,.doc,.pdf,.txt,.md,.markdown,.html,.htm', hidden: true });
    const fileName = h('span', { class: 'nowrap' }, '未选择文件');

    const dropzone = h('div', { class: 'dropzone', role: 'button', tabindex: '0' },
      h('strong', {}, '点击或拖拽文件到此处'),
      h('div', {}, '支持 docx / doc / pdf / txt / md / html，单文件不超过 100MB，配图随文档内嵌。'),
      fileName,
    );
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fileInput.click();
    });
    for (const type of ['dragover', 'dragenter']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('dropzone--over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.remove('dropzone--over');
      });
    }
    dropzone.addEventListener('drop', (event) => {
      const dropped = event.dataTransfer?.files?.[0];
      if (dropped) acceptFile(dropped);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) acceptFile(fileInput.files[0]);
    });
    function acceptFile(picked) {
      file = picked;
      fileName.textContent = `已选择：${picked.name}（${fmtBytes(picked.size)}）`;
    }

    const titleInput = textInput({ placeholder: '标题（留空用文件名）' });
    const phaseSelect = select(
      [{ value: 'fantasy', label: 'Fantasy' }, { value: 'logic', label: 'Logic' }],
      'fantasy',
      (value) => refreshSections(value),
    );
    let sectionSelect = select([{ value: 'essay', label: 'essay' }], 'essay', () => undefined);
    function refreshSections(phase) {
      const options = (UPLOAD_SECTIONS[phase] || []).map((section) => ({ value: section, label: section }));
      const next = select(options, options[0]?.value || '', () => undefined);
      sectionSelect.replaceWith(next);
      sectionSelect = next;
    }
    const tagsEl = chipInput([], (next) => { tags = next; }, '标签，回车添加');
    const coverIndex = textInput({ placeholder: '0' });

    const submit = button('上传并导入', {
      kind: 'primary',
      onclick: (event) => withBusy(event.currentTarget, async () => {
        if (!file) throw new Error('请先选择文件。');
        const form = new FormData();
        form.append('file', file);
        form.append('title', titleInput.value.trim());
        form.append('phase', phaseSelect.value);
        form.append('section', sectionSelect.value);
        form.append('tags', tags.join(','));
        form.append('coverIndex', coverIndex.value || '0');
        await request('/manage/import', { method: 'POST', form });
        toast('导入任务已提交，转换完成后回到「发布」触发上线。', 'ok');
        file = null;
        fileName.textContent = '未选择文件';
        fileInput.value = '';
        await loadTasks();
      }, '上传失败'),
    });

    tasksHost = h('div', { class: 'rows' }, muted('还没有导入任务。'));

    container.append(
      card({
        title: '上传文档',
        eyebrow: 'UPLOAD',
        body: [
          dropzone,
          fileInput,
          h('div', { class: 'inline' }, titleInput),
          h('div', { class: 'inline' },
            phaseSelect, sectionSelect,
            h('div', { class: 'grow' }, tagsEl),
          ),
          collapse('高级选项',
            h('div', { class: 'field' },
              h('span', { class: 'field__label' }, '封面图序号'),
              coverIndex,
              h('span', { class: 'field__hint' }, '文档内第几张图作为封面，从 0 开始；留空取第一张。也可以导入后在「条目」页里换封面。'),
            ),
          ),
          h('div', { class: 'inline' }, submit),
        ],
      }),
      card({ title: '导入任务', eyebrow: 'TASKS', body: [muted('最近 20 条任务。转换由云端进行，列表会自动刷新。'), tasksHost] }),
    );

    await loadTasks();
    return () => window.clearTimeout(pollTimer);
  },
};

async function loadTasks() {
  window.clearTimeout(pollTimer);
  tasksHost.replaceChildren();
  let items = [];
  try {
    const payload = await request('/manage/import');
    items = payload.items || [];
  } catch (error) {
    tasksHost.append(muted(`加载失败：${error.message}`));
    return;
  }
  if (!items.length) {
    tasksHost.append(muted('还没有导入任务。'));
    return;
  }
  for (const task of items) {
    tasksHost.append(taskRow(task));
  }
  if (items.some((task) => task.status === 'queued' || task.status === 'running')) {
    pollTimer = window.setTimeout(loadTasks, 10000);
  }
}

function taskRow(task) {
  const kind = task.status === 'succeeded' ? 'ok' : task.status === 'failed' ? 'danger' : task.status === 'running' ? 'accent' : 'muted';
  return h('div', { class: 'row' },
    h('div', { class: 'row__main' },
      h('div', { class: 'row__title' }, task.title || task.fileName),
      metaLine('row__meta',
        task.fileName,
        fmtBytes(task.bytes),
        `${PHASE_LABEL[task.phase] || task.phase || ''}#${task.section || ''}`,
        task.requestedAt ? fmtDateTime(task.requestedAt) : '',
        task.entryId ? '已生成条目' : '',
        task.counts?.wordCount ? `${task.counts.wordCount} 字` : '',
        task.error ? `错误：${task.error}` : '',
      ),
    ),
    h('div', { class: 'row__side' }, badge(IMPORT_STATUS[task.status] || task.status, kind)),
  );
}
