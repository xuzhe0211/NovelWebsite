import { Novel, Category, Chapter } from '../../models/index.js';
import { config } from '../../config/index.js';
import { logger } from '../logger.js';
import { fetchPage } from './browser.js';
import { getSource } from './sources.js';
import { parseNovelDetail, parseChapterList, parseChapter, discoverBooks } from './parser.js';
import { cacheClear } from '../cache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function matchCategory(name) {
  if (!name) return null;
  const exact = await Category.findOne({ where: { name } });
  if (exact) return exact.id;
  // 模糊映射：如“现代言情”包含“言情”，取最长的匹配分类
  const all = await Category.findAll({ attributes: ['id', 'name'] });
  const matches = all.filter((c) => name.includes(c.name)).sort((a, b) => b.name.length - a.name.length);
  return matches.length ? matches[0].id : null;
}

// 新增或更新小说主记录。sourceId 加数据源前缀，避免不同站同名ID冲突。
export async function upsertNovel(info, bookId, sourceKey) {
  const sourceId = `${sourceKey}:${bookId}`;
  const categoryId = await matchCategory(info.categoryName);
  const [novel] = await Novel.findOrCreate({
    where: { sourceId },
    defaults: {
      sourceId,
      title: info.title,
      author: info.author,
      intro: info.intro,
      coverUrl: info.coverUrl,
      categoryId,
      isCompleted: info.isCompleted,
      status: info.status,
      lastUpdateTime: new Date(),
    },
  });
  await novel.update({
    title: info.title || novel.title,
    author: info.author || novel.author,
    intro: info.intro || novel.intro,
    coverUrl: info.coverUrl || novel.coverUrl,
    categoryId: categoryId ?? novel.categoryId,
    isCompleted: info.isCompleted,
    status: info.status,
    lastUpdateTime: new Date(),
  });
  return novel;
}

// 页面框架文案（VIP/需登录时正文读不到，抓到的全是导航、阅读设置等）
const PAGE_CHROME = /立即登录|阅读设置|新人注册|举报类型|快捷键指南|全屏模式|下载七猫/;

// 保存单章（若已存在则跳过），返回是否新增
export async function saveChapter(novelId, ch, parsed) {
  if (!parsed.content || parsed.content.length < 20) {
    logger.warn({ novelId, sourceChapterId: ch.sourceChapterId }, '正文为空或过短，跳过（可能为 VIP/空白章节）');
    return false;
  }
  if (PAGE_CHROME.test(parsed.content.slice(0, 300))) {
    logger.warn({ novelId, sourceChapterId: ch.sourceChapterId }, '抓到的是页面框架而非正文（VIP/需登录），跳过');
    return false;
  }
  const exists = await Chapter.findOne({
    where: { novelId, sourceChapterId: ch.sourceChapterId },
    attributes: ['id'],
  });
  if (exists) return false;

  await Chapter.create({
    novelId,
    sourceChapterId: ch.sourceChapterId,
    chapterNo: ch.chapterNo,
    title: parsed.title || ch.title,
    content: parsed.content,
    wordCount: parsed.wordCount,
  });
  return true;
}

// 收尾：更新字数、最新章节
export async function finalizeNovel(novel) {
  const totalChapters = await Chapter.count({ where: { novelId: novel.id } });
  const wordSum = (await Chapter.sum('wordCount', { where: { novelId: novel.id } })) || 0;
  const lastChapter = await Chapter.findOne({
    where: { novelId: novel.id },
    order: [['chapterNo', 'DESC']],
  });
  await novel.update({
    wordCount: Number(wordSum),
    lastChapterId: lastChapter ? lastChapter.id : novel.lastChapterId,
    lastChapterTitle: lastChapter ? lastChapter.title : novel.lastChapterTitle,
    lastUpdateTime: new Date(),
  });
  return totalChapters;
}

// 抓取单部小说：详情 -> 目录 -> 增量抓正文
export async function crawlNovel(bookId, { source, headless = true, manualWaitMs, limit = 0 } = {}) {
  const src = source || getSource(config.crawl.source);
  const bookUrl = src.book(bookId);

  logger.info({ source: src.key, bookId, bookUrl }, '抓取小说详情/目录页');
  const afterLoad = src.afterBookLoad ? (page, url) => src.afterBookLoad(page, bookId) : undefined;
  const detailHtml = await fetchPage(bookUrl, { headless, manualWaitMs, afterLoad });

  const info = parseNovelDetail(detailHtml, src);
  if (!info.title) throw new Error(`未能解析到书名: ${bookUrl}`);

  const chapterList = parseChapterList(detailHtml, src, bookId);
  if (!chapterList.length) throw new Error(`未能解析到章节: ${bookUrl}`);
  logger.info({ bookId, title: info.title, chapters: chapterList.length }, '目录解析完成');

  const novel = await upsertNovel(info, bookId, src.key);

  const existing = await Chapter.findAll({
    where: { novelId: novel.id },
    attributes: ['sourceChapterId'],
  });
  const existingSet = new Set(existing.map((c) => c.sourceChapterId));

  let added = 0;
  let failed = 0;
  let attempted = 0;
  const maxFetch = limit > 0 ? limit : Infinity;
  for (const ch of chapterList) {
    if (existingSet.has(ch.sourceChapterId)) continue;
    if (attempted >= maxFetch) {
      logger.info({ bookId, limit }, '达到本次抓取上限，停止');
      break;
    }
    attempted++;
    try {
      const chapterUrl = src.chapter(bookId, ch.sourceChapterId);
      const html = await fetchPage(chapterUrl, { headless, manualWaitMs });
      const parsed = parseChapter(html, src);
      const created = await saveChapter(novel.id, ch, parsed);
      if (created) added++;
      await sleep(config.crawl.intervalMs);
    } catch (e) {
      failed++;
      logger.error({ bookId, chapter: ch.sourceChapterId, err: e.message }, '章节抓取失败，跳过');
    }
  }

  const totalChapters = await finalizeNovel(novel);
  cacheClear();
  const summary = { source: src.key, bookId, title: info.title, parsedChapters: chapterList.length, added, failed, totalChapters };
  logger.info(summary, '小说抓取完成');
  return summary;
}

// 遍历种子书籍；若无种子则从列表页发现
export async function runCrawl({ headless = true, limit = 0, sourceKey } = {}) {
  const src = getSource(sourceKey || config.crawl.source);
  let ids = [...config.crawl.seedIds];

  const listUrl = config.crawl.listUrl || src.baseUrl;
  if (!ids.length && listUrl) {
    logger.info({ source: src.key, listUrl }, '从列表页发现书籍');
    const html = await fetchPage(listUrl, { headless });
    ids = discoverBooks(html, src).slice(0, config.crawl.maxBooks || 3);
    logger.info({ found: ids.length, ids }, '发现书籍');
  }

  if (!ids.length) {
    throw new Error('没有可抓取的书籍：请设置 CRAWL_SEED_IDS（书籍ID）或 CRAWL_LIST_URL（书库/首页地址）');
  }

  const results = [];
  for (const id of ids) {
    try {
      results.push(await crawlNovel(id, { source: src, headless, limit }));
    } catch (e) {
      logger.error({ bookId: id, err: e.message }, '小说抓取失败');
      results.push({ bookId: id, error: e.message });
    }
  }
  return results;
}
