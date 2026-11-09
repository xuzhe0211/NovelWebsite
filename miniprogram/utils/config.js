// 运行环境配置
//
// MODE:
//   'local' —— 走 wx.request 直连后端（开发期用，需在开发者工具勾选「不校验合法域名」）
//   'cloud' —— 走 wx.cloud.callContainer 调微信云托管（上线用：免域名、免备案、免 HTTPS 配置）
//
// 切到 cloud 前需完成：
//   1. 云托管控制台创建环境与服务（服务名即 CLOUD_SERVICE）
//   2. 把环境 ID 填进 CLOUD_ENV
//   3. 小程序基础库 ≥ 2.23.0（callContainer 依赖）
const MODE = 'local';

module.exports = {
	MODE,
	// 仅 local 模式使用。真机调试请改成电脑局域网 IP，如 http://192.168.1.10:3000
	BASE_URL: 'http://127.0.0.1:3000',
	// 仅 cloud 模式使用：云托管环境 ID（形如 prod-1gxxxxxx）与服务名
	CLOUD_ENV: 'prod-d4ghyygv32488a832',
	CLOUD_SERVICE: 'koa-ia9w',
	// 云托管服务的公网 HTTPS 域名（控制台「服务设置 → 访问域名」里可查）
	// 接口调用走 callContainer 不需要它；只有 <image> 直连图片/静态资源时才用到
	CLOUD_BASE_URL: '',

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
