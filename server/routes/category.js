import { Router } from 'express';
import { Category } from '../models/index.js';
import { cacheGet, cacheSet } from '../services/cache.js';

const router = Router();

// GET /api/categories
router.get('/categories', async (req, res, next) => {
  try {
    const cached = cacheGet('categories');
    if (cached) return res.ok(cached);

    const categories = await Category.findAll({
      order: [['sortOrder', 'ASC']],
      attributes: ['id', 'name', 'slug', 'sortOrder'],
    });
    const data = categories.map((c) => c.toJSON());
    cacheSet('categories', data);
    res.ok(data);
  } catch (err) {
    next(err);
  }
});

export default router;
