import { Router } from 'express';
import { Bookshelf, Novel, Chapter } from '../models/index.js';
import { authRequired } from '../middleware/auth.js';
import { ErrorCodes } from '../middleware/response.js';
import { serializeNovel } from '../utils/serialize.js';

const router = Router();

// GET /api/bookshelf 我的书架（含小说信息与阅读进度）
router.get('/bookshelf', authRequired, async (req, res, next) => {
  try {
    const entries = await Bookshelf.findAll({
      where: { userId: req.user.userId },
      order: [['lastReadTime', 'DESC'], ['id', 'DESC']],
      include: [
        { model: Novel, as: 'novel' },
      ],
    });

    // 批量取「最近阅读章节标题」
    const chapterIds = entries.map((e) => e.lastChapterId).filter(Boolean);
    const chapters = chapterIds.length
      ? await Chapter.findAll({ where: { id: chapterIds }, attributes: ['id', 'title'] })
      : [];
    const chapterMap = new Map(chapters.map((c) => [c.id, c.title]));

    const list = entries.map((e) => {
      const j = e.toJSON();
      return {
        novelId: j.novelId,
        novel: j.novel ? serializeNovel(j.novel) : null,
        lastChapterId: j.lastChapterId,
        lastChapterTitle: j.lastChapterId ? chapterMap.get(j.lastChapterId) || null : null,
        lastPosition: j.lastPosition,
        lastReadTime: j.lastReadTime,
      };
    });
    res.ok(list);
  } catch (err) {
    next(err);
  }
});

// POST /api/bookshelf  { novelId } 加入书架（幂等）
router.post('/bookshelf', authRequired, async (req, res, next) => {
  try {
    const novelId = Number(req.body?.novelId);
    if (!novelId) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 novelId');
    const novel = await Novel.findByPk(novelId);
    if (!novel) return res.fail(ErrorCodes.NOT_FOUND, '小说不存在');

    const [entry, created] = await Bookshelf.findOrCreate({
      where: { userId: req.user.userId, novelId },
      defaults: { userId: req.user.userId, novelId, lastPosition: 0 },
    });
    res.ok({ added: created, novelId: entry.novelId });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/bookshelf/:novelId 移出书架
router.delete('/bookshelf/:novelId', authRequired, async (req, res, next) => {
  try {
    const destroyed = await Bookshelf.destroy({
      where: { userId: req.user.userId, novelId: req.params.novelId },
    });
    res.ok({ removed: destroyed > 0 });
  } catch (err) {
    next(err);
  }
});

// PUT /api/bookshelf/progress  { novelId, chapterId, position } 更新阅读进度
router.put('/bookshelf/progress', authRequired, async (req, res, next) => {
  try {
    const { novelId, chapterId, position } = req.body || {};
    if (!novelId || !chapterId) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 novelId 或 chapterId');

    const [entry] = await Bookshelf.findOrCreate({
      where: { userId: req.user.userId, novelId },
      defaults: { userId: req.user.userId, novelId, lastPosition: 0 },
    });
    entry.lastChapterId = chapterId;
    entry.lastPosition = Math.min(100, Math.max(0, Number(position) || 0));
    entry.lastReadTime = new Date();
    await entry.save();
    res.ok({ updated: true });
  } catch (err) {
    next(err);
  }
});

export default router;
