import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

// 连接到服务器（不带库名），若数据库不存在则创建 utf8mb4 库
export async function createDatabase() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.pass,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE ${config.db.collate}`
  );
  await conn.end();
}
