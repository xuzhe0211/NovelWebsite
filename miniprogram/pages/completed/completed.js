const { get } = require('../../utils/request');
const demo = require('../../utils/demo');
const { PAGE_SIZE } = require('../../utils/config');

const SORTS = [
  { key: 'words', label: '字数' },
  { key: 'new', label: '最新' },
  { key: 'hot', label: '人气' },
];

Page({
  data: {
    sorts: SORTS,
    sort: 'words',
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
    if (!this.data.list.length) this.reload();
  },

  switchSort(e) {
    const sort = e.currentTarget.dataset.key;
    if (sort === this.data.sort) return;
    this.setData({ sort }, () => this.reload());
  },

  reload() {
    demo.resetDemo();
    this.setData({ list: [], page: 1, hasMore: true, loading: true, error: '' });
    this.fetch(1);
  },

  fetch(page) {
    get(
      '/api/novels',
      { status: 'completed', sort: this.data.sort, page, pageSize: PAGE_SIZE },
      { retry: false, demoFill: page === 1 }
    )
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
    this.reload();
  },

  onPullDownRefresh() {
    this.reload();
    setTimeout(() => wx.stopPullDownRefresh(), 400);
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.setData({ loadingMore: true });
    this.fetch(this.data.page + 1);
  },
});
