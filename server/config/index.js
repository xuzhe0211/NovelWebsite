import 'dotenv/config';

const parseBool = (v, def = false) => {
	if (v === undefined || v === null || v === '') return def;
	return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

// 微信云托管的「MySQL」面板会往容器注入模板约定的变量：
//   MYSQL_ADDRESS=host:port  MYSQL_USERNAME  MYSQL_PASSWORD（有的版本还有 MYSQL_DATABASE）
// 本项目的标准变量是 DB_*，这里做一层兜底：DB_* 优先，没配才用 MYSQL_*。
// 好处是在控制台不用为了迁就变量名去删模板注入项，两种写法都能跑。
const mysqlAddress = String(process.env.MYSQL_ADDRESS || '');
const addrHost = mysqlAddress.includes(':') ? mysqlAddress.split(':')[0] : mysqlAddress;
const addrPort = mysqlAddress.includes(':') ? mysqlAddress.split(':')[1] : '';

export const config = {
	port: Number(process.env.PORT || 3000),
	db: {
		host: process.env.DB_HOST || addrHost || '127.0.0.1',
		port: Number(process.env.DB_PORT || addrPort || 3306),
		name: process.env.DB_NAME || process.env.MYSQL_DATABASE || 'novel',
		user: process.env.DB_USER || process.env.MYSQL_USERNAME || 'root',
		pass: process.env.DB_PASS || process.env.MYSQL_PASSWORD || 'root',
		// 排序规则：utf8mb4_unicode_ci 在 MySQL 5.7 / 8.0 均可用。
		// 本地 8.0 想用 0900_ai_ci 可设 DB_COLLATE=utf8mb4_0900_ai_ci
		collate: process.env.DB_COLLATE || 'utf8mb4_unicode_ci'
	},
	jwt: {
		secret: process.env.JWT_SECRET || 'dev-secret-change-me',
		expires: process.env.JWT_EXPIRES || '7d'
	},
	wx: {
		appid: process.env.WX_APPID || '',
		secret: process.env.WX_SECRET || ''
	},
	crawl: {
		// 数据源：qimao | fanqie | twkan
		source: process.env.CRAWL_SOURCE || 'qimao',		seedIds: (process.env.CRAWL_SEED_IDS || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		// 书库/首页地址：无 seedIds 时从中自动发现书籍
		listUrl: process.env.CRAWL_LIST_URL || '',
		maxBooks: Number(process.env.CRAWL_MAX_BOOKS || 3),
		headfulFirst: parseBool(process.env.CRAWL_HEADFUL_FIRST, true),
		intervalMs: Number(process.env.CRAWL_INTERVAL_MS || 800),
		limit: Number(process.env.CRAWL_LIMIT || 0),
		schedule: process.env.CRAWL_SCHEDULE || '0 3 * * 0'
	},
	// ===== 部署相关开关（云托管用环境变量控制）=====
	// 多实例容器里跑 node-cron 会重复执行，线上设为 false，改由云托管「定时任务」触发
	enableCron: parseBool(process.env.ENABLE_CRON, true),
	// 容器只采集 stdout；没有持久盘时文件日志没意义，线上设为 false
	logFile: parseBool(process.env.LOG_TO_FILE, true),
	// ===== 阅读限制 =====
	// 未登录用户每本书最多能读的章节数（按 chapterNo 判断），0 表示不限制。
	// 这是服务端硬限制：不依赖小程序前端判断，直接调接口也拿不到正文。
	freeChapters: (() => {
		const raw = process.env.FREE_CHAPTERS;
		if (raw === undefined || raw === '') return 10;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : 10;
	})(),
	// 部署在云托管/反向代理后面时，用于正确取到客户端 IP
	trustProxy: parseBool(process.env.TRUST_PROXY, false),
	logLevel: process.env.LOG_LEVEL || 'info'
};
