import { Router } from 'express';
import sequelizePkg from 'sequelize';
import { Chapter } from '../models/index.js';
import { ErrorCodes } from '../middleware/response.js';
import { authOptional } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { isLockedFor } from '../utils/access.js';

const { Op } = sequelizePkg;

const router = Router();

// GET /api/chapters/:id 正文 + 上一章/下一章
// 未登录时只放行前 FREE_CHAPTERS 章，超出直接返回 403（不下发正文）
router.get('/chapters/:id', authOptional, async (req, res, next) => {
  try {
    const chapter = await Chapter.findByPk(req.params.id);
    if (!chapter) return res.fail(ErrorCodes.NOT_FOUND, '章节不存在');

    if (isLockedFor(req.user, chapter.chapterNo)) {
      return res.fail(
        ErrorCodes.FORBIDDEN,
        `登录后可继续阅读（未登录仅可试读前 ${config.freeChapters} 章）`,
        {
          needLogin: true,
          freeChapters: config.freeChapters,
          chapterNo: chapter.chapterNo,
          novelId: chapter.novelId,
        }
      );
    }

    const [prev, nextChapter] = await Promise.all([
      Chapter.findOne({
        where: { novelId: chapter.novelId, chapterNo: { [Op.lt]: chapter.chapterNo } },
        order: [['chapterNo', 'DESC']],
        attributes: ['id', 'title', 'chapterNo'],
      }),
      Chapter.findOne({
        where: { novelId: chapter.novelId, chapterNo: { [Op.gt]: chapter.chapterNo } },
        order: [['chapterNo', 'ASC']],
        attributes: ['id', 'title', 'chapterNo'],
      }),
    ]);

    res.ok({
      id: chapter.id,
      novelId: chapter.novelId,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      content: chapter.content || '',
      wordCount: chapter.wordCount,
      prev: prev ? { id: prev.id, title: prev.title } : null,
      next: nextChapter ? { id: nextChapter.id, title: nextChapter.title } : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
