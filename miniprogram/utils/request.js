const transport = require('./transport');
const { getToken, clearAuth, login } = require('./auth');
const demo = require('./demo');

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
    res = await transport.send({ url, method, data, header: headers });
  } catch (err) {
    // 网络层失败（后端不可达 / 云端未部署）
    if (loading) wx.hideLoading();
    const hit = tryDemo(method, url, data);
    if (hit.hit) return hit.data;
    throw { code: -1, message: '网络异常，请稍后重试', error: err };
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
    throw { code: body.code, message: body.message || '服务器异常' };
  }

  if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 0) {
    if (demoFill) {
      const hit = tryFill(url, body.data);
      if (hit.hit) return hit.data;
    }
    return body.data;
  }

  throw { code: body.code, message: body.message || '请求失败' };
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
