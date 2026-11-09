# 微信云托管镜像：Node 20 + Chromium（全网搜索需要过 WAF）
# 构建上下文是仓库根目录，所以所有路径都带 server/ 前缀
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=80 \
    TZ=Asia/Shanghai \
    PLAYWRIGHT_BROWSERS_PATH=/app/.browsers \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

WORKDIR /app

# 中文字体 + 时区；chromium 的系统依赖由 playwright install --with-deps 负责
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# 先装依赖，利用镜像层缓存
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 只装 Chromium（firefox/webkit 不装），--with-deps 会补齐 libnss3 等系统库
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY server/ ./

# 云托管以 root 运行，Chromium 必须带 --no-sandbox（已在代码里固定）
EXPOSE 80

CMD ["node", "app.js"]
