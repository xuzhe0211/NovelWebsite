const { BASE_URL, MODE, CLOUD_ENV } = require('./utils/config');

// 云托管模式：callContainer 需要先 init
function initCloud() {
  if (MODE !== 'cloud') return;
  if (!wx.cloud || !wx.cloud.callContainer) {
    console.error('[cloud] 当前基础库不支持 callContainer，请升级微信/基础库到 2.23.0+');
    return;
  }
  if (!CLOUD_ENV) {
    console.error('[cloud] 未配置 CLOUD_ENV，请在 utils/config.js 填入云托管环境 ID');
    return;
  }
  wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
}

App({
  globalData: {
    mode: MODE,
    baseUrl: BASE_URL,
    userInfo: null,
  },
  onLaunch() {
    initCloud();
    // 恢复本地登录态展示用信息（token 有效性由请求 401 时自动重登处理）
    this.globalData.userInfo = wx.getStorageSync('novel_user') || null;
  },
});
