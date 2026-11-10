// 传输层：屏蔽「本地直连」与「云托管 callContainer」的差异。
// 上层（request.js / auth.js）只关心 { statusCode, data }，不关心底层走哪条链路。
const {
  MODE,
  BASE_URL,
  CLOUD_ENV,
  CLOUD_SERVICE,
  CLOUD_BASE_URL,
  CLOUD_VIA,
  CLOUD_HTTP_FALLBACK,
} = require('./config');

function isCloud() {
  return MODE === 'cloud';
}

function viaRequest({ url, method, data, header, timeout }, base = BASE_URL) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: base + url,
      method,
      data,
      header,
      timeout: timeout || 60000,
      success: (res) => resolve({ statusCode: res.statusCode, data: res.data }),
      fail: reject,
    });
  });
}

function viaContainer({ url, method, data, header, timeout }) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || !wx.cloud.callContainer) {
      reject(new Error('当前基础库不支持云托管调用，请升级微信版本（需 2.23.0+）'));
      return;
    }
    if (!CLOUD_ENV) {
      reject(new Error('CLOUD_ENV 未配置，请先在 utils/config.js 填入云托管环境 ID'));
      return;
    }
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path: url,
      method,
      // 云托管靠 X-WX-SERVICE 路由到具体服务
      header: { 'X-WX-SERVICE': CLOUD_SERVICE, ...header },
      // GET 的查询参数已经拼在 path 上，再传 data 会被当成请求体
      data: method === 'GET' ? undefined : data,
      timeout: timeout || 60000,
      success: (res) => resolve({ statusCode: res.statusCode, data: res.data }),
      fail: reject,
    });
  });
}

// 启动自检：单独打一次 callContainer，把网关的原始错误码打出来。
// 体验版没有 Network 面板，但打开「开发调试」后能在 vConsole 看到这行，一眼定位环境归属问题。
function probeContainer(path = '/api/health') {
  return new Promise((resolve) => {
    if (!wx.cloud || !wx.cloud.callContainer) {
      resolve({ ok: false, reason: '基础库不支持 callContainer（需 2.23.0+）' });
      return;
    }
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path,
      method: 'GET',
      header: { 'X-WX-SERVICE': CLOUD_SERVICE },
      timeout: 15000,
      success: (res) => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        statusCode: res.statusCode,
        code: res.data && res.data.code,
        data: res.data,
      }),
      fail: (e) => resolve({ ok: false, errCode: e.errCode, errMsg: e.errMsg }),
    });
  });
}

// 云托管网关「找不到服务」的几种表现：环境 ID 与服务名拼不出合法 host 时，
// callContainer 会以 404 + code=INVALID_HOST 走 success 回调（不是 reject），所以两处都要判。
const HOST_ERROR = /INVALID_HOST|INVALID_PATH|Invalid host|not exist/i;
function isHostError(payload) {
  if (!payload) return false;
  if (payload.statusCode === 404) {
    const code = payload.data && payload.data.code;
    if (typeof code === 'string' && HOST_ERROR.test(code)) return true;
    if (typeof code === 'string' && /SERVICE/i.test(code)) return true;
  }
  return false;
}
function isHostErrorMessage(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return HOST_ERROR.test(msg) || /-601031|ResourceNotFound/i.test(msg);
}

/**
 * 发送请求
 * @param {{url:string, method?:string, data?:any, header?:object, timeout?:number}} opts
 * @returns {Promise<{statusCode:number, data:any}>}
 */
// 一旦确认 callContainer 走不通（host / 服务路由问题），本次运行内就固定走公网域名，
// 免得每个请求都先失败一次再降级。下次冷启动会重新从 callContainer 试起。
let preferRequest = CLOUD_VIA === 'request';

function useRequestOnly() {
  if (preferRequest) return;
  preferRequest = true;
  console.warn('[transport] 本次运行后续请求改为直连公网域名：', CLOUD_BASE_URL);
}

async function send(opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const payload = { ...opts, method };
  if (!isCloud()) return viaRequest(payload);
  if (preferRequest) {
    // CLOUD_BASE_URL 空（新环境还没绑自定义域名时的常态）：直接报清楚，
    // 别拿空 base 拼出相对路径发出去，那样只会得到一句莫名其妙的网络错误。
    if (!CLOUD_BASE_URL) {
      throw new Error(
        'CLOUD_VIA=request 但 CLOUD_BASE_URL 为空：请先给云托管绑定已备案域名并填入 config.js，'
        + '或把 CLOUD_VIA 改回 auto 走 callContainer'
      );
    }
    return viaRequest(payload, CLOUD_BASE_URL);
  }

  let res;
  try {
    res = await viaContainer(payload);
  } catch (err) {
    if (CLOUD_HTTP_FALLBACK && CLOUD_BASE_URL && isHostErrorMessage(err)) {
      console.warn(
        '[transport] callContainer 找不到服务（环境 ID / 服务名不匹配？），'
          + '本次改用公网域名：', CLOUD_BASE_URL, '｜原因：', err.errMsg || err.message
      );
      useRequestOnly();
      return viaRequest(payload, CLOUD_BASE_URL);
    }
    throw err;
  }

  // 兜底：callContainer 没报错，但网关明确说这个 host 不存在 → 用公网域名重试一次。
  // 仅 devtools / 开了「不校验合法域名」时有效；体验版/正式版会被 request 白名单拦掉。
  if (CLOUD_HTTP_FALLBACK && CLOUD_BASE_URL && isHostError(res)) {
    console.warn(
      '[transport] callContainer 返回', res.statusCode, (res.data && res.data.code) || '',
      '（环境 ID / 服务名不匹配？），本次改用公网域名：', CLOUD_BASE_URL
    );
    useRequestOnly();
    return viaRequest(payload, CLOUD_BASE_URL);
  }

  return res;
}

module.exports = { send, isCloud, probeContainer };
