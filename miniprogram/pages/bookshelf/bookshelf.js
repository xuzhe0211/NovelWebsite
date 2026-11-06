const { get, del } = require('../../utils/request');
const { isLoggedIn } = require('../../utils/auth');
const demo = require('../../utils/demo');

Page({
  data: { list: [], loading: true, needLogin: false, error: '', demoMode: false },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    // 未登录不再静默自动登录，明确引导用户去登录
    if (!isLoggedIn()) {
      this.setData({ loading: false, needLogin: true, list: [], demoMode: demo.isDemo() });
      return;
    }
    get('/api/bookshelf', null, { retry: false })
      .then((list) => {
        const rows = (list || []).map((item) => ({
          ...item,
          initial: ((item.novel && item.novel.title) || '书')[0],
        }));
        this.setData({
          list: rows,
          loading: false,
          needLogin: false,
          demoMode: demo.isDemo(),
        });
      })
      .catch((e) => {
        if (e && e.code === 401) this.setData({ loading: false, needLogin: true });
        else this.setData({ loading: false, error: (e && e.message) || '加载失败' });
      });
  },

  retry() {
    this.load();
  },

  onPullDownRefresh() {
    this.load();
    setTimeout(() => wx.stopPullDownRefresh(), 400);
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  goStore() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goDetail(e) {
    const nid = e.currentTarget.dataset.nid;
    if (nid) wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${nid}` });
  },

  continueRead(e) {
    const { nid, cid, pos } = e.currentTarget.dataset;
    if (cid) {
      wx.navigateTo({ url: `/pages/reader/reader?chapterId=${cid}&novelId=${nid}&position=${pos || 0}` });
    } else {
      wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${nid}` });
    }
  },

  onRemove(e) {
    const novelId = Number(e.currentTarget.dataset.nid);
    wx.showModal({
      title: '移出书架',
      content: '确定将本书移出书架吗？',
      confirmColor: '#e8733b',
      success: (r) => {
        if (!r.confirm) return;
        del(`/api/bookshelf/${novelId}`)
          .then(() => {
            const list = this.data.list.filter((x) => Number(x.novelId) !== novelId);
            this.setData({ list });
            wx.showToast({ title: '已移出', icon: 'success' });
          })
          .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
      },
    });
  },
});
