import { config } from '../config/index.js';

/**
 * 未登录试读判定
 * @param {object|null} user     authOptional 解析出的 req.user（为空即未登录）
 * @param {number} chapterNo     章节序号（从 1 开始）
 * @returns {boolean}            true=需要登录才能看
 *
 * 规则：FREE_CHAPTERS=0 时不限制；已登录用户全部放行；
 * 未登录时 chapterNo <= FREE_CHAPTERS 可读。
 */
export function isLockedFor(user, chapterNo) {
  const limit = config.freeChapters;
  if (!limit) return false;
  if (user) return false;
  return Number(chapterNo) > limit;
}
