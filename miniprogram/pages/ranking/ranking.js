const { get } = require('../../utils/request');
const demo = require('../../utils/demo');
const { formatCount } = require('../../utils/util');

const TABS = [
  { key: 'week', label: '周榜' },
  { key: 'month', label: '月榜' },
  { key: 'total', label: '总榜' },
];

const TIPS = {
  week: '按最近更新时间排序，每周一刷新',
  month: '按读者评分排序，每月初刷新',
  total: '按累计人气排序，实时更新',
};

Page({
  data: {
    tabs: TABS,
    type: 'total',
    list: [],
    top3: [],
    rest: [],
    tip: TIPS.total,
    total: 0,
    loading: true,
    error: '',
    demoMode: false,
    skeleton: [1, 2, 3, 4],
  },

  onShow() {
    this.load();
  },

  switchType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.type) return;
    this.setData({ type, tip: TIPS[type] || '' }, () => this.load());
  },

  load() {
    demo.resetDemo();
    this.setData({ loading: true, error: '' });
    get('/api/ranking', { type: this.data.type }, { retry: false, demoFill: true })
      .then((raw) => {
        const list = (raw || []).map((n, i) => ({
          ...n,
          rank: n.rank || i + 1,
          initial: (n.title || '书')[0],
          hotText: formatCount(n.clickCount),
        }));
        this.setData({
          list,
          top3: list.slice(0, 3),
          rest: list.slice(3),
          total: list.length,
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

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${id}` });
  },
});
