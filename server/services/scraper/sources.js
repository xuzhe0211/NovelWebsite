// 数据源配置：不同免费小说站的 URL 规则、链接识别与选择器提示
// 解析器会优先用 hints，再用通用启发式兜底，尽量适配站点改版。

export function resolveUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

export const SOURCES = {
  // 七猫免费小说
  qimao: {
    key: 'qimao',
    name: '七猫免费小说',
    baseUrl: 'https://www.qimao.com',
    book: (id) => `https://www.qimao.com/shuku/${id}/`,
    // 章节页：/shuku/{bookId}-{chapterId}/
    chapter: (bookId, chapterId) => `https://www.qimao.com/shuku/${bookId}-${chapterId}/`,
    chapterIdFromHref: (href, bookId) => {
      const m = href.match(new RegExp(`/shuku/${bookId}-(\\d+)`));
      return m ? m[1] : null;
    },
    bookIdFromHref: (href) => {
      const m = href.match(/\/shuku\/(\d+)\/?$/);
      return m ? m[1] : null;
    },
    discoverSelector: 'a[href*="/shuku/"]',
    sortChapters: 'dom', // 完整目录已按阅读顺序，信任 DOM 顺序
    // 书本页加载后：点击“作品目录”标签，等待章节链接渲染
    async afterBookLoad(page, bookId) {
      try {
        const tab = page.locator('.qm-tab-list-item').filter({ hasText: '作品目录' }).first();
        if (await tab.count()) {
          await tab.click({ timeout: 5000 });
          await page.waitForTimeout(1500);
        }
      } catch {
        /* ignore */
      }
      await page.waitForSelector(`a[href*="/shuku/${bookId}-"]`, { timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    },
    contentHints: [
      '.chapter-detail-article .article',
      '.chapter-detail-article',
      '#content', '.content', '.read-content', '.article-content', '#chapter-content',
    ],
    titleHints: ['.title .txt', 'h1', '.book-name', '.book-title', 'meta[property="og:title"]'],
    authorHints: ['.sub-title .txt a', '.author', '.book-info .author', 'meta[property="og:novel:author"]'],
    introHints: ['.book-introduction .intro', 'p.intro', '.intro', '.book-intro', '#intro', 'meta[property="og:description"]'],
    coverHints: ['.wrap-pic img', '.book-cover img', '.cover img', 'meta[property="og:image"]'],
    categoryHints: ['.tags-wrap .qm-tag a', '.category', '.tags a', '.book-tags a', 'meta[property="og:novel:category"]'],
  },

  // 番茄小说
  fanqie: {
    key: 'fanqie',
    name: '番茄小说',
    baseUrl: 'https://fanqienovel.com',
    book: (id) => `https://fanqienovel.com/page/${id}`,
    chapter: (bookId, chapterId) => `https://fanqienovel.com/reader/${chapterId}`,
    chapterIdFromHref: (href) => {
      const m = href.match(/\/reader\/(\d+)/);
      return m ? m[1] : null;
    },
    bookIdFromHref: (href) => {
      const m = href.match(/\/page\/(\d+)/);
      return m ? m[1] : null;
    },
    discoverSelector: 'a[href*="/page/"]',
    sortChapters: 'dom',
    contentHints: ['.muye-reader-content', '.reader-content', '.chapter-content', '#content', '.content', '.article-content'],
    titleHints: ['h1', '.book-name', '.book-title', 'meta[property="og:title"]'],
    authorHints: ['.author', '.book-info .author', 'meta[property="og:novel:author"]'],
    introHints: ['.intro', '.book-intro', '.book-desc', 'meta[property="og:description"]'],
    coverHints: ['.book-cover img', '.cover img', 'meta[property="og:image"]'],
    categoryHints: ['.category', '.tags a', 'meta[property="og:novel:category"]'],
  },

  // 台湾 twkan（原始站点，需过 Cloudflare，保留作可选）
  twkan: {
    key: 'twkan',
    name: 'twkan',
    baseUrl: 'https://twkan.com',
    book: (id) => `https://twkan.com/txt/${id}/`,
    chapter: (bookId, chapterId) => `https://twkan.com/txt/${bookId}/${chapterId}`,
    chapterIdFromHref: (href, bookId) => {
      const m = href.match(new RegExp(`/txt/${bookId}/(\\d+)`));
      return m ? m[1] : null;
    },
    bookIdFromHref: (href) => {
      const m = href.match(/\/txt\/(\d+)\/?$/);
      return m ? m[1] : null;
    },
    discoverSelector: 'a[href*="/txt/"]',
    sortChapters: 'number', // 目录含“最新章节”区块，按第N章排序
    contentHints: ['#content', '#chaptercontent', '#booktxt', '.content', '.showtxt', '.read-content'],
    titleHints: ['h1', '.bookinfo h1', 'meta[property="og:novel:book_name"]'],
    authorHints: ['.bookinfo .author', '.author', 'meta[property="og:novel:author"]'],
    introHints: ['#intro', '.intro', '.bookintro', 'meta[property="og:description"]'],
    coverHints: ['.bookinfo img', '.cover img', 'meta[property="og:image"]'],
    categoryHints: ['.breadcrumb a', '.bookinfo .cat', 'meta[property="og:novel:category"]'],
  },
};

export function getSource(key) {
  return SOURCES[key] || SOURCES.qimao;
}
