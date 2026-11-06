// 书源扫描：批量拉取书籍目录接口，统计「免费章节数」，用于挑选章节最全的书
//
//   node services/scraper/scan.js --limit 60
//   node services/scraper/scan.js --urls https://www.qimao.com/shuku/a-a-a-a-a-a-a-click-1/
import https from 'node:https';
import { chromium } from 'playwright';
import { getSource } from './sources.js';
import { discoverBooks } from './parser.js';
import { Novel, sequelize } from '../../models/index.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argValue(n) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function httpGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        insecureHTTPParser: true,
        timeout: 15000,
        headers: { 'User-Agent': UA, Referer: 'https://www.qimao.com/', Cookie: cookie || '' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    })
  );
}

// 书库列表页（可按页翻，每页约 20~40 本）
const LIST_PAGES = [
  'https://www.qimao.com/shuku/a-a-a-a-a-a-a-click-1/',
  'https://www.qimao.com/shuku/a-a-a-a-a-a-a-click-2/',
  'https://www.qimao.com/shuku/a-a-a-a-a-a-a-click-3/',
  'https://www.qimao.com/shuku/a-a-a-a-a-a-a-new-1/',
  'https://www.qimao.com/shuku/a-a-a-a-a-a-a-new-2/',
  'https://www.qimao.com/shuku/a-a-a-a-a-a-a-over-1/',
  'https://www.qimao.com/paihang/boy/over/date/',
  'https://www.qimao.com/paihang/girl/over/date/',
  'https://www.qimao.com/paihang/boy/new/date/',
  'https://www.qimao.com/paihang/girl/new/date/',
];

async function main() {
  await sequelize.authenticate();
  const src = getSource('qimao');
  const limit = Number(argValue('limit') || 60);
  const extra = (argValue('urls') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = [...extra, ...LIST_PAGES];

  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  await page.goto('https://www.qimao.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1800);
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await b.close();

  const existing = await Novel.findAll({ attributes: ['sourceId'] });
  const known = new Set(existing.map((n) => String(n.sourceId).split(':')[1]));

  const ids = [];
  const seen = new Set();
  for (const u of urls) {
    try {
      const html = await httpGet(u, cookie);
      const found = discoverBooks(html, src).filter((id) => !known.has(id) && !seen.has(id));
      found.forEach((id) => {
        seen.add(id);
        ids.push(id);
      });
      console.log(`  ${u} → +${found.length}（累计候选 ${ids.length}）`);
    } catch (e) {
      console.log(`  ${u} 失败: ${e.message}`);
    }
    await sleep(150);
  }

  console.log(`\n开始扫描 ${Math.min(ids.length, limit)} 本书的免费章节数...`);
  const rows = [];
  const targets = ids.slice(0, limit);
  await pool(targets, 4, async (id) => {
    try {
      const raw = await httpGet(`https://www.qimao.com/qimaoapi/api/book/chapter-list?book_id=${id}`, cookie);
      const list = JSON.parse(raw).data.chapters || [];
      const free = list.filter((c) => String(c.is_vip) === '0').length;
      rows.push({ id, total: list.length, free, title: String(list[0]?.title || '') });
    } catch (e) {
      /* ignore */
    }
    await sleep(60);
  });

  rows.sort((a, b) => b.free - a.free);
  console.log('\n免费章节数 Top:');
  rows.slice(0, 25).forEach((r) => console.log(`  ${r.id}  免费 ${String(r.free).padStart(4)} / 共 ${r.total}`));
  console.log('\n可导入的 ID（免费≥40）：');
  console.log(rows.filter((r) => r.free >= 40).map((r) => r.id).join(','));

  await sequelize.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
