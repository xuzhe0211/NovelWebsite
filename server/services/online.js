// 全网搜索 + 一键入库
// ------------------------------------------------------------
// 小程序搜索页可以切换「全网搜索」：直接查免费小说站（当前接七猫）的搜索接口，
// 命中后把书抓取入库，并自动加入当前用户书架，随后就能像站内书一样阅读。
//
// 抓取是异步任务（一本几十章约 5~40s），接口返回 taskId，前端轮询进度。
import { randomUUID } from 'node:crypto';
import { Novel, Chapter, Bookshelf } from '../models/index.js';
import { logger } from './logger.js';
import { cacheClear } from './cache.js';
import { getSource } from './scraper/sources.js';
import { fetchText, importBook, refreshCookies, fetchToc, validContent } from './scraper/qimao-fetch.js';
import { parseNovelDetail, parseChapter } from './scraper/parser.js';
import { previewGenericBook, importGeneric, genericBookId, genericBookIdAliases } from './scraper/generic.js';

const log = (...a) => logger.info(a.join(' '));

// 启动后空闲预热 WAF cookie：让用户第一次搜索不用等浏览器过挑战
const warmup = setTimeout(() => {
  refreshCookies(log).catch(() => {});
}, 6000);
if (warmup.unref) warmup.unref();

// 单次导入最多抓多少章（免费章节通常集中在前部，够连续阅读）
const DEFAULT_MAX_CHAPTERS = 50;
// 「继续补章」每次补多少章：抓一批能读一阵，又不至于让用户等太久
const DEFAULT_CONTINUE_CHAPTERS = 20;
const TASK_TTL_MS = 30 * 60 * 1000;

/** 任务表：taskId -> task */
const tasks = new Map();

// 过期任务清理
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.finishedAt && now - t.finishedAt > TASK_TTL_MS) tasks.delete(id);
  }
}, 5 * 60 * 1000);
if (cleaner.unref) cleaner.unref();

// ---------- 搜索 ----------

/** "348.06万字" → 3480600 */
function parseWords(text) {
  if (!text) return 0;
  const m = String(text).match(/([\d.]+)\s*万/);
  if (m) return Math.round(Number(m[1]) * 10000);
  const n = String(text).match(/(\d+)/);
  return n ? Number(n[1]) : 0;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

/** 调七猫搜索接口 */
async function searchQimao(keyword, page = 1) {
  const url = `https://www.qimao.com/qimaoapi/api/search/result?keyword=${encodeURIComponent(
    keyword
  )}&page=${page}`;
  const raw = await fetchText(url, { log });
  const json = JSON.parse(raw);
  const data = (json && json.data) || {};
  const list = data.search_list || [];
  const pageData = data.page_data || {};

  return {
    total: Number(pageData.count) || list.length,
    list: list.map((it) => ({
      source: 'qimao',
      sourceName: getSource('qimao').name,
      bookId: String(it.book_id),
      title: stripTags(it.title),
      author: stripTags(it.author),
      coverUrl: it.image_link || '',
      intro: stripTags(it.intro),
      category: it.category2_name || '',
      isCompleted: String(it.is_over_txt || '').includes('完结'),
      wordCount: parseWords(it.words_num),
      lastChapterTitle: stripTags(it.latest_chapter_title),
      updateTime: it.update_time || '',
      url: it.read_url || `https://www.qimao.com/shuku/${it.book_id}/`,
    })),
  };
}

const SEARCHERS = { qimao: searchQimao };

// 搜索结果缓存：七猫对高频请求会返回 WAF 验证页，
// 相同关键词 5 分钟内直接复用结果，既省请求也避免撞限流。
const SEARCH_TTL = 5 * 60 * 1000;
const searchCache = new Map();

// 缓存清理
const searchCleaner = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.at > SEARCH_TTL * 2) searchCache.delete(k);
  }
}, 10 * 60 * 1000);
if (searchCleaner.unref) searchCleaner.unref();

/**
 * 全网搜索。返回结果会标注是否已在书库（inLibrary / novelId / chapterCount）
 */
export async function searchOnline(keyword, { page = 1, source = 'qimao' } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { total: 0, page, pageSize: 15, list: [], sources: Object.keys(SEARCHERS) };

  const cacheKey = `${source}:${page}:${kw}`;
  const now = Date.now();
  const cached = searchCache.get(cacheKey);
  const useCache = cached && now - cached.at < SEARCH_TTL;

  const searcher = SEARCHERS[source] || searchQimao;
  let result;
  if (useCache) {
    result = cached.result;
  } else {
    try {
      result = await searcher(kw, page);
      searchCache.set(cacheKey, { at: now, result });
    } catch (e) {
      // 抓不到就用旧结果顶一下（比直接报错体验好）
      if (cached) {
        result = cached.result;
      } else {
        logger.warn({ keyword: kw, err: e.message }, '全网搜索失败');
        const msg = /验证|WAF|反爬|频繁/.test(e.message)
          ? '书源暂时限流，请稍等 1 分钟再试'
          : `联网搜索失败：${e.message}`;
        throw new Error(msg);
      }
    }
  }

  // 标记已在库的书，前端可直接跳详情，不必重复导入
  const sourceIds = result.list.map((it) => `${it.source}:${it.bookId}`);
  const existing = sourceIds.length
    ? await Novel.findAll({
        where: { sourceId: sourceIds },
        attributes: ['id', 'sourceId', 'title'],
      })
    : [];
  const map = new Map(existing.map((n) => [n.sourceId, n]));

  const counts = existing.length
    ? await Chapter.findAll({
        where: { novelId: existing.map((n) => n.id) },
        attributes: ['novelId'],
      })
    : [];
  const countMap = counts.reduce((acc, c) => {
    acc[c.novelId] = (acc[c.novelId] || 0) + 1;
    return acc;
  }, {});

  return {
    total: result.total,
    page,
    pageSize: 15,
    list: result.list.map((it) => {
      const hit = map.get(`${it.source}:${it.bookId}`);
      return {
        ...it,
        inLibrary: !!hit,
        novelId: hit ? hit.id : null,
        importedChapters: hit ? countMap[hit.id] || 0 : 0,
      };
    }),
  };
}

// ---------- 链接识别 & 在线详情 ----------

// 已适配站点的链接规则：从用户粘贴的 URL 反解书籍 ID
const URL_PARSERS = [
  {
    key: 'qimao',
    test: /(^|\.)qimao\.com$/i,
    parse: (u) => {
      const m = u.pathname.match(/\/shuku\/(\d+)/) || u.pathname.match(/\/book\/(\d+)/);
      return m ? m[1] : '';
    },
  },
  {
    key: 'fanqie',
    test: /(^|\.)fanqienovel\.com$/i,
    parse: (u) => {
      const m = u.pathname.match(/\/page\/(\d+)/) || u.pathname.match(/\/reader\/(\d+)/);
      return m ? m[1] : '';
    },
  },
];

/** 识别链接归属：返回 { source, bookId, url, sourceName }；未知站点 source='web' */
export function resolveBookUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('链接格式不正确');
  }
  if (!/^https?:$/i.test(u.protocol)) throw new Error('只支持 http/https 链接');

  for (const p of URL_PARSERS) {
    if (!p.test.test(u.hostname)) continue;
    const bookId = p.parse(u);
    if (!bookId) throw new Error('未能从链接中识别书籍 ID，请粘贴书籍详情页地址');
    return { source: p.key, bookId, url: u.toString(), sourceName: getSource(p.key).name };
  }
  return { source: 'web', bookId: genericBookId(u.toString()), url: u.toString(), sourceName: u.hostname };
}

// 详情缓存：避免用户来回点同一本书时反复抓页面
const detailCache = new Map();
const DETAIL_TTL = 10 * 60 * 1000;

/** 导入完成后让详情缓存失效，否则页面上的「已入库 N 章」是旧值 */
function dropDetailCache(sourceKey, bookId) {
  for (const k of [...detailCache.keys()]) {
    if (k.startsWith(`${sourceKey}:`) && k.includes(String(bookId))) detailCache.delete(k);
  }
}

/** 在线书籍详情（含免费章数、是否已入库） */
export async function fetchOnlineDetail({ source = 'qimao', bookId = '', url = '', refresh = false } = {}) {
  const key = `${source}:${bookId || url}`;
  const cached = detailCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < DETAIL_TTL) return cached.data;

  let detail;
  if (source === 'web') {
    if (!url) throw new Error('缺少书籍链接');
    const { info, chapters } = await previewGenericBook(url);
    detail = {
      source: 'web',
      sourceName: new URL(url).hostname,
      bookId: genericBookId(url),
      url,
      title: info.title,
      author: info.author || '',
      coverUrl: info.coverUrl || '',
      intro: info.intro || '',
      category: info.categoryName || '',
      isCompleted: !!info.isCompleted,
      chapterCount: chapters.length,
      freeChapters: chapters.length,
      canImport: chapters.length > 0,
    };
  } else {
    const src = getSource(source);
    const html = await fetchText(src.book(bookId), { log });
    const info = parseNovelDetail(html, src);
    if (!info.title) throw new Error('未能解析书籍信息，可能被站点拦截');

    let toc = [];
    try {
      toc = await fetchToc(bookId, { log });
    } catch {
      toc = [];
    }
    const free = toc.filter((c) => c.free).length;
    detail = {
      source: src.key,
      sourceName: src.name,
      bookId: String(bookId),
      url: src.book(bookId),
      title: info.title,
      author: info.author || '',
      coverUrl: info.coverUrl || '',
      intro: info.intro || '',
      category: info.categoryName || '',
      isCompleted: !!info.isCompleted,
      chapterCount: toc.length,
      freeChapters: free,
      canImport: free >= 3,
    };

    // 目录里的「免费」标记不等于网页端真能读到正文（不少书实际是 VIP），
    // 探一章确认，避免用户点了按钮等半天才失败。
    const firstFree = toc.find((c) => c.free);
    if (firstFree) {
      try {
        const page = await fetchText(src.chapter(bookId, firstFree.sourceChapterId), { log });
        detail.canImport = validContent(parseChapter(page, src));
      } catch {
        detail.canImport = false;
      }
    } else {
      detail.canImport = false;
    }
    detail.readable = detail.canImport;
  }

  // web 源的书籍标识做过归一化，旧记录用未归一化的哈希，这里一并匹配
  const novel =
    detail.source === 'web' && detail.url
      ? await Novel.findOne({
          where: { sourceId: genericBookIdAliases(detail.url).map((id) => `web:${id}`) },
          attributes: ['id'],
        })
      : await Novel.findOne({
          where: { sourceId: `${detail.source}:${detail.bookId}` },
          attributes: ['id'],
        });
  if (novel) {
    detail.inLibrary = true;
    detail.novelId = novel.id;
    detail.importedChapters = await Chapter.count({ where: { novelId: novel.id } });
  } else {
    detail.inLibrary = false;
    detail.novelId = null;
    detail.importedChapters = 0;
  }

  detailCache.set(key, { at: Date.now(), data: detail });
  if (detailCache.size > 200) detailCache.delete(detailCache.keys().next().value);
  return detail;
}

// ---------- 导入任务 ----------

function runningTaskBySource(sourceId) {
  for (const t of tasks.values()) {
    if (t.sourceId === sourceId && t.status !== 'error' && !t.finishedAt) return t;
  }
  return null;
}

/**
 * 创建（或复用）一本书的导入任务
 * @param {object} opts
 * @param {string} opts.bookId
 * @param {string} opts.source      数据源 key：qimao / fanqie / web（任意站点）
 * @param {string} opts.url         第三方站点链接（source=web 时必填）
 * @param {number} opts.userId      登录用户 ID
 * @param {boolean} opts.addToShelf 完成后是否加入书架（false = 仅拉取到本站书库）
 * @param {number} opts.maxChapters
 * @param {string} opts.forceBookId 强制写入已有书库记录（继续补章用）
 */
export function startImport({
  bookId,
  source = 'qimao',
  userId = null,
  maxChapters,
  url = '',
  addToShelf = true,
  forceBookId = '',
} = {}) {
  const isWeb = source === 'web';
  const src = isWeb ? null : getSource(source);
  const key = isWeb ? 'web' : src.key;
  const finalBookId = forceBookId || (isWeb ? genericBookId(url) : String(bookId));
  const sourceId = `${key}:${finalBookId}`;

  const running = runningTaskBySource(sourceId);
  if (running) return { ...running, reused: true };

  const task = {
    id: randomUUID(),
    sourceId,
    source: key,
    bookId: finalBookId,
    url: isWeb ? url : '',
    userId,
    addToShelf: !!addToShelf,
    status: 'running',
    stage: '准备中',
    progress: 0,
    title: '',
    novelId: null,
    chapters: 0,
    added: 0,
    message: '',
    createdAt: Date.now(),
    finishedAt: null,
  };
  tasks.set(task.id, task);

  const limit = Number(maxChapters) > 0 ? Math.min(Number(maxChapters), 300) : DEFAULT_MAX_CHAPTERS;

  (async () => {
    try {
      task.stage = '抓取详情与目录';
      const onProgress = ({ done, total, added }) => {
        task.stage = '下载正文';
        task.progress = Math.min(95, Math.round((done / Math.max(total, 1)) * 90) + 5);
        task.chapters = added;
      };

      const res = isWeb
        ? await importGeneric(url, {
            maxChapters: limit,
            concurrency: 3,
            log,
            onProgress,
            bookId: forceBookId,
          })
        : await importBook(src, bookId, { maxChapters: limit, concurrency: 6, log, onProgress });

      task.novelId = res.novelId;
      task.title = res.title;
      task.chapters = res.total;
      task.added = res.added;
      task.sourceTotal = res.sourceTotal || 0;

      // web 源整本可抓，剩余就是「还能补多少」；七猫只有免费章节可抓，剩余要在源站读
      const importable = Number(res.free || res.sourceTotal || 0);
      task.remaining = Math.max(0, importable - res.total);
      task.hasMore = task.remaining > 0;
      task.progress = 100;

      if (addToShelf && userId) {
        await Bookshelf.findOrCreate({
          where: { userId, novelId: res.novelId },
          defaults: { userId, novelId: res.novelId, lastPosition: 0 },
        });
      }

      const toShelf = addToShelf && !!userId;
      const base = res.added
        ? `新增 ${res.added} 章，库内共 ${res.total} 章`
        : res.unchanged
          ? `已是最新，库内共 ${res.total} 章`
          : `本次未新增，库内共 ${res.total} 章`;
      const tail = task.hasMore
        ? isWeb
          ? `，还可继续补 ${task.remaining} 章`
          : `，源站有 ${task.remaining} 章需在源站阅读`
        : '';
      task.status = 'done';
      task.stage = toShelf ? '已加入书架' : '已入库';
      task.message = base + tail + (toShelf && !res.unchanged ? '，已加入书架' : '');
      dropDetailCache(key, finalBookId);
      cacheClear();
    } catch (e) {
      task.status = 'error';
      task.stage = '导入失败';
      task.message = e.message || '导入失败';
      logger.warn({ bookId, source, err: e.message }, '联网导入失败');
    } finally {
      task.finishedAt = Date.now();
    }
  })();

  return task;
}

export function getTask(id) {
  const t = tasks.get(String(id));
  if (!t) return null;
  return {
    id: t.id,
    sourceId: t.sourceId,
    status: t.status,
    stage: t.stage,
    progress: t.progress,
    title: t.title,
    novelId: t.novelId,
    chapters: t.chapters,
    added: t.added,
    sourceTotal: t.sourceTotal || 0,
    remaining: t.remaining || 0,
    hasMore: !!t.hasMore,
    message: t.message,
  };
}

// ---------- 继续补章 ----------

function splitSourceId(sourceId) {
  const raw = String(sourceId || '');
  const i = raw.indexOf(':');
  return i < 0 ? { key: raw, bookId: '' } : { key: raw.slice(0, i), bookId: raw.slice(i + 1) };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

/** 这本书还能不能继续补章（在线来源 + 有可回溯的源站信息） */
export async function continueInfo(novelId) {
  const novel = await Novel.findByPk(Number(novelId), {
    attributes: ['id', 'sourceId', 'title', 'sourceUrl'],
  });
  if (!novel) return null;

  const { key, bookId } = splitSourceId(novel.sourceId);
  const isWeb = key === 'web';
  const imported = await Chapter.count({ where: { novelId: novel.id } });

  let src = null;
  if (!isWeb) {
    try {
      src = getSource(key);
    } catch {
      src = null;
    }
  }
  const sourceUrl = novel.sourceUrl || (src && bookId ? src.book(bookId) : '');

  // 最近一次导入任务知道「源站共几章 / 还能补几章」，用它给前端一个准确提示
  const last = [...tasks.values()]
    .filter((t) => t.sourceId === novel.sourceId && t.finishedAt && t.status === 'done')
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];

  return {
    novelId: novel.id,
    source: key,
    bookId,
    sourceName: isWeb ? hostOf(sourceUrl) : src ? src.name : '',
    sourceUrl,
    importedChapters: imported,
    sourceTotal: last ? last.sourceTotal || 0 : 0,
    remaining: last ? last.remaining || 0 : null,
    hasMore: last ? !!last.hasMore : null,
    // 早期抓的外部书没存链接，需要用户补一次（补完就会记住）
    needUrl: isWeb && !sourceUrl,
    canContinue: imported > 0 && (isWeb ? !!sourceUrl : !!src),
  };
}

/**
 * 继续补章：把某条书库记录剩下的章节再抓一批
 * @param {object} opts { novelId, userId, maxChapters, addToShelf, url }
 *        url：历史 web 书没有源站链接时，允许用户现场粘贴一次
 */
export async function startContinueImport({
  novelId,
  userId = null,
  maxChapters,
  addToShelf = false,
  url = '',
} = {}) {
  const novel = await Novel.findByPk(Number(novelId), {
    attributes: ['id', 'sourceId', 'sourceUrl', 'title'],
  });
  if (!novel) throw new Error('书籍不存在');

  const { key, bookId } = splitSourceId(novel.sourceId);
  const limit = Number(maxChapters) > 0 ? Number(maxChapters) : DEFAULT_CONTINUE_CHAPTERS;

  if (key === 'web') {
    const link = String(url || novel.sourceUrl || '').trim();
    if (!link) {
      const err = new Error('这本书缺少源站链接，请粘贴一次书籍详情页地址');
      err.code = 'NEED_URL';
      throw err;
    }
    return startImport({
      source: 'web',
      url: link,
      userId,
      maxChapters: limit,
      addToShelf,
      forceBookId: bookId,
    });
  }

  const src = getSource(key); // 未知来源会抛错，交给上层返回给前端
  return startImport({
    source: src.key,
    bookId,
    userId,
    maxChapters: limit,
    addToShelf,
    forceBookId: bookId,
  });
}

/** 已入库书籍列表（供前端显示「已可阅读」状态） */
export async function libraryStatus(books = []) {
  const ids = books.map((b) => `${b.source || 'qimao'}:${b.bookId}`);
  if (!ids.length) return [];
  const rows = await Novel.findAll({ where: { sourceId: ids }, attributes: ['id', 'sourceId'] });
  return rows.map((r) => ({ novelId: r.id, sourceId: r.sourceId }));
}

