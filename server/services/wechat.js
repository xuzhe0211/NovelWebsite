import https from 'node:https';
import { config } from '../config/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pick = (headers, name) => {
  if (!headers) return '';
  const v = headers[name] ?? headers[name.toUpperCase()];
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * 云托管用 wx.cloud.callContainer 调用时，网关会在请求头注入
 * X-WX-OPENID / X-WX-APPID / X-WX-UNIONID。
 *
 * 有这组头说明请求确实经过微信网关，可以直接取 openid：
 *   - 省掉一次 api.weixin.qq.com 往返（冷启动时能省 1~2 秒）；
 *   - 容器出网异常时也能正常登录（本次踩的就是这个坑）；
 *   - 不必把 AppSecret 传进 URL。
 *
 * 安全约束：必须同时带 X-WX-APPID 且与本项目 WX_APPID 一致才采信，
 * 避免公网直连时伪造 X-WX-OPENID 冒充他人账号。
 */
export function openidFromGateway(headers) {
  const openid = pick(headers, 'x-wx-openid');
  const appid = pick(headers, 'x-wx-appid');
  if (!openid) return '';
  if (!appid) return '';
  if (config.wx.appid && appid !== config.wx.appid) {
    console.warn('[wx] 忽略 X-WX-OPENID：X-WX-APPID 不匹配', appid);
    return '';
  }
  return openid;
}

// 用 https 模块而不是全局 fetch：
// fetch(undici) 默认会同时尝试 AAAA，容器没有 IPv6 路由时会直接 ECONNREFUSED，
// 报出来只有一句 `fetch failed`（真实原因藏在 err.cause 里，日志里看不到）。
// 这里显式 family: 4 + 超时，失败原因也能完整打印。
function getJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`微信接口返回非 JSON（HTTP ${res.statusCode}）：${text.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`微信接口超时（${timeout}ms）`)));
    req.on('error', reject);
  });
}

/**
 * 用 wx.login 的 code 换取 openid。
 * 未配置 WX_APPID/WX_SECRET（测试号开发阶段）时走 mock：
 * 优先用前端传来的稳定 deviceId 作为 openid，保证多次登录是同一用户。
 */
export async function codeToOpenid(code, deviceId) {
  if (!config.wx.appid || !config.wx.secret) {
    return `mock_${deviceId || code}`;
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(config.wx.appid)}&secret=${encodeURIComponent(config.wx.secret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const json = await getJson(url, 8000);
      if (json.openid) return json.openid;

      // 微信明确返回了 errcode（40029 code 无效/已用过、40163 code 已使用…），重试无意义
      const wxErr = new Error(
        `微信登录失败：${json.errcode ?? '?'} ${json.errmsg || ''}`.trim()
      );
      wxErr.wxErrcode = json.errcode;
      throw wxErr;
    } catch (err) {
      lastErr = err;
      if (err.wxErrcode) throw err; // 业务错误直接抛，别重试
      const cause = err.cause ? `${err.cause.code || ''} ${err.cause.message || ''}`.trim() : '';
      console.error(
        `[wx] 调 jscode2session 失败（第 ${attempt}/2 次）:`,
        err.code || '',
        err.message,
        cause ? `｜cause: ${cause}` : ''
      );
      if (attempt < 2) await sleep(600);
    }
  }

  const err = new Error(
    '无法连接微信登录服务（容器访问 api.weixin.qq.com 失败），请稍后重试或查看云托管运行日志'
  );
  err.cause = lastErr;
  throw err;
}
