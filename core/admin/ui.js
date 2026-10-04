// DOM 助手与通用组件：h() 元素工厂、toast、分级确认弹窗、开关、徽标、chips。

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'required') {
      if (value) el[key] = true;
    } else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// ---------- toast ----------

let toastStack = null;

export function toast(message, kind = 'info') {
  if (!toastStack) toastStack = document.querySelector('[data-toasts]');
  if (!toastStack) return;
  const item = h('div', { class: `toast toast--${kind}`, role: 'status' }, message);
  const close = h('button', { class: 'toast__close', type: 'button', 'aria-label': '关闭', onclick: () => item.remove() }, '×');
  item.append(close);
  toastStack.append(item);
  setTimeout(() => item.remove(), 4600);
}

// ---------- 确认弹窗 ----------

let modalRoot = null;

/**
 * 分级确认：影响面大的操作弹此框，body 支持字符串或节点数组。
 * 返回 Promise<boolean>。
 */
export function confirmDialog({ title, body, confirmLabel = '确认', danger = false }) {
  if (!modalRoot) modalRoot = document.querySelector('[data-modal]');
  return new Promise((resolve) => {
    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };
    const backdrop = h('div', {
      class: 'modal-backdrop',
      onclick: (event) => { if (event.target === backdrop) close(false); },
    },
    h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true' },
      h('h3', { class: 'modal__title' }, title),
      h('div', { class: 'modal__body' }, body),
      h('div', { class: 'modal__actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, '取消'),
        h('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
          type: 'button',
          onclick: () => close(true),
        }, confirmLabel),
      ),
    ));
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close(false);
    });
    modalRoot.append(backdrop);
    backdrop.querySelector('.modal__actions .btn--danger, .modal__actions .btn--primary')?.focus();
  });
}

// ---------- 小组件 ----------

export function badge(text, kind = 'muted') {
  return h('span', { class: `badge badge--${kind}` }, text);
}

export function button(label, { kind = '', size = '', onclick, disabled = false, title = '' } = {}) {
  return h('button', {
    class: `btn ${kind ? `btn--${kind}` : ''} ${size ? `btn--${size}` : ''}`.trim(),
    type: 'button',
    onclick,
    disabled,
    title,
  }, label);
}

/** 受控文本输入。onEnter 为回车回调。 */
export function textInput({ placeholder = '', value = '', onEnter, oninput, size = '' } = {}) {
  const el = h('input', {
    class: `input ${size ? `input--${size}` : ''}`.trim(),
    type: 'text',
    placeholder,
    value,
    oninput,
  });
  if (onEnter) {
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onEnter(el.value);
    });
  }
  return el;
}

export function select(options, value, onchange) {
  const el = h('select', { class: 'input input--select', onchange: (event) => onchange(event.target.value) });
  for (const opt of options) {
    el.append(h('option', { value: opt.value, selected: opt.value === value }, opt.label));
  }
  return el;
}

/** 表单行：标签 + 控件 + 说明。 */
export function field(label, control, hint = '') {
  return h('label', { class: 'field' },
    h('span', { class: 'field__label' }, label),
    control,
    hint ? h('span', { class: 'field__hint' }, hint) : null,
  );
}

/** 开关（checkbox 视觉化），onchange 返回勾选值。 */
export function switchControl(checked, onchange, label = '') {
  const input = h('input', {
    class: 'switch__input',
    type: 'checkbox',
    checked,
    onchange: (event) => onchange(event.target.checked),
  });
  return h('label', { class: 'switch' },
    input,
    h('span', { class: 'switch__track' }, h('span', { class: 'switch__thumb' })),
    label ? h('span', { class: 'switch__label' }, label) : null,
  );
}

/** 卡片。header 可为 null；actions 渲染在头右侧。 */
export function card({ title, eyebrow = '', actions = null, body = [], className = '' }) {
  const el = h('section', { class: `panel ${className}`.trim() });
  if (title || actions) {
    el.append(h('header', { class: 'panel__head' },
      h('div', {},
        eyebrow ? h('p', { class: 'panel__eyebrow' }, eyebrow) : null,
        title ? h('h2', { class: 'panel__title' }, title) : null,
      ),
      actions ? h('div', { class: 'panel__actions' }, actions) : null,
    ));
  }
  el.append(h('div', { class: 'panel__body' }, body));
  return el;
}

/** 空态/说明文字。 */
export function muted(text) {
  return h('p', { class: 'muted' }, text);
}

/**
 * 元信息行：把每个片段包进独立 span，flex gap 才能生效
 * （相邻裸文本节点会合并成一个匿名 item，间隔会失效）。
 */
export function metaLine(className, ...items) {
  return h('div', { class: className },
    items
      .filter((item) => item !== '' && item !== null && item !== undefined && item !== false)
      .map((item) => h('span', {}, item)),
  );
}

/** 错误/结果消息行。 */
export function messageLine() {
  return h('p', { class: 'msg' });
}

export function setMessage(el, text, kind = 'info') {
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('msg--error', 'msg--ok');
  if (kind === 'error') el.classList.add('msg--error');
  if (kind === 'ok') el.classList.add('msg--ok');
}

/** 标签 chips 输入：回车添加、点 × 移除，变更即时回调。 */
export function chipInput(values, onChange, placeholder = '输入后回车添加') {
  let current = [...values];
  const wrap = h('div', { class: 'chips' });
  function render() {
    clear(wrap);
    for (const tag of current) {
      wrap.append(h('span', { class: 'chip' },
        tag,
        h('button', {
          class: 'chip__x', type: 'button', 'aria-label': `移除 ${tag}`,
          onclick: () => { current = current.filter((item) => item !== tag); render(); onChange(current); },
        }, '×'),
      ));
    }
    const input = textInput({
      placeholder,
      onEnter: (value) => {
        const tag = String(value || '').trim();
        if (tag && !current.includes(tag)) {
          current = [...current, tag];
          onChange(current);
        }
        render();
      },
    });
    input.addEventListener('blur', () => {
      const tag = String(input.value || '').trim();
      if (tag && !current.includes(tag)) {
        current = [...current, tag];
        onChange(current);
      }
    });
    wrap.append(input);
  }
  render();
  return wrap;
}

/** 可折叠高级区。 */
export function collapse(summary, ...body) {
  return h('details', { class: 'collapse' },
    h('summary', {}, summary),
    h('div', { class: 'collapse__body' }, body),
  );
}

/** 带加载中遮罩的异步操作包装：运行期间禁用按钮，失败 toast。 */
export async function withBusy(btn, run, failureMessage = '操作失败') {
  if (btn) btn.disabled = true;
  try {
    return await run();
  } catch (error) {
    toast(error?.message || failureMessage, 'error');
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}
