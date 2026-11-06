const { get, post } = require('../../utils/request');
const { isLoggedIn } = require('../../utils/auth');
const { formatWordCount } = require('../../utils/util');

const HISTORY_KEY = 'novel_search_history';
const POLL_INTERVAL = 1200;
const MAX_POLL = 120; // 最多轮询 120 次（约 2.5 分钟）

Page({
  data: {
    mode: 'local', // local=站内书库  online=全网免费书
    keyword: '',
    // 站内
    results: [],
    loading: false,
    searched: false,
    error: '',
    // 全网
    onlineList: [],
    onlineLoading: false,
    onlineSearched: false,
    onlineError: '',
    onlineTotal: 0,
    onlinePage: 1,
    onlineHasMore: false,
    importingBookId: '',
    history: [],
    hotWords: ['剑来', '凡人修仙', '赘婿', '十日终焉', '诡秘之主'],
  },

  onLoad(options) {
    this.setData({ history: wx.getStorageSync(HISTORY_KEY) || [] });
    if (options.keyword) {
      this.setData({ keyword: options.keyword, mode: options.mode === 'online' ? 'online' : 'local' }, () =>
        this.doSearch()
      );
    } else if (options.mode === 'online') {
      this.setData({ mode: 'online' });
    }
  },

  onUnload() {
    this._destroyed = true;
    if (this._timer) clearTimeout(this._timer);
  },

  // ---------- 通用 ----------
  onInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  clear() {
    this.setData({
      keyword: '',
      results: [],
      searched: false,
      error: '',
      onlineList: [],
      onlineSearched: false,
      onlineError: '',
    });
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.mode) return;
    this.setData({ mode });
    const kw = (this.data.keyword || '').trim();
    if (mode === 'online' && !this.data.onlineSearched && kw) this.doSearch();
    if (mode === 'local' && !this.data.searched && kw) this.doSearch();
  },

  tapWord(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    this.setData({ keyword: word }, () => this.doSearch());
  },

  saveHistory(kw) {
    const list = [kw].concat((this.data.history || []).filter((x) => x !== kw)).slice(0, 8);
    wx.setStorageSync(HISTORY_KEY, list);
    this.setData({ history: list });
  },

  clearHistory() {
    wx.removeStorageSync(HISTORY_KEY);
    this.setData({ history: [] });
  },

  doSearch() {
    const kw = (this.data.keyword || '').trim();
    if (!kw) {
      wx.showToast({ title: '请输入书名、作者或书籍链接', icon: 'none' });
      return;
    }
    // 粘贴第三方书籍链接：直接进在线详情页解析并拉取
    if (/^https?:\/\//i.test(kw)) {
      this.saveHistory(kw);
      wx.navigateTo({
        url: `/pages/online-detail/online-detail?url=${encodeURIComponent(kw)}`,
      });
      return;
    }
    this.saveHistory(kw);
    if (this.data.mode === 'online') this.searchOnline(kw, 1);
    else this.searchLocal(kw);
  },

  // ---------- 站内书库 ----------
  searchLocal(kw) {
    this.setData({ loading: true, searched: true, error: '' });
    get('/api/novels', { keyword: kw, page: 1, pageSize: 30 }, { retry: false })
      .then((res) => this.setData({ results: (res && res.list) || [], loading: false }))
      .catch((e) => this.setData({ loading: false, error: e.message || '搜索失败' }));
  },

  // ---------- 全网搜索 ----------
  searchOnline(kw, page) {
    this.setData({ onlineLoading: true, onlineSearched: true, onlineError: '' });
    get('/api/online/search', { keyword: kw, page }, { retry: false })
      .then((res) => {
        const list = ((res && res.list) || []).map((it) => ({
          ...it,
          wordText: it.wordCount ? formatWordCount(it.wordCount) : '',
          importState: { progress: 0, stage: '', done: false, error: '' },
        }));
        const merged = page > 1 ? this.data.onlineList.concat(list) : list;
        const total = (res && res.total) || merged.length;
        this.setData({
          onlineList: merged,
          onlineTotal: total,
          onlinePage: page,
          onlineHasMore: merged.length < total && list.length >= 15,
          onlineLoading: false,
        });
      })
      .catch((e) =>
        this.setData({
          onlineLoading: false,
          onlineError: (e && e.message) || '联网搜索失败，请确认后端服务已启动',
        })
      );
  },

  onReachBottom() {
    if (this.data.mode !== 'online') return;
    if (!this.data.onlineHasMore || this.data.onlineLoading) return;
    const kw = (this.data.keyword || '').trim();
    if (!kw) return;
    this.searchOnline(kw, this.data.onlinePage + 1);
  },

  // ---------- 导入到书架 ----------
  setImportState(bookId, patch, extra = {}) {
    const idx = (this.data.onlineList || []).findIndex((x) => String(x.bookId) === String(bookId));
    const data = { ...extra };
    if (idx >= 0) {
      const prev = this.data.onlineList[idx].importState || {};
      data[`onlineList[${idx}].importState`] = { ...prev, ...patch };
    }
    this.setData(data);
  },

  onImport(e) {
    const { bookid, title } = e.currentTarget.dataset;
    const bookId = String(bookid);
    if (!bookId) return;

    const hit = this.data.onlineList.find((x) => String(x.bookId) === bookId);
    // 已在库：直接阅读
    if (hit && hit.inLibrary && hit.novelId) {
      this.openNovel(hit.novelId);
      return;
    }

    if (this.data.importingBookId) {
      wx.showToast({ title: '请等待当前书籍导入完成', icon: 'none' });
      return;
    }

    this.setImportState(
      bookId,
      { progress: 3, stage: '正在连接书源…', done: false, error: '' },
      { importingBookId: bookId }
    );

    post('/api/online/import', { bookId, source: (hit && hit.source) || 'qimao', maxChapters: 50 }, { retry: false })
      .then((res) => {
        if (!res || !res.taskId) throw new Error('导入任务创建失败');
        this.pollTask(res.taskId, bookId, title);
      })
      .catch((err) => {
        const message = (err && err.message) || '导入失败';
        this.setImportState(
          bookId,
          { progress: 0, stage: message, done: true, error: message },
          { importingBookId: '' }
        );
        wx.showToast({ title: message, icon: 'none', duration: 2500 });
      });
  },

  pollTask(taskId, bookId, title) {
    let times = 0;
    const tick = () => {
      if (this._destroyed) return;
      times += 1;
      if (times > MAX_POLL) {
        this.setImportState(bookId, { stage: '导入超时', error: '导入超时' }, { importingBookId: '' });
        wx.showToast({ title: '导入超时，请稍后重试', icon: 'none' });
        return;
      }
      get(`/api/online/import/${taskId}`, null, { retry: false })
        .then((task) => {
          if (!task) throw new Error('任务不存在');
          if (task.status === 'done') {
            this.finishImport(bookId, task, title);
            return;
          }
          if (task.status === 'error') {
            const msg = task.message || '导入失败';
            this.setImportState(bookId, { progress: 0, stage: msg, done: true, error: msg }, { importingBookId: '' });
            wx.showToast({ title: msg, icon: 'none', duration: 2500 });
            return;
          }
          this.setImportState(bookId, {
            progress: task.progress || 0,
            stage: task.stage || '抓取中…',
            done: false,
            error: '',
          });
          this._timer = setTimeout(tick, POLL_INTERVAL);
        })
        .catch(() => {
          // 偶发网络抖动继续重试
          if (times < MAX_POLL) this._timer = setTimeout(tick, POLL_INTERVAL * 2);
          else {
            this.setImportState(bookId, { stage: '导入中断', error: '导入中断' }, { importingBookId: '' });
            wx.showToast({ title: '导入中断，请重试', icon: 'none' });
          }
        });
    };
    tick();
  },

  finishImport(bookId, task, title) {
    const done = () => {
      const idx = this.data.onlineList.findIndex((x) => String(x.bookId) === String(bookId));
      const data = { importingBookId: '' };
      if (idx >= 0) {
        data[`onlineList[${idx}].inLibrary`] = true;
        data[`onlineList[${idx}].novelId`] = task.novelId;
        data[`onlineList[${idx}].importedChapters`] = task.chapters;
        data[`onlineList[${idx}].importState`] = {
          progress: 100,
          stage: `已加入书架 · ${task.chapters} 章`,
          done: true,
          error: '',
        };
      }
      this.setData(data);
      wx.showToast({
        title: isLoggedIn() ? task.message || '导入完成' : '已导入，登录后可同步书架',
        icon: 'none',
        duration: 1800,
      });
      setTimeout(() => {
        wx.showModal({
          title: `《${task.title || title || '本书'}》已就绪`,
          content:
            task.added > 0
              ? `已抓取 ${task.chapters} 章正文，是否开始阅读？`
              : `已加入书架（共 ${task.chapters} 章），是否开始阅读？`,
          confirmText: '开始阅读',
          confirmColor: '#e8733b',
          success: (r) => {
            if (r.confirm) this.openNovel(task.novelId);
          },
        });
      }, 500);
    };

    // 未登录时后端不会写书架；已登录则服务端已完成，这里幂等补一次
    if (!isLoggedIn()) {
      done();
      return;
    }
    post('/api/bookshelf', { novelId: task.novelId }, { retry: false })
      .then(done)
      .catch(done);
  },

  openNovel(novelId) {
    if (!novelId) return;
    wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${novelId}` });
  },

  // 点击卡片：已在库直接进详情，否则进「在线详情」看简介/章数再决定拉取方式
  openItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = (this.data.onlineList || [])[index];
    if (!item) return;
    if (item.inLibrary && item.novelId) {
      this.openNovel(item.novelId);
      return;
    }
    wx.navigateTo({
      url: `/pages/online-detail/online-detail?source=${item.source}&bookId=${item.bookId}`,
    });
  },

  retryOnline() {
    this.doSearch();
  },
});
