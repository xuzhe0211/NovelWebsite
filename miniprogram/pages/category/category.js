const { get } = require('../../utils/request');
const demo = require('../../utils/demo');
const { PAGE_SIZE } = require('../../utils/config');

Page({
  data: {
    categories: [],
    activeSlug: '',
    activeName: '全部',
    list: [],
    page: 1,
    total: 0,
    hasMore: true,
    loading: true,
    loadingMore: false,
    error: '',
    demoMode: false,
    skeleton: [1, 2, 3, 4],
  },

  onShow() {
    // 首页点击分类会写入 pending_category，这里切换过去
    const pending = wx.getStorageSync('pending_category');
    if (pending) {
      wx.removeStorageSync('pending_category');
      this.setData({ activeSlug: pending }, () => {
        this.syncActiveName();
        this.reload();
      });
    } else if (!this.data.list.length) {
      this.reload();
    }
    if (!this.data.categories.length) this.loadCategories();
  },

  loadCategories() {
    get('/api/categories', null, { retry: false, demoFill: true })
      .then((list) => {
        this.setData({ categories: list || [], demoMode: demo.isDemo() }, () => this.syncActiveName());
      })
      .catch(() => {});
  },

  syncActiveName() {
    const slug = this.data.activeSlug;
    if (!slug) return this.setData({ activeName: '全部' });
    const cat = (this.data.categories || []).find((c) => c.slug === slug);
    this.setData({ activeName: cat ? cat.name : '全部' });
  },

  switchCat(e) {
    const slug = e.currentTarget.dataset.slug;
    if (slug === this.data.activeSlug) return;
    this.setData({ activeSlug: slug }, () => {
      this.syncActiveName();
      this.reload();
    });
  },

  reload() {
    demo.resetDemo();
    this.setData({ list: [], page: 1, hasMore: true, loading: true, error: '' });
    this.fetch(1);
  },

  fetch(page) {
    const params = { sort: 'hot', page, pageSize: PAGE_SIZE };
    if (this.data.activeSlug) params.category = this.data.activeSlug;
    get('/api/novels', params, { retry: false, demoFill: page === 1 })
      .then((res) => {
        const rows = (res && res.list) || [];
        const list = page === 1 ? rows : this.data.list.concat(rows);
        this.setData({
          list,
          page,
          total: (res && res.total) || list.length,
          hasMore: !!(res && res.hasMore),
          loading: false,
          loadingMore: false,
          demoMode: demo.isDemo(),
        });
      })
      .catch((e) =>
        this.setData({
          loading: false,
          loadingMore: false,
          error: e.message || '加载失败',
          demoMode: demo.isDemo(),
        })
      );
  },

  retry() {
    this.loadCategories();
    this.reload();
  },

  onPullDownRefresh() {
    this.loadCategories();
    this.reload();
    setTimeout(() => wx.stopPullDownRefresh(), 400);
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.setData({ loadingMore: true });
    this.fetch(this.data.page + 1);
  },
});
