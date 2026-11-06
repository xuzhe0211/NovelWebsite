import { config } from '../config/index.js';

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
    `?appid=${config.wx.appid}&secret=${config.wx.secret}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (!json.openid) {
    throw new Error(`jscode2session 失败: ${JSON.stringify(json)}`);
  }
  return json.openid;
}
