const {
  login,
  loginLocal,
  logout,
  isLoggedIn,
  getUser,
  updateProfile,
  persistAvatar,
} = require('../../utils/auth');
const { ENABLE_DEMO } = require('../../utils/config');

// 失败原因不同，给的建议也该不同（原来固定一句「勾选不校验合法域名」会误导）
function hintForError(e) {
  const code = e && e.code;
  if (code === -2) return '请在小程序后台把服务域名加入 request 合法域名。';
  if (typeof code === 'number' && code >= 500) {
    return '服务正在启动（闲置后首次访问约 20~30 秒），请再点一次登录。若长期如此，把最小实例调成 1。';
  }
  if (code === -1) return '连不上服务器，请确认云托管服务处于「运行中」。';
  return '登录凭证或服务配置异常，请关掉小程序重新打开再试。';
}

Page({
  data: {
    loading: false,
    logged: false,
    agreed: false,
    nickname: '',
    initial: '书',
    avatar: '',
    avatarFailed: false,
    isDemoUser: false,
    demoEnabled: false,
    error: '',
    errorTip: '',
    saving: false,
  },

  onLoad() {
    this.setData({ demoEnabled: !!ENABLE_DEMO });
  },

  onShow() {
    this.sync();
  },

  sync() {
    const user = getUser();
    const logged = isLoggedIn();
    const nickname = (user && user.nickname) || (logged ? '微信用户' : '未登录');
    this.setData({
      logged,
      nickname,
      initial: (nickname || '书')[0],
      avatar: (user && user.avatar) || '',
      avatarFailed: false,
      isDemoUser: !!(user && user.demo),
    });
    wx.setNavigationBarTitle({ title: logged ? '账号资料' : '登录' });
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  showAgreement(e) {
    const type = e.currentTarget.dataset.type;
    wx.showModal({
      title: type === 'privacy' ? '隐私政策' : '用户协议',
      content:
        type === 'privacy'
          ? '我们仅收集必要的登录标识与阅读进度，用于书架同步。不会向第三方出售你的个人信息。'
          : '本小程序内容来自公开网络，仅供学习交流。请勿用于商业用途，阅读时请支持正版。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#e8733b',
    });
  },

  // 未勾选协议时用弹窗确认，避免「点了没反应」的误解
  onLogin() {
    if (this.data.loading) return;
    if (this.data.agreed) {
      this.doLogin();
      return;
    }
    wx.showModal({
      title: '登录前确认',
      content: '登录需要你同意《用户协议》与《隐私政策》，登录后仅用于同步书架与阅读进度。',
      confirmText: '同意并登录',
      confirmColor: '#e8733b',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ agreed: true });
        this.doLogin();
      },
    });
  },

  doLogin() {
    this.setData({ loading: true, error: '', errorTip: '' });
    login()
      .then((res) => {
        const demoUser = !!(res && res.user && res.user.demo);
        this.setData({ loading: false });
        this.sync();
        wx.showToast({
          title: demoUser ? '已进入本地体验模式' : '登录成功',
          icon: demoUser ? 'none' : 'success',
        });
        setTimeout(() => this.goBack(), 700);
      })
      .catch((e) => {
        const message = (e && e.message) || '登录失败，请稍后重试';
        this.setData({ loading: false, error: message, errorTip: hintForError(e) });
        wx.showToast({ title: message, icon: 'none' });
      });
  },

  onDemoLogin() {
    if (this.data.loading) return;
    if (!this.data.agreed) {
      wx.showModal({
        title: '登录前确认',
        content: '本地体验账号同样需要同意《用户协议》与《隐私政策》，数据仅保存在本机。',
        confirmText: '同意并体验',
        confirmColor: '#e8733b',
        success: (r) => {
          if (!r.confirm) return;
          this.setData({ agreed: true });
          this.doDemoLogin();
        },
      });
      return;
    }
    this.doDemoLogin();
  },

  doDemoLogin() {
    this.setData({ loading: true, error: '' });
    try {
      loginLocal();
      this.setData({ loading: false });
      this.sync();
      wx.showToast({ title: '已进入本地体验模式', icon: 'none' });
      setTimeout(() => this.goBack(), 700);
    } catch (e) {
      this.setData({ loading: false, error: '本地体验登录失败' });
    }
  },

  onAvatarError() {
    this.setData({ avatarFailed: true });
  },

  onChooseAvatar(e) {
    const temp = e.detail && e.detail.avatarUrl;
    if (!temp) return;
    this.setData({ saving: true, avatarFailed: false });
    persistAvatar(temp)
      .then((saved) => updateProfile({ avatar: saved }))
      .then(() => {
        this.setData({ saving: false });
        this.sync();
        wx.showToast({ title: '头像已更新', icon: 'success' });
      })
      .catch(() => {
        this.setData({ saving: false });
        wx.showToast({ title: '头像保存失败', icon: 'none' });
      });
  },

  onNicknameChange(e) {
    const value = ((e.detail && e.detail.value) || '').trim().slice(0, 20);
    if (!value || value === this.data.nickname) return;
    this.setData({ saving: true });
    updateProfile({ nickname: value })
      .then(() => {
        this.setData({ saving: false });
        this.sync();
        wx.showToast({ title: '昵称已更新', icon: 'success' });
      })
      .catch(() => this.setData({ saving: false }));
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？退出后书架需要重新登录才能同步。',
      confirmColor: '#e8733b',
      success: (r) => {
        if (!r.confirm) return;
        logout();
        this.sync();
        wx.showToast({ title: '已退出', icon: 'success' });
      },
    });
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.switchTab({ url: '/pages/mine/mine' }),
    });
  },
});
