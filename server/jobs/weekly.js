// 每周末定时爬虫调度。失败不阻塞、下次自动补抓。
import cron from 'node-cron';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';

let started = false;

export function startWeeklyJob() {
  if (started) return;
  started = true;

  if (!cron.validate(config.crawl.schedule)) {
    logger.error({ schedule: config.crawl.schedule }, 'CRAWL_SCHEDULE 不是合法 cron 表达式，调度未启动');
    return;
  }

  cron.schedule(config.crawl.schedule, async () => {
    logger.info('周末定时爬虫触发');
    try {
      // 延迟加载，避免启动时就拉起 Playwright
      const { runCrawl } = await import('../services/scraper/index.js');
      const { closeBrowser } = await import('../services/scraper/browser.js');
      try {
        const results = await runCrawl({ headless: true });
        logger.info({ results }, '周末定时爬虫完成');
      } finally {
        await closeBrowser();
      }
    } catch (e) {
      logger.error({ err: e.message }, '周末定时爬虫失败（不影响服务，下个周期重试）');
    }
  });

  logger.info({ schedule: config.crawl.schedule }, '周末定时爬虫调度已启动');
}
