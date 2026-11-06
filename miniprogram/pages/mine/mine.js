const { get } = require('../../utils/request');
const { getUser, isLoggedIn, logout } = require('../../utils/auth');
const demo = require('../../utils/demo');

Page({
  data: {
    logged: false,
    nickname: '未登录',
    avatar: '',
    avatarFailed: false,
    initial: '游',
    isDemoUser: false,
    shelfCount: 0,
    recent: null,
    demoMode: false,
    version: 'v1.0.0',
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const user = getUser();
    const logged = isLoggedIn();
    const nickname = (user && user.nickname) || (logged ? '微信用户' : '未登录');
    this.setData({
      logged,
      nickname,
      avatar: (user && user.avatar) || '',
      avatarFailed: false,
      initial: nickname[0] || '游',
      isDemoUser: !!(user && user.demo),
    });

    if (logged) this.loadShelf();
    else this.setData({ shelfCount: 0, recent: null, demoMode: demo.isDemo() });
  },

  onAvatarError() {
    this.setData({ avatarFailed: true });
  },

  loadShelf() {
    get('/api/bookshelf', null, { retry: false })
      .then((list) => {
        const rows = list || [];
        const first = rows[0] || null;
        this.setData({
          shelfCount: rows.length,
          recent: first
            ? {
                ...first,
                initial: ((first.novel && first.novel.title) || '书')[0],
                position: first.lastPosition || 0,
              }
            : null,
          demoMode: demo.isDemo(),
        });
      })
      .catch(() => {
        this.setData({ shelfCount: 0, recent: null });
      });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  goShelf() {
    if (!this.data.logged) return this.goLogin();
    wx.navigateTo({ url: '/pages/bookshelf/bookshelf' });
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  continueRead() {
    const recent = this.data.recent;
    if (!recent) return;
    if (recent.lastChapterId) {
      wx.navigateTo({
        url: `/pages/reader/reader?chapterId=${recent.lastChapterId}&novelId=${recent.novelId}&position=${recent.position || 0}`,
      });
    } else {
      wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${recent.novelId}` });
    }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将无法同步书架和阅读进度，确定退出吗？',
      confirmColor: '#e8733b',
      success: (r) => {
        if (!r.confirm) return;
        logout();
        this.refresh();
        wx.showToast({ title: '已退出', icon: 'success' });
      },
    });
  },

  clearCache() {
    wx.showModal({
      title: '清除缓存',
      content: '将清除本地缓存（含阅读设置与体验模式书架），确定继续吗？',
      confirmColor: '#e8733b',
      success: (r) => {
        if (!r.confirm) return;
        wx.clearStorageSync();
        demo.resetDemo();
        this.refresh();
        wx.showToast({ title: '已清除', icon: 'success' });
      },
    });
  },

  about() {
    wx.showModal({
      title: '关于',
      content: '免费小说 · 阅读小程序\n版本 v1.0.0\n内容来自公开网络，仅供学习交流。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#e8733b',
    });
  },
});
