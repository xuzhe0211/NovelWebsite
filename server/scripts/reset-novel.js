// 删除某本书及其章节（用于重抓验证）：node scripts/reset-novel.js qimao:222767
import { sequelize, Novel, Chapter, Bookshelf } from '../models/index.js';

const sourceId = process.argv[2];
if (!sourceId) {
  console.error('用法: node scripts/reset-novel.js qimao:222767');
  process.exit(1);
}

const novel = await Novel.findOne({ where: { sourceId } });
if (novel) {
  await Chapter.destroy({ where: { novelId: novel.id } });
  await Bookshelf.destroy({ where: { novelId: novel.id } });
  await novel.destroy();
  console.log('已删除:', sourceId);
} else {
  console.log('未找到:', sourceId);
}
await sequelize.close();
