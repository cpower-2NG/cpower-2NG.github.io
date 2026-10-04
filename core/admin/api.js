// 管理接口访问与双通道认证（Microsoft 登录 + 站点口令）。
// 认证状态是全局单例，视图通过 request()/loginPassword() 等入口使用。

const SESSION_KEY = 'bifrost:admin:session';

const state = {
  config: null,      // site.json 的 interactions 段
  msal: null,        // PublicClientApplication 实例（可用时）
  account: null,
  unauthorizedHandler: null,
};

export function isLocalDevelopment() {
  return ['localhost', '127.0.0.1'].includes(location.hostname);
}

export function apiBase() {
  return String(state.config?.apiBaseUrl || '').replace(/\/+$/, '');
}

export function msalReady() {
  return Boolean(state.config?.admin?.tenantId && state.config?.admin?.clientId && state.config?.admin?.apiScope);
}

export function adminName() {
  return state.account?.name || readSession()?.name || '';
}

export function onUnauthorized(handler) {
  state.unauthorizedHandler = handler;
}

// ---------- 站点口令会话 ----------

export function readSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!session?.token || new Date(session.expiresAt).getTime() <= Date.now() + 60000) return null;
    return session;
  } catch {
    return null;
  }
}

export async function loginPassword(username, password) {
  const payload = await request('/manage/auth/login', {
    method: 'POST',
    body: { username, password },
    auth: false,
  });
  const session = {
    token: payload.token,
    expiresAt: payload.expiresAt,
    name: payload.name || username,
    method: 'password',
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearPasswordSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ---------- Microsoft 登录 ----------

export async function initAuth(siteInteractions) {
  state.config = siteInteractions || {};
  if (!msalReady() || !window.msal) return;
  state.msal = new window.msal.PublicClientApplication({
    auth: {
      clientId: state.config.admin.clientId,
      authority: `https://login.microsoftonline.com/${state.config.admin.tenantId}`,
      redirectUri: `${location.origin}/admin.html`,
      postLogoutRedirectUri: `${location.origin}/admin.html`,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await state.msal.initialize();
  const redirect = await state.msal.handleRedirectPromise();
  state.account = redirect?.account || state.msal.getAllAccounts()[0] || null;
}

export async function loginMicrosoft() {
  if (!state.msal) {
    if (msalReady() && !window.msal) throw new Error('Microsoft 登录库加载失败，请刷新页面重试。');
    throw new Error('Microsoft 登录未配置，请使用站点口令登录。');
  }
  await state.msal.loginRedirect({ scopes: [state.config.admin.apiScope] });
}

export async function logout() {
  clearPasswordSession();
  if (state.msal && state.account) {
    await state.msal.logoutRedirect({ account: state.account });
    return;
  }
  state.account = null;
}

// ---------- 请求 ----------

async function bearerToken() {
  const session = readSession();
  if (session) return session.token;
  if (state.msal && state.account) {
    const result = await state.msal.acquireTokenSilent({
      account: state.account,
      scopes: [state.config.admin.apiScope],
    });
    return result.accessToken;
  }
  // 本地开发且未配置 Azure：服务端 ADMIN_DEV_BYPASS 放行。
  if (isLocalDevelopment() && !msalReady()) return '';
  return null;
}

export function hasIdentity() {
  return Boolean(readSession() || state.account || (isLocalDevelopment() && !msalReady()));
}

/**
 * 统一请求入口。path 以 /manage 开头；body 自动 JSON；form 传 FormData。
 * 认证失败时清会话并回调 unauthorizedHandler（回登录门）。
 */
export async function request(path, { method = 'GET', body, form, auth = true } = {}) {
  const headers = { accept: 'application/json' };
  if (auth) {
    const token = await bearerToken();
    if (token === null) {
      state.unauthorizedHandler?.('请先登录管理台。');
      throw new Error('请先登录管理台。');
    }
    if (token) headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      credentials: 'omit',
      body: form ? form : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error('无法连接管理接口，请检查网络或 API 配置。');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) {
    clearPasswordSession();
    state.unauthorizedHandler?.(payload?.message || '登录状态已失效，请重新登录。');
    throw new Error(payload?.message || '登录状态已失效。');
  }
  if (!response.ok) {
    throw new Error(payload?.message || `管理请求失败（HTTP ${response.status}）`);
  }
  return payload;
}
