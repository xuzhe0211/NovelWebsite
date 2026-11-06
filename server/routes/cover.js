import { Router } from 'express';

/**
 * 图片代理：GET /api/cover?url=<encoded>
 * ------------------------------------------------------------
 * 小说站点的封面大多有防盗链（校验 Referer），小程序里直接加载会 403；
 * 同时小程序还要求图片域名在白名单内。这里由服务端带 Referer 取图再回传，
 * 前端只认 BASE_URL 一个域名。
 *
 * 两种返回格式：
 *   1. 默认 → 原始图片二进制（image/jpeg 等），适合浏览器 / 调试工具；
 *   2. ?b64=1 → { code:0, data:{ dataUrl, type, width, height, bytes } }
 *      dataUrl 是 data:image/jpeg;base64,... 可以直接塞进 <image src>。
 *      微信小程序自基础库 3.8.7 起，image 组件在开发版/体验版不再加载
 *      http:// 图片（真机预览不打开调试时表现为一片空白、且不触发 binderror），
 *      走 data URI 就完全不发图片请求，绕开这条限制。
 *
 * 可选 ?w=200 指定缩放宽度（默认不缩放，上限 1080），统一转 JPEG 并压到 72% 质量，
 * base64 体积能控制在 10KB 左右，避免一屏十几张封面的 setData 过大。
 */
const router = Router();

const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CACHE = 400;
const rawCache = new Map(); // href -> { buf, type, at }
const outCache = new Map(); // href|w -> { buf, type, width, height, at }

// sharp 是可选依赖：装不上也照常工作，只是不做缩放
let sharpLib;
async function getSharp() {
  if (sharpLib !== undefined) return sharpLib;
  try {
    sharpLib = (await import('sharp')).default;
  } catch {
    sharpLib = null;
  }
  return sharpLib;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function readCache(store, key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    store.delete(key);
    return null;
  }
  return hit;
}

function writeCache(store, key, value) {
  if (store.size > MAX_CACHE) store.delete(store.keys().next().value);
  store.set(key, { ...value, at: Date.now() });
}

async function fetchImage(target) {
  const origin = `${target.protocol}//${target.host}/`;
  const res = await fetch(target.href, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: {
      Referer: origin,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });

  // 手动处理一次跳转，避免被重定向到内网地址
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return null;
    const next = new URL(location, target);
    if (!/^https?:$/.test(next.protocol) || isPrivateHost(next.hostname)) return null;
    return fetchImage(next);
  }

  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  const length = Number(res.headers.get('content-length')) || 0;
  if (length > MAX_BYTES) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { buf, type };
}

/** 取原图（带缓存），失败返回 null */
async function loadRaw(href) {
  const cached = readCache(rawCache, href);
  if (cached) return cached;
  const target = new URL(href);
  const image = await fetchImage(target);
  if (!image) return null;
  writeCache(rawCache, href, image);
  return { ...image, at: Date.now() };
}

/** 按需缩放 + 转 JPEG，返回 { buf, type, width, height } */
async function transform(image, width) {
  if (!width) return { ...image, width: 0, height: 0 };
  const sharp = await getSharp();
  if (!sharp) return { ...image, width: 0, height: 0 };
  try {
    const out = await sharp(image.buf)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 66, progressive: true })
      .toBuffer({ resolveWithObject: true });
    return {
      buf: out.data,
      type: 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    // 特殊格式（动图 / 异常文件）缩不了就用原图
    return { ...image, width: 0, height: 0 };
  }
}

router.get('/cover', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('missing url');

  let target;
  try {
    target = new URL(String(raw));
  } catch {
    return res.status(400).send('bad url');
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    return res.status(403).send('forbidden');
  }

  const wantB64 = String(req.query.b64 || '') === '1';
  const width = Math.min(1080, Math.max(0, Number(req.query.w) || 0));
  const key = `${target.href}|${width}`;

  try {
    let image = readCache(outCache, key);
    if (!image) {
      const base = await loadRaw(target.href);
      if (!base) {
        if (wantB64) return res.fail(404, '封面获取失败');
        return res.status(404).send('not found');
      }
      image = width ? await transform(base, width) : { ...base, width: 0, height: 0 };
      writeCache(outCache, key, image);
    }

    if (wantB64) {
      return res.ok({
        dataUrl: `data:${image.type};base64,${image.buf.toString('base64')}`,
        type: image.type,
        width: image.width,
        height: image.height,
        bytes: image.buf.length,
      });
    }

    res.set('Content-Type', image.type);
    res.set('Cache-Control', 'public, max-age=21600');
    return res.send(image.buf);
  } catch (err) {
    if (wantB64) return res.fail(502, '封面获取失败');
    return res.status(502).send('upstream error');
  }
});

export default router;
