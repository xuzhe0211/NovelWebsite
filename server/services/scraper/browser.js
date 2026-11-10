import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-extra');

// 隐身插件可选：加载失败不影响主流程
try {
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());
} catch (e) {
  logger.warn({ err: e.message }, 'stealth 插件未加载，使用基础模式');
}

// 服务端和命令行脚本用不同的 profile 目录：
// 两者共用会抢 Chromium 的 ProcessSingleton 锁，导致一方上下文被关掉。
const IS_SERVER = /(^|[\\/])app\.js$/.test(process.argv[1] || '');
const USER_DATA_DIR = path.resolve(
  process.cwd(),
  process.env.PW_PROFILE_DIR || (IS_SERVER ? '.playwright-profile-server' : '.playwright-profile')
);

// 强特征（仅挑战页特有，避免误伤正文页）
const CHALLENGE_MARKERS = [
  'Just a moment',
  'Attention Required',
  'Enable JavaScript and cookies to continue',
  'Please verify you are a human',
  'Verify you are a human',
];

const CHALLENGE_TITLE = /Just a moment|Attention Required|Verify you are a human|请稍候|安全验证|人机验证/i;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let context = null;
let currentHeadless = null;

// 容器里没有系统 Chrome（只装了 headless shell），直接走内置，避免每次启动都先失败一次；
// 本机（macOS）优先用真实 Chrome，过 Cloudflare 更稳。PW_CHANNEL=chrome|none 可强制指定。
const USE_SYSTEM_CHROME =
  process.env.PW_CHANNEL === 'chrome' ||
  (process.env.PW_CHANNEL !== 'none' && process.platform === 'darwin');

async function launch(headless) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const baseOptions = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    userAgent: DEFAULT_UA,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (USE_SYSTEM_CHROME) {
    try {
      return await chromium.launchPersistentContext(USER_DATA_DIR, { ...baseOptions, channel: 'chrome' });
    } catch (e) {
      logger.warn({ err: e.message }, '系统 Chrome 启动失败，回退内置 Chromium');
    }
  }
  return await chromium.launchPersistentContext(USER_DATA_DIR, baseOptions);
}

export async function getContext(headless = true) {
  if (process.env.PW_DISABLED === '1') {
    throw new Error('当前镜像不含浏览器（Dockerfile.lite）：七猫源搜索/导入/阅读正常，需要过 WAF 的第三方站点（如 69shuba）的搜索、导入与补章暂不可用');
  }
  if (context) {
    if (currentHeadless === headless) return context;
    await closeBrowser();
  }
  logger.info({ headless, userDataDir: USER_DATA_DIR }, '启动浏览器');
  try {
    context = await launch(headless);
  } catch (e) {
    // 镜像里没装浏览器时的兜底：给可读报错，而不是 execute playwright install 之类的原始堆栈
    if (/Executable doesn't exist|playwright install|No such file or directory/i.test(String(e?.message || ''))) {
      throw new Error('容器内没有可用浏览器（未安装 Chromium）：第三方站点抓取不可用，七猫源不受影响');
    }
    throw e;
  }
  currentHeadless = headless;
  return context;
}

function isChallenge(html) {
  return CHALLENGE_MARKERS.some((m) => html.includes(m));
}

async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

// 跳转过程中 page.content() 会抛错，这里容错重试
async function safeContent(page) {
  for (let i = 0; i < 20; i++) {
    if (page.isClosed()) throw new Error('Target page has been closed');
    try {
      const html = await page.content();
      if (html) return html;
    } catch (e) {
      if (!/navigating and changing|Target closed|has been closed/i.test(e.message)) throw e;
    }
    await page.waitForTimeout(600).catch(() => {});
  }
  return '';
}

// 轮询标题判断 Cloudflare 验证是否通过（通过后再取正文）
async function waitForPage(page, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (page.isClosed()) throw new Error('Target page has been closed');
    const title = await safeTitle(page);
    if (title && !CHALLENGE_TITLE.test(title)) {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      // 等 JS 渲染完成（SPA 站点的书籍/章节链接多为异步加载）
      try {
        await page.waitForLoadState('networkidle', { timeout: 6000 });
      } catch {
        /* ignore */
      }
      await page.waitForTimeout(1000).catch(() => {});
      return await safeContent(page);
    }
    await page.waitForTimeout(1500).catch(() => {});
  }
  return await safeContent(page).catch(() => '');
}

/**
 * 抓取页面 HTML。每次尝试都新建页面；页面/浏览器被关闭时销毁上下文并重试。
 */
export async function fetchPage(url, { headless = true, retries = 3, manualWaitMs, afterLoad } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let page;
    try {
      const ctx = await getContext(headless);
      page = await ctx.newPage();
      page.setDefaultTimeout(45000);

      logger.info({ url, attempt, headless }, '打开页面');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!headless) {
        logger.info('有头模式：请在弹出的浏览器窗口内完成 Cloudflare 验证（如有勾选框请点击），通过后会自动继续。请勿关闭窗口。');
      }

      const wait = manualWaitMs ?? (headless ? 25000 : 180000);
      const html = await waitForPage(page, wait);

      if (html && html.length > 200 && !isChallenge(html)) {
        if (afterLoad) {
          try {
            await afterLoad(page, url);
          } catch (e) {
            logger.warn({ url, err: e.message }, 'afterLoad 失败(忽略)');
          }
          const html2 = await safeContent(page).catch(() => html);
          logger.info({ url, attempt, length: html2.length }, '页面获取成功(含交互)');
          return html2;
        }
        logger.info({ url, attempt, length: html.length }, '页面获取成功');
        return html;
      }
      const title = await safeTitle(page);
      logger.warn({ url, attempt, title, length: html.length }, 'Cloudflare 挑战未通过，准备重试');
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    } catch (e) {
      lastErr = e;
      logger.warn({ url, attempt, err: e.message }, '抓取异常，重试');
      if (/has been closed|Target closed|browser has disconnected|crash/i.test(e.message)) {
        await closeBrowser();
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
  throw lastErr || new Error(`Cloudflare 挑战未通过: ${url}`);
}

// ---------- 快速通道：过验证后直接用页内 fetch 取原始字节 ----------
// 部分站点按 TLS 指纹拦截 Node 直连（69shuba 全站 403），但浏览器一旦拿到 cookie，
// 同一个 context 里的 fetch 就能 200。比起每章 page.goto，这样快很多（不加载图片/样式）。
const readyHosts = new Set();
let keepPage = null;

async function getFetchPage(ctx) {
  if (keepPage && !keepPage.isClosed()) return keepPage;
  keepPage = await ctx.newPage();
  keepPage.setDefaultTimeout(30000);
  return keepPage;
}

async function waitHostReady(page, url, waitMs) {
  const host = new URL(url).host;
  if (readyHosts.has(host)) return true;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {
    /* 挑战页导航常抛异常，继续轮询 */
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const title = await safeTitle(page);
    if (title && !CHALLENGE_TITLE.test(title)) {
      readyHosts.add(host);
      return true;
    }
    await page.waitForTimeout(700).catch(() => {});
  }
  return false;
}

/**
 * 用浏览器上下文抓取页面，返回未解码的原始字节（交给调用方按 charset 解码）
 * 浏览器/上下文被意外关闭时（profile 锁冲突、Chrome 崩溃）自动重建并重试一次。
 * @param {string} url
 * @param {object} opts { timeout, challengeWait }
 */
export async function fetchBytesViaBrowser(url, opts = {}) {
  try {
    return await fetchBytesOnce(url, opts);
  } catch (e) {
    if (!/has been closed|Target closed|browser has disconnected|crash|Protocol error|Session closed/i.test(e.message)) {
      throw e;
    }
    await closeBrowser();
    return await fetchBytesOnce(url, opts);
  }
}

async function fetchBytesOnce(url, { timeout = 25000, challengeWait = 25000 } = {}) {
  const ctx = await getContext(true);
  const page = await getFetchPage(ctx);

  if (!readyHosts.has(new URL(url).host)) {
    const ok = await waitHostReady(page, url, challengeWait);
    if (!ok) throw new Error('站点验证未通过（浏览器也拿不到内容）');
  }

  const res = await Promise.race([
    page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include', redirect: 'follow' });
        const bytes = new Uint8Array(await r.arrayBuffer());
        const CHUNK = 0x8000;
        let bin = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { status: r.status, b64: btoa(bin) };
      } catch (e) {
        return { status: 0, b64: '', error: String((e && e.message) || e) };
      }
    }, url),
    new Promise((_, rej) => setTimeout(() => rej(new Error('浏览器抓取超时')), timeout)),
  ]);

  if (!res || !res.b64) throw new Error(`浏览器抓取失败${res && res.error ? `：${res.error}` : ''}`);
  if (res.status !== 200) throw new Error(`站点返回 HTTP ${res.status}`);
  return Buffer.from(res.b64, 'base64');
}

export async function closeBrowser() {
  if (keepPage && !keepPage.isClosed()) await keepPage.close().catch(() => {});
  keepPage = null;
  readyHosts.clear();
  if (context) {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    context = null;
    currentHeadless = null;
  }
}
