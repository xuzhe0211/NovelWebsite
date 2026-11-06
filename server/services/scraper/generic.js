// 通用站点抓取：用户粘贴任意小说站链接时，用通用启发式解析详情/目录/正文
// ------------------------------------------------------------
// 已知站点（七猫/番茄）走各自适配器；这里兜底「其他网站」：
//   · 详情：og 标签 + 通用选择器 + 启发式
//   · 目录：从页面所有链接里挑「第N章」形状的，同域、去重、按序号或 DOM 顺序
//   · 正文：常见正文容器 + 「汉字最多的块 - 链接惩罚」兜底（parser.js 已有）
// 支持 GBK/GB2312 站点（不少老站点仍是 GBK）。
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import net from 'node:net';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { parseNovelDetail, parseChapter } from './parser.js';
import { upsertNovel, saveChapter, finalizeNovel } from './index.js';
import { resolveUrl } from './sources.js';
import { fetchBytesViaBrowser } from './browser.js';
import { Novel, Chapter } from '../../models/index.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 通用选择器提示（站点改版/杂牌站大多能被这些命中）
export const GENERIC_SOURCE = {
  key: 'web',
  name: '第三方站点',
  baseUrl: '',
  contentHints: [
    '#content', '#chaptercontent', '#chapterContent', '#booktxt', '#txtContent', '#htmlContent',
    '.read-content', '.article-content', '.chapter-content', '.content_read', '.showtxt',
    '.neirong', '.txt', 'article', '.content',
  ],
  titleHints: [
    'meta[property="og:novel:book_name"]', 'meta[property="og:title"]',
    '.book-info h1', '.bookname h1', '.book-name', 'h1',
  ],
  authorHints: [
    'meta[property="og:novel:author"]', '.book-info .author', '.author', '.bookinfo .author', '#info p',
  ],
  introHints: [
    'meta[property="og:description"]', '#intro', '.intro', '.book-intro', '.bookintro', '.desc', '#desc',
  ],
  coverHints: [
    'meta[property="og:image"]', '.book-cover img', '.cover img', '.book-img img', '.bookinfo img',
  ],
  categoryHints: ['meta[property="og:novel:category"]', '.category', '.tags a', '.breadcrumb a'],
};

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local')) return true;
  const ip = net.isIP(h);
  if (!ip) return false;
  if (ip === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  const p = h.split('.').map(Number);
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] === 0
  );
}

function decodeBody(buf, contentType = '') {
  let charset = (contentType.match(/charset=([\w-]+)/i) || [])[1] || '';
  if (!charset) {
    const head = buf.slice(0, 2048).toString('latin1');
    charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || '';
  }
  charset = String(charset).toLowerCase();
  if (!charset || charset === 'utf-8' || charset === 'utf8') return buf.toString('utf8');
  try {
    return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 抓取 HTML（自动解压 + 编码识别 + 跳转跟随） */
function httpFetchHtml(url, { timeout = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error('链接格式不正确'));
    }
    if (!/^https?:$/.test(target.protocol)) return reject(new Error('只支持 http/https 链接'));
    if (isPrivateHost(target.hostname)) return reject(new Error('不支持内网地址'));

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(
      target,
      {
        insecureHTTPParser: true,
        timeout,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          const next = new URL(headers.location, url).toString();
          return resolve(httpFetchHtml(next, { timeout, redirects: redirects - 1 }));
        }
        if (statusCode !== 200) {
          res.resume();
          const err = new Error(`站点返回 HTTP ${statusCode}`);
          err.status = statusCode;
          return reject(err);
        }
        const enc = String(headers['content-encoding'] || '').toLowerCase();
        const stream =
          enc === 'gzip' ? res.pipe(zlib.createGunzip())
          : enc === 'deflate' ? res.pipe(zlib.createInflate())
          : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
          : res;
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          if (size > 6 * 1024 * 1024) {
            req.destroy(new Error('页面过大'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve(decodeBody(Buffer.concat(chunks), headers['content-type'])));
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 站点拦截/挑战页特征：内容过短，或命中 Cloudflare 等人机验证页
const BLOCK_MARKERS =
  /Just a moment|cf-mitigated|__cf_chl|Attention Required|Enable JavaScript and cookies|Please verify you are a human|人机验证|访问过于频繁|安全验证/i;

function looksBlocked(html) {
  const t = String(html || '');
  if (t.trim().length < 300) return true;
  return BLOCK_MARKERS.test(t.slice(0, 3000));
}

/**
 * 抓取 HTML：先走裸 HTTP（快），遇到 TLS 指纹拦截/人机验证页再用浏览器兜底。
 * 69shuba 这类站点对 Node/curl 一律 403，但浏览器正常，只能走第二条路。
 */
export async function fetchHtml(url, { timeout = 15000, redirects = 3, browser = true } = {}) {
  let html = '';
  try {
    html = await httpFetchHtml(url, { timeout, redirects });
    if (!looksBlocked(html)) return html;
  } catch (e) {
    if (!browser) throw e;
  }
  if (!browser) throw new Error('页面被站点拦截');

  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error('链接格式不正确');
  }
  if (isPrivateHost(target.hostname)) throw new Error('不支持内网地址');

  const buf = await fetchBytesViaBrowser(url);
  const viaBrowser = decodeBody(buf, '');
  if (looksBlocked(viaBrowser)) {
    throw new Error(html ? '页面被站点拦截（需要人机验证）' : '页面内容为空，可能被站点拦截');
  }
  return viaBrowser;
}

const CHAPTER_TITLE = /第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回]|^\s*\d{1,5}\s*[\.、:：]|序章|楔子|番外/;

function cleanText(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s·•\-|]+|[\s·•\-|]+$/g, '')
    .trim();
}

function chapterNumOf(title) {
  const m = String(title).match(/第\s*([0-9零一二三四五六七八九十百千万两]+)\s*[章节回]/);
  if (!m) return null;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  return cnToNum(raw);
}

// 中文数字转阿拉伯数字（支持到亿），用于章节排序
function cnToNum(s) {
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of String(s)) {
    if (digits[ch] !== undefined) {
      num = digits[ch];
    } else if (units[ch]) {
      if (num === 0) num = 1;
      section += num * units[ch];
      num = 0;
    } else if (ch === '万') {
      section += num;
      total += section * 10000;
      section = 0;
      num = 0;
    } else if (ch === '亿') {
      total = (total + section) * 100000000;
      section = 0;
      num = 0;
    }
  }
  const val = total + section + num;
  return val > 0 ? val : null;
}

/** 从页面里挑章节链接（同域、去重） */
export function findChapterLinks(html, pageUrl, { limit = 3000 } = {}) {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const seen = new Set();
  const items = [];

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (!href || /^javascript:|^#/.test(href)) return;
    const title = cleanText($(el).attr('title') || '') || cleanText($(el).text());
    if (!title || title.length > 60) return;
    if (!CHAPTER_TITLE.test(title)) return;
    let abs;
    try {
      abs = resolveUrl(href, pageUrl);
      const u = new URL(abs);
      if (u.host !== base.host) return;
      if (u.pathname === base.pathname) return;
      u.hash = '';
      abs = u.toString();
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    items.push({ url: abs, title, num: chapterNumOf(title), pos: i });
  });

  // 有明显编号时按编号排序（抵消「最新章节」区块在顶部的乱序），否则用 DOM 顺序
  const numbered = items.filter((x) => x.num !== null).length;
  const list =
    numbered >= items.length * 0.6
      ? items.slice().sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.pos - b.pos)
      : items.slice().sort((a, b) => a.pos - b.pos);

  return list.slice(0, limit).map((it, i) => ({
    url: it.url,
    title: it.title,
    // 排序后的数组顺序即阅读顺序（番外等无编号章节按位置落到末尾）
    chapterNo: i + 1,
  }));
}

/** 找目录页（有些站点详情页只放“最新章节”，目录在单独页面） */
function findCatalogUrl(html, pageUrl) {
  const $ = cheerio.load(html);
  let hit = '';
  $('a[href]').each((i, el) => {
    if (hit) return;
    const t = cleanText($(el).text());
    if (!/^(目录|章节目录|全部章节|查看目录|章节列表|开始阅读)$/.test(t)) return;
    try {
      hit = resolveUrl($(el).attr('href'), pageUrl);
    } catch {
      /* ignore */
    }
  });
  return hit;
}

/** 清理书名上的站点修饰词：「凡人修仙传最新章节列表」→「凡人修仙传」 */
export function cleanBookTitle(raw) {
  let t = cleanText(raw);
  t = t.split(/[,，]/)[0]; // 有的站 title 是「书名,书名最新章节阅读-站名」
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t
      .replace(/[（(【\[]?(?:最新章节列表|最新章节|章节目录|目录列表|全文阅读|无弹窗|免费阅读|txt下载|txt全集下载|在线阅读)[）)】\]]?$/i, '')
      .replace(/\s*[-_|｜]\s*[^-_|｜]{1,20}$/, '') // 尾部「-69书吧」
      .replace(/^(?:最新章节|章节目录)[：:]\s*/, '')
      .trim();
    if (t === before) break;
  }
  // 兜底：只在剩余长度够时才去尾部站点名，避免把短书名截没
  if (t.length > 12 && /[-_|｜]/.test(t)) t = t.split(/[-_|｜]/)[0].trim();
  return t || cleanText(raw);
}

/** 该页看着像目录/章节列表页（标题带「最新章节」或没有作者信息） */
function looksLikeCatalogPage(info, chapterCount) {
  if (chapterCount < 3) return false;
  if (/最新章节|章节目录|目录|章节列表/.test(String(info.title || ''))) return true;
  return !info.author || !info.intro;
}

/** 从目录页找对应的书籍详情页候选 */
function detailCandidates(html, pageUrl) {
  const out = [];
  const push = (u) => {
    if (!u) return;
    try {
      const abs = new URL(resolveUrl(u, pageUrl)).toString();
      const base = new URL(pageUrl);
      if (new URL(abs).host !== base.host) return;
      if (abs === pageUrl || out.includes(abs)) return;
      out.push(abs);
    } catch {
      /* ignore */
    }
  };

  const $ = cheerio.load(html);
  // 1) 标题里常常直接链到详情页：<h1><a href="/book/1234.htm">书名最新章节</a></h1>
  $('h1 a[href]').each((i, el) => push($(el).attr('href')));
  // 2) 目录页 ↔ 详情页互转：/book/1234/ ⇄ /book/1234.htm
  const u = new URL(pageUrl);
  if (/\/book\/\w+\/?$/.test(u.pathname)) push(u.pathname.replace(/\/$/, '.htm'));
  else if (/\/book\/\w+\.s?html?$/.test(u.pathname)) push(u.pathname.replace(/\.s?html?$/, '/'));
  return out.slice(0, 3);
}

/** 同一本书的其他常见写法（有的站 /book/1 404 但 /book/1/ 正常，反之亦然） */
function urlVariants(raw) {
  const out = [];
  try {
    const x = new URL(raw);
    const p = x.pathname;
    const push = (path) => {
      const c = new URL(x.toString());
      c.pathname = path;
      const s = c.toString();
      if (s !== raw && !out.includes(s)) out.push(s);
    };
    if (/\.s?html?$/i.test(p)) {
      push(p.replace(/\.s?html?$/i, '/'));
      push(p.replace(/\.s?html?$/i, ''));
    } else if (p.endsWith('/')) {
      push(p.replace(/\/+$/, ''));
      push(p.replace(/\/+$/, '.htm'));
    } else {
      push(`${p}/`);
      push(`${p}.htm`);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 解析任意站点的一本书：详情 + 目录 */
export async function resolveGenericBook(url) {
  let pageUrl = url;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    // 链接少写/多写斜杠时部分站点直接 404，换写法再试
    for (const v of urlVariants(url)) {
      try {
        html = await fetchHtml(v);
        pageUrl = v;
        break;
      } catch {
        /* 下一个 */
      }
    }
    if (!html) throw err;
  }
  if (html.length < 500) throw new Error('页面内容为空，可能被站点拦截');

  let info = parseNovelDetail(html, GENERIC_SOURCE);
  if (info.title) info.title = cleanBookTitle(info.title);
  if (!info.title) {
    const og = cheerio.load(html)('title').text();
    info.title = cleanBookTitle(og);
  }
  if (!info.title) throw new Error('未能识别书名，请确认这是书籍详情页');

  let chapters = findChapterLinks(html, pageUrl);

  // 用户贴的可能是「目录页」，详情（作者/简介/分类）在另一个地址，反之亦然：
  // 两个方向都试一次，信息取更全的、目录取更长的。
  if (looksLikeCatalogPage(info, chapters.length) || chapters.length < 20) {
    for (const cand of detailCandidates(html, pageUrl)) {
      try {
        const detailHtml = await fetchHtml(cand);
        if (detailHtml.length < 500) continue;
        const dInfo = parseNovelDetail(detailHtml, GENERIC_SOURCE);
        const dChapters = findChapterLinks(detailHtml, cand);
        if (!dInfo.title && !dChapters.length) continue;
        if (dInfo.title) dInfo.title = cleanBookTitle(dInfo.title);

        const merged = { ...info };
        for (const k of ['author', 'intro', 'categoryName', 'isCompleted', 'coverUrl', 'wordCount']) {
          if (dInfo[k]) merged[k] = dInfo[k];
        }
        // 书名取更短更干净的（详情页通常没有「最新章节」后缀）
        if (dInfo.title && (!info.title || dInfo.title.length <= info.title.length)) {
          merged.title = dInfo.title;
        }
        info = merged;
        if (dChapters.length > chapters.length) chapters = dChapters;
      } catch {
        /* 换下一个候选 */
      }
    }
  }

  // 第三方站点常给相对路径，按页面地址补全
  if (info.coverUrl && !/^https?:/i.test(info.coverUrl)) {
    info.coverUrl = resolveUrl(info.coverUrl, pageUrl);
  }
  // 站点「暂无封面」占位图清掉，前端会走渐变封面兜底
  if (info.coverUrl && isPlaceholderCover(info.coverUrl)) info.coverUrl = '';

  let catalogUrl = '';

  // 详情页章节太少 → 试目录页
  if (chapters.length < 3) {
    catalogUrl = findCatalogUrl(html, pageUrl);
    if (catalogUrl) {
      const catalogHtml = await fetchHtml(catalogUrl);
      const more = findChapterLinks(catalogHtml, catalogUrl);
      if (more.length > chapters.length) chapters = more;
    }
  }

  return { info, chapters, pageUrl, catalogUrl };
}

/** 正文字数与汉字占比校验 */
function validChapter(parsed) {
  const t = (parsed && parsed.content) || '';
  if (t.length < 200) return false;
  const han = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  return han / t.length > 0.5;
}

/** 去掉正文首尾的站点套话：章节标题、日期、作者、本章完 等 */
export function trimChapterNoise(content, title) {
  let lines = String(content || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const norm = (s) => String(s).replace(/[\s\u3000]/g, '');
  const t = norm(title || '');

  const isHeadLine = (l) => {
    const n = norm(l);
    if (!n) return true;
    if (t && (n === t || n === `正文${t}` || n === `${t}正文`)) return true;
    if (/^\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}/.test(l)) return true; // 更新日期
    if (/^作\s*者[:：]/.test(n)) return true;
    if (/^字\s*数[:：]/.test(n)) return true;
    // 「第1章」这类标题片段
    if (n.length <= 12 && t.includes(n) && /第\s*[0-9零一二三四五六七八九十百千万两]+/.test(n)) return true;
    return false;
  };

  let head = 0;
  while (head < lines.length && head < 8 && isHeadLine(lines[head])) head++;
  if (head > 0 && lines.length - head >= 8) lines = lines.slice(head);

  const TAIL = /^[（(【\[]?\s*(本章完|本章结束|未完待续|全文完|本章未完[^）)】\]]*)\s*[）)】\]]?$/;
  while (lines.length && TAIL.test(lines[lines.length - 1])) lines.pop();

  return lines.join('\n');
}

/** 站点「无封面」占位图，别当真封面入库 */
export function isPlaceholderCover(url) {
  return /(^|\/)(nc|no[-_]?image|no[-_]?cover|nopic|nocover|default|blank|loading)\.(jpe?g|png|gif|webp)$/i.test(
    String(url || '')
  );
}

// 不少站点把正文用 JS 混淆输出，纯 HTML 取不到：
//   document.write(decodeURIComponent('%3Cp%3E'))  → URL 编码
// 这里在解析前把这些片段还原成真实 HTML。
export function expandObfuscated(html) {
  let out = String(html || '');
  const parts = [];

  const collect = (text) => {
    if (!text || !/[\u4e00-\u9fa5<>]/.test(text)) return false;
    parts.push(text);
    return true;
  };

  out = out.replace(
    /document\.writeln?\(\s*[\w$]+\.[\w$]+\(\s*['"]([A-Za-z0-9+/=\s]{24,})['"]\s*\)\s*\)/g,
    (m, b64) => {
      try {
        const text = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8');
        return collect(text) ? '' : m;
      } catch {
        return m;
      }
    }
  );

  out = out.replace(
    /document\.writeln?\(\s*(?:decodeURIComponent|unescape)\(\s*['"]([^'"]{20,})['"]\s*\)\s*\)/g,
    (m, enc) => {
      try {
        return collect(decodeURIComponent(enc)) ? '' : m;
      } catch {
        return m;
      }
    }
  );

  // 解出来的正文原本在 <script> 里，直接内联会被解析器当脚本清掉，
  // 统一挂到 body 末尾的独立容器里，交给正文启发式挑中。
  if (parts.length) {
    const block = `<div id="__decoded_body__">${parts.join('')}</div>`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${block}</body>`) : out + block;
  }

  return { html: out, hit: parts.length };
}

function sid(str) {
  return createHash('sha1').update(String(str)).digest('hex').slice(0, 24);
}

/**
 * 归一化书籍链接：同一个站的同一本书常有多种写法
 *   /book/1296/  ·  /book/1296.htm  ·  /book/1296.html  ·  大小写 host
 * 归一后 `.../book/1296`，保证几种写法指向同一条书库记录。
 */
export function normalizeBookUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    u.host = u.host.toLowerCase();
    u.hash = '';
    const path = u.pathname.replace(/\.s?html?$/i, '').replace(/\/+$/, '');
    u.pathname = path || '/';
    return u.toString();
  } catch {
    return String(raw || '');
  }
}

/** 第三方站点的书籍标识：由链接哈希得到，稳定且不会超过 sourceId 长度限制 */
export const genericBookId = (url) => sid(normalizeBookUrl(url));

/** 历史数据用的旧标识：把同一本书的各种写法都算一遍，查重时一并匹配，避免重复建书 */
export function genericBookIdAliases(url) {
  const raw = String(url || '').trim();
  const forms = new Set([raw, normalizeBookUrl(raw)]);
  try {
    const u = new URL(raw);
    const p = u.pathname || '/';
    const variant = (path) => {
      const c = new URL(u.toString());
      c.pathname = path;
      forms.add(c.toString());
    };
    if (/\.s?html?$/i.test(p)) {
      const bare = p.replace(/\.s?html?$/i, '');
      variant(bare);
      variant(`${bare}/`);
    } else if (p.endsWith('/')) {
      const bare = p.replace(/\/+$/, '');
      variant(bare);
      variant(`${bare}.htm`);
    } else {
      variant(`${p}/`);
      variant(`${p}.htm`);
    }
  } catch {
    /* ignore */
  }
  const ids = [...forms].filter(Boolean).map((f) => sid(f));
  return [...new Set(ids)];
}

/**
 * 把任意站点的一本书抓进本地书库
 * @param {string} url 书籍详情页地址
 * @param {object} opts { maxChapters, concurrency, onProgress, log, bookId }
 *        bookId：指定写入哪条书库记录（继续补章时用，避免同一本书因链接写法不同被拆成两条）
 */
export async function importGeneric(
  url,
  { maxChapters = 30, concurrency = 3, onProgress, log = () => {}, bookId: forcedBookId = '' } = {}
) {
  const t0 = Date.now();
  const { info, chapters, catalogUrl } = await resolveGenericBook(url);
  if (!chapters.length) throw new Error('没有识别到章节链接，请换成该站的书本详情页或目录页');

  // 同一个站的同一本书可能被贴过不同写法的链接，先按旧标识找已存在的记录，避免重复建书
  let bookId = forcedBookId || genericBookId(url);
  if (forcedBookId) {
    // 继续补章时链接由用户提供，先确认抓到的确实是同一本书，别把别的内容写进这条记录
    const target = await Novel.findOne({
      where: { sourceId: `web:${forcedBookId}` },
      attributes: ['id', 'title'],
    });
    const norm = (s) => String(s || '').replace(/[\s《》〈〉「」【】\-—_·.,，。:：;；()（）\[\]]/g, '');
    const a = norm(target && target.title);
    const b = norm(info.title);
    if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
      throw new Error(`链接对应的是《${info.title}》，与当前书籍《${target.title}》不一致`);
    }
  } else {
    const aliasIds = genericBookIdAliases(url).map((id) => `web:${id}`);
    const found = await Novel.findOne({ where: { sourceId: aliasIds }, attributes: ['id', 'sourceId'] });
    if (found) bookId = String(found.sourceId).replace(/^web:/, '');
  }

  const novel = await upsertNovel(info, bookId, 'web');

  // 记住源站链接：下次「继续补章」不用再让用户粘贴
  const canonicalUrl = normalizeBookUrl(url);
  if (canonicalUrl && novel.sourceUrl !== canonicalUrl) {
    try {
      await novel.update({ sourceUrl: canonicalUrl });
    } catch {
      /* 老库没有该字段时忽略，不影响抓取 */
    }
  }

  const existing = await Chapter.findAll({
    where: { novelId: novel.id },
    attributes: ['sourceChapterId'],
  });
  const have = new Set(existing.map((c) => c.sourceChapterId));

  const todo = chapters.filter((c) => !have.has(sid(c.url))).slice(0, maxChapters);
  if (!todo.length) {
    const total = await Chapter.count({ where: { novelId: novel.id } });
    return {
      novelId: novel.id,
      title: info.title,
      added: 0,
      failed: 0,
      total,
      sourceTotal: chapters.length,
      free: chapters.length,
      unchanged: true,
    };
  }

  let added = 0;
  let failed = 0;
  let done = 0;
  let consecutiveFail = 0;
  let stop = false;
  let cursor = 0;
  const requeued = new Map(); // url -> 已重排次数（限流时放回队尾，最多两次）

  // 站点软限流：69shuba 连续抓约 30 章后就开始返回 429。
  // 用「全局最小间隔 + 命中限流后全体冷却」的节流器，让大批次（100/200 章）也能慢慢抓完。
  const BASE_INTERVAL = 260;
  let intervalMs = BASE_INTERVAL;
  let gateUntil = 0;
  let nextSlot = 0;
  let rateHits = 0;
  let okStreak = 0;
  let lastLimitAt = 0;

  const acquireSlot = async () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot, gateUntil);
    nextSlot = slot + intervalMs;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  };

  const noteRateLimit = () => {
    const now = Date.now();
    // 多个并发 worker 同时撞上限流时只算一次，否则冷却时间会被瞬间叠满
    if (now - lastLimitAt < 1500) return;
    lastLimitAt = now;
    rateHits = Math.min(3, rateHits + 1);
    okStreak = 0;
    intervalMs = Math.min(2200, Math.round(intervalMs * 1.5));
    // 冷却窗口逐次加长：6s → 12s → 20s
    const cooldown = Math.min(20000, 6000 * 2 ** (rateHits - 1));
    gateUntil = Math.max(gateUntil, now + cooldown);
    log(`  · 站点限流，暂停 ${Math.round(cooldown / 1000)}s 后继续（间隔 ${intervalMs}ms）`);
  };

  const noteOk = () => {
    okStreak++;
    if (okStreak >= 5 && rateHits > 0) rateHits = 0;
    // 连续成功 20 次才慢慢提速，避免刚恢复就再次撞限流
    if (okStreak % 20 === 0 && intervalMs > BASE_INTERVAL) {
      intervalMs = Math.max(BASE_INTERVAL, intervalMs - 100);
    }
  };

  const MAX_ATTEMPTS = 4;

  const worker = async () => {
    while (cursor < todo.length && !stop) {
      const ch = todo[cursor++];
      let parsed = null;
      let reason = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !parsed; attempt++) {
        await acquireSlot();
        try {
          const rawHtml = await fetchHtml(ch.url);
          const { html } = expandObfuscated(rawHtml);
          const p = parseChapter(html, GENERIC_SOURCE);
          // 目录里的标题比页面 h1（常常是站点 logo）更可靠
          const cleaned = trimChapterNoise(p.content, ch.title || p.title);
          const withClean = {
            title: ch.title || p.title,
            content: cleaned || p.content,
            wordCount: (cleaned || p.content).replace(/\s/g, '').length,
          };
          if (validChapter(withClean)) {
            parsed = withClean;
            noteOk();
          } else {
            reason = '正文为空或过短';
            if (attempt === 0) await sleep(500);
          }
        } catch (e) {
          reason = (e && e.message ? e.message : String(e)).slice(0, 80);
          if (/429|too many requests|访问过于频繁/i.test(reason)) noteRateLimit();
          else if (attempt < MAX_ATTEMPTS - 1) await sleep(400 + attempt * 500);
        }
      }
      if (!parsed) {
        // 纯限流导致的失败不算「抓不到」：把它放回队尾，等冷却结束再抓
        const tries = requeued.get(ch.url) || 0;
        if (/429|too many requests|访问过于频繁/i.test(reason) && tries < 2) {
          requeued.set(ch.url, tries + 1);
          todo.push(ch);
          continue;
        }
        failed++;
        consecutiveFail++;
        // 连续失败多半是还在限流期：退避一会儿再看，别把整批都撞死
        if (consecutiveFail >= 2) await sleep(Math.min(6000, 800 * consecutiveFail));
        if (consecutiveFail >= 8) {
          stop = true;
          log(`  · 连续 ${consecutiveFail} 章抓不到正文，提前停止${reason ? `（${reason}）` : ''}`);
        }
      } else {
        consecutiveFail = 0;
        const ok = await saveChapter(
          novel.id,
          { sourceChapterId: sid(ch.url), chapterNo: ch.chapterNo, title: ch.title },
          parsed
        );
        if (ok) added++;
        else failed++;
      }
      done++;
      if (onProgress) onProgress({ done, total: todo.length, added, failed });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  const total = await finalizeNovel(novel);
  log(`  · ${info.title}（${new URL(url).host}）：新增 ${added} 章，库内 ${total} 章，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    novelId: novel.id,
    title: info.title,
    added,
    failed,
    total,
    sourceTotal: chapters.length,
    free: chapters.length,
    catalogUrl,
  };
}

/** 仅解析不入库（详情预览用） */
export async function previewGenericBook(url) {
  const { info, chapters, catalogUrl } = await resolveGenericBook(url);
  return { info, chapters, catalogUrl };
}
