// 把本地 novel 库完整搬到云端 MySQL（云托管 MySQL / 腾讯云数据库 / 任何可连的 MySQL 8）
//
// 用法（参数优先，其次读环境变量）：
//   node scripts/migrate-db.mjs --host=10.0.0.5 --port=3306 --user=root --pass=xxxx --name=novel
//   TARGET_DB_HOST=... TARGET_DB_PASS=... node scripts/migrate-db.mjs
//
// 特性：
//   · 纯 Node 实现，不依赖 mysqldump/mysql 客户端
//   · 按外键顺序建表，复制期间关闭外键检查
//   · INSERT IGNORE，可重复执行（已存在的行不会覆盖）
//   · 结束后逐表比对行数
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

// 外键依赖顺序：父表在前
const TABLES = ['users', 'categories', 'novels', 'chapters', 'bookshelves'];
// 章节正文可能很长，批次过大会撑爆目标库的 max_allowed_packet
const BATCH = 50;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const target = {
  host: arg('host', process.env.TARGET_DB_HOST || ''),
  port: Number(arg('port', process.env.TARGET_DB_PORT || 3306)),
  user: arg('user', process.env.TARGET_DB_USER || 'root'),
  password: arg('pass', process.env.TARGET_DB_PASS || ''),
  database: arg('name', process.env.TARGET_DB_NAME || config.db.name),
};

if (!target.host) {
  console.error('缺少目标库地址。示例：node scripts/migrate-db.mjs --host=10.0.0.5 --user=root --pass=xxxx');
  process.exit(1);
}

const source = {
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.pass,
  database: config.db.name,
  multipleStatements: false,
};

const log = (...a) => console.log(...a);
const t0 = Date.now();

async function main() {
  log(`源库: ${source.host}:${source.port}/${source.database}`);
  log(`目标: ${target.host}:${target.port}/${target.database}`);

  const src = await mysql.createConnection(source);
  log('源库连接成功');

  // 先连到实例（不指定库），保证目标库存在
  const root = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    connectTimeout: 15000,
  });
  // 目标库版本决定排序规则：MySQL 5.7（含云托管 CynosDB 5.7）没有 utf8mb4_0900_ai_ci
  const [[vrow]] = await root.query('SELECT VERSION() AS v');
  const serverVersion = String(vrow.v || '');
  const major = parseInt(serverVersion, 10) || 0;
  const collate =
    arg('collate', '') || (major >= 8 ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_unicode_ci');
  log(`目标版本: ${serverVersion} → 排序规则 ${collate}`);

  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${target.database}\` CHARACTER SET utf8mb4 COLLATE ${collate}`
  );
  await root.end();
  log(`目标库就绪: ${target.database}`);

  const dst = await mysql.createConnection({ ...target, multipleStatements: true });
  log('目标库连接成功');

  await dst.query('SET FOREIGN_KEY_CHECKS=0');
  await dst.query('SET UNIQUE_CHECKS=0');

  const summary = [];

  for (const table of TABLES) {
    // 1) 建表：直接用源库的 DDL，保证索引与字段完全一致
    const [[ddlRow]] = await src.query(`SHOW CREATE TABLE \`${table}\``);
    // 源库 DDL 带 0900_ai_ci，目标库若是 5.7 需替换掉
    const ddl = ddlRow['Create Table']
      .replace(/utf8mb4_0900_ai_ci/g, collate)
      .replace(/^CREATE TABLE/, 'CREATE TABLE IF NOT EXISTS');
    await dst.query(ddl);

    // 2) 复制数据
    const [[{ total }]] = await src.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
    let copied = 0;

    if (total > 0) {
      const [cols] = await src.query(`SHOW COLUMNS FROM \`${table}\``);
      const names = cols.map((c) => c.Field);
      const colList = names.map((n) => `\`${n}\``).join(',');
      const placeholders = `(${names.map(() => '?').join(',')})`;

      for (let offset = 0; offset < total; offset += BATCH) {
        const [rows] = await src.query(
          `SELECT * FROM \`${table}\` ORDER BY 1 LIMIT ? OFFSET ?`,
          [BATCH, offset]
        );
        if (!rows.length) break;
        const values = rows.map((r) => names.map((n) => r[n]));
        const sql = `INSERT IGNORE INTO \`${table}\` (${colList}) VALUES ${rows
          .map(() => placeholders)
          .join(',')}`;
        const [res] = await dst.query(sql, values.flat());
        copied += res.affectedRows;
        process.stdout.write(`\r  · ${table}: ${Math.min(offset + rows.length, total)}/${total}`);
      }
      process.stdout.write('\n');
    }

    const [[{ now }]] = await dst.query(`SELECT COUNT(*) AS now FROM \`${table}\``);
    summary.push({ table, 源库: total, 新增: copied, 目标库: now });
    log(`  ${table}: 源 ${total} 行 → 新增 ${copied} 行，目标现有 ${now} 行`);
  }

  await dst.query('SET FOREIGN_KEY_CHECKS=1');
  await dst.query('SET UNIQUE_CHECKS=1');

  await src.end();
  await dst.end();

  console.log('\n=== 迁移结果 ===');
  console.table(summary);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n下一步：把云端环境变量指向新库，重启服务后在云托管日志里确认「数据库连接成功」。');
}

main().catch((e) => {
  console.error('\n迁移失败:', e.message);
  if (e.code) console.error('错误码:', e.code);
  process.exit(1);
});
