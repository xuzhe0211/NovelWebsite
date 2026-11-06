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

async function bootstrap() {
  try {
    await sequelize.authenticate();
    console.log('[server] 数据库连接成功');
  } catch (err) {
    console.error('[server] 数据库连接失败，请检查 .env 与 MySQL 服务', err.message);
    process.exit(1);
  }

  // 注册每周末爬虫调度
  startWeeklyJob();

  app.listen(config.port, () => {
    console.log(`[server] API 已启动: http://localhost:${config.port}`);
  });
}

bootstrap();
