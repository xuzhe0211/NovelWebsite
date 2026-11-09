import express from 'express';
import { config } from './config/index.js';
import { sequelize } from './models/index.js';
import { responseMiddleware, notFoundHandler, errorHandler } from './middleware/response.js';

// 路由
import authRouter from './routes/auth.js';
import homeRouter from './routes/home.js';
import categoryRouter from './routes/category.js';
import novelRouter from './routes/novel.js';
import chapterRouter from './routes/chapter.js';
import bookshelfRouter from './routes/bookshelf.js';
import coverRouter from './routes/cover.js';
import onlineRouter from './routes/online.js';

// 定时任务
import { startWeeklyJob } from './jobs/weekly.js';

const app = express();
// 部署在云托管/反向代理后面时，让 req.ip / req.protocol 取到真实值
if (config.trustProxy) app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));
app.use(responseMiddleware);

// 静态资源：封面图等（爬虫下载到 public/ 后对外提供）
app.use('/static', express.static(new URL('./public', import.meta.url).pathname));

app.get('/api/health', (req, res) => res.ok({ time: new Date().toISOString() }));

app.use('/api/auth', authRouter);
app.use('/api', homeRouter);
app.use('/api', categoryRouter);
app.use('/api', novelRouter);
app.use('/api', chapterRouter);
app.use('/api', bookshelfRouter);
app.use('/api', coverRouter);
app.use('/api', onlineRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 容器冷启动时数据库可能还没就绪，先重试几次再放弃
async function connectDb(attempts = 6, gapMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await sequelize.authenticate();
      console.log(`[server] 数据库连接成功（第 ${i} 次尝试）`);
      return;
    } catch (err) {
      console.warn(`[server] 数据库连接失败（第 ${i}/${attempts} 次）: ${err.message}`);
      if (i === attempts) throw err;
      await sleep(gapMs);
    }
  }
}

async function bootstrap() {
  try {
    await connectDb();
  } catch (err) {
    console.error('[server] 数据库不可用，进程退出（容器会自动重启）', err.message);
    process.exit(1);
  }

  // 多实例/缩容到 0 的环境里内置 cron 会重复或漏跑，线上关掉，改用云托管定时任务
  if (config.enableCron) {
    startWeeklyJob();
  } else {
    console.log('[server] ENABLE_CRON=false，未启用内置定时爬虫');
  }

  const server = app.listen(config.port, () => {
    console.log(`[server] API 已启动，监听端口 ${config.port}`);
  });

  // 容器缩容/重启发 SIGTERM，优雅关闭避免请求被硬切
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${sig}，正在关闭`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap();
