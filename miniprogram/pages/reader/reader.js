const { get, put, post } = require('../../utils/request');
const { isLoggedIn } = require('../../utils/auth');

function winSize() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    return { width: info.windowWidth, height: info.windowHeight };
  } catch (e) {
    return { width: 375, height: 667 };
  }
}

function winHeight() {
  return winSize().height;
}

const POLL_INTERVAL = 1200;
const MAX_POLL = 500;
// 正文行高（与 WXSS 的 line-height 保持一致）
const LINE_HEIGHT_RATIO = 1.95;

// ---------- 排版测量：用离屏 canvas 量字宽，按行切页 ----------
const charWidthCache = new Map();
let measureCanvas = null;
let measureCtx = null;
let measureFont = '';

function getMeasureCtx(fontPx) {
  const font = `${fontPx}px sans-serif`;
  if (measureCtx && measureFont === font) return measureCtx;
  try {
    if (!measureCanvas) {
      measureCanvas = wx.createOffscreenCanvas({ type: '2d', width: 64, height: 64 });
    }
    measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = font;
    measureFont = font;
  } catch (e) {
    measureCtx = null;
  }
  return measureCtx;
}

function charWidth(ch, fontPx) {
  const key = `${fontPx}|${ch}`;
  const hit = charWidthCache.get(key);
  if (hit != null) return hit;
  const ctx = getMeasureCtx(fontPx);
  let w = 0;
  if (ctx) {
    try {
      w = ctx.measureText(ch).width;
    } catch (e) {
      w = 0;
    }
  }
  // canvas 不可用或量出 0 时退回全角/半角估算，否则一行会塞下整段
  if (!w || w <= 0) w = /[\x00-\xff]/.test(ch) ? fontPx * 0.55 : fontPx;
  charWidthCache.set(key, w);
  return w;
}

// 不能出现在行首的标点（避头）
const NO_LINE_START = /^[，。、；：？！）】》」』”’…·,.;:?!)\]}>%]$/;

// 把一段文字按宽度折成若干行（中文逐字断行，够用且和正文排版一致）
function wrapText(text, maxWidth, fontPx) {
  const lines = [];
  let cur = '';
  let width = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch, fontPx);
    if (cur && width + cw > maxWidth) {
      if (NO_LINE_START.test(ch) && cur.length > 1) {
        // 标点落到行首时，把上一行最后一个字带下来，排成「字+标点」开头的下一行
        const lastCh = cur[cur.length - 1];
        lines.push(cur.slice(0, -1));
        cur = lastCh + ch;
        width = charWidth(lastCh, fontPx) + cw;
      } else {
        lines.push(cur);
        cur = ch;
        width = cw;
      }
    } else {
      cur += ch;
      width += cw;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

Page({
  data: {
    novelId: null,
    chapterId: null,
    chapter: null,
    paragraphs: [],
    prev: null,
    next: null,
    fontSize: 34,
    theme: 'light',
    loading: true,
    error: '',
    settingsOpen: false,
    themes: [
      { key: 'light', label: '白' },
      { key: 'sepia', label: '黄' },
      { key: 'dark', label: '黑' },
    ],
    // 翻页模式（分页结果放 this.pages，data 里只留当前页要渲染的行）
    pageMode: 'scroll',
    modes: [
      { key: 'scroll', label: '上下滚动' },
      { key: 'flip', label: '左右翻页' },
    ],
    pageLines: [],
    pageIndex: 0,
    pageCount: 0,
    pagePct: 0,
    turning: '',
    // 目录
    catalogOpen: false,
    catalogLoading: false,
    chapters: [],
    catalogInto: '',
    // 继续补章
    contOpen: false,
    cont: null,
    contBusy: false,
    contProgress: 0,
    contStage: '',
    contMsg: '',
    batchOptions: [10, 50, 100, 200],
    contBatch: 50,
  },

  onLoad(options) {
    const settings = wx.getStorageSync('reader_settings') || {};
    this.setData({
      novelId: Number(options.novelId) || options.novelId,
      chapterId: Number(options.chapterId) || options.chapterId,
      fontSize: settings.fontSize || 34,
      theme: settings.theme || 'light',
      contBatch: Number(settings.contBatch) || 50,
      pageMode: settings.pageMode === 'flip' ? 'flip' : 'scroll',
    });
    this.contentHeight = 0;
    this.allLines = [];
    this.perPage = 0;
    this.currentLine = 0;
    this.flipTarget = '';
    this.applyThemeBg(settings.theme || 'light');
    this.scrollTop = 0;
    this.lastSaveTs = 0;
    this.pendingPos = Number(options.position) || 0;

    this.loadChapter(options.chapterId);
    this.ensureShelf();
    this.loadContinue();
  },

  onUnload() {
    this._unloaded = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._turnTimer) clearTimeout(this._turnTimer);
    this.saveProgress(this.currentPct());
  },

  // 阅读即自动加入书架（幂等）
  ensureShelf() {
    if (!isLoggedIn() || !this.data.novelId) return;
    post('/api/bookshelf', { novelId: this.data.novelId }).catch(() => {});
  },

  loadChapter(chapterId) {
    this.setData({ loading: true, error: '' });
    // 换章后行号从头算，避免沿用上一章的行号跳到中间某页
    this.currentLine = 0;
    get(`/api/chapters/${chapterId}`, null, { retry: false })
      .then((ch) => {
        const paragraphs = (ch.content || '')
          .split('\n')
          .map((text, i) => ({ id: i, text }))
          .filter((p) => p.text && p.text.trim());
        this.setData(
          {
            chapter: ch,
            chapterId: ch.id,
            paragraphs,
            prev: ch.prev,
            next: ch.next,
            loading: false,
          },
          () => {
            wx.setNavigationBarTitle({ title: ch.title || '阅读' });
            if (this.data.pageMode === 'flip') {
              // 翻页模式：重新切页，按 flipTarget / pendingPos 定位
              this.buildPages();
              return;
            }
            wx.pageScrollTo({ scrollTop: 0, duration: 0 });
            this.measureContent();
            const restorePos = this.pendingPos || 0;
            this.pendingPos = 0;
            if (restorePos > 0) setTimeout(() => this.restorePosition(restorePos), 200);
            this.saveProgress(restorePos);
          }
        );
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '章节加载失败' }));
  },

  measureContent() {
    setTimeout(() => {
      const q = wx.createSelectorQuery();
      q.select('#reader-content').boundingClientRect();
      q.exec((res) => {
        if (res && res[0]) this.contentHeight = res[0].height;
      });
    }, 80);
  },

  restorePosition(pct) {
    const wh = winHeight();
    const maxScroll = Math.max(0, this.contentHeight - wh);
    const top = (maxScroll * Math.min(100, Math.max(0, pct))) / 100;
    if (top > 0) wx.pageScrollTo({ scrollTop: top, duration: 0 });
  },

  computePct() {
    const wh = winHeight();
    if (!this.contentHeight || !wh) return 0;
    const maxScroll = Math.max(1, this.contentHeight - wh);
    return Math.min(100, Math.round(((this.scrollTop || 0) / maxScroll) * 100));
  },

  // 当前阅读进度：翻页按页码算，滚动按滚动比例算
  currentPct() {
    return this.data.pageMode === 'flip' ? this.data.pagePct : this.computePct();
  },

  saveProgress(pct) {
    if (!isLoggedIn() || !this.data.novelId || !this.data.chapterId) return;
    const position = Math.max(0, Math.min(100, Math.round(pct || 0)));
    put('/api/bookshelf/progress', {
      novelId: this.data.novelId,
      chapterId: this.data.chapterId,
      position,
    }).catch(() => {});
  },

  onPageScroll(e) {
    if (this.data.pageMode === 'flip') return;
    this.scrollTop = e.scrollTop;
    const now = Date.now();
    if (now - this.lastSaveTs > 2000) {
      this.lastSaveTs = now;
      this.saveProgress(this.computePct());
    }
  },

  // ---------- 翻页排版 ----------
  buildPages() {
    if (this.data.pageMode !== 'flip') return;
    const q = wx.createSelectorQuery();
    q.select('#flip-body').boundingClientRect();
    q.exec((res) => {
      const rect = res && res[0];
      if ((!rect || !rect.height) && !this._flipRetried) {
        this._flipRetried = true;
        setTimeout(() => this.buildPages(), 90);
        return;
      }
      this._flipRetried = false;
      const size = winSize();
      const width = (rect && rect.width) || size.width - 40;
      const height = (rect && rect.height) || size.height - 180;
      this.layoutPages(width, height, size.width);
    });
  },

  layoutPages(width, height, windowWidth) {
    const fontPx = (this.data.fontSize * windowWidth) / 750;
    const lineH = fontPx * LINE_HEIGHT_RATIO;
    const perPage = Math.max(2, Math.floor((height - 2) / lineH));
    // 留 2.5% 余量：量出来的行宽比实际可用的略窄，避免真实渲染时折行挤掉下一行
    const textWidth = Math.max(60, (width - 8) * 0.975);

    const lines = [];
    (this.data.paragraphs || []).forEach((p) => {
      const txt = String(p.text || '').trim();
      if (!txt) return;
      // 首行缩进两个全角空格（翻页模式下不再用 CSS 的 text-indent）
      wrapText(`　　${txt}`, textWidth, fontPx).forEach((l) => lines.push(l));
    });

    const pages = [];
    for (let i = 0; i < lines.length; i += perPage) {
      pages.push({ start: i, lines: lines.slice(i, i + perPage) });
    }
    if (!pages.length) pages.push({ start: 0, lines: [] });

    this.allLines = lines;
    this.perPage = perPage;
    this.pages = pages;

    let idx = 0;
    if (this.flipTarget === 'last') idx = pages.length - 1;
    else if (this.flipTarget === 'first') idx = 0;
    else if (this.pendingPos) idx = Math.round((this.pendingPos / 100) * (pages.length - 1));
    else if (this.currentLine) idx = Math.floor(this.currentLine / perPage);
    this.flipTarget = '';
    this.pendingPos = 0;
    idx = Math.max(0, Math.min(pages.length - 1, idx));
    this.currentLine = pages[idx].start;

    this.setData(
      {
        pageCount: pages.length,
        pageIndex: idx,
        pageLines: this.lineItems(pages[idx].lines),
        pagePct: this.pctOf(pages.length, idx),
      },
      () => this.saveProgress(this.data.pagePct)
    );
  },

  pctOf(count, idx) {
    if (count <= 1) return 0;
    return Math.round((idx / (count - 1)) * 100);
  },

  // 行数据带上 key，避免 wx:for 报警
  lineItems(lines) {
    return (lines || []).map((text, i) => ({ id: i, text }));
  },

  gotoPage(idx, dir) {
    const pages = this.pages || [];
    if (!pages.length) return;
    idx = Math.max(0, Math.min(pages.length - 1, idx));
    if (idx === this.data.pageIndex && !dir) return;
    this.currentLine = pages[idx].start;
    this.setData({
      pageIndex: idx,
      pageLines: this.lineItems(pages[idx].lines),
      pagePct: this.pctOf(pages.length, idx),
      turning: dir || '',
    });
    if (dir) {
      if (this._turnTimer) clearTimeout(this._turnTimer);
      this._turnTimer = setTimeout(() => this.setData({ turning: '' }), 220);
    }
    this.saveProgress(this.data.pagePct);
  },

  // 点按 / 滑动翻页时，别让「点」和「滑」各翻一次
  blockedBySwipe() {
    return this._swipedAt && Date.now() - this._swipedAt < 320;
  },

  prevPage() {
    if (this.blockedBySwipe()) return;
    if (this.data.settingsOpen || this.data.catalogOpen || this.data.contOpen) return;
    if (this.data.pageIndex > 0) {
      this.gotoPage(this.data.pageIndex - 1, 'prev');
      return;
    }
    if (this.data.prev) {
      this.flipTarget = 'last';
      this.loadChapter(this.data.prev.id);
      return;
    }
    wx.showToast({ title: '已经是第一章', icon: 'none' });
  },

  nextPage() {
    if (this.blockedBySwipe()) return;
    if (this.data.settingsOpen || this.data.catalogOpen || this.data.contOpen) return;
    if (this.data.pageIndex + 1 < this.data.pageCount) {
      this.gotoPage(this.data.pageIndex + 1, 'next');
      return;
    }
    if (this.data.next) {
      this.flipTarget = 'first';
      this.loadChapter(this.data.next.id);
      return;
    }
    wx.showToast({ title: '已是最后一章，点底部「补章」继续抓取', icon: 'none', duration: 2000 });
  },

  onFlipTouchStart(e) {
    if (this.data.pageMode !== 'flip') return;
    const t = (e.touches && e.touches[0]) || {};
    this._touch = { x: t.clientX || 0, y: t.clientY || 0 };
  },

  onFlipTouchEnd(e) {
    if (this.data.pageMode !== 'flip') return;
    const start = this._touch;
    if (!start) return;
    const t = (e.changedTouches && e.changedTouches[0]) || {};
    const dx = (t.clientX || 0) - start.x;
    const dy = (t.clientY || 0) - start.y;
    this._touch = null;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
    this._swipedAt = Date.now();
    // 左滑看下一屏，右滑回上一屏
    if (dx < 0) this.nextPage();
    else this.prevPage();
  },

  toggleSettings() {
    this.setData({
      settingsOpen: !this.data.settingsOpen,
      catalogOpen: false,
      contOpen: false,
    });
  },

  // 切换「上下滚动 / 左右翻页」，尽量停在原位置
  changeMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.pageMode) return;
    if (mode === 'flip') {
      const pct = this.computePct();
      this.setData({ pageMode: 'flip', settingsOpen: false }, () => {
        this.flipTarget = '';
        this.pendingPos = pct;
        this.saveSettings();
        this.buildPages();
      });
      return;
    }
    const pct = this.data.pagePct;
    this.setData({ pageMode: 'scroll', settingsOpen: false }, () => {
      this.saveSettings();
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      this.measureContent();
      if (pct > 0) {
        this.pendingPos = 0;
        setTimeout(() => this.restorePosition(pct), 320);
      }
    });
  },

  // ---------- 目录 ----------
  openCatalog() {
    if (this.data.catalogOpen) {
      this.setData({ catalogOpen: false });
      return;
    }
    this.setData({ catalogOpen: true, contOpen: false, settingsOpen: false });
    if (this.data.chapters.length) this.scrollCatalogToCurrent();
    else this.loadCatalog();
  },

  closeCatalog() {
    this.setData({ catalogOpen: false });
  },

  loadCatalog() {
    if (!this.data.novelId) return Promise.resolve();
    this.setData({ catalogLoading: true });
    return get(`/api/novels/${this.data.novelId}/chapters`, null, { retry: false })
      .then((list) => {
        this.setData({ chapters: list || [], catalogLoading: false }, () =>
          this.scrollCatalogToCurrent()
        );
      })
      .catch(() => this.setData({ catalogLoading: false }));
  },

  // 打开目录时直接定位到当前章
  scrollCatalogToCurrent() {
    const id = this.data.chapterId;
    if (!id) return;
    this.setData({ catalogInto: `c-${id}` });
  },

  onCatalogTap(e) {
    const id = Number(e.currentTarget.dataset.id);
    this.setData({ catalogOpen: false });
    if (!id || id === Number(this.data.chapterId)) return;
    this.pendingPos = 0;
    this.currentLine = 0;
    this.flipTarget = 'first';
    this.loadChapter(id);
  },

  // ---------- 继续补章 ----------
  loadContinue() {
    if (!this.data.novelId) return Promise.resolve();
    return get('/api/online/continue', { novelId: this.data.novelId }, { retry: false })
      .then((cont) => this.setData({ cont }))
      .catch(() => {});
  },

  openCont() {
    if (this.data.contOpen) {
      this.setData({ contOpen: false });
      return;
    }
    this.setData({ contOpen: true, catalogOpen: false, settingsOpen: false });
    this.loadContinue();
  },

  closeCont() {
    this.setData({ contOpen: false });
  },

  // 点面板外的空白处收起
  closePanels() {
    this.setData({ catalogOpen: false, contOpen: false });
  },

  chooseBatch(e) {
    if (this.data.contBusy) return;
    const n = Number(e.currentTarget.dataset.n) || 50;
    this.setData({ contBatch: n });
    const settings = wx.getStorageSync('reader_settings') || {};
    wx.setStorageSync('reader_settings', { ...settings, contBatch: n });
  },

  startContinue() {
    const cont = this.data.cont;
    if (this.data.contBusy) {
      wx.showToast({ title: '正在补章，请稍候', icon: 'none' });
      return;
    }
    if (!cont) {
      wx.showToast({ title: '正在读取补章信息，请稍候', icon: 'none' });
      return;
    }
    if (cont.needUrl) return this.askSourceUrl();
    if (!cont.canContinue) {
      wx.showToast({ title: '这本书暂不支持补章', icon: 'none' });
      return;
    }
    this.runContinue({});
  },

  // 早期抓的外部书没存源站链接：现场补一次链接
  askSourceUrl() {
    wx.showModal({
      title: '补章需要源站链接',
      content: '这本书没有记录来源地址。粘贴一次书籍详情页链接，之后就能一键补章。',
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
      { novelId: this.data.novelId, maxChapters: this.data.contBatch, ...extra },
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
      // 目录里多了章节，下次打开重新拉
      chapters: [],
    });
    wx.showToast({ title: task.message || '补章完成', icon: 'none', duration: 2200 });
    this.loadContinue();
    this.refreshNav();
  },

  // 只更新上一章/下一章，不重载正文（避免丢失阅读位置）
  refreshNav() {
    const id = this.data.chapterId;
    if (!id) return;
    get(`/api/chapters/${id}`, null, { retry: false })
      .then((ch) => this.setData({ prev: ch.prev, next: ch.next }))
      .catch(() => {});
  },

  failContinue(message) {
    this.setData({ contBusy: false, contProgress: 0, contStage: '' });
    wx.showToast({ title: message, icon: 'none', duration: 2500 });
  },

  changeFont(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    let fs = this.data.fontSize + delta;
    fs = Math.max(26, Math.min(48, fs));
    if (fs === this.data.fontSize) return;
    this.setData({ fontSize: fs }, () => {
      this.saveSettings();
      // 字号变了要重新切页，尽量停在同一行
      if (this.data.pageMode === 'flip') this.buildPages();
    });
  },

  changeTheme(e) {
    const theme = e.currentTarget.dataset.theme;
    this.setData({ theme }, () => {
      this.applyThemeBg(theme);
      this.saveSettings();
    });
  },

  // 同步页面级背景色，避免深色主题下下拉回弹露出浅色底
  applyThemeBg(theme) {
    const colors = { light: '#f7f6f2', sepia: '#f3e9d2', dark: '#17181a' };
    wx.setBackgroundColor({
      backgroundColor: colors[theme] || colors.light,
      backgroundColorTop: colors[theme] || colors.light,
      backgroundColorBottom: colors[theme] || colors.light,
    });
  },

  saveSettings() {
    wx.setStorageSync('reader_settings', {
      fontSize: this.data.fontSize,
      theme: this.data.theme,
      contBatch: this.data.contBatch,
      pageMode: this.data.pageMode,
    });
  },

  goPrev() {
    if (this.data.prev) {
      this.flipTarget = 'first';
      this.currentLine = 0;
      this.loadChapter(this.data.prev.id);
    }
  },

  goNext() {
    if (this.data.next) {
      this.flipTarget = 'first';
      this.currentLine = 0;
      this.loadChapter(this.data.next.id);
    }
  },

  noop() {},
});
