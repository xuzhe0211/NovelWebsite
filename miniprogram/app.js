const { BASE_URL, MODE, CLOUD_ENV, CLOUD_SERVICE, CLOUD_VIA } = require('./utils/config');

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
  probeCloud();
}

// 启动自检：打一次 callContainer 并把网关原始错误码翻成人话。
// 体验版打开「开发调试」（右上角 … → 开发调试）就能在 vConsole 里看到这一行，
// 是判断「环境到底归不归当前小程序」最快的手段，不用进控制台来回翻。
function probeCloud() {
  const { probeContainer } = require('./utils/transport');
  const head = `[cloud] 探针 env=${CLOUD_ENV} service=${CLOUD_SERVICE} via=${CLOUD_VIA}`;
  probeContainer('/api/health').then((r) => {
    if (r.ok) {
      console.log(head, `✅ callContainer 连通（HTTP ${r.statusCode} code=${r.code}）`);
      return;
    }
    const raw = `${r.errCode || ''} ${r.errMsg || ''} ${r.code || ''} ${JSON.stringify(r.data || {})}`;
    let hint = '';
    if (/INVALID_HOST|Invalid host/i.test(raw)) {
      hint = '→ 「环境ID + 服务名」拼不出可路由的 host。最常见是环境ID 手抄错一个字符'
        + '（控制台「设置 → 环境信息」有复制按钮，别手打），其次是该环境不归本小程序';
    } else if (/-601031/.test(raw)) {
      hint = '→ 该环境里没有这个服务（或服务下没有线上版本），或环境不归本小程序';
    } else if (/-601027/.test(raw)) {
      hint = '→ 环境 ID 不存在（是不是填了环境名？）';
    } else if (/-601034/.test(raw)) {
      hint = '→ 本小程序未开通云托管，也没被同主体「资源复用」';
    } else if (/not in domain list/i.test(raw)) {
      hint = '→ 请求被小程序 request 合法域名拦住';
    }
    console.error(head, '❌ callContainer 失败：', raw.trim(), hint);
  });
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
