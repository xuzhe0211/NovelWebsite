import * as cheerio from 'cheerio';
import { t2s, normalizeText, stripLabel } from './convert.js';
import { resolveUrl } from './sources.js';

const HAN = /[一-龥]/g;
function countHan(s) {
  return (String(s).match(HAN) || []).length;
}

// 常见噪声行（站点广告、导航）
const NOISE = /请记住本站|请收藏本站|最新网址|本站域名|章节错误|点击举报|上一章|下一章|返回目录|加入书签|加入书架|手机阅读|一秒记住|笔趣阁|本章未完|请翻页|下载客户端/;

function pickText($, hints) {
  for (const sel of hints) {
    const el = $(sel).first();
    if (!el || !el.length) continue;
    const v = sel.startsWith('meta') ? el.attr('content') : el.text();
    if (v && v.trim()) return v.trim();
  }
  return '';
}

function pickImage($, hints) {
  for (const sel of hints) {
    const el = $(sel).first();
    if (!el || !el.length) continue;
    const v = sel.startsWith('meta')
      ? el.attr('content')
      : el.attr('src') || el.attr('data-src') || el.attr('data-original') || el.attr('data-lazy-src');
    if (v && v.trim()) return v.trim();
  }
  return '';
}

// 清理标题里常见的站点后缀
function cleanTitleSuffix(title) {
  return String(title || '')
    .replace(/\s*[-_|｜]\s*[^-_|｜]{0,20}?(小说|小说网|免费阅读|官网|全文阅读).*$/, '')
    .trim();
}

// 解析小说详情
export function parseNovelDetail(html, source) {
  const $ = cheerio.load(html);

  let title = t2s(pickText($, source.titleHints));
  if (!title) title = t2s($('meta[property="og:title"]').attr('content') || '');
  if (!title) title = t2s(cleanTitleSuffix($('title').text()));
  title = cleanTitleSuffix(title);

  let author = stripLabel(pickText($, source.authorHints), ['作者', '作家']);
  if (!author) {
    const m = $('body').text().match(/作\s*者[:：]\s*([^\s|｜]{1,20})/);
    if (m) author = m[1];
  }
  author = t2s(author);

  let intro = stripLabel(pickText($, source.introHints), ['简介', '内容简介', '作品简介', '书籍简介']);
  if (!intro) {
    intro =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      '';
  }
  // 七猫 meta 形如 “《书名》主角：A,B简介：正文…”，截取“简介：”之后
  const introMark = intro.indexOf('简介：');
  if (introMark >= 0) intro = intro.slice(introMark + 3);
  intro = t2s(intro).replace(/\s+/g, ' ').trim();
  if (intro.length > 1200) intro = intro.slice(0, 1200);

  let coverUrl = pickImage($, source.coverHints);
  if (coverUrl) coverUrl = resolveUrl(coverUrl, source.baseUrl);

  const categoryHints =
    source.categoryHints || ['.category', '.tags a', '.book-tags a', 'meta[property="og:novel:category"]'];
  const categoryName = t2s(stripLabel(pickText($, categoryHints), ['分类', '类别', '类型']));

  // 状态判断：优先看书名区域的标签，避免被推荐位/页脚里的“完结”误伤
  const statusScope = $('.tags-wrap, .book-tags, .book-status, .book-info, .book-detail-header').text() || '';
  let isCompleted;
  if (/连载中|连载/.test(statusScope)) isCompleted = false;
  else if (/已完结|完结|完本/.test(statusScope)) isCompleted = true;
  else {
    const bodyText = $('body').text();
    isCompleted = /已完结|完结|完本/.test(bodyText) && !/连载中/.test(bodyText);
  }

  return {
    title,
    author,
    intro,
    coverUrl,
    categoryName,
    isCompleted,
    status: isCompleted ? '完结' : '连载中',
  };
}

// 解析章节目录
export function parseChapterList(html, source, bookId) {
  const $ = cheerio.load(html);
  const items = [];

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const chapterId = source.chapterIdFromHref(href, bookId);
    if (!chapterId) return;
    const raw = normalizeText($(el).text());
    if (!raw) return;
    if (/^(首页|书架|排行|分类|登录|注册|目录|更多|查看更多)$/.test(raw)) return;
    items.push({ id: chapterId, raw });
  });

  // 去重：保留“最后一次出现”的位置（可跳过目录顶部“最新章节”重复块），标题取更长者
  const pos = new Map();
  const raw = new Map();
  items.forEach((it, idx) => {
    pos.set(it.id, idx);
    const prevRaw = raw.get(it.id) || '';
    if (it.raw.length > prevRaw.length) raw.set(it.id, it.raw);
  });
  let list = [...pos.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => ({ id, raw: raw.get(id) }));

  // 目录顺序：默认信任站点目录 DOM 顺序；sortChapters==='number' 时按“第N章”排序
  if (source.sortChapters === 'number' && list.length) {
    const numOf = (t) => {
      const m = t.match(/第\s*(\d+)\s*[章回节]/);
      return m ? Number(m[1]) : null;
    };
    const withNum = list.map((it) => ({ ...it, num: numOf(it.raw) }));
    const numbered = withNum.filter((x) => x.num !== null).length;
    if (numbered >= list.length * 0.5) {
      list = withNum.sort(
        (a, b) => (a.num ?? Number.MAX_SAFE_INTEGER) - (b.num ?? Number.MAX_SAFE_INTEGER)
      );
    }
  }

  return list.map((it, i) => ({
    sourceChapterId: it.id,
    title: t2s(it.raw) || `第${i + 1}章`,
    chapterNo: i + 1,
  }));
}

// 从正文容器提取段落
function extractParagraphs($, $el) {
  $el.find('script,style,ins,iframe,noscript').remove();
  $el.find('a').each((i, a) => {
    const t = $(a).text();
    if (/广告|最新|举报|收藏|网址|记住|下载/.test(t)) $(a).remove();
  });

  const ps = [];
  $el.find('p').each((i, p) => {
    const t = normalizeText($(p).text());
    if (t && !NOISE.test(t)) ps.push(t);
  });
  if (ps.length) return ps;

  // 回退：按 br / 块结束标签切分
  let h = $el.html() || '';
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|li|h\d)>/gi, '\n');
  // 注意：必须取第一个 div。选择器 $('div') 会匹配所有层级，
  // 嵌套 div 的文本会被重复拼接（69shuba 这类站点正文会变成 3 份）。
  const text = cheerio.load(`<div>${h}</div>`)('div').first().text();
  return text
    .split('\n')
    .map((l) => normalizeText(l))
    .filter((l) => l && !NOISE.test(l));
}

// 找正文容器：优先源提示，其次“汉字最多的块 - 链接汉字惩罚”
function findContent($, source) {
  for (const sel of source.contentHints) {
    const el = $(sel).first();
    if (el.length && countHan(el.text()) > 200) return el;
  }

  $('script,style,noscript,iframe,ins,nav,header,footer,form,aside').remove();
  let best = null;
  let bestScore = 0;
  $('div,article,section,main').each((i, el) => {
    const $el = $(el);
    const zh = countHan($el.text());
    if (zh < 120) return;
    const linkZh = countHan($el.find('a').text());
    const score = zh - linkZh * 4;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  });
  return best ? $(best) : $('body');
}

// 解析章节正文
export function parseChapter(html, source) {
  const $ = cheerio.load(html);
  const rawTitle = pickText($, ['h1', 'meta[property="og:title"]', '.chapter-title', '.title', '.bookname h1']);
  const contentEl = findContent($, source);
  const paras = extractParagraphs($, contentEl);
  const content = paras.map((p) => t2s(p)).filter(Boolean).join('\n');
  return {
    title: t2s(rawTitle),
    content,
    wordCount: content.replace(/\s/g, '').length,
  };
}

// 从列表页发现书籍ID
export function discoverBooks(html, source) {
  const $ = cheerio.load(html);
  const ids = [];
  const seen = new Set();
  $(source.discoverSelector).each((i, el) => {
    const href = $(el).attr('href') || '';
    const id = source.bookIdFromHref(href);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}
