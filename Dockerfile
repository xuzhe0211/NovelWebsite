# 微信云托管镜像：Node 20 + Chromium headless shell（全网搜索要过 WAF）
# 构建上下文是仓库根目录，所以所有路径都带 server/ 前缀
#
# ⚠️ 体积与推送：实测镜像 1.31GB，压缩后约 430MB。云托管构建机推 TCR 只有 ~3MB/s，
#    `install-deps`（约 130MB）与浏览器（约 125MB）两层并发上传时，其中一层经常
#    `net/http: timeout awaiting response headers` 而整体失败。
#    所以本文件是「功能完整版」，上线先用 Dockerfile.lite。
#    压体积的三处处理：只装 headless shell、系统依赖与浏览器分两层、清下载缓存。
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=80 \
    TZ=Asia/Shanghai \
    PLAYWRIGHT_BROWSERS_PATH=/app/.browsers \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# 中文字体 + 时区
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# 先装依赖，利用镜像层缓存（PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 防止 npm 阶段重复下载浏览器）
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /root/.npm /tmp/*

# Chromium 需要的系统库（单独一层，避免与浏览器下载合成一个超大层）
RUN npx playwright install-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# 只装 headless shell：代码里一律 headless，用不到有头 Chrome；ffmpeg 用不上，删掉
RUN npx playwright install chromium --only-shell \
 && rm -rf /root/.cache /tmp/* /app/.browsers/ffmpeg-*

COPY server/ ./

# 云托管以 root 运行，Chromium 必须带 --no-sandbox（已在代码里固定）
EXPOSE 80

CMD ["node", "app.js"]
