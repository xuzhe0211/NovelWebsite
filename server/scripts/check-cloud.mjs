// 云托管上线自检（纯静态检查，不连数据库、不需要 Docker）
//
//   npm run check:cloud
//
// 逐项核对「本地代码 → 云托管容器 → 小程序调用」这条链路上的配置是否自洽，
// 只读不写，可反复执行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');
const ROOT = path.resolve(SERVER, '..');

const C = {
  ok: '\x1b[32m✓\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  bad: '\x1b[31m✗\x1b[0m',
  dim: '\x1b[2m',
  nc: '\x1b[0m',
};
let pass = 0;
let warnCount = 0;
let fail = 0;

const ok = (msg) => { pass += 1; console.log(`  ${C.ok} ${msg}`); };
const warn = (msg) => { warnCount += 1; console.log(`  ${C.warn} ${msg}`); };
const bad = (msg) => { fail += 1; console.log(`  ${C.bad} ${msg}`); };
const section = (t) => console.log(`\n${C.dim}${t}${C.nc}`);

const read = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
};
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const exists = (p) => fs.existsSync(p);

// ---------------- 1. 构建所需文件 ----------------
section('1. 镜像构建文件（上传上下文 = 仓库根目录）');
const dockerfile = read(path.join(ROOT, 'Dockerfile'));
const containerCfg = readJson(path.join(ROOT, 'container.config.json'));
const dockerignore = read(path.join(ROOT, '.dockerignore'));
const lock = readJson(path.join(SERVER, 'package-lock.json'));
const pkg = readJson(path.join(SERVER, 'package.json'));

dockerfile ? ok('Dockerfile 存在') : bad('缺 Dockerfile：云托管无法构建');
containerCfg ? ok('container.config.json 存在') : bad('缺 container.config.json：端口/规格不会生效');
dockerignore ? ok('.dockerignore 存在') : warn('缺 .dockerignore：构建上下文会把 node_modules 一起上传');
lock ? ok('server/package-lock.json 存在') : bad('缺 package-lock.json：Dockerfile 用 npm ci 会直接失败');

if (lock && pkg) {
  const deps = Object.keys(pkg.dependencies || {});
  const locked = Object.keys(lock.packages?.['']?.dependencies || {});
  const missing = deps.filter((d) => !locked.includes(d));
  const stale = locked.filter((d) => !deps.includes(d));
  if (!missing.length && !stale.length) {
    ok(`package.json 与 lock 一致（${deps.length} 个依赖）`);
  } else {
    if (missing.length) bad(`lock 缺少依赖：${missing.join(', ')} → 本地 npm install 后重新提交 lock`);
    if (stale.length) warn(`lock 多出依赖（无害）：${stale.join(', ')}`);
  }
}

// 实际生效的是哪一个 Dockerfile（container.config.json 决定）
const activeDf = containerCfg?.dockerfilePath || 'Dockerfile';
if (!exists(path.join(ROOT, activeDf))) {
  bad(`container.config.json 的 dockerfilePath=${activeDf} 文件不存在`);
} else if (/\.lite$/i.test(activeDf)) {
  warn(`构建用 ${activeDf}（精简版，无 Chromium）：阅读/书架/登录/目录正常，云端全网搜索与补章不可用`);
} else {
  ok(`构建用 ${activeDf}（含 Chromium，功能完整）`);
}

// 镜像体积：单层过大是「构建成功但推送超时」的根因
if (dockerfile) {
  if (/playwright install --with-deps/.test(dockerfile)) {
    warn('Dockerfile 用 `playwright install --with-deps` 单层装「系统库 + 完整 Chrome」，镜像近 2GB，推送 TCR 会 timeout');
  } else if (/--only-shell/.test(dockerfile)) {
    ok('完整版 Dockerfile 只装 headless shell，系统依赖与浏览器分层（镜像约 1.31GB，压缩后 ~430MB）');
  } else if (/playwright install/.test(dockerfile)) {
    warn('未使用 --only-shell，镜像体积偏大');
  }
  if (exists(path.join(ROOT, 'Dockerfile.lite'))) ok('有 Dockerfile.lite 兜底（无浏览器，约 350MB）');
}

// ---------------- 2. 端口与规格 ----------------
section('2. 端口 / 规格一致性');
if (containerCfg && dockerfile) {
  const port = containerCfg.containerPort;
  const envPort = containerCfg.envParams?.PORT;
  const dockerEnvPort = /ENV[\s\S]*?PORT=(\d+)/.exec(dockerfile)?.[1];
  const exposed = /EXPOSE\s+(\d+)/.exec(dockerfile)?.[1];
  Number(envPort) === Number(port)
    ? ok(`容器端口 ${port} = 环境变量 PORT=${envPort}`)
    : bad(`containerPort=${port} 与 envParams.PORT=${envPort} 不一致，服务会监听错端口`);
  Number(dockerEnvPort) === Number(port)
    ? ok(`Dockerfile ENV PORT=${dockerEnvPort}`)
    : warn(`Dockerfile ENV PORT=${dockerEnvPort}，建议与 ${port} 对齐（云端会被环境变量覆盖）`);
  Number(exposed) === Number(port)
    ? ok(`Dockerfile EXPOSE ${exposed}`)
    : warn(`Dockerfile EXPOSE ${exposed} 与 containerPort=${port} 不一致（仅文档作用）`);

  const mem = containerCfg.mem;
  mem >= 2 ? ok(`内存 ${mem}G（Chromium 需要 ≥2G）`) : bad(`内存 ${mem}G 不足，抓取时会 OOM`);
  const delay = containerCfg.initialDelaySeconds ?? 0;
  delay >= 10
    ? ok(`启动探测延迟 ${delay}s（数据库重试 6×3s 期间不会被误判）`)
    : warn(`initialDelaySeconds=${delay}，冷启动连库重试期间可能被判不健康，建议 ≥10`);
}

// ---------------- 3. 镜像不该带的东西 ----------------
section('3. 不打包进镜像的项（.dockerignore）');
if (dockerignore) {
  const must = [
    ['server/.env', '本地密钥与数据库密码'],
    ['node_modules', '依赖由镜像内 npm ci 安装'],
    ['server/.playwright-profile', '浏览器 profile 缓存（几十 MB）'],
    ['*.zip', '部署包产物'],
  ];
  for (const [pattern, why] of must) {
    dockerignore.includes(pattern)
      ? ok(`已排除 ${pattern}（${why}）`)
      : warn(`未排除 ${pattern}：${why}`);
  }
}

// ---------------- 4. 服务端运行期开关 ----------------
section('4. 服务端运行期行为');
const cfg = read(path.join(SERVER, 'config', 'index.js')) || '';
/parseBool\(process\.env\.ENABLE_CRON, true\)/.test(cfg)
  ? warn('ENABLE_CRON 默认为 true：云端必须在控制台显式设 false，否则多实例重复跑爬虫')
  : ok('ENABLE_CRON 默认关闭，符合多实例部署');
/parseBool\(process\.env\.TRUST_PROXY, false\)/.test(cfg)
  ? warn('TRUST_PROXY 默认 false：云端需在控制台设 true，否则日志里是代理 IP')
  : ok('TRUST_PROXY 默认开启');
const appJs = read(path.join(SERVER, 'app.js')) || '';
appJs.includes('connectDb') ? ok('启动时带数据库重试（容器冷启动等待 DB）') : warn('未见数据库重试逻辑');
appJs.includes("'/api/health'") ? ok('有 /api/health 健康检查') : warn('缺 /api/health');
appJs.includes('SIGTERM') ? ok('处理 SIGTERM（缩容时优雅退出）') : warn('未处理 SIGTERM，缩容会硬切请求');

// ---------------- 5. 小程序端调用配置 ----------------
section('5. 小程序端（miniprogram/utils/config.js）');
const mpCfg = read(path.join(ROOT, 'miniprogram', 'utils', 'config.js')) || '';
const pick = (key) => new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(mpCfg)?.[1] ?? '';
const mode = (/const\s+MODE\s*=\s*'([^']*)'/.exec(mpCfg) || [])[1] || '';
const envId = pick('CLOUD_ENV');
const service = pick('CLOUD_SERVICE');
const cloudBase = pick('CLOUD_BASE_URL');
const demo = /ENABLE_DEMO:\s*(true|false)/.exec(mpCfg)?.[1];

mode === 'cloud'
  ? ok("MODE = 'cloud'（走 callContainer）")
  : warn("MODE 仍是 'local'：还没切云端，上线前改成 'cloud'");
envId ? ok(`CLOUD_ENV = ${envId}`) : bad('CLOUD_ENV 为空，callContainer 会直接报错');
service ? ok(`CLOUD_SERVICE = ${service}`) : bad('CLOUD_SERVICE 为空，云托管找不到服务');
if (mode === 'cloud') {
  cloudBase
    ? ok(`CLOUD_BASE_URL = ${cloudBase}`)
    : warn('CLOUD_BASE_URL 为空：<image> 无法直连静态图，封面会退化成文字封面（base64 内联仍可用）');
  if (demo === 'true') warn('ENABLE_DEMO 仍为 true：接口异常时会显示演示数据，上线前改 false');
  else ok('ENABLE_DEMO 已关闭');
} else if (demo === 'true') {
  warn('ENABLE_DEMO 为 true（local 模式正常，切 cloud 时记得改 false）');
}
const transport = read(path.join(ROOT, 'miniprogram', 'utils', 'transport.js')) || '';
transport.includes('callContainer')
  ? ok('transport.js 已实现 callContainer 分支')
  : bad('transport.js 缺 callContainer 分支');
transport.includes('X-WX-SERVICE')
  ? ok('请求带 X-WX-SERVICE（云托管靠它路由到服务）')
  : bad('缺 X-WX-SERVICE，callContainer 找不到服务');

// ---------------- 6. 本地硬编码残留 ----------------
section('6. 本地地址残留（不影响云端，但换网段会踩）');
const hits = [];
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.js')) {
      const txt = read(p) || '';
      const lines = txt.split('\n');
      lines.forEach((line, i) => {
        if (/127\.0\.0\.1|localhost/.test(line)) {
          hits.push(`${path.relative(ROOT, p)}:${i + 1} ${line.trim().slice(0, 80)}`);
        }
      });
    }
  }
};
walk(SERVER);
if (!hits.length) ok('服务端无 127.0.0.1 硬编码');
else {
  console.log(`  ${C.warn} 服务端有 ${hits.length} 处本地地址（多为 fallback，确认线上都靠环境变量覆盖）：`);
  hits.slice(0, 6).forEach((h) => console.log(`      ${C.dim}${h}${C.nc}`));
  if (hits.length > 6) console.log(`      ${C.dim}... 其余 ${hits.length - 6} 处${C.nc}`);
  warnCount += 1;
}

// ---------------- 7. 部署包体积 ----------------
section('7. 部署包');
for (const z of fs.readdirSync(ROOT).filter((f) => f.endsWith('.zip'))) {
  const size = fs.statSync(path.join(ROOT, z)).size;
  const mb = (size / 1024 / 1024).toFixed(1);
  if (mb > 3) warn(`${z} ${mb}MB，疑似打进了 .playwright-profile / node_modules，建议删掉重新打`);
  else ok(`${z} ${mb}MB`);
}

// ---------------- 8. 数据迁移 ----------------
section('8. 数据迁移');
exists(path.join(SERVER, 'scripts', 'migrate-db.mjs'))
  ? ok('scripts/migrate-db.mjs 可用（npm run db:migrate）')
  : bad('缺 migrate-db.mjs，云端库没法初始化');

// ---------------- 汇总 ----------------
console.log('');
if (fail) {
  console.log(`${C.bad} 有 ${fail} 项必须修，${warnCount} 项待确认，${pass} 项通过`);
  process.exit(1);
}
console.log(`${C.ok} 通过 ${pass} 项${warnCount ? `，${warnCount} 项待确认` : ''}`);
console.log(`${C.dim}下一步：docs/deploy-cloudrun.md${C.nc}`);
