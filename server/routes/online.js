import { Router } from 'express';
import { authOptional } from '../middleware/auth.js';
import { ErrorCodes } from '../middleware/response.js';
import { searchOnline, startImport, getTask, fetchOnlineDetail, resolveBookUrl, continueInfo, startContinueImport } from '../services/online.js';

const router = Router();

// GET /api/online/search?keyword=剑来&page=1
// 全网（免费小说站）搜索，结果带 inLibrary 标记
router.get('/online/search', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) return res.fail(ErrorCodes.BAD_REQUEST, '请输入书名或作者');
    const page = Math.max(1, Math.min(20, Number(req.query.page) || 1));
    const source = String(req.query.source || 'qimao');
    const data = await searchOnline(keyword, { page, source });
    res.ok(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/online/detail?source=qimao&bookId=143170
// GET /api/online/detail?url=https://www.xbiquge.bz/books_7257/
// 书籍详情：抓源站详情页 + 目录，返回免费章数与是否已入库
router.get('/online/detail', async (req, res, next) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    let source = String(req.query.source || '').trim();
    let bookId = String(req.query.bookId || '').trim();

    if (rawUrl) {
      const resolved = resolveBookUrl(rawUrl);
      source = resolved.source;
      bookId = resolved.bookId;
    }
    if (!source) source = 'qimao';
    if (source === 'web' && !rawUrl) return res.fail(ErrorCodes.BAD_REQUEST, '第三方站点需要提供 url');
    if (source !== 'web' && !bookId) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 bookId');

    const detail = await fetchOnlineDetail({
      source,
      bookId,
      url: rawUrl,
      refresh: String(req.query.refresh || '') === '1',
    });
    res.ok(detail);
  } catch (err) {
    next(err);
  }
});

// GET /api/online/resolve?url=...  仅识别链接归属（不抓页面，快）
router.get('/online/resolve', (req, res, next) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 url');
    res.ok(resolveBookUrl(rawUrl));
  } catch (err) {
    next(err);
  }
});

// POST /api/online/import
// { bookId, source?, url?, addToShelf?, maxChapters? }
// 异步抓取入库；addToShelf 默认 true，已登录用户完成后自动加入书架
router.post('/online/import', authOptional, async (req, res, next) => {
  try {
    const rawUrl = String(req.body?.url || '').trim();
    let source = String(req.body?.source || '').trim();
    let bookId = String(req.body?.bookId || '').trim();

    // 直接粘贴链接时，从 URL 反解站点与书籍 ID
    if (!source && rawUrl) {
      const resolved = resolveBookUrl(rawUrl);
      source = resolved.source;
      bookId = resolved.bookId;
    }
    if (!source) source = 'qimao';

    if (source === 'web') {
      if (!rawUrl) return res.fail(ErrorCodes.BAD_REQUEST, '第三方站点需要提供 url');
    } else if (!bookId || !/^[0-9A-Za-z_-]+$/.test(bookId)) {
      return res.fail(ErrorCodes.BAD_REQUEST, '缺少有效的 bookId');
    }

    const task = startImport({
      bookId,
      source,
      url: rawUrl,
      userId: req.user ? req.user.userId : null,
      maxChapters: req.body?.maxChapters,
      addToShelf: req.body?.addToShelf !== false,
    });
    res.ok({
      taskId: task.id,
      status: task.status,
      stage: task.stage,
      progress: task.progress,
      reused: !!task.reused,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/online/import/:taskId  轮询导入进度
router.get('/online/import/:taskId', async (req, res, next) => {
  try {
    const task = getTask(req.params.taskId);
    if (!task) return res.fail(ErrorCodes.NOT_FOUND, '任务不存在或已过期');
    res.ok(task);
  } catch (err) {
    next(err);
  }
});

// GET /api/online/continue?novelId=97  这本书还能不能补章（含已入库章数 / 源站名）
router.get('/online/continue', async (req, res, next) => {
  try {
    const novelId = Number(req.query.novelId);
    if (!novelId) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 novelId');
    const info = await continueInfo(novelId);
    if (!info) return res.fail(ErrorCodes.NOT_FOUND, '书籍不存在');
    res.ok(info);
  } catch (err) {
    next(err);
  }
});

// POST /api/online/continue  { novelId, maxChapters?, url? }
// 继续补章：按已有书库记录再抓一批；url 仅用于早期没存源站链接的外部书
router.post('/online/continue', authOptional, async (req, res, next) => {
  try {
    const novelId = Number(req.body?.novelId);
    if (!novelId) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 novelId');
    const task = await startContinueImport({
      novelId,
      url: String(req.body?.url || '').trim(),
      userId: req.user ? req.user.userId : null,
      maxChapters: req.body?.maxChapters,
      addToShelf: req.body?.addToShelf === true,
    });
    res.ok({
      taskId: task.id,
      status: task.status,
      stage: task.stage,
      progress: task.progress,
      reused: !!task.reused,
    });
  } catch (err) {
    if (err && err.code === 'NEED_URL') return res.fail(ErrorCodes.BAD_REQUEST, err.message);
    next(err);
  }
});

// GET /api/online/sources  可用数据源
router.get('/online/sources', (req, res) => {
  res.ok([
    { key: 'qimao', name: '七猫免费小说', searchable: true },
    { key: 'web', name: '第三方站点', searchable: false, note: '粘贴书籍详情页链接即可拉取' },
  ]);
});

export default router;
