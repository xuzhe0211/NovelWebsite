// 查看数据库抓取结果：node scripts/check-db.js
import { sequelize, Novel, Chapter, Category } from '../models/index.js';

async function main() {
  await sequelize.authenticate();
  const novels = await Novel.findAll({ order: [['id', 'DESC']], limit: 10 });
  if (!novels.length) {
    console.log('数据库里还没有小说，请先运行 npm run crawl');
  }
  for (const n of novels) {
    const count = await Chapter.count({ where: { novelId: n.id } });
    const cat = n.categoryId ? await Category.findByPk(n.categoryId, { attributes: ['name'] }) : null;
    console.log('----------------------------------------');
    console.log(`ID: ${n.id}  sourceId: ${n.sourceId}`);
    console.log(`书名: ${n.title}  作者: ${n.author}  分类: ${cat ? cat.name : '-'}`);
    console.log(`状态: ${n.status}  章节数: ${count}  字数: ${Number(n.wordCount)}`);
    console.log(`简介: ${(n.intro || '').slice(0, 60)}`);

    const first = await Chapter.findAll({
      where: { novelId: n.id },
      order: [['chapterNo', 'ASC']],
      limit: 5,
      attributes: ['chapterNo', 'title', 'content'],
    });
    for (const c of first) {
      const len = c.content ? c.content.replace(/\s/g, '').length : 0;
      console.log(`   ${c.chapterNo}. ${c.title}  (正文 ${len} 字)`);
    }
    if (first[0] && first[0].content) {
      console.log(`   正文样例: ${first[0].content.slice(0, 80).replace(/\n/g, ' ')}…`);
    }
  }
  await sequelize.close();
}

main().catch(async (e) => {
  console.error('检查失败:', e.message);
  await sequelize.close();
  process.exit(1);
});
