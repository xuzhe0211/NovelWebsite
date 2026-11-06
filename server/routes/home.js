import { Router } from 'express';
import { Novel, Category } from '../models/index.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { serializeNovel } from '../utils/serialize.js';

const router = Router();

// GET /api/home 首页聚合：热门推荐、最近更新、分类入口
router.get('/home', async (req, res, next) => {
  try {
    const cached = cacheGet('home');
    if (cached) return res.ok(cached);

    const [hot, latest, categories] = await Promise.all([
      Novel.findAll({
        order: [['clickCount', 'DESC'], ['id', 'DESC']],
        limit: 10,
        include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
      }),
      Novel.findAll({
        order: [['lastUpdateTime', 'DESC'], ['id', 'DESC']],
        limit: 12,
        include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }],
      }),
      Category.findAll({ order: [['sortOrder', 'ASC']], attributes: ['id', 'name', 'slug'] }),
    ]);

    const data = {
      hot: hot.map(serializeNovel),
      latest: latest.map(serializeNovel),
      categories: categories.map((c) => c.toJSON()),
    };
    cacheSet('home', data);
    res.ok(data);
  } catch (err) {
    next(err);
  }
});

export default router;
