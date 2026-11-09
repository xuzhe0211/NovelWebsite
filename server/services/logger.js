import pino from 'pino';
import { config } from '../config/index.js';

// 终端始终输出；文件日志按 LOG_TO_FILE 开关（容器里关闭，交给平台采集 stdout）
const streams = [{ level: config.logLevel, stream: process.stdout }];

if (config.logFile) {
  try {
    streams.push({
      level: config.logLevel,
      stream: pino.destination({ dest: './logs/app.log', mkdir: true, sync: true }),
    });
  } catch (e) {
    // 只读文件系统或目录不可写时降级为纯 stdout，不影响服务启动
    process.stdout.write(`[logger] 文件日志不可用，仅输出到终端: ${e.message}\n`);
  }
}

export const logger = pino(
  { level: config.logLevel, base: undefined },
  pino.multistream(streams)
);

// 兼容旧引用
export const consoleLogger = logger;
