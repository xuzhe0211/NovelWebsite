const transport = require('./transport');
const demo = require('./demo');

const TOKEN_KEY = 'novel_token';
const USER_KEY = 'novel_user';
const DEMO_TOKEN = 'demo-local-token';

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token || '');
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function setUser(user) {
  const next = user || {};
  wx.setStorageSync(USER_KEY, next);
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.userInfo = next;
  } catch (e) {
    // getApp 在部分生命周期不可用，忽略
  }
  return next;
}

function clearAuth() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
}

// 当前是否为「后端不可达时的本地体验账号」
function isDemoUser() {
  return getToken() === DEMO_TOKEN;
}

// 退出登录：清本地登录态（后端 JWT 无状态，无需通知服务端）
function logout() {
  clearAuth();
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.userInfo = null;
  } catch (e) {
    // ignore
  }
}

// 底层请求（不走 request.js，避免循环依赖；也不做演示兜底）
// 走 transport，自动适配本地直连 / 云托管 callContainer。
// 返回完整 { statusCode, data }：登录失败时要靠状态码判断是「网关没就绪」还是「后端业务报错」。
function rawRequest(options) {
  return transport.send({
    url: options.url,
    method: options.method,
    data: options.data,
    header: options.header,
    timeout: options.timeout || 8000,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把「不是我们后端 JSON」的响应描述清楚：网关 5xx 时 body 往往是 HTML 或空，
// 以前这里只会显示一句「登录失败，请稍后重试」，完全看不出是容器没起来。
function describeResponse(res, fallback) {
  const body = res && res.data;
  if (body && typeof body === 'object') {
    return body.message || fallback;
  }
  const text = typeof body === 'string' ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  const status = res && res.statusCode ? `HTTP ${res.statusCode}` : '无响应';
  return `${fallback}（${status}${text ? '：' + text : ''}）`;
}

// 只有「容器没就绪 / 网关报错」才重试；业务错误（HTTP 200 + code≠0）不重试。
const LOGIN_RETRY = 2;
const LOGIN_GAP = 1200;

// 用 code 换 token
async function exchangeCode(code) {
  const payload = {
    url: '/api/auth/login',
    method: 'POST',
    data: { code: code || getDeviceId(), deviceId: getDeviceId() },
    header: { 'content-type': 'application/json' },
  };

  let res = null;
  let lastError = null;
  for (let attempt = 0; attempt <= LOGIN_RETRY; attempt++) {
    try {
      res = await rawRequest(payload);
      lastError = null;
    } catch (e) {
      res = null;
      lastError = e;
    }
    // 网络层失败，或网关 5xx（容器还在拉镜像/连库），都值得再等一次
    const coldStart = !res || (res.statusCode >= 500 && res.statusCode < 600);
    if (!coldStart) break;
    if (attempt === LOGIN_RETRY) break;
    if (attempt === 0) wx.showToast({ title: '正在唤醒服务…', icon: 'none', duration: 1800 });
    await sleep(LOGIN_GAP * (attempt + 1));
  }

  if (!res) {
    // 域名白名单 / 网络不可达：reject 到这里的原始 errMsg 最有信息量
    const raw = String((lastError && (lastError.errMsg || lastError.message)) || '');
    if (/not in domain list|url not in domain|非法域名/i.test(raw)) {
      const err = new Error('服务器域名未加入白名单，请在后台配置 request 合法域名');
      err.code = -2;
      throw err;
    }
    const err = new Error('连不上服务器，请检查后端是否启动');
    err.code = -1;
    err.cause = lastError;
    throw err;
  }

  const body = res.data;
  if (body && typeof body === 'object' && body.code === 0 && body.data && body.data.token) {
    setToken(body.data.token);
    setUser(body.data.user || {});
    return body.data;
  }

  // 后端业务错误：把 code / message 原样透出（如「微信登录失败：40029 invalid code」）
  if (body && typeof body === 'object') {
    const err = new Error(body.message || '登录失败，请稍后重试');
    err.code = body.code;
    throw err;
  }

  // 走到这里说明响应不是我们的 JSON —— 基本就是网关层 5xx（容器未就绪/启动失败）
  const err = new Error(describeResponse(res, '登录接口未返回正常数据'));
  err.code = res.statusCode;
  console.error('[auth] 登录响应异常', res.statusCode, String(res.data).slice(0, 200));
  throw err;
}

// 游客模式（无 AppID）下 wx.login 可能失败，用本地持久设备ID兜底
function getDeviceId() {
  let id = wx.getStorageSync('novel_device_id');
  if (!id) {
    id = 'dev_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    wx.setStorageSync('novel_device_id', id);
  }
  return id;
}

function wxLoginCode() {
  return new Promise((resolve) => {
    wx.login({
      success: ({ code }) => resolve(code || ''),
      fail: () => resolve(''),
    });
  });
}

// 登录：wx.login 拿 code -> 后端换 token。
// 后端不可达且开启演示模式时，降级为本地体验账号（返回 demo:true 的 user）。
let loginPromise = null;
function login(options = {}) {
  if (loginPromise) return loginPromise;
  const allowDemo = options.allowDemo !== false;

  const task = (async () => {
    try {
      const code = await wxLoginCode();
      return await exchangeCode(code);
    } catch (e) {
      const code = e && e.code;
      const canFallback = code === -1 || code === undefined || code >= 500;
      if (allowDemo && demo.ENABLE_DEMO && canFallback) return loginLocal();
      throw e;
    }
  })();

  loginPromise = task;
  const clear = () => {
    if (loginPromise === task) loginPromise = null;
  };
  task.then(clear, clear);
  return task;
}

// 显式的本地体验登录（登录页「先本地体验」按钮）
function loginLocal() {
  const res = demo.loginDemo();
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.userInfo = res.user;
  } catch (e) {
    // ignore
  }
  return res;
}

function isLoggedIn() {
  return !!getToken();
}

// 确保已登录，未登录则自动登录（静默场景用；需要用户确认的场景请显式引导）
function ensureLogin() {
  return isLoggedIn() ? Promise.resolve(getUser()) : login();
}

// 临时文件（开发者工具 http://tmp/、真机 wxfile://）不算远程地址
function isRealRemote(url) {
  if (!/^https?:\/\//i.test(url || '')) return false;
  return !/^https?:\/\/tmp\//i.test(url);
}

// 头像临时文件转本地持久路径（重启小程序后仍可用）
function persistAvatar(tempPath) {
  return new Promise((resolve) => {
    if (!tempPath) return resolve('');
    if (isRealRemote(tempPath)) return resolve(tempPath);
    try {
      wx.getFileSystemManager().saveFile({
        tempFilePath: tempPath,
        success: (r) => resolve(r.savedFilePath || tempPath),
        fail: () => resolve(tempPath),
      });
    } catch (e) {
      resolve(tempPath);
    }
  });
}

// 更新昵称/头像：先写本地，登录态可用时再同步到服务端
async function updateProfile(patch = {}) {
  const cur = getUser() || {};
  const next = { ...cur, ...patch };
  setUser(next);
  if (isDemoUser()) return next;

  const payload = {};
  if (patch.nickname) payload.nickname = patch.nickname;
  if (patch.avatar && isRealRemote(patch.avatar)) payload.avatar = patch.avatar;
  if (!Object.keys(payload).length) return next;

  try {
    const res = await rawRequest({
      url: '/api/auth/profile',
      method: 'PUT',
      data: payload,
      header: {
        'content-type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
    });
    if (res && res.data && res.data.code === 0 && res.data.data) {
      return setUser({ ...next, ...res.data.data });
    }
  } catch (e) {
    // 离线时仅本地生效，下次登录后可再同步
  }
  return next;
}

module.exports = {
  getToken,
  setToken,
  getUser,
  setUser,
  clearAuth,
  logout,
  login,
  loginLocal,
  isLoggedIn,
  isDemoUser,
  ensureLogin,
  persistAvatar,
  updateProfile,
};
