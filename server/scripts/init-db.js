// 初始化：创建数据库（若不存在）+ 同步表结构 + seed 分类
import { createDatabase } from '../models/db-create.js';
import { sequelize, Category } from '../models/index.js';
import { categories } from '../seed/categories.js';
import { consoleLogger as log } from '../services/logger.js';

async function main() {
  await createDatabase();
  await sequelize.authenticate();
  log.info('数据库连接成功');

  await sequelize.sync({ alter: true });
  log.info('表结构同步完成');

  for (const c of categories) {
    await Category.findOrCreate({ where: { slug: c.slug }, defaults: c });
  }
  log.info(`分类 seed 完成：${categories.length} 个`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[init-db] 失败', err);
  process.exit(1);
});
