import { Router } from 'express';
import sequelizePkg from 'sequelize';
import { Novel, Category, Chapter } from '../models/index.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { serializeNovel, parsePaging, pagedResult } from '../utils/serialize.js';
import { ErrorCodes } from '../middleware/response.js';
import { authOptional } from '../middleware/auth.js';
import { isLockedFor } from '../utils/access.js';

const router = Router();
const { Op } = sequelizePkg;

const SORTS = {
  hot: [['clickCount', 'DESC'], ['id', 'DESC']],
  new: [['lastUpdateTime', 'DESC'], ['id', 'DESC']],
  words: [['wordCount', 'DESC'], ['id', 'DESC']],
  rating: [['rating', 'DESC'], ['id', 'DESC']],
};

// GET /api/novels  列表（分类/状态/关键词/排序/分页）
router.get('/novels', async (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const where = {};

    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      where[Op.or] = [{ title: { [Op.like]: `%${kw}%` } }, { author: { [Op.like]: `%${kw}%` } }];
    }
    if (req.query.status === 'completed' || req.query.status === '完结') {
      where.isCompleted = true;
    } else if (req.query.status === 'serial' || req.query.status === '连载中') {
      where.isCompleted = false;
    }

    const include = [{ model: Category, as: 'category', attributes: ['id', 'name'] }];
    if (req.query.category) {
      const catKey = String(req.query.category);
      include[0].where = /^\d+$/.test(catKey) ? { id: Number(catKey) } : { slug: catKey };
      include[0].required = true;
    }

    const sort = SORTS[req.query.sort] || SORTS.hot;
    const { count, rows } = await Novel.findAndCountAll({
      where,
      include,
      order: sort,
      limit: pageSize,
      offset,
      distinct: true,
    });

    res.ok(pagedResult(rows.map(serializeNovel), count, page, pageSize));
  } catch (err) {
    next(err);
  }
});

// GET /api/novels/:id 详情
router.get('/novels/:id', async (req, res, next) => {
  try {
    const novel = await Novel.findByPk(req.params.id, {
      include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
    });
    if (!novel) return res.fail(ErrorCodes.NOT_FOUND, '小说不存在');

    const chapterCount = await Chapter.count({ where: { novelId: novel.id } });
    res.ok({ ...serializeNovel(novel), chapterCount });
  } catch (err) {
    next(err);
  }
});

// GET /api/novels/:id/chapters 章节列表（不含正文，避免大响应）
// 每条带 locked 标记：未登录且超出试读章数 → true（前端据此显示「登录」角标）
router.get('/novels/:id/chapters', authOptional, async (req, res, next) => {
  try {
    const chapters = await Chapter.findAll({
      where: { novelId: req.params.id },
      order: [['chapterNo', 'ASC']],
      attributes: ['id', 'chapterNo', 'title', 'wordCount'],
    });
    res.ok(
      chapters.map((c) => {
        const item = c.toJSON();
        item.locked = isLockedFor(req.user, item.chapterNo);
        return item;
      })
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/ranking?type=week|month|total
// 说明：每周爬虫无阅读时序数据，week 用最近更新、month 用评分、total 用点击量作为排行依据
router.get('/ranking', async (req, res, next) => {
  try {
    const type = req.query.type || 'total';
    const key = `ranking:${type}`;
    const cached = cacheGet(key);
    if (cached) return res.ok(cached);

    const order =
      type === 'week' ? SORTS.new : type === 'month' ? SORTS.rating : SORTS.hot;
    const rows = await Novel.findAll({
      order,
      limit: 50,
      include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
    });
    const data = rows.map((n, i) => ({ rank: i + 1, ...serializeNovel(n) }));
    cacheSet(key, data);
    res.ok(data);
  } catch (err) {
    next(err);
  }
});

export default router;
