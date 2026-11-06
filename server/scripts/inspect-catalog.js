// 打印 probe.html 里章节链接的真实 DOM 顺序（用于判断目录排序）
// 用法：node scripts/inspect-catalog.js 222767
import fs from 'fs';
import * as cheerio from 'cheerio';

const bookId = process.argv[2] || '222767';
const html = fs.readFileSync('probe.html', 'utf-8');
const $ = cheerio.load(html);
const re = new RegExp(`/shuku/${bookId}-(\\d+)`);

let total = 0;
$('a[href]').each((i, el) => {
  const href = $(el).attr('href') || '';
  if (!re.test(href)) return;
  total++;
  if (total <= 30) {
    console.log(`${total}\t${$(el).text().trim()}\t${href}`);
  }
});

console.log('\n章节链接总数:', total);
console.log('页面含“最新章节”:', html.includes('最新章节'));
console.log('页面含“全部章节”:', html.includes('全部章节'));
console.log('页面含“作品目录”:', html.includes('作品目录'));
