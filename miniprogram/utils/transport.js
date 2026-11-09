// 传输层：屏蔽「本地直连」与「云托管 callContainer」的差异。
// 上层（request.js / auth.js）只关心 { statusCode, data }，不关心底层走哪条链路。
const { MODE, BASE_URL, CLOUD_ENV, CLOUD_SERVICE } = require('./config');

function isCloud() {
  return MODE === 'cloud';
}

function viaRequest({ url, method, data, header, timeout }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + url,
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

/**
 * 发送请求
 * @param {{url:string, method?:string, data?:any, header?:object, timeout?:number}} opts
 * @returns {Promise<{statusCode:number, data:any}>}
 */
function send(opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const payload = { ...opts, method };
  return isCloud() ? viaContainer(payload) : viaRequest(payload);
}

module.exports = { send, isCloud };
