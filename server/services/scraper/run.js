// 手动触发爬虫：
//   npm run crawl                          # 按 .env 的 CRAWL_SOURCE 抓取（默认 qimao）
//   npm run crawl -- --source qimao --limit 3
//   npm run crawl -- --headful             # 有头（调试/首次过验证）
import { sequelize } from '../../models/index.js';
import { config } from '../../config/index.js';
import { runCrawl } from './index.js';
import { getSource } from './sources.js';
import { closeBrowser } from './browser.js';
import { consoleLogger as log } from '../logger.js';

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await sequelize.authenticate();
  const headless = !process.argv.includes('--headful');
  const sourceKey = argValue('source') || config.crawl.source;
  const limit = Number(argValue('limit') ?? config.crawl.limit);
  const seedIds = (argValue('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (seedIds.length) config.crawl.seedIds = seedIds;

  const src = getSource(sourceKey);
  log.info(
    {
      source: src.key,
      sourceName: src.name,
      headless,
      limit: limit || 'unlimited',
      seedIds: config.crawl.seedIds.length ? config.crawl.seedIds : '(将通过列表页发现)',
      listUrl: config.crawl.listUrl || src.baseUrl,
    },
    '爬虫开始'
  );

  try {
    const results = await runCrawl({ headless, limit, sourceKey });
    log.info({ results }, '爬虫结束');
    console.log('\n=== 爬虫结果 ===');
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = 0;
  } catch (e) {
    log.error({ err: e.message }, '爬虫异常终止');
    console.error(e);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
    await sequelize.close();
  }
}

main();
