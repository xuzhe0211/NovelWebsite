// 七猫抓取核心（可复用）
// ------------------------------------------------------------
// 供两处调用：
//   1. services/scraper/fast.js —— 命令行批量补书
//   2. services/online.js       —— 小程序「全网搜索 → 一键入库」
//
// 要点：
//   · 七猫用阿里云 WAF 的 JS 挑战，纯 HTTP 过不去：先用 Playwright 过一次拿 cookie，之后复用；
//   · 响应头含多余空格，undici/fetch 会判协议非法 → 用原生 http(s) + insecureHTTPParser；
//   · 目录走 /qimaoapi/api/book/chapter-list，一次拿全，比翻页快得多；
//   · 目录里 is_vip=1 的章节网页端读不到正文，只抓 is_vip=0。
import http from 'node:http';
import https from 'node:https';
import { Chapter } from '../../models/index.js';
import { getSource } from './sources.js';
import { launchBrowser } from './browser-args.js';
import { parseNovelDetail, parseChapter } from './parser.js';
import { upsertNovel, saveChapter, finalizeNovel } from './index.js';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookieJar = '';
let cookieAt = 0; // 上次拿到 cookie 的时间戳
let lastRefreshAt = 0; // 上次尝试刷新的时间戳（节流用）
let refreshing = null;

// WAF 的 acw_sc__v2 是有时效的：早先只在「完全没有 cookie」时才去刷新，
// 结果 cookie 过期后每次请求都撞验证页，重试三次全失败，前端只看到「书源限流」。
// 现在按 TTL 主动续期，并在命中验证页时强制刷新一次。
const COOKIE_TTL = 6 * 60 * 1000;
const MIN_REFRESH_GAP = 20 * 1000; // 两次刷新至少隔 20s，避免刷得太凶

function cookieFresh() {
  return !!cookieJar && Date.now() - cookieAt < COOKIE_TTL;
}

export async function refreshCookies(log = () => {}, { force = false } = {}) {
  if (refreshing) return refreshing;
  if (!force && cookieFresh()) return;
  // 刚刷过还是不行，说明不是 cookie 的问题，别再反复开浏览器
  if (Date.now() - lastRefreshAt < MIN_REFRESH_GAP) return;

  refreshing = (async () => {
    lastRefreshAt = Date.now();
    log('  · 获取会话 cookie ...');
    const browser = await launchBrowser();
    try {
      const ctx = await browser.newContext({ userAgent: UA });
      const page = await ctx.newPage();
      await page
        .goto('https://www.qimao.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
      await page.waitForTimeout(2000);
      // 顺带打一次搜索接口：让 WAF 把 cookie 覆盖到 API 路径，
      // 避免首页过了挑战、API 仍要验证的情况。
      await page
        .evaluate(async () => {
          await fetch('https://www.qimao.com/qimaoapi/api/search/result?keyword=%E5%89%91%E6%9D%A5&page=1', {
            credentials: 'include',
          }).catch(() => {});
        })
        .catch(() => {});
      const list = await ctx.cookies();
      cookieJar = list.map((c) => `${c.name}=${c.value}`).join('; ');
      cookieAt = Date.now();
      log(`  · cookie 已就绪（${list.length} 个）`);
    } finally {
      await browser.close().catch(() => {});
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * 兜底：直接在浏览器上下文里用页内 fetch 取数据。
 * 手工同步 cookie 偶尔仍过不去（WAF 还会校验客户端指纹），
 * 而页内 fetch 用的是浏览器自己的会话，实测稳定。
 * 代价是每次要起一个 Chromium（约 2~4s），只给搜索这类低频接口用。
 */
export async function fetchViaBrowser(url, log = () => {}) {
  const browser = await launchBrowser();
  try {
    log('  · 改用浏览器直取 ...');
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page
      .goto('https://www.qimao.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const text = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return r.text();
    }, url);
    const list = await ctx.cookies();
    if (list.length) {
      cookieJar = list.map((c) => `${c.name}=${c.value}`).join('; ');
      cookieAt = Date.now();
    }
    return text;
  } finally {
    await browser.close().catch(() => {});
  }
}

// 反爬挑战页 / 验证页的特征
export const BAD_MARKERS = /arg1=|document\.cookie|\{"l1":|_0x[0-9a-f]{4}|人机验证|访问过于频繁|验证码|captcha/i;
// 页面框架文本（正文不可读时，抓到的都是这些）
export const CHROME_MARKERS = /立即登录|阅读设置|新人注册|举报类型|快捷键指南|全屏模式|下载七猫/;

export function validContent(parsed) {
  const t = (parsed && parsed.content) || '';
  if (t.length < 300) return false;
  if (BAD_MARKERS.test(t.slice(0, 500))) return false;
  if (CHROME_MARKERS.test(t.slice(0, 300))) return false;
  const han = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  return han / t.length > 0.5;
}

export function httpGet(url, { timeout = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      {
        insecureHTTPParser: true,
        timeout,
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.qimao.com/',
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(cookieJar ? { Cookie: cookieJar } : {}),
        },
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          const next = new URL(headers.location, url).toString();
          return resolve(httpGet(next, { timeout, redirects: redirects - 1 }));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

export async function fetchText(
  url,
  { retry = 3, timeout = 15000, log = () => {}, browserFallback = false } = {}
) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      // 优先裸 HTTP：七猫大部分接口（搜索、目录、正文）直接可读，
      // 只有偶发命中 WAF 挑战页时才需要浏览器过一次拿 cookie。
      const text = await httpGet(url, { timeout });
      if (text.includes('id="renderData"')) {
        // cookie 缺失或已过期：强制换一次再重试（内部有节流，不会狂开浏览器）
        await refreshCookies(log, { force: true }).catch((e) =>
          log(`  · 浏览器不可用，跳过 cookie（${e.message.split('\n')[0]}）`)
        );
        await sleep(1000); // 等 WAF cookie 生效
        throw new Error('命中反爬验证页');
      }
      if (!text || text.length < 20) throw new Error(`响应过短 ${text.length}`);
      return text;
    } catch (e) {
      lastErr = e;
      if (i < retry) {
        // 被限流时退避久一点，避免连续触发挑战
        const limited = /验证页|频繁/.test(e.message);
        await sleep(limited ? 1500 * (i + 1) : 600 * (i + 1));
      }
    }
  }

  // cookie 路线彻底走不通时，用浏览器页内 fetch 兜底（只给低频接口开）
  if (browserFallback) {
    try {
      const text = await fetchViaBrowser(url, log);
      if (text && text.length >= 20 && !text.includes('id="renderData"')) return text;
    } catch (e) {
      log(`  · 浏览器直取失败（${String(e.message).split('\n')[0]}）`);
    }
  }

  throw lastErr;
}

// 目录接口：一次拿全（几千章也就 400KB）
export async function fetchToc(bookId, opts = {}) {
  const raw = await fetchText(
    `https://www.qimao.com/qimaoapi/api/book/chapter-list?book_id=${bookId}`,
    opts
  );
  const json = JSON.parse(raw);
  const list = (json && json.data && json.data.chapters) || [];
  if (!list.length) return [];
  return list
    .slice()
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((c, i) => ({
      sourceChapterId: String(c.id),
      title: String(c.title || `第${i + 1}章`).trim(),
      chapterNo: Number(c.index) || i + 1,
      words: Number(c.words) || 0,
      free: String(c.is_vip) === '0',
    }));
}

// 并发池
export async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/**
 * 抓取单本书入库（增量，已存在的章节自动跳过）
 * @param {object} src      数据源（sources.js 中的一项）
 * @param {string} bookId   源站书号
 * @param {object} opts
 * @param {number} opts.maxChapters  本次最多新增章节数
 * @param {number} opts.concurrency  并发数
 * @param {function} opts.onProgress ({done,total,added,failed}) => void
 * @param {function} opts.log
 */
export async function importBook(
  src,
  bookId,
  { maxChapters = 200, concurrency = 6, onProgress, log = () => {} } = {}
) {
  const t0 = Date.now();
  const bookUrl = src.book(bookId);
  const html = await fetchText(bookUrl, { log });
  const info = parseNovelDetail(html, src);
  if (!info.title) throw new Error(`未能解析书名: ${bookUrl}`);

  const novel = await upsertNovel(info, bookId, src.key);
  if (novel.sourceUrl !== bookUrl) {
    try {
      await novel.update({ sourceUrl: bookUrl });
    } catch {
      /* 老库没有该字段时忽略 */
    }
  }

  const toc = await fetchToc(bookId, { log });
  if (!toc.length) throw new Error(`目录为空: ${bookUrl}`);

  const existing = await Chapter.findAll({
    where: { novelId: novel.id },
    attributes: ['sourceChapterId'],
  });
  const have = new Set(existing.map((c) => c.sourceChapterId));

  // 只抓免费章节：目录里 is_vip=1 的章节网页端读不到正文
  const freeList = toc.filter((c) => c.free);
  if (freeList.length < 3) {
    if (!have.size) await novel.destroy();
    throw new Error(`该书免费章节仅 ${freeList.length} 章，暂不支持导入`);
  }

  const todo = freeList.filter((c) => !have.has(c.sourceChapterId)).slice(0, maxChapters);
  if (!todo.length) {
    const total = await Chapter.count({ where: { novelId: novel.id } });
    log(`  · ${info.title}：已是最新（库里 ${have.size} 章 / 免费 ${freeList.length} 章）`);
    return {
      novelId: novel.id,
      title: info.title,
      added: 0,
      failed: 0,
      total,
      sourceTotal: toc.length,
      free: freeList.length,
      unchanged: true,
    };
  }

  // 探一章：确认正文可读，避免把导航栏文案当正文入库
  const probePage = await fetchText(src.chapter(bookId, todo[0].sourceChapterId), { log });
  if (!validContent(parseChapter(probePage, src))) {
    if (!have.size) await novel.destroy();
    throw new Error('正文不可读（VIP/需登录），暂不支持导入');
  }

  let added = 0;
  let failed = 0;
  let done = 0;
  let consecutiveFail = 0;
  let stop = false;

  await pool(todo, concurrency, async (ch) => {
    if (stop) {
      done++;
      return;
    }
    await sleep(20 + Math.random() * 60); // 轻量节流，避免触发反爬
    let parsed = null;
    for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
      try {
        const page = await fetchText(src.chapter(bookId, ch.sourceChapterId), { log });
        const p = parseChapter(page, src);
        if (validContent(p)) parsed = p;
        else if (attempt < 2) await sleep(800 * (attempt + 1) + Math.random() * 400);
      } catch {
        if (attempt < 2) await sleep(600 * (attempt + 1));
      }
    }
    if (!parsed) {
      failed++;
      if (++consecutiveFail >= 20) stop = true;
    } else {
      consecutiveFail = 0;
      if (await saveChapter(novel.id, ch, parsed)) added++;
      else failed++;
    }
    done++;
    if (onProgress) onProgress({ done, total: todo.length, added, failed });
  });

  if (stop) log('  · 连续多章无正文，提前停止（后续章节多为 VIP）');

  const total = await finalizeNovel(novel);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`  · ${info.title}：新增 ${added} 章（失败/空 ${failed}），库内共 ${total} 章，用时 ${secs}s`);
  return {
    novelId: novel.id,
    title: info.title,
    added,
    failed,
    total,
    sourceTotal: toc.length,
    free: freeList.length,
  };
}
