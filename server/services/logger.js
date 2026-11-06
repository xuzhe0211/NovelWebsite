import pino from 'pino';
import { config } from '../config/index.js';

// 同时输出到终端与文件，便于调试与留痕
const streams = [
  { level: config.logLevel, stream: process.stdout },
  {
    level: config.logLevel,
    stream: pino.destination({ dest: './logs/app.log', mkdir: true, sync: true }),
  },
];

export const logger = pino(
  { level: config.logLevel, base: undefined },
  pino.multistream(streams)
);

// 兼容旧引用
export const consoleLogger = logger;
