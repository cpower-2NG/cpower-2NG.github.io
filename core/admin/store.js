// 轻量响应式 store：视图按 key 订阅，set 后自动重渲对应片段。
// 目的是替代旧代码里散落各处的“改完数据手动重绘 DOM”。

const listeners = new Map();
const state = {};

export function getState() {
  return state;
}

export function get(key) {
  return state[key];
}

export function set(key, value) {
  const changed = state[key] !== value;
  state[key] = value;
  if (changed) emit(key);
}

/** merge 到对象型 key（如 status），并触发订阅。 */
export function patch(key, partial) {
  state[key] = { ...(state[key] || {}), ...partial };
  emit(key);
}

export function watch(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  fn(state[key]);
  return () => listeners.get(key)?.delete(fn);
}

/** 订阅集合：视图卸载时调用 dispose() 一次性退订全部。 */
export function createSubscriptions() {
  const disposers = [];
  return {
    watch(key, fn) {
      disposers.push(watch(key, fn));
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

function emit(key) {
  listeners.get(key)?.forEach((fn) => {
    try {
      fn(state[key]);
    } catch (error) {
      console.error(`store watch handler failed for ${key}`, error);
    }
  });
}
