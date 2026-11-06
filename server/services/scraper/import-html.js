// 兜底：当无法自动抓取时，在浏览器里手动保存页面 HTML 后导入。
// 目录结构：
//   saved-html/
//     detail.html            # 小说详情/目录页
//     chapter-<章节ID>.html  # 各章节正文页（文件名用章节URL尾号）
// 用法：
//   npm run import-html -- --dir ./saved-html --book-id 12345 --source qimao
import fs from 'fs';
import path from 'path';
import { sequelize } from '../../models/index.js';
import { config } from '../../config/index.js';
import { consoleLogger as log } from '../logger.js';
import { getSource } from './sources.js';
import { parseNovelDetail, parseChapterList, parseChapter } from './parser.js';
import { upsertNovel, saveChapter, finalizeNovel } from './index.js';

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await sequelize.authenticate();
  const dir = path.resolve(process.cwd(), argValue('dir') || './saved-html');
  const bookId = argValue('book-id');
  const src = getSource(argValue('source') || config.crawl.source);

  if (!bookId) throw new Error('缺少 --book-id');
  const detailPath = path.join(dir, 'detail.html');
  if (!fs.existsSync(detailPath)) throw new Error(`找不到 ${detailPath}`);

  const detailHtml = fs.readFileSync(detailPath, 'utf-8');
  const info = parseNovelDetail(detailHtml, src);
  if (!info.title) throw new Error('detail.html 未能解析出书名');
  const chapterList = parseChapterList(detailHtml, src, bookId);
  if (!chapterList.length) throw new Error('detail.html 未能解析出章节列表');

  log.info({ source: src.key, bookId, title: info.title, chapters: chapterList.length }, '开始导入');
  const novel = await upsertNovel(info, bookId, src.key);

  let added = 0;
  let missing = 0;
  for (const ch of chapterList) {
    const file = path.join(dir, `chapter-${ch.sourceChapterId}.html`);
    if (!fs.existsSync(file)) {
      missing++;
      continue;
    }
    const html = fs.readFileSync(file, 'utf-8');
    const parsed = parseChapter(html, src);
    const created = await saveChapter(novel.id, ch, parsed);
    if (created) added++;
  }

  const total = await finalizeNovel(novel);
  log.info({ bookId, added, missing, total }, '导入完成');
  console.log(`导入完成：新增 ${added} 章，缺文件 ${missing} 章，共 ${total} 章`);

  await sequelize.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('导入失败:', e.message);
  await sequelize.close();
  process.exit(1);
});
