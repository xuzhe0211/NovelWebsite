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
// 走 transport，自动适配本地直连 / 云托管 callContainer
function rawRequest(options) {
  return transport
    .send({
      url: options.url,
      method: options.method,
      data: options.data,
      header: options.header,
      timeout: options.timeout || 8000,
    })
    .then((res) => res.data);
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

// 用 code 换 token
async function exchangeCode(code) {
  let res;
  try {
    res = await rawRequest({
      url: '/api/auth/login',
      method: 'POST',
      data: { code: code || getDeviceId(), deviceId: getDeviceId() },
      header: { 'content-type': 'application/json' },
    });
  } catch (e) {
    const err = new Error('连不上服务器，请检查后端是否启动');
    err.code = -1;
    err.cause = e;
    throw err;
  }
  if (res && res.code === 0 && res.data && res.data.token) {
    setToken(res.data.token);
    setUser(res.data.user || {});
    return res.data;
  }
  const err = new Error((res && res.message) || '登录失败，请稍后重试');
  err.code = res && res.code;
  throw err;
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
    if (res && res.code === 0 && res.data) return setUser({ ...next, ...res.data });
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
