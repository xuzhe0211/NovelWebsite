const { get, post } = require('../../utils/request');
const { isLoggedIn } = require('../../utils/auth');
const { formatWordCount, formatCount } = require('../../utils/util');

const POLL_INTERVAL = 1200;
// 200 章的批次遇到站点限流会分批放慢，留够约 10 分钟
const MAX_POLL = 500;
// 每次「继续补章」可选的抓取章数
const BATCH_OPTIONS = [10, 50, 100, 200];
const CONTINUE_BATCH = 50;

Page({
  data: {
    id: null,
    novel: null,
    chapters: [],
    loading: true,
    error: '',
    inShelf: false,
    shelfItem: null,
    wordText: '',
    hotText: '',
    initial: '书',
    chapterCount: 0,
    // 继续补章
    cont: null,
    contBusy: false,
    contProgress: 0,
    contStage: '',
    contMsg: '',
    batchOptions: BATCH_OPTIONS,
    contBatch: CONTINUE_BATCH,
  },

  onLoad(options) {
    const id = options.id;
    // 补章章数跟阅读页共用一份偏好
    const settings = wx.getStorageSync('reader_settings') || {};
    const saved = Number(settings.contBatch);
    this.setData({
      id,
      contBatch: BATCH_OPTIONS.includes(saved) ? saved : CONTINUE_BATCH,
    });
    this.loadDetail(id);
    this.loadChapters(id);
    this.checkShelf(id);
    this.loadContinue(id);
  },

  onUnload() {
    this._unloaded = true;
    if (this._timer) clearTimeout(this._timer);
  },

  onPullDownRefresh() {
    const id = this.data.id;
    if (!id) return wx.stopPullDownRefresh();
    Promise.all([this.loadDetail(id), this.loadChapters(id), this.loadContinue(id)])
      .catch(() => {})
      .then(() => wx.stopPullDownRefresh());
  },

  // 目录区的「刷新」：章节列表是 scroll-view，下拉手势容易被拦住，给个明确入口
  onRefreshTap() {
    if (this.data.contBusy) {
      wx.showToast({ title: '补章进行中，稍候自动刷新', icon: 'none' });
      return;
    }
    wx.showToast({ title: '刷新中…', icon: 'none', duration: 900 });
    this.onPullDownRefresh();
  },

  // 从登录页 / 阅读页返回后刷新书架状态与已入库章节数
  onShow() {
    if (!this.data.id) return;
    if (!this._shown) {
      this._shown = true; // 首次进入由 onLoad 负责，避免重复请求
      return;
    }
    this.checkShelf(this.data.id);
    this.loadContinue(this.data.id);
  },

  loadDetail(id) {
    return get(`/api/novels/${id}`, null, { retry: false })
      .then((novel) => {
        this.setData({
          novel,
          wordText: formatWordCount(novel.wordCount),
          hotText: formatCount(novel.clickCount),
          initial: (novel.title || '书')[0],
          chapterCount: novel.chapterCount || 0,
          loading: false,
        });
        wx.setNavigationBarTitle({ title: novel.title || '小说详情' });
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '加载失败' }));
  },

  loadChapters(id) {
    return get(`/api/novels/${id}/chapters`, null, { retry: false })
      .then((chapters) => {
        const list = chapters || [];
        this.setData({
          chapters: list,
          chapterCount: list.length || this.data.chapterCount,
        });
      })
      .catch(() => {});
  },

  checkShelf(id) {
    if (!isLoggedIn()) return Promise.resolve();
    return get('/api/bookshelf', null, { retry: false })
      .then((list) => {
        const hit = (list || []).find((x) => Number(x.novelId) === Number(id)) || null;
        this.setData({ inShelf: !!hit, shelfItem: hit });
      })
      .catch(() => {});
  },

  // ---------- 继续补章 ----------
  loadContinue(id) {
    const novelId = id || this.data.id;
    if (!novelId) return Promise.resolve();
    return get('/api/online/continue', { novelId }, { retry: false })
      .then((cont) => {
        // hasMore 为 false 说明上次已经抓干净了（源站没有可补的章节），就不显示补章入口
        const usable = cont && (cont.needUrl || (cont.canContinue && cont.hasMore !== false));
        this.setData({ cont: usable ? cont : null });
      })
      .catch(() => {});
  },

  // 选择本次补章的数量，记住选择（与阅读页共用）
  chooseBatch(e) {
    if (this.data.contBusy) return;
    const n = Number(e.currentTarget.dataset.n);
    if (!BATCH_OPTIONS.includes(n) || n === this.data.contBatch) return;
    this.setData({ contBatch: n });
    const settings = wx.getStorageSync('reader_settings') || {};
    wx.setStorageSync('reader_settings', { ...settings, contBatch: n });
  },

  onContinue() {
    if (this.data.contBusy) {
      wx.showToast({ title: '正在补章，请稍候', icon: 'none' });
      return;
    }
    const cont = this.data.cont;
    if (!cont) return;
    if (cont.needUrl) return this.askSourceUrl();
    this.runContinue({});
  },

  // 早期抓的外部书没存源站链接：让用户补一次，补完服务端会记住
  askSourceUrl() {
    wx.showModal({
      title: '补章需要源站链接',
      content: '这本书是早前抓取的，没有记录来源地址。粘贴一次书籍详情页链接，之后就能一键补章。',
      editable: true,
      placeholderText: 'https://www.example.com/book/123/',
      confirmText: '开始补章',
      confirmColor: '#e8733b',
      success: (r) => {
        if (!r.confirm) return;
        const url = String(r.content || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          wx.showToast({ title: '请粘贴完整链接', icon: 'none' });
          return;
        }
        this.runContinue({ url });
      },
    });
  },

  runContinue(extra) {
    this.setData({
      contBusy: true,
      contProgress: 3,
      contStage: '正在连接站点…',
      contMsg: '',
    });
    post(
      '/api/online/continue',
      { novelId: this.data.id, maxChapters: this.data.contBatch, ...extra },
      { retry: false }
    )
      .then((res) => {
        if (!res || !res.taskId) throw new Error('任务创建失败');
        this.pollContinue(res.taskId);
      })
      .catch((e) => this.failContinue((e && e.message) || '补章失败'));
  },

  pollContinue(taskId) {
    let times = 0;
    const tick = () => {
      if (this._unloaded) return;
      times += 1;
      if (times > MAX_POLL) return this.failContinue('补章超时，请稍后重试');

      get(`/api/online/import/${taskId}`, null, { retry: false })
        .then((task) => {
          if (!task) throw new Error('任务不存在');
          if (task.status === 'done') return this.finishContinue(task);
          if (task.status === 'error') return this.failContinue(task.message || '补章失败');
          this.setData({
            contProgress: task.progress || 0,
            contStage: task.stage || '抓取中…',
          });
          this._timer = setTimeout(tick, POLL_INTERVAL);
        })
        .catch(() => {
          if (times < MAX_POLL) this._timer = setTimeout(tick, POLL_INTERVAL * 2);
          else this.failContinue('补章中断，请重试');
        });
    };
    tick();
  },

  finishContinue(task) {
    this.setData({
      contBusy: false,
      contProgress: 100,
      contStage: '已完成',
      contMsg: task.message || `已补 ${task.added} 章`,
    });
    wx.showToast({ title: task.message || '补章完成', icon: 'none', duration: 2200 });
    this.loadDetail(this.data.id);
    this.loadChapters(this.data.id);
    this.loadContinue(this.data.id);
  },

  failContinue(message) {
    this.setData({ contBusy: false, contProgress: 0, contStage: '' });
    wx.showToast({ title: message, icon: 'none', duration: 2500 });
  },

  onAddShelf() {
    if (this.data.inShelf) {
      wx.showToast({ title: '已在书架中', icon: 'none' });
      return;
    }
    if (!isLoggedIn()) {
      wx.showModal({
        title: '需要登录',
        content: '登录后才能把书加入书架，并在换设备时同步阅读进度。',
        confirmText: '去登录',
        confirmColor: '#e8733b',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/login/login' });
        },
      });
      return;
    }
    post('/api/bookshelf', { novelId: this.data.id })
      .then(() => {
        this.setData({ inShelf: true });
        wx.showToast({ title: '已加入书架', icon: 'success' });
      })
      .catch((e) => wx.showToast({ title: (e && e.message) || '加入失败', icon: 'none' }));
  },

  startRead() {
    const shelf = this.data.shelfItem;
    if (shelf && shelf.lastChapterId) {
      this.openChapter(shelf.lastChapterId, shelf.lastPosition || 0);
      return;
    }
    const chapters = this.data.chapters;
    if (!chapters.length) {
      wx.showToast({ title: '暂无章节', icon: 'none' });
      return;
    }
    this.openChapter(chapters[0].id, 0);
  },

  onChapterTap(e) {
    const { cid, locked } = e.currentTarget.dataset;
    // 未登录超试读章数：服务端本就取不到正文，这里先拦一道，避免进阅读页才看到空页
    if (locked) {
      wx.showModal({
        title: '需要登录',
        content: '未登录只能试读每本书的前几章，登录后可阅读全部章节。',
        confirmText: '去登录',
        cancelText: '再看看',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/login/login' });
        },
      });
      return;
    }
    this.openChapter(cid, 0);
  },

  openChapter(chapterId, position) {
    wx.navigateTo({
      url: `/pages/reader/reader?chapterId=${chapterId}&novelId=${this.data.id}&position=${position || 0}`,
    });
  },
});
