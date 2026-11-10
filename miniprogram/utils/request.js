const transport = require('./transport');
const { getToken, clearAuth, login } = require('./auth');
const demo = require('./demo');

// 冷启动重试：云托管最小实例为 0 时，闲置后第一个请求会先被网关回 500/503（容器还在拉镜像/连库），
// 或者直接超时。这类失败重试一次基本就能成功，不重试的话用户看到的就是「网络异常，请稍后重试」白屏。
const WAKE_RETRY = 2;      // 额外重试次数
const WAKE_GAP = 1200;     // 首次等待 1.2s，之后翻倍

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 只有「容器没就绪/网关报错」才值得重试；业务错误（body.code=500 且 HTTP 200）不重试，
// 否则像「书源需要人机验证」这种会白白多等两三秒。
function looksLikeColdStart(res) {
  if (!res) return true;                                  // 连响应都没有：网络层失败或超时
  return res.statusCode >= 500 && res.statusCode < 600;
}

// 域名没进白名单：重试没有任何意义（每次都被微信拦在本地），必须让用户立刻看到真实原因。
// 体验版 / 正式版强制执行 request 合法域名，devtools 的「不校验合法域名」管不到它们。
function isDomainBlocked(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return /not in domain list|url not in domain|非法域名|域名不合法/i.test(msg);
}

async function sendWithWakeRetry(payload) {
  let res = null;
  for (let attempt = 0; attempt <= WAKE_RETRY; attempt++) {
    try {
      res = await transport.send(payload);
    } catch (err) {
      if (isDomainBlocked(err)) throw err;                 // 白名单问题，别浪费时间重试
      res = null;
      if (attempt === WAKE_RETRY) throw err;
    }
    if (res && !looksLikeColdStart(res)) return res;
    if (attempt === WAKE_RETRY) return res;
    if (attempt === 0) wx.showToast({ title: '正在唤醒服务…', icon: 'none', duration: 1800 });
    await sleep(WAKE_GAP * (attempt + 1));
  }
  return res;
}

/**
 * 统一请求封装（底层传输见 utils/transport.js：本地 wx.request / 云托管 callContainer）
 * @param {object} opts
 *  - url: 相对路径，如 '/api/home'
 *  - method, data, header
 *  - retry: 401 时是否静默重登并重放（默认 true）
 *  - demoFill: 列表为空时是否用演示数据填充（默认 false）
 *  - loading: 是否显示 loading
 *  - loadingText
 * 成功 resolve 业务 data；失败 reject { code, message }
 */

// 演示兜底：命中时标记演示模式并返回数据
function tryDemo(method, url, data) {
  const result = demo.fallback(method, url, data);
  if (result !== undefined) {
    demo.markDemo();
    return { hit: true, data: result };
  }
  return { hit: false };
}

// 成功返回但列表为空：仅在页面显式要求时填充
function isEmptyResult(data) {
  if (!data) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (Array.isArray(data.list)) return data.list.length === 0;
  if (Array.isArray(data.hot) || Array.isArray(data.latest)) {
    return !(data.hot && data.hot.length) && !(data.latest && data.latest.length);
  }
  return false;
}

function tryFill(url, data) {
  if (!demo.ENABLE_DEMO) return { hit: false };
  if (!isEmptyResult(data)) return { hit: false };
  const result = demo.fill(url);
  if (result !== undefined) {
    demo.markDemo();
    return { hit: true, data: result };
  }
  return { hit: false };
}

async function request(opts) {
  const {
    url,
    method = 'GET',
    data,
    header = {},
    retry = true,
    demoFill = false,
    loading = false,
    loadingText = '加载中',
  } = opts;

  if (loading) wx.showLoading({ title: loadingText, mask: true });

  const token = getToken();
  const headers = {
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...header,
  };

  let res;
  try {
    res = await sendWithWakeRetry({ url, method, data, header: headers });
  } catch (err) {
    // 网络层失败（后端不可达 / 域名没进白名单 / 冷启动超时，已重试过）
    if (loading) wx.hideLoading();
    if (isDomainBlocked(err)) {
      console.error(
        '[request] 该域名不在小程序 request 合法域名里，请求被微信在本地拦截。\n'
        + '请到 mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名 → request 合法域名 添加：',
        (err && (err.errMsg || err.message)) || ''
      );
      throw { code: -2, message: '服务器域名未加入白名单' };
    }
    const hit = tryDemo(method, url, data);
    if (hit.hit) return hit.data;
    throw { code: -1, message: '服务正在启动，请稍后再试', error: err };
  }

  if (loading) wx.hideLoading();
  const body = res.data || {};

  // 401：静默重登 + 重放一次
  if (res.statusCode === 401 || body.code === 401) {
    if (retry) {
      try {
        await login();
        return await request({ ...opts, retry: false, loading: false });
      } catch (e) {
        clearAuth();
      }
    } else {
      clearAuth();
    }
    throw { code: 401, message: '请先登录' };
  }

  const serverError =
    res.statusCode >= 500 || (typeof body.code === 'number' && body.code >= 500);
  if (serverError) {
    const hit = tryDemo(method, url, data);
    if (hit.hit) return hit.data;
    // HTTP 5xx（重试后仍失败）基本是容器刚被唤醒 / 正在重启，给一句用户看得懂的提示
    const cold = res.statusCode >= 500 && res.statusCode < 600;
    throw {
      code: body.code || res.statusCode,
      message: cold ? '服务正在启动，请稍后再试' : (body.message || '服务器异常'),
    };
  }

  if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 0) {
    if (demoFill) {
      const hit = tryFill(url, body.data);
      if (hit.hit) return hit.data;
    }
    return body.data;
  }

  // 业务错误：把 data 一起带出去（如试读限制的 freeChapters / needLogin）
  throw { code: body.code, message: body.message || '请求失败', data: body.data };
}

const get = (url, params, opts = {}) => {
  let qs = '';
  if (params) {
    const parts = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`);
    if (parts.length) qs = '?' + parts.join('&');
  }
  return request({ url: url + qs, method: 'GET', ...opts });
};

const post = (url, data, opts = {}) => request({ url, method: 'POST', data, ...opts });
const put = (url, data, opts = {}) => request({ url, method: 'PUT', data, ...opts });
const del = (url, opts = {}) => request({ url, method: 'DELETE', ...opts });

module.exports = { request, get, post, put, del };
