#!/usr/bin/env node
// 云端部署后的冒烟验收：直接打真实域名，逐项判定「能不能上线」。
//
// 用法：
//   npm run verify:cloud -- https://xxx-yyy.sh.run.tcloudbase.com
//   npm run verify:cloud -- --url=https://... --timeout=20000
//
// 设计意图：控制台日志只能告诉你「容器起来了」，不能告诉你「接口真的返回数据」。
// 这里把小程序首屏/详情/目录/搜索/404 五类请求真实走一遍，任何一项失败都退出码 1，
// 方便在切 MODE='cloud' 之前卡住问题。

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};

let base = flag('url', '') || args.find((a) => a.startsWith('http')) || '';
if (!base) {
  console.error('用法: npm run verify:cloud -- https://<云托管访问域名>');
  console.error('域名位置：云托管控制台 → 服务设置 → 访问域名（形如 https://xxx-yyy.sh.run.tcloudbase.com）');
  process.exit(2);
}
base = base.replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) base = `https://${base}`;

const TIMEOUT = Number(flag('timeout', 15000));

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const results = [];
const rec = (ok, name, detail, hint) => {
  results.push({ ok, name, detail, hint });
  const mark = ok === true ? `${C.g}✓${C.x}` : ok === 'warn' ? `${C.y}!${C.x}` : `${C.r}✗${C.x}`;
  console.log(`${mark} ${name.padEnd(30)} ${detail}`);
  if (hint) console.log(`  ${C.d}↳ ${hint}${C.x}`);
};

async function call(pathname) {
  const url = `${base}${pathname}`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { 'user-agent': 'novel-verify-cloud/1.0' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  const ms = Date.now() - started;
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON，多半是网关错误页 */ }
  return { url, status: res.status, ms, text, json };
}

// 网关卡片的典型特征：返回 HTML 或 status 5xx，此时后面所有项都会失败，直接给结论
const isGatewayPage = (r) => !r.json && /<html|nginx|502|503|504/i.test(r.text.slice(0, 400));

async function main() {
  console.log(`${C.b}验收目标${C.x} ${base}`);
  console.log(`${C.d}超时 ${TIMEOUT}ms，逐项请求真实接口${C.x}\n`);

  // 1) health —— 容器是否真的在监听、Express 是否活着
  let gateway = null;
  try {
    const r = await call('/api/health');
    if (isGatewayPage(r)) {
      gateway = r;
      rec(false, '/api/health', `HTTP ${r.status}，返回的不是 JSON`,
        '容器没起来或端口不对。看云托管「运行日志」有没有「API 已启动，监听端口 80」；端口必须 80');
    } else if (r.json?.code === 0) {
      rec(true, '/api/health', `HTTP ${r.status} · ${r.ms}ms · ${r.json.data?.time || ''}`);
    } else {
      rec(false, '/api/health', `HTTP ${r.status} · code=${r.json?.code}`, r.json?.message);
    }
  } catch (err) {
    rec(false, '/api/health', `请求失败：${err.message}`,
      '域名解析不了 / 实例数为 0（冷启动要 10~20s，可稍后重试）/ 本地网络代理拦截。本机请加 --noproxy');
  }

  if (gateway) {
    console.log(`\n${C.r}网关就没通，后续项目跳过。${C.x}先解决容器启动问题，再重跑本脚本。`);
    summarize();
    return;
  }

  // 2) 首页聚合 —— 同时验证「数据库连得上」和「有数据」
  try {
    const r = await call('/api/home');
    const d = r.json?.data || {};
    const hot = Array.isArray(d.hot) ? d.hot.length : 0;
    const latest = Array.isArray(d.latest) ? d.latest.length : 0;
    const cats = Array.isArray(d.categories) ? d.categories.length : 0;
    if (r.json?.code !== 0) {
      rec(false, '/api/home', `code=${r.json?.code} ${r.json?.message || ''}`,
        'code=500 多半是 DB_* 配错或 CynosDB 内网不通：确认 DB_HOST=10.4.111.146、DB_PASS 是真实密码');
    } else if (!hot && !latest) {
      rec(false, '/api/home', `HTTP 200 但 hot/latest 都是空`, '数据库连上了但没有数据，先在本地跑一次 npm run db:migrate');
    } else {
      rec(true, '/api/home', `hot ${hot} / latest ${latest} / 分类 ${cats}`);
    }
  } catch (err) {
    rec(false, '/api/home', `请求失败：${err.message}`);
  }

  // 3) 分类
  try {
    const r = await call('/api/categories');
    const n = Array.isArray(r.json?.data) ? r.json.data.length : 0;
    rec(r.json?.code === 0 && n > 0, '/api/categories', r.json?.code === 0 ? `${n} 个分类` : `code=${r.json?.code}`);
  } catch (err) {
    rec(false, '/api/categories', `请求失败：${err.message}`);
  }

  // 4) 详情 + 目录（取首页第一本书，避免写死 id）
  try {
    const home = await call('/api/home');
    const first = home.json?.data?.hot?.[0] || home.json?.data?.latest?.[0];
    if (!first?.id) {
      rec('warn', '/api/novels/:id/chapters', '首页没有书，跳过');
    } else {
      const r = await call(`/api/novels/${first.id}/chapters`);
      const list = Array.isArray(r.json?.data) ? r.json.data : (r.json?.data?.list || []);
      rec(r.json?.code === 0 && list.length > 0, `/api/novels/${first.id}/chapters`,
        r.json?.code === 0 ? `《${first.title || ''}》${list.length} 章` : `code=${r.json?.code}`);
    }
  } catch (err) {
    rec(false, '/api/novels/:id/chapters', `请求失败：${err.message}`);
  }

  // 5) 全网搜索（lite 镜像走 HTTP API，不需要浏览器；失败不阻断上线）
  try {
    const r = await call(`/api/online/search?keyword=${encodeURIComponent('剑来')}`);
    const total = r.json?.data?.total ?? (Array.isArray(r.json?.data) ? r.json.data.length : 0);
    if (r.json?.code === 0 && total > 0) rec(true, '/api/online/search', `${total} 条结果`);
    else rec('warn', '/api/online/search', `code=${r.json?.code} ${r.json?.message || ''}`,
      '不影响阅读功能；若提示「不含浏览器」属预期（Dockerfile.lite），要抓取请改用完整镜像');
  } catch (err) {
    rec('warn', '/api/online/search', `请求失败：${err.message}`);
  }

  // 6) 404 语义 —— 确认请求真的进了 Express，而不是被域名层拦掉
  try {
    const r = await call('/api/__not_exist__');
    rec(r.json?.code === 404, '不存在的接口返回 code=404', `HTTP ${r.status} code=${r.json?.code}`,
      r.json?.code !== 404 ? '返回不对：可能域名指向了别的服务，或部署的还是官方模板代码' : null);
  } catch (err) {
    rec(false, '不存在的接口返回 code=404', `请求失败：${err.message}`);
  }

  summarize();
}

function summarize() {
  const fail = results.filter((r) => r.ok === false).length;
  const warn = results.filter((r) => r.ok === 'warn').length;
  console.log('');
  if (fail === 0) {
    console.log(`${C.g}${C.b}通过 ${results.length - warn} 项${warn ? `，${warn} 项告警` : ''}${C.x}  —— 可以把 miniprogram/utils/config.js 的 MODE 改成 'cloud'`);
    process.exit(0);
  }
  console.log(`${C.r}${C.b}${fail} 项失败${C.x} —— 先别切 MODE='cloud'，小程序会白屏`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`${C.r}脚本异常：${err.message}${C.x}`);
  process.exit(1);
});
