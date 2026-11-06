const { BASE_URL, USE_COVER_PROXY, COVER_INLINE } = require('../../utils/config');

/**
 * 通用书籍封面
 * ------------------------------------------------------------
 * 1. 有可用的 coverUrl：直接展示图片；
 * 2. 无封面 / 图片加载失败（防盗链、域名未配置、404）：渲染一张按书名生成的
 *    排版封面（渐变底 + 书名 + 作者 + 分类），保证列表里永远不会出现空白块。
 * 3. 相对路径（/static/xxx.jpg）自动补 BASE_URL；外链可选走服务端代理，
 *    绕开防盗链与小程序域名白名单。
 * 4. 外链封面默认走 data URI（base64）内联：微信 3.8.7+ 的 image 组件在
 *    开发版/体验版不再加载 http:// 图片，真机预览会静默空白且不触发 binderror；
 *    改成先用 wx.request 拿 base64 再赋给 src，就完全不发图片请求，绕开该限制。
 */
const PALETTES = [
  { a: '#4b5c70', b: '#222d3a' },
  { a: '#8a4a35', b: '#47241a' },
  { a: '#3f6657', b: '#1d322a' },
  { a: '#4d4b74', b: '#262440' },
  { a: '#7a5a33', b: '#3c2a15' },
  { a: '#2f5f7a', b: '#15303e' },
  { a: '#6b3a55', b: '#331b27' },
  { a: '#56575b', b: '#2a2b2e' },
];

// 屏宽只需取一次：rpx → px 换算用
let WINDOW_WIDTH = 375;
try {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  if (info && info.windowWidth) WINDOW_WIDTH = info.windowWidth;
} catch (e) {}

const inlineCache = new Map(); // key -> dataUri
const inlinePending = new Map(); // key -> Promise
const MAX_CACHE = 200;

function proxyUrl(url) {
  return `${BASE_URL}/api/cover?url=${encodeURIComponent(url)}`;
}

function hashCode(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function isRemote(url) {
  return /^https?:\/\//i.test(url) || url.indexOf('//') === 0;
}

function resolveSrc(src) {
  if (!src) return '';
  let url = String(src).trim();
  if (!url) return '';
  if (url.indexOf('//') === 0) url = 'https:' + url;
  // 本地临时/持久文件直接使用
  if (/^(wxfile|file):/i.test(url) || /^https?:\/\/tmp\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) {
    return USE_COVER_PROXY ? proxyUrl(url) : url;
  }
  if (url.charAt(0) === '/') return BASE_URL + url;
  return url;
}

/** 按封面显示宽度估算需要的像素宽度（按 2.2 倍屏取，封顶 420） */
function pixelWidth(rpx) {
  const px = Math.round((Number(rpx) || 120) * (WINDOW_WIDTH / 750) * 2.2);
  return Math.max(96, Math.min(420, px));
}

/** 用 wx.request 取 base64 封面（带内存缓存 + 并发去重） */
function loadInline(url, width) {
  const key = `${url}@${width}`;
  if (inlineCache.has(key)) return Promise.resolve(inlineCache.get(key));
  if (inlinePending.has(key)) return inlinePending.get(key);

  const task = new Promise((resolve, reject) => {
    wx.request({
      url: `${proxyUrl(url)}&b64=1&w=${width}`,
      method: 'GET',
      timeout: 15000,
      success(res) {
        const body = (res && res.data) || {};
        const data = body.data || {};
        const dataUrl = data.dataUrl;
        if (res.statusCode === 200 && body.code === 0 && dataUrl) {
          if (inlineCache.size > MAX_CACHE) inlineCache.clear();
          inlineCache.set(key, dataUrl);
          resolve(dataUrl);
        } else {
          reject(new Error('cover inline failed'));
        }
      },
      fail: reject,
    });
  });

  inlinePending.set(key, task);
  const done = () => inlinePending.delete(key);
  task.then(done, done);
  return task;
}

Component({
  properties: {
    src: { type: String, value: '' },
    title: { type: String, value: '' },
    author: { type: String, value: '' },
    category: { type: String, value: '' },
    // 封面宽度（rpx），高度按 3:4 自动计算
    size: { type: Number, value: 120 },
    radius: { type: Number, value: 10 },
    badge: { type: String, value: '' },
    lazy: { type: Boolean, value: true },
  },

  data: {
    failed: false,
    realSrc: '',
    rootStyle: '',
    markStyle: '',
    titleStyle: '',
    authorStyle: '',
    tagStyle: '',
    displayTitle: '',
    mark: '书',
    innerPad: 12,
    hasAuthor: false,
    tag: '',
  },

  observers: {
    'src, title, author, category, size, radius': function observe() {
      this.render();
    },
  },

  lifetimes: {
    attached() {
      this.render();
    },
    detached() {
      this._destroyed = true;
    },
  },

  methods: {
    render() {
      const p = this.properties || {};
      const w = Math.max(40, Number(p.size) || 120);
      const h = Math.round((w * 4) / 3);
      const r = Number(p.radius) >= 0 ? Number(p.radius) : 10;
      const title = (p.title || '').trim() || '未命名';
      const author = (p.author || '').trim();
      const category = (p.category || '').trim();
      const palette = PALETTES[hashCode(title) % PALETTES.length];

      const pad = Math.round(w * 0.09);
      // 书名越长字号越小，避免小尺寸封面被截断
      const len = title.length;
      let ratio = 0.2;
      if (len > 5) ratio = 0.185;
      if (len > 8) ratio = 0.17;
      if (len > 12) ratio = 0.155;
      const titleFont = Math.max(18, Math.round(w * ratio));
      const authorFont = Math.max(16, Math.round(w * 0.115));
      const tagFont = Math.max(15, Math.round(w * 0.1));
      const letter = w >= 140 ? 1 : 0;

      this.setData({
        failed: false,
        realSrc: '',
        rootStyle:
          `width:${w}rpx;height:${h}rpx;border-radius:${r}rpx;` +
          `background:linear-gradient(152deg,${palette.a} 0%,${palette.b} 100%);`,
        markStyle: `font-size:${Math.round(w * 1.12)}rpx;`,
        titleStyle:
          `font-size:${titleFont}rpx;line-height:1.32;letter-spacing:${letter}rpx;` +
          `margin-bottom:${Math.round(w * 0.03)}rpx;`,
        authorStyle: `font-size:${authorFont}rpx;`,
        tagStyle: `font-size:${tagFont}rpx;padding:2rpx ${Math.round(w * 0.055)}rpx;`,
        displayTitle: title,
        mark: title[0] || '书',
        innerPad: pad,
        hasAuthor: !!author,
        tag: category,
      });

      this.loadImage((p.src || '').trim(), w);
    },

    /**
     * 外链封面优先走 data URI：微信 image 组件在开发版/体验版会拦 http 图片，
     * 而 wx.request 取 base64 不受这条限制；失败再退回代理地址，最后才用文字封面。
     */
    loadImage(raw, w) {
      const seq = (this._seq || 0) + 1;
      this._seq = seq;

      if (!raw) return;

      if (!isRemote(raw)) {
        this.setData({ realSrc: resolveSrc(raw) });
        return;
      }

      if (!(USE_COVER_PROXY && COVER_INLINE)) {
        this.setData({ realSrc: resolveSrc(raw) });
        return;
      }

      const url = raw.indexOf('//') === 0 ? 'https:' + raw : raw;
      loadInline(url, pixelWidth(w)).then(
        (dataUrl) => {
          if (this._destroyed || this._seq !== seq) return;
          this.setData({ realSrc: dataUrl });
        },
        () => {
          if (this._destroyed || this._seq !== seq) return;
          console.warn('[novel-cover] 内联封面失败，退回代理地址：', url);
          this.setData({ realSrc: proxyUrl(url) });
        }
      );
    },

    onError() {
      if (!this.data.failed) this.setData({ failed: true });
    },

    onTap() {
      this.triggerEvent('tap');
    },
  },
});
