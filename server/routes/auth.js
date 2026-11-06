import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
import { config } from '../config/index.js';
import { codeToOpenid } from '../services/wechat.js';
import { ErrorCodes } from '../middleware/response.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/login  { code, deviceId } -> { token, user }
router.post('/login', async (req, res, next) => {
	try {
		const { code, deviceId } = req.body || {};
		if (!code) return res.fail(ErrorCodes.BAD_REQUEST, '缺少 code');
		const openid = await codeToOpenid(code, deviceId);

		const [user] = await User.findOrCreate({ where: { openid } });
		// 新用户没有昵称时给一个默认名，避免前端显示空白/「微信用户」
		if (!user.nickname) {
			await user.update({
				nickname: `书友${String(user.id).padStart(4, '0')}`
			});
		}
		const token = jwt.sign({ userId: user.id, openid }, config.jwt.secret, {
			expiresIn: config.jwt.expires
		});
		res.ok({
			token,
			user: { id: user.id, nickname: user.nickname, avatar: user.avatar }
		});
	} catch (err) {
		next(err);
	}
});

// PUT /api/auth/profile  { nickname, avatar } -> 更新后的用户资料
router.put('/profile', authRequired, async (req, res, next) => {
	try {
		const { nickname, avatar } = req.body || {};
		const patch = {};
		if (typeof nickname === 'string' && nickname.trim()) {
			patch.nickname = nickname.trim().slice(0, 20);
		}
		if (typeof avatar === 'string' && /^https?:\/\//i.test(avatar)) {
			patch.avatar = avatar.slice(0, 512);
		}
		if (!Object.keys(patch).length) {
			return res.fail(ErrorCodes.BAD_REQUEST, '没有需要更新的内容');
		}

		const user = await User.findByPk(req.user.userId);
		if (!user) return res.fail(ErrorCodes.NOT_FOUND, '用户不存在');
		await user.update(patch);
		res.ok({ id: user.id, nickname: user.nickname, avatar: user.avatar });
	} catch (err) {
		next(err);
	}
});

// GET /api/auth/profile  需登录
router.get('/profile', authRequired, async (req, res, next) => {
	try {
		const user = await User.findByPk(req.user.userId);
		if (!user) return res.fail(ErrorCodes.NOT_FOUND, '用户不存在');
		res.ok({ id: user.id, nickname: user.nickname, avatar: user.avatar });
	} catch (err) {
		next(err);
	}
});

export default router;
