// 登录门：Microsoft 重定向 + 站点口令两条通道，认证成功后回调进入管理台。

import { loginMicrosoft, loginPassword } from '../api.js';
import { clear, h, setMessage } from '../ui.js';

export function initGate({ onAuthenticated }) {
  const gate = document.querySelector('[data-gate]');
  const message = gate.querySelector('[data-gate-message]');
  const form = gate.querySelector('[data-gate-form]');
  const user = gate.querySelector('[data-gate-user]');
  const pass = gate.querySelector('[data-gate-pass]');
  const submit = gate.querySelector('[data-gate-submit]');

  gate.querySelector('[data-gate-ms]').addEventListener('click', () => {
    setMessage(message, '正在跳转 Microsoft 登录…');
    loginMicrosoft().catch((error) => setMessage(message, error.message, 'error'));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage(message, '');
    submit.disabled = true;
    try {
      const session = await loginPassword(user.value.trim(), pass.value);
      user.value = '';
      pass.value = '';
      onAuthenticated(session);
    } catch (error) {
      setMessage(message, error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

export function showGate(messageText = '') {
  document.querySelector('[data-gate]').hidden = false;
  document.querySelector('[data-shell]').hidden = true;
  const message = document.querySelector('[data-gate-message]');
  setMessage(message, messageText, messageText ? 'error' : 'info');
}

export function hideGate() {
  document.querySelector('[data-gate]').hidden = true;
  document.querySelector('[data-shell]').hidden = false;
}

/** 未接入 API 时显示的引导卡片（登录门位置）。 */
export function showGateSetupNotice(container) {
  clear(container).append(
    h('p', { class: 'muted' }, '站点配置里还没有管理接口地址（data/site.json 的 interactions.apiBaseUrl）。'),
    h('p', { class: 'muted' }, '请先完成 Azure 互动配置，再刷新本页。'),
  );
}
