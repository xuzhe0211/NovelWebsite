#!/usr/bin/env bash
# ============================================================
#  本地开发启动器（macOS / Linux）—— 对应 Windows 的 start-dev.bat
#
#  做三件事：
#    1. 确保 MySQL 可用（优先复用已有实例，其次 Docker 容器）
#    2. 检查依赖（node_modules / Playwright Chromium）
#    3. 启动后端 API（npm run dev，改代码自动重启）
#
#  用法：
#    ./start-dev.sh              正常启动
#    ./start-dev.sh --skip-db    不起 MySQL，直连 .env 里已配好的库
#    ./start-dev.sh --prod       用 npm start 启动（不带 --watch）
# ============================================================
set -uo pipefail

cd "$(dirname "$0")" || exit 1
ROOT=$(pwd)
SERVER="${ROOT}/server"

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; NC=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
warn() { printf '%s!%s %s\n' "${YELLOW}" "${NC}" "$*"; }
die()  { printf '%s✗%s %s\n' "${RED}" "${NC}" "$*"; exit 1; }
step() { printf '\n%s%s%s\n' "${DIM}" "$*" "${NC}"; }

SKIP_DB=0
RUN_MODE=dev
for arg in "$@"; do
  case "${arg}" in
    --skip-db) SKIP_DB=1 ;;
    --prod) RUN_MODE=start ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：${arg}" ;;
  esac
done

# ---------- 读 server/.env ----------
env_get() {
  [ -f "${SERVER}/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "${SERVER}/.env" | tail -1 | tr -d '\r'
}

[ -f "${SERVER}/.env" ] || {
  warn "server/.env 不存在，从 .env.example 复制一份"
  cp "${SERVER}/.env.example" "${SERVER}/.env" || die "复制 .env 失败"
  warn "已生成 server/.env，按需修改 DB_* / WX_APPID / WX_SECRET 后重跑"
}

DB_HOST=$(env_get DB_HOST); DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=$(env_get DB_PORT); DB_PORT=${DB_PORT:-3306}
DB_PASS=$(env_get DB_PASS); DB_PASS=${DB_PASS:-root}
API_PORT=$(env_get PORT);   API_PORT=${API_PORT:-3000}
MYSQL_CONTAINER=${MYSQL_CONTAINER:-novel-mysql}

port_open() { nc -z -G 1 "$1" "$2" >/dev/null 2>&1; }

is_local_db() {
  case "${DB_HOST}" in
    127.0.0.1|localhost|::1) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- 1. MySQL ----------
start_mysql_container() {
  command -v docker >/dev/null 2>&1 || {
    die "未找到 docker。两种选择：装 Docker Desktop，或本地装 MySQL 后把 server/.env 的 DB_HOST/DB_PORT 指过去"
  }

  if ! docker info >/dev/null 2>&1; then
    warn "Docker 未运行，正在启动 Docker Desktop（首次可能要 30~60 秒）..."
    open -a Docker >/dev/null 2>&1 || die "无法启动 Docker Desktop，请手动打开后重试"
    for _ in $(seq 1 40); do
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
    docker info >/dev/null 2>&1 || die "Docker 启动超时，请手动打开 Docker Desktop 后重试"
  fi
  ok "Docker 已就绪"

  if docker ps -a --format '{{.Names}}' | grep -qx "${MYSQL_CONTAINER}"; then
    docker start "${MYSQL_CONTAINER}" >/dev/null 2>&1 || die "启动容器 ${MYSQL_CONTAINER} 失败（docker logs ${MYSQL_CONTAINER} 看原因）"
    ok "已启动已有容器 ${MYSQL_CONTAINER}"
  else
    info_create="创建 MySQL 容器 ${MYSQL_CONTAINER}（mysql:8，首次需拉镜像）..."
    warn "${info_create}"
    docker run --name "${MYSQL_CONTAINER}" \
      -e MYSQL_ROOT_PASSWORD="${DB_PASS}" \
      -e MYSQL_DATABASE=novel \
      -p "${DB_PORT}:3306" \
      -d mysql:8 >/dev/null || die "创建容器失败，检查 ${DB_PORT} 是否被占用"
    ok "容器已创建：${MYSQL_CONTAINER}（root / ${DB_PASS}，库 novel）"
  fi
}

if [ "${SKIP_DB}" -eq 1 ]; then
  step "[1/3] 跳过 MySQL 检查（--skip-db），直连 ${DB_HOST}:${DB_PORT}"
elif port_open "${DB_HOST}" "${DB_PORT}"; then
  step "[1/3] MySQL 已在 ${DB_HOST}:${DB_PORT} 运行"
  ok "复用现有实例"
elif is_local_db; then
  step "[1/3] 本机 ${DB_PORT} 未监听，改用 Docker 启动 MySQL"
  start_mysql_container
  for _ in $(seq 1 40); do port_open "${DB_HOST}" "${DB_PORT}" && break; sleep 1; done
  port_open "${DB_HOST}" "${DB_PORT}" || die "MySQL 端口 ${DB_PORT} 一直未就绪，看 docker logs ${MYSQL_CONTAINER}"
  ok "MySQL 已就绪（${DB_HOST}:${DB_PORT}）"
else
  die "远端库 ${DB_HOST}:${DB_PORT} 连不上：确认地址、防火墙/白名单，或改成 127.0.0.1 用本地 Docker 库"
fi

# ---------- 2. 依赖 ----------
step "[2/3] 检查依赖"
if [ ! -d "${SERVER}/node_modules" ]; then
  warn "server/node_modules 不存在，执行 npm install ..."
  ( cd "${SERVER}" && npm install ) || die "npm install 失败"
fi
ok "依赖已安装"

PW_DIR="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/Library/Caches/ms-playwright}"
if [ -d "${PW_DIR}" ] && ls "${PW_DIR}" 2>/dev/null | grep -q '^chromium'; then
  ok "Playwright Chromium 已安装"
else
  warn "未检测到 Chromium（只影响全网搜索/在线导入，不影响已有书阅读）"
  warn "需要时执行：cd server && npx playwright install chromium"
fi

# ---------- 3. API ----------
step "[3/3] 启动后端 API"
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
printf '  本机      http://127.0.0.1:%s/api/health\n' "${API_PORT}"
if [ -n "${LAN_IP}" ]; then
  printf '  局域网    http://%s:%s/api/health   %s(真机/手机预览用这个)%s\n' "${LAN_IP}" "${API_PORT}" "${DIM}" "${NC}"
fi
printf '  退出      Ctrl+C\n\n'

cd "${SERVER}" || exit 1
if [ "${RUN_MODE}" = "prod" ]; then
  exec npm start
else
  exec npm run dev
fi
