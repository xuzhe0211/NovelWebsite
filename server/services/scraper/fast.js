// 高速抓取器（命令行）：目录走站点接口，正文走并发 HTTP（不开浏览器）
//
//   node services/scraper/fast.js --books 20 --chapters 200   # 补 20 本新书，每本最多新增 200 章
//   node services/scraper/fast.js --chapters 300              # 只给库里已有的书补章节
//   node services/scraper/fast.js --ids 1809361,216404 --chapters 100
//
// 与 run.js 的区别：run.js 用 Playwright 逐章打开页面（约 2.5s/章），
// 这里用并发 HTTP 拉取（约 0.35s/章），且目录一次请求拿全。
// 抓取核心已抽到 qimao-fetch.js，与 services/online.js（小程序联网搜索）共用。
import sequelizePkg from 'sequelize';
import { Novel, sequelize } from '../../models/index.js';
import { config } from '../../config/index.js';
import { getSource } from './sources.js';
import { discoverBooks } from './parser.js';
import { fetchText, importBook, sleep } from './qimao-fetch.js';
import { cacheClear } from '../cache.js';

const { Op } = sequelizePkg;
const log = (...a) => console.log(...a);

// 默认发现书源：男频/女频 × 完结/人气/新书榜单（均为服务端渲染）
const DISCOVER_URLS = [
  'https://www.qimao.com/paihang/boy/over/date/',
  'https://www.qimao.com/paihang/girl/over/date/',
  'https://www.qimao.com/paihang/boy/over/week/',
  'https://www.qimao.com/paihang/girl/over/week/',
  'https://www.qimao.com/paihang/boy/click/date/',
  'https://www.qimao.com/paihang/boy/new/date/',
  'https://www.qimao.com/paihang/girl/new/date/',
];

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function discoverBookIds(src, exclude) {
  const ids = [];
  const seen = new Set(exclude);
  for (const url of DISCOVER_URLS) {
    try {
      const html = await fetchText(url, { log });
      for (const id of discoverBooks(html, src)) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      log(`  发现源 ${url} → 累计候选 ${ids.length}`);
    } catch (e) {
      log(`  发现源失败 ${url}: ${e.message}`);
    }
    await sleep(200);
  }
  return ids;
}

async function main() {
  await sequelize.authenticate();
  const src = getSource(argValue('source') || config.crawl.source);
  const maxChapters = Number(argValue('chapters') || 200);
  const maxNewBooks = Number(argValue('books') || 0);
  const concurrency = Number(argValue('concurrency') || 6);
  const idsArg = (argValue('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const targets = [];

  // 1) 库里已有的书（只补章节）
  const existing = await Novel.findAll({
    where: { sourceId: { [Op.like]: `${src.key}:%` } },
  });
  const existingBookIds = existing.map((n) => n.sourceId.split(':')[1]);
  if (!idsArg.length && !hasFlag('new-only')) {
    for (const id of existingBookIds) targets.push(id);
  }

  // 2) 新书
  if (idsArg.length) {
    targets.push(...idsArg);
  } else if (maxNewBooks > 0) {
    log(`发现新书（已有 ${existingBookIds.length} 本，排除重复）...`);
    const found = await discoverBookIds(src, existingBookIds);
    targets.push(...found.slice(0, maxNewBooks));
  }

  const uniq = [...new Set(targets)];
  log(`\n共 ${uniq.length} 本待处理，每本最多补 ${maxChapters} 章，并发 ${concurrency}\n`);

  const results = [];
  for (let i = 0; i < uniq.length; i++) {
    log(`[${i + 1}/${uniq.length}] book ${uniq[i]}`);
    try {
      results.push(await importBook(src, uniq[i], { maxChapters, concurrency, log }));
    } catch (e) {
      log(`  ! 失败: ${e.message}`);
      results.push({ bookId: uniq[i], error: e.message });
    }
  }

  cacheClear();
  const ok = results.filter((r) => !r.error);
  const added = ok.reduce((s, r) => s + (r.added || 0), 0);
  const failed = ok.reduce((s, r) => s + (r.failed || 0), 0);
  log(`\n=== 完成：${ok.length}/${results.length} 本成功，新增 ${added} 章，失败/空 ${failed} 章 ===`);
  const bad = results.filter((r) => r.error);
  if (bad.length) log('失败明细:', JSON.stringify(bad, null, 1));

  await sequelize.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sequelize.close();
  } catch {}
  process.exit(1);
});
