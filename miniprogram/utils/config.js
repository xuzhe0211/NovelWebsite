// 后端服务地址：开发期用本机地址，需在微信开发者工具勾选「不校验合法域名」
// 真机调试请改为电脑局域网 IP，如 http://192.168.1.10:3000；上线改为备案 HTTPS 域名
module.exports = {
	BASE_URL: 'http://192.168.1.111:3000',
	PAGE_SIZE: 20,
	// 后端未启动 / 数据库为空时的演示数据兜底。
	// 上线前请改为 false：届时所有页面只展示真实接口数据。
	ENABLE_DEMO: true,
	// 外链封面是否经后端 /api/cover 代理加载（绕开站点防盗链与域名白名单限制）
	USE_COVER_PROXY: true,
	// 封面是否改走 data URI（base64）内联：
	// 微信 3.8.7+ 的 image 组件在开发版/体验版不再加载 http:// 图片，
	// 真机预览（未开调试）会静默空白；用 wx.request 取 base64 再塞给 <image>
	// 可以完全避开这条限制。后端 /api/cover?b64=1&w=300 已支持缩放压缩。
	COVER_INLINE: true
};
