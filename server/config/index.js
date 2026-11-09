import 'dotenv/config';

const parseBool = (v, def = false) => {
	if (v === undefined || v === null || v === '') return def;
	return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const config = {
	port: Number(process.env.PORT || 3000),
	db: {
		host: process.env.DB_HOST || '127.0.0.1',
		port: Number(process.env.DB_PORT || 3306),
		name: process.env.DB_NAME || 'novel',
		user: process.env.DB_USER || 'root',
		pass: process.env.DB_PASS || 'root'
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
	// 部署在云托管/反向代理后面时，用于正确取到客户端 IP
	trustProxy: parseBool(process.env.TRUST_PROXY, false),
	logLevel: process.env.LOG_LEVEL || 'info'
};
