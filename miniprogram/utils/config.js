// 运行环境配置
//
// MODE:
//   'local' —— 走 wx.request 直连后端（开发期用，需在开发者工具勾选「不校验合法域名」）
//   'cloud' —— 走 wx.cloud.callContainer 调微信云托管（上线用：免域名、免备案、免 HTTPS 配置）
//
// 2026-11-10 已切到 'cloud'（环境 prod-d8g08o83h02a961c3 / 服务 nove-service）。
// 切回本地开发：MODE='local' + ENABLE_DEMO=true，并确认 BASE_URL 指向本机后端。
// 依赖：小程序基础库 ≥ 2.23.0（callContainer）。
const MODE = 'cloud';

module.exports = {
	MODE,
	// 仅 local 模式使用。真机调试请改成电脑局域网 IP，如 http://192.168.1.10:3000
	BASE_URL: 'http://127.0.0.1:3000',
	// 仅 cloud 模式使用：云托管环境 ID（形如 prod-1gxxxxxx）与服务名
	// ⚠️ 环境 ID 请从控制台「设置 → 环境信息」点复制按钮取得，**不要手打**：
	//    顶部下拉显示的是环境名（prod），不是 ID；ID 抄错一个字符的表现就是 callContainer 报
	//    404 INVALID_HOST（不是 -601027），非常容易被误判成「环境没开通」。
	// ⚠️ 该环境必须由本小程序（wx3de365140274c5f6）自己开通：跨主体不支持「资源复用」，
	//    环境不属于本小程序时 callContainer 永远 404 INVALID_HOST（已实踩）。
	CLOUD_ENV: 'prod-d8g08o83h02a961c3',
	CLOUD_SERVICE: 'nove-service',
	// 云托管服务的公网 HTTPS 域名（控制台「服务设置 → 访问域名」里可查）
	// ✅ callContainer 通了就不需要它；留空即可，只有「绑了自己备案域名」时才填。
	CLOUD_BASE_URL: '',

	// 云端走哪条链路（MODE === 'cloud' 时生效）：
	//   'auto'      —— 先 callContainer（官方唯一「免域名」方式），一旦确认 host/服务路由不通，
	//                  本次运行内自动降级为 wx.request 打 CLOUD_BASE_URL，后续请求不再试容器。
	//   'container' —— 只用 callContainer。
	//   'request'   —— 只用 wx.request 打 CLOUD_BASE_URL。
	//                  ⚠️ 云托管**默认公网域名无法加入小程序 request 合法域名**（官方明确限制），
	//                  所以这个取值只有在「给云托管绑定了自己的已备案域名」后才有意义。
	CLOUD_VIA: 'auto',

	// callContainer 报 INVALID_HOST / 找不到服务时，是否改用上面的公网域名请求。
	// 只在 CLOUD_VIA 为 'auto' / 'container' 时生效；公网域名仍受限（见上）。
	CLOUD_HTTP_FALLBACK: true,

	PAGE_SIZE: 20,
	// 后端未启动 / 数据库为空时的演示数据兜底。
	// 上线前请改为 false：届时所有页面只展示真实接口数据。
	ENABLE_DEMO: false,
	// 外链封面是否经后端 /api/cover 代理加载（绕开站点防盗链与域名白名单限制）
	USE_COVER_PROXY: true,
	// 封面是否改走 data URI（base64）内联：
	// 微信 3.8.7+ 的 image 组件在开发版/体验版不再加载 http:// 图片，
	// 真机预览（未开调试）会静默空白；用 wx.request 取 base64 再塞给 <image>
	// 可以完全避开这条限制。后端 /api/cover?b64=1&w=300 已支持缩放压缩。
	COVER_INLINE: true
};
