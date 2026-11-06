// 无数据库依赖的自检脚本：node scripts/verify.js
import { t2s } from '../services/scraper/convert.js';
import { getSource } from '../services/scraper/sources.js';
import { parseNovelDetail, parseChapterList, parseChapter } from '../services/scraper/parser.js';
import { codeToOpenid } from '../services/wechat.js';

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('✓', msg);
  else {
    failed++;
    console.error('✗', msg);
  }
}

// 1) 繁简转换
const simplified = t2s('漢字測試 龍鳳 臺灣 小說');
check(simplified === '汉字测试 龙凤 台湾 小说', `繁转简：${simplified}`);

// 2) twkan 详情页解析（繁体 -> 简体）
const twkan = getSource('twkan');
const detailHtml = `<!DOCTYPE html><html><head>
<meta property="og:novel:book_name" content="測試小說" />
<meta property="og:novel:author" content="作者甲乙" />
<meta property="og:description" content="這是一本測試小說的簡介。" />
<meta property="og:novel:category" content="玄幻" />
</head><body>
<div class="bookinfo"><span class="author">作者：作者甲乙</span></div>
<div id="list">
  <dd><a href="/txt/91662/57134352">第1章 開始</a></dd>
  <dd><a href="/txt/91662/57134353">第2章 繼續</a></dd>
</div>
</body></html>`;

const info = parseNovelDetail(detailHtml, twkan);
check(info.title === '测试小说', `书名解析：${info.title}`);
check(info.author === '作者甲乙', `作者解析：${info.author}`);
check(info.categoryName === '玄幻', `分类解析：${info.categoryName}`);

const chapters = parseChapterList(detailHtml, twkan, '91662');
check(chapters.length === 2, `章节数：${chapters.length}`);
check(chapters[0].sourceChapterId === '57134352', `首章ID：${chapters[0].sourceChapterId}`);
check(chapters[0].title === '第1章 开始', `首章标题（简体）：${chapters[0].title}`);

const chapterHtml = `<!DOCTYPE html><html><head><meta property="og:title" content="第1章 開始" /></head>
<body><div id="content"><p>第一段內容。</p><p>第二段內容，龍鳳呈祥。</p></div></body></html>`;
const parsed = parseChapter(chapterHtml, twkan);
check(parsed.title === '第1章 开始', `章节标题：${parsed.title}`);
check(parsed.content.includes('第一段内容。'), '正文段落提取');
check(parsed.content.includes('龙凤呈祥'), '正文繁转简');

// 3) qimao 目录链接识别 + 通用正文启发式
const qimao = getSource('qimao');
const qimaoBookHtml = `<html><body><h1>测试之书</h1>
<div class="chapter-list">
  <a href="/shuku/12345-67890/">第1章 开端</a>
  <a href="/shuku/12345-67891/">第2章 发展</a>
  <a href="/shuku/99999-11111/">无关链接</a>
</div></body></html>`;
const qChapters = parseChapterList(qimaoBookHtml, qimao, '12345');
check(qChapters.length === 2, `qimao 章节数：${qChapters.length}`);
check(qChapters[0].sourceChapterId === '67890', `qimao 首章ID：${qChapters[0].sourceChapterId}`);

// 通用正文：没有命中任何 contentHints，也要能靠“最大汉字块”提取
const genericChapter = `<html><head><title>第3章</title></head><body>
<header><a href="/">首页</a><a href="/rank">排行</a></header>
<div class="main"><div class="article">
<p>这是测试正文的第一段，包含足够多的中文字符以便启发式命中内容区域。</p>
<p>这是测试正文的第二段，继续补充一些中文字符，确保正文块明显大于导航区域。</p>
</div></div>
<footer>版权所有 示例站点</footer></body></html>`;
const gParsed = parseChapter(genericChapter, { ...qimao, contentHints: [] });
check(gParsed.content.includes('这是测试正文的第一段'), '通用正文启发式提取');

// 4) mock 登录 openid 稳定
const openid = await codeToOpenid('abc', 'dev_stable');
check(openid === 'mock_dev_stable', `mock openid：${openid}`);

// 5) 模型与 Playwright 模块可加载（不连接数据库、不启动浏览器）
try {
  const { sequelize } = await import('../models/index.js');
  check(!!sequelize, 'Sequelize 模型模块加载');
} catch (e) {
  check(false, `Sequelize 模型模块加载：${e.message}`);
}

try {
  await import('../services/scraper/browser.js');
  check(true, 'Playwright 爬虫模块加载');
} catch (e) {
  check(false, `Playwright 爬虫模块加载：${e.message}`);
}

console.log('\n' + (failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`));
process.exit(failed === 0 ? 0 : 1);
