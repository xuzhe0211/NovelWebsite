const { get } = require('../../utils/request');
const demo = require('../../utils/demo');
const { formatCount } = require('../../utils/util');

Page({
  data: {
    hot: [],
    latest: [],
    categories: [],
    loading: true,
    error: '',
    demoMode: false,
    skeleton: [1, 2, 3, 4],
  },

  onShow() {
    this.load();
  },

  load() {
    demo.resetDemo();
    this.setData({ loading: true, error: '' });
    get('/api/home', null, { retry: false, demoFill: true })
      .then((data) => {
        const hot = (data.hot || []).map((n) => ({
          ...n,
          initial: (n.title || '书')[0],
          hotText: formatCount(n.clickCount),
        }));
        const latest = (data.latest || []).map((n) => ({
          ...n,
          initial: (n.title || '书')[0],
        }));
        this.setData({
          hot,
          latest,
          categories: data.categories || [],
          loading: false,
          demoMode: demo.isDemo(),
        });
      })
      .catch((e) => {
        this.setData({
          loading: false,
          error: e.message || '加载失败',
          demoMode: demo.isDemo(),
        });
      });
  },

  retry() {
    this.load();
  },

  onPullDownRefresh() {
    this.load();
    setTimeout(() => wx.stopPullDownRefresh(), 400);
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  // 直接进入「全网搜索」：从免费小说站检索并一键导入书架
  goOnlineSearch() {
    wx.navigateTo({ url: '/pages/search/search?mode=online' });
  },

  goCategory(e) {
    const slug = e.currentTarget.dataset.slug;
    if (slug) wx.setStorageSync('pending_category', slug);
    wx.switchTab({ url: '/pages/category/category' });
  },

  goRanking() {
    wx.switchTab({ url: '/pages/ranking/ranking' });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${id}` });
  },
});
