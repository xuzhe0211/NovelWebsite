import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { ErrorCodes } from './response.js';

// JWT 鉴权中间件：解析 Authorization: Bearer <token>，挂载 req.user
export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.fail(ErrorCodes.UNAUTHORIZED, '未登录');
  try {
    req.user = jwt.verify(token, config.jwt.secret);
    next();
  } catch {
    res.fail(ErrorCodes.UNAUTHORIZED, '登录已过期，请重新登录');
  }
}

// 可选鉴权：有 token 则解析，无则放行（首页等接口可带可不带）
export function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      req.user = jwt.verify(token, config.jwt.secret);
    } catch {
      req.user = null;
    }
  }
  next();
}
