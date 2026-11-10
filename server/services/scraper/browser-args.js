// Chromium 启动参数的单一来源。
// 容器（云托管）以 root 运行，必须禁用沙箱；--disable-dev-shm-usage 避免 /dev/shm 过小导致渲染进程崩溃。
export const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

// 懒加载 playwright：只在真正需要浏览器时拉起
export async function launchBrowser(options = {}) {
  if (process.env.PW_DISABLED === '1') {
    throw new Error('当前镜像不含浏览器（Dockerfile.lite）：需要过 WAF 的第三方站点抓取不可用，七猫源不受影响');
  }
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: CHROMIUM_ARGS, ...options });
}
