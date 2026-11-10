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

// 连库前打一份「不含密码」的指纹。
// 云托管上最常见的坑是：环境变量里贴密码时带了尾部空格 / 换行，或者变量根本没生效
// （DB_PASS 没读到就回退成默认值 root）。有了这三项，日志里一眼能对出来，不用反复猜。
function describeDb() {
  const p = String(config.db.pass ?? '');
  const src = process.env.DB_PASS
    ? 'DB_PASS'
    : process.env.MYSQL_PASSWORD
      ? 'MYSQL_PASSWORD（回退）'
      : '未配置 → 默认值';
  // 密码「形状」：字母→a、数字→9、连字符→-、其它→?，长度和信息量都不泄露内容，
  // 但能一眼看出中间混进了全角/中文破折号这类「看起来一样」的字符。
  const shape = [...p]
    .map((c) => (/[a-z]/i.test(c) ? 'a' : /[0-9]/.test(c) ? '9' : c === '-' ? '-' : '?'))
    .join('');
  return [
    `目标 ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name}`,
    `密码来源 ${src}`,
    `密码长度 ${p.length}`,
    `首字符 ${JSON.stringify(p[0] ?? '')}`,
    `末字符 ${JSON.stringify(p[p.length - 1] ?? '')}`,
    `含空白字符 ${/\s/.test(p)}`,
    `密码形状 ${shape || '(空)'}`,
  ].join(' · ');
}

// 容器冷启动时数据库可能还没就绪，先重试几次再放弃
async function connectDb(attempts = 6, gapMs = 3000) {
  console.log(`[server] 准备连库：${describeDb()}`);
  for (let i = 1; i <= attempts; i++) {
    try {
      await sequelize.authenticate();
      console.log(`[server] 数据库连接成功（第 ${i} 次尝试）`);
      return;
    } catch (err) {
      console.warn(`[server] 数据库连接失败（第 ${i}/${attempts} 次）: ${err.message}`);
      // 认证失败几乎只有两种原因：容器里的密码不是你想的那个字符串，或账号来源主机被限制。
      // 上面那行指纹已经能区分第一种，所以这里只提示第二种的查法。
      if (err.code === 'ER_ACCESS_DENIED_ERROR') {
        console.warn('[server] ↑ 认证被拒：先比对上面「密码长度/含空白字符」是否与本地 .env 一致；'
          + '若一致，去 CynosDB「账号管理」确认账号主机为 %（容器 IP 落在 10.4.0.0/16 的其它网段）');
      }
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
