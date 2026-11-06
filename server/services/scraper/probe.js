// 探查脚本：抓取真实页面并打印结构，用于确认真实选择器与链接规则。
// 用法：
//   npm run probe                                  # 探查 .env 源的书库/首页
//   npm run probe -- --source fanqie --url https://fanqienovel.com/library
//   npm run probe -- --source qimao --book-id 12345    # 探查某本书详情页并统计章节链接
//   npm run probe -- --headful                     # 有头（首次过验证）
import fs from 'fs';
import * as cheerio from 'cheerio';
import { fetchPage, closeBrowser } from './browser.js';
import { getSource } from './sources.js';
import { discoverBooks, parseNovelDetail, parseChapterList } from './parser.js';
import { config } from '../../config/index.js';

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const headful = process.argv.includes('--headful');
  const sourceKey = argValue('source') || config.crawl.source;
  const src = getSource(sourceKey);
  const bookId = argValue('book-id');
  const explicitUrl = argValue('url');

  const url =
    explicitUrl ||
    (bookId ? src.book(bookId) : config.crawl.listUrl || src.baseUrl);

  console.log('数据源:', src.key, `(${src.name})`);
  console.log('探查 URL:', url);

  const afterLoad = bookId && src.afterBookLoad ? (page) => src.afterBookLoad(page, bookId) : undefined;
  const html = await fetchPage(url, {
    headless: !headful,
    manualWaitMs: headful ? 120000 : 25000,
    afterLoad,
  });
  console.log('HTML 长度:', html.length);
  fs.writeFileSync('probe.html', html);
  console.log('完整 HTML 已写入 server/probe.html（可用浏览器打开查看）');

  const $ = cheerio.load(html);
  console.log('\n--- 基础信息 ---');
  console.log('title 标签:', $('title').text().trim());
  console.log('h1:', $('h1').first().text().trim());

  console.log('\n--- 书籍发现（列表页） ---');
  const found = discoverBooks(html, src);
  console.log(`按 ${src.discoverSelector} 发现书籍数:`, found.length, found.slice(0, 10));

  console.log('\n--- 详情解析（若这是详情页） ---');
  const info = parseNovelDetail(html, src);
  console.log('书名:', info.title || '(未解析到)');
  console.log('作者:', info.author || '(未解析到)');
  console.log('分类:', info.categoryName || '(未解析到)');
  console.log('简介:', (info.intro || '').slice(0, 80));
  console.log('封面:', info.coverUrl || '(未解析到)');

  console.log('\n--- 章节链接（需 --book-id 才能精确统计） ---');
  if (bookId) {
    const chapters = parseChapterList(html, src, bookId);
    console.log('解析到章节数:', chapters.length);
    chapters.slice(0, 5).forEach((c) => console.log(`  ${c.chapterNo}. ${c.title} (id=${c.sourceChapterId})`));
  } else {
    const totalLinks = $('a[href]').length;
    console.log(`页面共 ${totalLinks} 个链接；加 --book-id 可统计章节链接`);
  }

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('探查失败:', e.message);
  await closeBrowser();
  process.exit(1);
});
