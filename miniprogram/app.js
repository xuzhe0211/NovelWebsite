const { BASE_URL } = require('./utils/config');

App({
  globalData: {
    baseUrl: BASE_URL,
    userInfo: null,
  },
  onLaunch() {
    // 恢复本地登录态展示用信息（token 有效性由请求 401 时自动重登处理）
    this.globalData.userInfo = wx.getStorageSync('novel_user') || null;
  },
});
