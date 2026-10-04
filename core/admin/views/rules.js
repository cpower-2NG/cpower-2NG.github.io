// 同步规则：常用项表单化，完整 JSON 折叠为高级模式。
// 表单改动写回 working 对象并同步到 JSON；用户手改过 JSON 则以 JSON 为准保存。

import { request } from '../api.js';
import { button, card, chipInput, collapse, h, muted, select, setMessage, switchControl, textInput } from '../ui.js';

let working = null;     // 表单正在编辑的 rules 深拷贝
let jsonDirty = false;  // 用户是否手改过高级 JSON

export default {
  id: 'rules',
  title: '同步规则',
  async mount(container) {
    jsonDirty = false;
    let payload;
    try {
      payload = await request('/manage/settings');
    } catch (error) {
      container.append(card({ title: '同步规则', body: [muted(`加载失败：${error.message}`)] }));
      return;
    }
    working = structuredClone(payload.rules || {});

    const msg = h('p', { class: 'msg' });

    // ---- 自动发布 ----
    const autoPublish = switchControl(Boolean(working.autoPublish), (checked) => {
      working.autoPublish = checked;
      syncJson();
      setMessage(msg, checked ? '开启后，通过全部检查的内容会在真实同步时直接发布。' : '关闭时，所有内容只进审查队列，不会发布。');
    }, '自动发布（autoPublish）');

    // ---- 基础 ----
    const phaseSelect = select(
      [{ value: 'fantasy', label: 'Fantasy' }, { value: 'logic', label: 'Logic' }],
      working.defaultPhase || 'fantasy',
      (value) => { working.defaultPhase = value; syncJson(); },
    );
    const backfillInput = numberInput(working.initialBackfillDays ?? 31, (value) => { working.initialBackfillDays = value; syncJson(); });
    const keywords = chipInput(Array.isArray(working.exclude?.keywords) ? working.exclude.keywords : [], (next) => {
      ensure('exclude').keywords = next;
      syncJson();
    }, '输入关键词后回车，如：抽奖');

    // ---- include / exclude / safety 开关组 ----
    const includeToggles = h('div', { class: 'inline' },
      ...toggleGroup('include', {
        originalText: '保留原文',
        imagePosts: '图片内容',
        videoReposts: '视频转载',
        historicalInteractions: '历史互动数据',
      }),
    );
    const excludeToggles = h('div', { class: 'inline' },
      ...toggleGroup('exclude', {
        emptyPosts: '排除空内容',
        checkIns: '排除签到',
        applicationShares: '排除应用分享',
        duplicateMedia: '排除重复媒体',
      }),
    );
    const safetyToggles = h('div', { class: 'inline' },
      ...toggleGroup('safety', {
        quarantineUnknownVisibility: '可见性未知时隔离',
        quarantineParseWarnings: '解析不完整时隔离',
      }),
    );
    const missingChecks = numberInput(working.safety?.confirmedMissingChecks ?? 2, (value) => {
      ensure('safety').confirmedMissingChecks = value;
      syncJson();
    });

    // ---- 高级 JSON ----
    const jsonArea = h('textarea', { class: 'code', spellcheck: 'false' });
    jsonArea.addEventListener('input', () => { jsonDirty = true; });
    function syncJson() {
      if (!jsonDirty) jsonArea.value = JSON.stringify(working, null, 2);
    }
    syncJson();

    const save = button('保存规则', {
      kind: 'primary',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        setMessage(msg, '');
        let rules = working;
        if (jsonDirty) {
          try {
            rules = JSON.parse(jsonArea.value);
          } catch (error) {
            event.currentTarget.disabled = false;
            setMessage(msg, `高级 JSON 无法解析：${error.message}`, 'error');
            return;
          }
        }
        try {
          const saved = await request('/manage/settings', { method: 'PUT', body: { rules } });
          working = structuredClone(saved.rules);
          jsonDirty = false;
          jsonArea.value = JSON.stringify(working, null, 2);
          setMessage(msg, '规则已保存。下一次同步生效。', 'ok');
        } catch (error) {
          setMessage(msg, error.message, 'error');
        } finally {
          event.currentTarget.disabled = false;
        }
      },
    });

    container.append(card({
      title: 'QQ 空间同步规则',
      eyebrow: 'SYNC RULES',
      body: [
        autoPublish,
        muted('自动发布是总开关：关闭时所有抓取内容只进入审查队列，需要在「QQ 空间同步」页逐条放行；开启后，未触发任何隔离条件的内容会在真实同步时直接发布到公开仓库。'),
        h('div', { class: 'inline' },
          h('div', { class: 'field' }, h('span', { class: 'field__label' }, '内容默认位面'), phaseSelect),
          h('div', { class: 'field' }, h('span', { class: 'field__label' }, '首次回填天数'), backfillInput),
        ),
        h('div', { class: 'field' },
          h('span', { class: 'field__label' }, '排除关键词'),
          keywords,
        ),
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, '包含内容'), includeToggles),
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, '排除与安全'), excludeToggles, safetyToggles),
        h('div', { class: 'field' },
          h('span', { class: 'field__label' }, '删除判定：连续拉取失败次数'),
          missingChecks,
          h('span', { class: 'field__hint' }, '原始说说连续 N 次确认不存在后，才在站内标记为已删除（防止 QQ 接口抖动误判）。'),
        ),
        collapse('高级：完整规则 JSON',
          muted('表单未覆盖的字段（media 尺寸数组等）在这里编辑。手改过 JSON 后将以 JSON 内容为准保存。'),
          jsonArea,
        ),
        h('div', { class: 'inline' }, save, msg),
      ],
    }));
  },
};

function ensure(section) {
  working[section] = { ...(working[section] || {}) };
  return working[section];
}

function toggleGroup(section, labels) {
  return Object.entries(labels).map(([key, label]) =>
    switchControl(Boolean(working[section]?.[key]), (checked) => {
      ensure(section)[key] = checked;
      syncJson();
    }, label),
  );
}

function numberInput(value, onChange) {
  const input = textInput({ value: String(value) });
  input.type = 'number';
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
    else input.value = String(value);
  });
  return input;
}
