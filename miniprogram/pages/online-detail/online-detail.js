const { get, post } = require('../../utils/request');
const { isLoggedIn } = require('../../utils/auth');

const POLL_INTERVAL = 1200;
const MAX_POLL = 150;

Page({
  data: {
    source: 'qimao',
    bookId: '',
    url: '',
    detail: null,
    loading: true,
    error: '',
    inShelf: false,
    // 导入
    importing: false,
    action: '', // shelf | library
    progress: 0,
    stage: '',
    taskError: '',
    novelId: null,
    introExpanded: false,
  },

  onLoad(options) {
    const source = options.source || (options.url ? 'web' : 'qimao');
    const url = options.url ? decodeURIComponent(options.url) : '';
    this.setData({ source, bookId: options.bookId || '', url });
    this.loadDetail();
  },

  onUnload() {
    this._destroyed = true;
    if (this._timer) clearTimeout(this._timer);
  },

  // 下拉刷新：绕过服务端 10 分钟缓存，重新解析源站信息（补章后已入库章数会变）
  onPullDownRefresh() {
    this.loadDetail(true).then(() => wx.stopPullDownRefresh());
  },

  loadDetail(refresh) {
    const { source, bookId, url } = this.data;
    // 下拉刷新时保留已有内容，只清错误提示，避免整页闪一下
    if (refresh && this.data.detail) this.setData({ error: '' });
    else this.setData({ loading: true, error: '' });
    const params = source === 'web' ? { url } : { source, bookId };
    if (refresh) params.refresh = 1;
    return get('/api/online/detail', params, { retry: false })
      .then((detail) => {
        this.setData({
          detail,
          loading: false,
          // 粘贴链接进来时后端会解析出真实站点，后续导入要用解析后的 source/bookId
          source: detail.source || source,
          bookId: detail.bookId || bookId,
          novelId: detail.novelId || null,
        });
        wx.setNavigationBarTitle({ title: detail.title || '书籍详情' });
        this.checkShelf(detail.novelId);
      })
      .catch((e) =>
        this.setData({ loading: false, error: (e && e.message) || '解析失败，请检查链接是否正确' })
      );
  },

  checkShelf(novelId) {
    if (!novelId || !isLoggedIn()) return;
    get('/api/bookshelf', null, { retry: false })
      .then((list) => {
        const hit = (list || []).some((x) => Number(x.novelId) === Number(novelId));
        this.setData({ inShelf: hit });
      })
      .catch(() => {});
  },

  toggleIntro() {
    this.setData({ introExpanded: !this.data.introExpanded });
  },

  retry() {
    this.loadDetail();
  },

  // ---------- 拉取 ----------
  // action: 'shelf' 加入书架（抓取+入库+书架） / 'library' 仅拉取到本网站
  onPull(e) {
    const action = e.currentTarget.dataset.action || 'shelf';
    const { detail, importing } = this.data;

    if (importing) {
      wx.showToast({ title: '正在拉取中，请稍候', icon: 'none' });
      return;
    }
    if (!detail) return;

    if (!detail.canImport) {
      wx.showToast({ title: '该书没有可抓取的免费章节', icon: 'none' });
      return;
    }
    if (action === 'shelf' && !isLoggedIn()) {
      wx.showModal({
        title: '需要登录',
        content: '登录后才能把书加入书架并同步阅读进度。也可以先「拉取到本网站」，登录后再加入书架。',
        confirmText: '去登录',
        confirmColor: '#e8733b',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/login/login' });
        },
      });
      return;
    }

    this.setData({
      importing: true,
      action,
      progress: 3,
      stage: '正在连接站点…',
      taskError: '',
    });

    const body = {
      source: this.data.source,
      bookId: this.data.bookId,
      url: this.data.url,
      addToShelf: action === 'shelf',
      maxChapters: 50,
    };

    post('/api/online/import', body, { retry: false })
      .then((res) => {
        if (!res || !res.taskId) throw new Error('任务创建失败');
        this.pollTask(res.taskId, action);
      })
      .catch((err) => this.fail((err && err.message) || '拉取失败'));
  },

  pollTask(taskId, action) {
    let times = 0;
    const tick = () => {
      if (this._destroyed) return;
      times += 1;
      if (times > MAX_POLL) return this.fail('拉取超时，请稍后重试');

      get(`/api/online/import/${taskId}`, null, { retry: false })
        .then((task) => {
          if (!task) throw new Error('任务不存在');
          if (task.status === 'done') return this.finish(task, action);
          if (task.status === 'error') return this.fail(task.message || '拉取失败');
          this.setData({
            progress: task.progress || 0,
            stage: task.stage || '抓取中…',
            novelId: task.novelId || this.data.novelId,
          });
          this._timer = setTimeout(tick, POLL_INTERVAL);
        })
        .catch(() => {
          if (times < MAX_POLL) this._timer = setTimeout(tick, POLL_INTERVAL * 2);
          else this.fail('拉取中断，请重试');
        });
    };
    tick();
  },

  fail(message) {
    this.setData({ importing: false, progress: 0, stage: '', taskError: message });
    wx.showToast({ title: message, icon: 'none', duration: 2500 });
  },

  finish(task, action) {
    const detail = this.data.detail || {};
    this.setData({
      importing: false,
      progress: 100,
      stage: task.stage,
      novelId: task.novelId,
      inShelf: action === 'shelf' ? true : this.data.inShelf,
      detail: {
        ...detail,
        inLibrary: true,
        novelId: task.novelId,
        importedChapters: task.chapters,
        freeChapters: detail.freeChapters,
      },
    });

    wx.showToast({ title: task.message || '已完成', icon: 'none', duration: 1800 });

    setTimeout(() => {
      wx.showModal({
        title: `《${task.title || detail.title || '本书'}》已就绪`,
        content:
          action === 'shelf'
            ? `本次抓取 ${task.added} 章（库内共 ${task.chapters} 章）并加入书架，现在开始阅读？`
            : `本次抓取 ${task.added} 章（库内共 ${task.chapters} 章），现在去看看？`,
        confirmText: '去看看',
        cancelText: '留在本页',
        confirmColor: '#e8733b',
        success: (r) => {
          if (r.confirm) this.openNovel(task.novelId);
        },
      });
    }, 500);
  },

  openNovel(novelId) {
    const id = novelId || this.data.novelId;
    if (!id) return;
    wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${id}` });
  },

  onOpen() {
    this.openNovel();
  },
});
