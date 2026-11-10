// 统一响应 { code, message, data } + 错误码表
export const ErrorCodes = {
  OK: 0,
  BAD_REQUEST: 1001,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 1002,
  INTERNAL: 500,
};

const send = (res, code, message, data) => {
  res.json({ code, message, data: data ?? null });
};

// 挂载 res.ok / res.fail
export const responseMiddleware = (req, res, next) => {
  res.ok = (data, message = 'ok') => send(res, ErrorCodes.OK, message, data);
  res.fail = (code, message, data = null) => send(res, code, message, data);
  next();
};

export const notFoundHandler = (req, res) => res.fail(ErrorCodes.NOT_FOUND, '接口不存在');

export const errorHandler = (err, req, res, next) => {
  // Sequelize 唯一约束冲突 → 幂等跳过，不报错
  if (err?.name === 'SequelizeUniqueConstraintError') {
    return res.fail(ErrorCodes.DUPLICATE, '数据已存在');
  }
  if (err?.type === 'entity.parse.failed') {
    return res.fail(ErrorCodes.BAD_REQUEST, '请求体格式错误');
  }
  console.error('[error]', err);
  res.fail(ErrorCodes.INTERNAL, err.message || '服务器异常');
};
