# 部署到微信云托管

目标：小程序不配服务器域名、不备案，直接通过 `wx.cloud.callContainer` 内网调用后端。
代码侧的适配已经完成，本文是按顺序执行的上线清单。

---

## 0. 前置条件

| 项 | 说明 |
|---|---|
| 小程序认证 | 云托管要求小程序主体信息完备（个人主体需微信认证，30 元） |
| 基础库 | 小程序端需 ≥ 2.23.0（`wx.cloud.callContainer` 依赖） |
| 本地能跑通 | `npm run smoke` 全绿（已确认） |
| 配置自检 | `cd server && npm run check:cloud` 无 ✗ 项 |

### 0.1 先跑自检，别等构建失败

```bash
cd server && npm run check:cloud
```

它把整条链路（镜像构建 → 容器端口 → 运行期开关 → 小程序调用配置 → 数据迁移）静态核对一遍，
不连数据库、不需要 Docker，10 秒出结果。输出三档：`✓` 通过、`!` 需人工确认、`✗` 必须修（退出码 1）。

当前项目的自检结论（2026-11-10）：

| 检查项 | 状态 |
|---|---|
| Dockerfile / container.config.json / package-lock | ✓ 齐备 |
| 端口 80 三处一致（containerPort / `PORT` / `EXPOSE`） | ✓ |
| 1 核 2G、最小实例 0、启动延迟 10s | ✓ |
| `npm ci` 锁文件与 package.json 同步（13 个依赖） | ✓ |
| `.dockerignore` 排除 `.env` / `node_modules` / playwright profile / `*.zip` | ✓ |
| 服务端连库重试、`/api/health`、SIGTERM 优雅退出 | ✓ |
| `transport.js` 的 `callContainer` + `X-WX-SERVICE` | ✓ |
| `ENABLE_CRON` 默认 true | ! 云端必须用环境变量关掉 |
| `TRUST_PROXY` 默认 false | ! 云端必须用环境变量打开 |
| 小程序 `MODE` 仍是 `local` | ! 上线前改 `cloud` |
| `CLOUD_BASE_URL` 为空 | ! 静态图无法直连（base64 封面不受影响） |
| 云库数据 | ✓ 已迁至 CynosDB（85 本 / 4424 章 / 8 用户 / 15 分类 / 6 条书架，16.2s） |
| 云托管环境 | ✓ `prod-d8g08o83h02a961c3`（**由小程序 `wx3de365140274c5f6` 自己开通**，同主体） |
| 服务 `nove-service` 线上版本 | ✓ `nove-service-007` 曾在旧环境跑通；新环境待发布（见 6.3.2） |

> 2026-11-10 14:40 **换到新环境 `prod-d8g08o83h02a961c3`**：旧环境 `prod-d2gmec6wl77c62d83`
> 与小程序属**不同主体**（控制台「资源复用」直接红字「不同主体不支持资源复用」），
> `callContainer` 永远 404 `INVALID_HOST`，默认公网域名又不允许加进 request 白名单 —— 两头堵死，只能换环境。
> 旧环境里的服务名同样是 `nove-service`，所以代码只需改 `CLOUD_ENV` 一行。

## 1. 开通云托管并创建环境

1. 微信开发者工具右上角「云托管」→ 开通；
2. 创建环境：地域选 **上海** 或 **广州**（离用户近），环境 ID 记下来（形如 `prod-1gxxxxxx`）；
3. 在环境里**新建服务**，服务名即 `CLOUD_SERVICE`（控制台里叫什么就填什么，两边必须一字不差；本项目为 **`nove-service`**，环境 `prod-d8g08o83h02a961c3`）；
4. 服务设置：端口 **80**，CPU **1 核**，内存 **2 GB**（Chromium 需要至少 2G，1G 会 OOM），最小实例 **0**（省钱），最大实例 5。

> 仓库根目录的 `container.config.json` 已经写好了上述参数，上传时工具会自动读。

## 2. 准备数据库

本项目已用**腾讯云 CynosDB（MySQL 5.7）**，两个地址要分清：

| 用途 | 地址 | 端口 | 谁用 |
|---|---|---|---|
| **内网** | `10.5.110.101` | 3306 | 云托管容器（同一 VPC 时可用，能省流量费、降 10~40ms；**未验证**，见 6.3.2） |
| **外网** | `sh-cynosdbmysql-grp-ak4ysgny.sql.tencentcdb.com` | 23729 | 当前容器实际在用（已验证）+ 本地迁移脚本 |

- 账号 `root`，密码单独保管（不要写进仓库，`server/.env.cloud` / `server/.cloudrun-env.json` 已被忽略）；
- 库名 `novel`，由迁移脚本自动创建；
- 5.7 没有 `utf8mb4_0900_ai_ci`，`migrate-db.mjs` 会按目标版本自动降级为 `utf8mb4_unicode_ci`；
- 若本地连外网地址超时，去 CynosDB 控制台把本机公网 IP 加进**白名单**（云托管走外网连库时需放通任意 IP）。

### 2.1 容器报 `Access denied for user 'root'@'10.4.7.xx'`（2026-11-10 实踩）

```
[server] 数据库连接失败（第 1/6 次）: Access denied for user 'root'@'10.4.7.202' (using password: YES)
[server] 数据库不可用，进程退出（容器会自动重启）
```

**先读错误再动手**：`Access denied` 说明 TCP 已经到达 MySQL（网络/VPC 是通的），
问题只在「账号 / 密码 / 来源主机」三者之一。若是网络不通，报的会是 `ETIMEDOUT` / `ECONNREFUSED`。

排查顺序：

0. **先读指纹行**（2026-11-10 新增）。容器启动第一行会打出：

   ```
   [server] 准备连库：目标 root@10.4.111.146:3306/novel · 密码来源 DB_PASS · 密码长度 15 · 首字符 "x" · 末字符 "3" · 含空白字符 false · 密码形状 aaaaa-999999999
   ```

   对照本地 `server/.env.cloud`（`npm run dev:cloud` 也打同一行）：**长度、首尾字符、含空白、密码形状** 必须一致。
   - `密码来源 = 未配置 → 默认值` → 环境变量名写错或保存后没换成新版本（会拿 `root` 当密码去连）；
   - `密码来源 = MYSQL_PASSWORD（回退）` → `DB_PASS` 没生效，代码退到了模板变量；
   - `含空白字符 true` 或长度比本地多 1~2 → 粘贴时带了空格/换行，删掉重打（**不要复制粘贴**）；
   - `密码形状` 里出现 `?`（本应是 `aaaaa-999999999`）→ 中间混了全角减号/中文破折号，肉眼几乎看不出。

1. **网络是通的**：`Access denied` 说明 TCP 已到达 MySQL；网络不通会报 `ETIMEDOUT` / `ECONNREFUSED`。
   所以别去改安全组、别去打通 VPC，问题只在「账号 / 密码 / 来源主机」。
2. **密码本身已排除**：本机 `npm run dev:cloud` 用外网地址 + 同一个 `DB_PASS` 能连
   （实测 `root@%` 存在、`mysql_native_password`、对 `*.*` 权限齐全、版本 `5.7.18-cynos-2.1.14-log`），
   所以别反复重置密码。
3. **来源主机**：CynosDB → 实例 → **账号管理**，看 `root` 的「主机」列。
   本实例确认是 `%`，若不慎被限制成 `10.4.111.%` 或具体 IP，容器（`10.4.7.x`）就会被拒；
   CynosDB 5.7 多数不允许改主机，那就新建账号（见下）。
4. **权限范围**：账号需对 `novel` 库有 `SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES`。
5. 顺手确认容器与数据库在**同一个 VPC / 同一地域**（不同 VPC 要配「内网互通」，且报错会是超时不是拒绝）。

#### 指纹全对上却仍被拒 → 先怀疑「连错实例」

2026-11-10 11:33 实测：容器日志显示 `密码来源 DB_PASS · 密码长度 15 · 首字符 "x" · 末字符 "3" · 含空白字符 false`，
与本机**完全一致**，仍然 `Access denied`。而 `root@%` 是全局放行的、密码本机可验证 —— 那么剩下的变量只有一个：
**请求到的 MySQL 不是那台有数据的实例**。

CynosDB 的内网地址和外网域名必须属于**同一个实例**，控制台「实例详情」页会同时列出两者。
本项目有数据的实例，其特征是外网地址为
`sh-cynosdbmysql-grp-qcog9b86.sql.tencentcdb.com:24246`；要填进 `DB_HOST` 的，是**这台实例自己**的内网地址
（形如 `10.4.x.y:3306`），不是另一台实例的。辨识方法：在该实例的「SQL 窗口」执行

```sql
SELECT @@hostname, @@version, (SELECT COUNT(*) FROM novel.chapters) AS chapters;
```

有数据的实例应返回 `chapters = 4424`、版本 `5.7.18-cynos-*`。

**一分钟 A/B 验证（不用重新部署）**：把 `DB_HOST` 临时改成外网域名、`DB_PORT=24246`，保存后看日志：

| 结果 | 结论 |
|---|---|
| `数据库连接成功` | 内网地址填错了（或该内网路径不通）；服务可先用外网地址跑起来 |
| 仍 `Access denied` | 才轮到密码中间字符的问题（看「密码形状」是否为 `aaaaa-999999999`） |
| `Host '10.4.7.x' is not allowed` | 外网白名单没放通容器网段，去 CynosDB 开外网访问/加白名单 |

建专用账号（比继续用 root 好，容器只碰 `novel` 一个库）：

```sql
-- 在 CynosDB 控制台「SQL 窗口」或本地 mysql 客户端执行
CREATE USER 'novel'@'%' IDENTIFIED BY '<新密码>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES ON novel.* TO 'novel'@'%';
FLUSH PRIVILEGES;
```

然后把环境变量改成 `DB_USER=novel` / `DB_PASS=<新密码>`（`DB_NAME` 也建议显式写 `novel`，别依赖默认值），
保存后新实例会自动重启。若 5.7 提示 `Unknown column` 之类老版本限制，改用 `GRANT ALL PRIVILEGES ON novel.* TO ...`。

> 也可以换成云托管自带 MySQL，代价是约 246 元/月；外部 CynosDB 通常几十元。

### 2.2 内网地址不通时的兜底：容器直连外网地址（**已用于 007 版本**）

2026-11-10 12:35，`nove-service-007` 把 `DB_HOST` 改成外网域名后一次成功：

```
[server] 准备连库：目标 root@sh-cynosdbmysql-grp-qcog9b86.sql.tencentcdb.com:24246/novel · ... · 密码形状 aaaaa-999999999
[server] 数据库连接成功（第 1 次尝试）
[server] API 已启动，监听端口 80
```

| 变量 | 当时的坑 | 现状（007） |
|---|---|---|
| `DB_HOST` | `10.4.111.146` 连上去被 `Access denied`（该 IP 不是这台实例的内网地址） | `sh-cynosdbmysql-grp-qcog9b86.sql.tencentcdb.com` |
| `DB_PORT` | `3306` | `24246` |

**代价**：走公网，比内网多 10~40ms 延迟，且 CynosDB 外网流量计费；MySQL 协议本身不加密（除非开 SSL）。
**安全前提**：既然容器要从公网连进来，CynosDB 的「外网访问」白名单就不能只放自己家 IP，
通常得放 `0.0.0.0/0` —— 这等于把 `root` 暴露在公网上。所以至少要做一件事：

1. 建专用账号（见下），别再用 `root`；
2. 有条件时把白名单收窄到云托管的 NAT 出口 IP 段；
3. 后续有空再把 `DB_HOST` 换回**正确的那台实例的内网地址**（实例详情页里同时列内外网），换回后延迟和费用都会降。

## 3. 配置环境变量

云托管控制台 → 服务 → 版本配置 → 环境变量：

| 变量 | 值 | 必填 |
|---|---|---|
| `DB_HOST` | `sh-cynosdbmysql-grp-ak4ysgny.sql.tencentcdb.com`（外网；内网 `10.5.110.101` 未验证连通） | ✅ |
| `DB_PORT` | `23729`（内网为 3306） | ✅ |
| `DB_NAME` | novel | ✅ |
| `DB_USER` | root | ✅ |
| `DB_PASS` | CynosDB 密码 | ✅ |
| `JWT_SECRET` | 强随机串（**不要用本地那个**） | ✅ |
| `WX_APPID` | wx3de365140274c5f6 | ✅ |
| `WX_SECRET` | 小程序 AppSecret | ✅ |
| `NODE_ENV` | production | ✅ |
| `PORT` | 80 | ✅ |
| `TRUST_PROXY` | true | ✅ |
| `LOG_TO_FILE` | false | ✅ |
| `ENABLE_CRON` | false | ✅ |
| `FREE_CHAPTERS` | 10（未登录试读章数，0=不限制；不填即默认 10） | 可选 |

`ENABLE_CRON=false` 是必须的：容器多实例 + 缩容到 0，内置 cron 会重复跑或漏跑。

> **用「官方模板」创建服务时会自带 5 个变量**（`COS_BUCKET`、`COS_REGION`、`MYSQL_ADDRESS`、
> `MYSQL_USERNAME`、`MYSQL_PASSWORD`）。注意 `MYSQL_PASSWORD` 是模板的占位值，
> **不是 CynosDB 的真实密码**（实测 `uUB29n5m` 登录被拒），必须改。
> 代码已做兼容：`DB_*` 优先，没配才回退到 `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD`
> （见 `server/config/index.js`），所以两种写法都能跑，但**推荐按上表显式配 `DB_*`**，最不容易踩坑。

两个密钥的来源：

```bash
# JWT_SECRET：本地随机生成，不要复用仓库里那个 "change-me..."
openssl rand -hex 32
```

**WX_SECRET**（小程序 AppSecret）：`https://mp.weixin.qq.com` → 登录小程序 → 开发管理 → 开发设置 →
开发者ID → AppSecret「生成/重置」。**只显示一次**，重置后旧值立即失效（会让本地 `server/.env`
里的旧值失效，记得同步）。当前本地 `.env` 已有一份可用值，云端直接填同一个即可。

## 4. 上传部署

开发者工具「云托管」面板 → 选**仓库根目录**（有 `Dockerfile` 的那层）→ 上传代码包。
云端构建，本地不需要 Docker。

### 4.0 控制台「部署发布」页怎么填（新服务 `nove-service`）

新服务第一次发布时，页面默认停在这一步，按下面改：

| 表单项 | 填什么 | 说明 |
|---|---|---|
| 选择方式 | **上传代码包 / 本地代码** | ⚠️ 默认可能是「从镜像仓库拉取镜像」，必须改掉：镜像仓库里目前没有任何本项目镜像（003/005 都卡在推送阶段） |
| 代码包 | `novel-api-deploy.zip`（116KB） | 根目录已备好，内含 `Dockerfile.lite` + `container.config.json` |
| 端口 | `80` | 与 `container.config.json` 的 `containerPort`、`PORT` 一致 |
| 规格 | 1 核 2G / 最小实例 0 | 精简版 1 核 1G 也能跑，但 2G 更稳 |

上传后先点「发布」，构建大约 1~2 分钟；**密码类环境变量可以后加**，但 `DB_*` 没配的话
容器会连 `127.0.0.1:3306` 失败并退出，所以第一次发布前就把第 3 节的变量填上最省事。

仓库根目录有两个现成包，**先传第一个**：

| 包 | 用哪个 Dockerfile | 体积/构建 | 能力 |
|---|---|---|---|
| `novel-api-deploy.zip` | `Dockerfile.lite` | 镜像 ~330MB，构建 1~2 分钟 | 阅读/登录/书架/目录全可用，**抓取类接口不可用** |
| `novel-api-deploy-full.zip` | `Dockerfile` | 镜像 1.31GB，构建 5~8 分钟 | 全部功能（含 Chromium，可过 WAF） |

> 为什么默认先上精简版：完整版在**推送镜像到 TCR** 这一步反复超时（见 4.1），
> 而精简版 20 秒就能推完。先让服务上线，抓取功能后续再单独解决。

构建失败常见原因：
- `npm ci` 报锁文件不一致 → 本地在 `server/` 执行 `npm install` 重新生成 `package-lock.json` 再传；
- 内存不足 → 构建规格调到 2G。

### 4.1 构建成功但推送失败（`timeout awaiting response headers`）

2026-11-10 连续两次踩到，两次都**构建全成功、推送阶段挂**：

| 版本 | 镜像 | 失败层 | 现象 |
|---|---|---|---|
| `express-pnpz-003` | 1.99GB（单层 apt+完整 Chrome） | ~1GB 那层 | 等 3 分半超时 |
| `express-pnpz-005` | 1.31GB（已瘦身） | 浏览器层 ~125MB | 62 秒无响应头 |

```
failed commit on ref "layer-sha256:2fec3e5bb672...":
failed to do request: Put "https://ccr.ccs.tencentyun.com/...": net/http: timeout awaiting response headers
```

关键线索在 005 的时间线：同时开推的两个大层里，apt 依赖层（约 130MB）用了 **39 秒**推完
（≈3.3MB/s），浏览器层（约 125MB）**62 秒没拿到响应头**被判失败。也就是说构建机到
TCR 的上行带宽只有 3MB/s 上下，**两个大层并发就会有一层被挤死**，跟层大小是否"超大"关系不大。

已做的瘦身（`Dockerfile`，无法根治推送）：

1. 浏览器只装 headless shell：`npx playwright install chromium --only-shell`（省掉完整 Chrome ~450MB）；
2. `install-deps` 与浏览器下载**拆成两层**，最大层从 ~1GB 降到 ~130MB；
3. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` + 清 `/root/.cache`、`/root/.npm`、ffmpeg。

结论：**要上线就用 `Dockerfile.lite`**（`container.config.json` 的 `dockerfilePath` 当前已是它）。
精简版能力（2026-11-10 用 `PW_DISABLED=1` 实测过）：

| 功能 | 精简版 |
|---|---|
| 登录 / 书架 / 分类 / 首页 / 目录 / 阅读 / 字符统计 | ✅ 正常（连的是云库 4424 章） |
| 全网搜索（七猫源，`/api/online/search`） | ✅ 返回 2172 条结果（走 HTTP API，不依赖浏览器） |
| 七猫详情 / 目录 / 导入、七猫书补章 | ✅ 正常 |
| 粘贴第三方链接（69shuba、xbiquge 等需要过 WAF 的站） | ⚠️ 返回明确错误：`当前镜像不含浏览器（Dockerfile.lite）…` |
| 已入库的 69shuba 书（如 id=97《凡人修仙传》）补章 | ⚠️ 同上，需在**本机**跑补章后 `npm run db:migrate` 同步 |

容器里 `PW_DISABLED=1`，不会尝试拉起浏览器、不会卡超时；错误信息是给用户看的可读文案，不是堆栈。

想赌一次完整版（网络空闲时段成功率更高）：传 `novel-api-deploy-full.zip`，
或把 `container.config.json` 的 `dockerfilePath` 改回 `"Dockerfile"`。

**别自己随手打 zip**：两个包都已按正确结构打好（115KB / 66 个文件，含 `Dockerfile`、`Dockerfile.lite`、
`package-lock.json`，不含 `node_modules`、`.env`、`.playwright-profile-server`、`probe.html`）。要重打：

```bash
cd /path/to/NovelWebsite
rm -f novel-api-deploy.zip novel-api-deploy-full.zip
zip -r -q novel-api-deploy.zip Dockerfile Dockerfile.lite .dockerignore container.config.json server \
  -x "server/node_modules/*" "server/.playwright-profile*" "server/.env" "server/.env.cloud" \
     "server/logs/*" "server/*.zip" "server/probe.html" "*.DS_Store"
# 完整版：先把 container.config.json 的 dockerfilePath 改成 "Dockerfile" 再打第二个包
```

日常更推荐开发者工具直接上传仓库目录，`.dockerignore` 会自动剔除上面这些。

## 5. 迁移数据

在本地 `server/` 目录执行（源库是 `server/.env` 里的本地库，目标是云库的**外网地址**）：

```bash
cd server
npm run db:migrate -- --host=<云库外网地址> --port=3306 --user=root --pass=<密码> --name=novel
```

脚本会建库、按外键顺序建表、分批复制、最后逐表打印行数对比，可重复执行（`INSERT IGNORE`）。
云端容器连的是**内网地址**，本地迁移连的是**外网地址**，两个地址别填反。

实测（2026-11-10）：85 本 / 4424 章 / 8 用户 / 15 分类 / 6 条书架，14.7 秒，目标库 `utf8mb4_unicode_ci`（CynosDB 是 MySQL 5.7）。

### 5.1 本地连云库调试

`server/.env.cloud` 已存好云库外网连接串（含密码，已在 `.gitignore` 里）：

```bash
cd server && npm run dev:cloud     # node --env-file=.env.cloud --watch app.js
```

`--env-file` 先于 `dotenv` 加载，且 `dotenv` 不覆盖已有变量，所以走的是云库，本地 `server/.env` 不受影响。
已实测：首页/详情/章节都能正常读云库数据。改回本地库就 `npm run dev`。

## 6. 小程序切到云端（**2026-11-10 14:45 已更新为新环境**）

`miniprogram/utils/config.js` 当前值：

```js
const MODE = 'cloud';                       // ✅ 已切
CLOUD_ENV: 'prod-d8g08o83h02a961c3',        // ✅ 同主体新环境（callContainer 用）
CLOUD_SERVICE: 'nove-service',              // ✅ 已填（callContainer 用）
CLOUD_BASE_URL: '',                         // ✅ 留空：callContainer 通了就不需要；绑备案域名后才填
CLOUD_VIA: 'auto',                          // ✅ 先试 callContainer，不通才降级
ENABLE_DEMO: false,                         // ✅ 已关（不再用演示数据兜底）
```

`CLOUD_VIA = 'auto'`（默认）先走 `wx.cloud.callContainer`；只有判定 host/服务不可路由时才降级
（`CLOUD_BASE_URL` 为空时不再降级，直接报明确错误，避免拼出相对路径）。
**云托管默认公网域名不能加进小程序 request 合法域名**（官方限制，见 6.2），
所以体验版真正可用的只有「环境同主体 → callContainer 直通」或「绑定已备案自定义域名」两条路。
外链封面走 base64 内联（`COVER_INLINE: true`），同域名取图，不开「不校验合法域名」也能显示。

> 临时回本地开发：把 `MODE` 改回 `'local'`、`ENABLE_DEMO` 改回 `true`，`BASE_URL` 指向 `http://127.0.0.1:3000` 即可。

### 6.1 `callContainer` 报 `INVALID_HOST`（2026-11-10 13:53 实踩）

小程序端表现：`callContainer` 返回 **404**，`data.code = INVALID_HOST`，
`message = Invalid host. For more information, please refer to https://docs.cloudbase.net/error-code/service/INVALID_HOST`，
首页变成「网络异常」。**这时后端是好的**（公网域名 `/api/health`、`/api/home` 都 200），
是网关按「环境 ID + 服务名」拼不出一个可路由的 host。

三样东西必须**逐字**一致，且环境必须授权给当前 AppID：

| 项 | 代码里的位置 | 从哪抄 |
|---|---|---|
| 环境 ID | `CLOUD_ENV` | 云托管控制台顶部环境下拉 / 「设置 → 环境信息」；**注意不是环境名 `prod`** |
| 服务名 | `CLOUD_SERVICE` | 服务设置 → 基础信息 → 服务名（含大小写、连字符，别抄成域名前缀） |
| AppID | — | 该云托管环境必须是**当前小程序（`wx3de365140274c5f6`）自己开通的**，或同主体且配了「资源复用」；否则只能走公网 |

在开发者工具 Console 里跑这段最小复现，能拿到精确 errCode（比看页面有用）：

```js
wx.cloud.init({ env: 'prod-d2gmec6wl77c62d83' });
wx.cloud.callContainer({
  config: { env: 'prod-d2gmec6wl77c62d83' },
  path: '/api/health',
  method: 'GET',
  header: { 'X-WX-SERVICE': 'nove-service' },
  success: (r) => console.log('success', r.statusCode, r.data),
  fail: (e) => console.error('fail', e.errCode, e.errMsg),
});
```

| errCode / 现象 | 结论 |
|---|---|
| `-601027 Environment not found` | 环境 ID 错（多半填了环境名） |
| `-601031 EnvDbId ... ServiceName ... not exist` | 环境里没有这个服务名（或服务下没有线上版本） |
| `-501000 INVALID_HOST` | 环境与服务名拼不出合法 host，或该环境未授权给此 AppID |
| `-601034 没有权限，请先开通云托管` | 该环境不是当前小程序开通的，也没有「资源复用」 |

**开发期临时兜底**（已实现）：`utils/config.js` 的 `CLOUD_HTTP_FALLBACK = true`，
`callContainer` 命中 INVALID_HOST/找不到服务时，自动改用 `CLOUD_BASE_URL`（公网域名）请求，
Console 会打一条 warning。但这条兜底同样受 request 合法域名白名单约束，**体验版/正式版必翻车**（见 6.2）。

### 6.2 体验版 / 正式版「连不上服务器」（2026-11-10 14:00 实踩，结论已更正）

现象：devtools 正常、真机预览正常，一上传体验版就白屏「连不上服务器 / 网络异常」。
**不是后端挂了** —— 同一时刻公网探测：`/api/health` HTTP 200（216ms）、`/api/home` HTTP 200（147ms，hot 10 本）、
`/api/categories` HTTP 200（175ms）。

原因是两件事叠加：

1. `callContainer` 仍是 404 `INVALID_HOST`（见 6.1），这条链路在体验版一样不通；
2. 兜底走 `wx.request` 打 `*.sh.run.tcloudbase.com`：devtools 勾了「不校验合法域名」所以能过，
   但**体验版 / 正式版强制执行 request 合法域名**，微信在本地就拦掉（errMsg 含 `url not in domain list`）。

> ⚠️ **重要更正**：曾尝试把默认公网域名加进 request 合法域名，此路**不通**。
> 微信官方《云托管开发常识》原文：「默认公网域名性能有限制，仅能支持接口测试使用，请勿用于正式生产环境。
> **小程序后台也无法配置使用默认公网域名**。」FAQ 同样写着「请使用 callcontainer 方式调用或绑定自定义域名」。
> 所以在后台保存该域名会报「协议头非法 / 无法保存」，不是操作问题。

因此体验版要跑起来，只有两条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 修通 `callContainer`**（官方推荐） | 定位 6.1 的 `INVALID_HOST`：确认该云托管环境**属于当前小程序 `wx3de365140274c5f6`**，或同主体配了「资源复用」 | 0 元、免备案；需在控制台核对归属 |
| **B. 绑自定义域名** | 云托管「服务设置 → 自定义域名」绑一个**已备案**域名 → 把它填进 `CLOUD_BASE_URL` → 再加进小程序 request 合法域名 | 需要一个已备案域名 + 证书 |

`callContainer` 的 errCode 对照（官方《调用服务问题排查指引》）：

| errCode / errMsg | 含义 |
|---|---|
| `-501000 Path access permission error` | `path` 格式错误（引号、空格、非法字符） |
| `-501000 Authorization mismatch uin` | 环境不属于当前小程序，或没配 `resourceAppid` |
| `-501000 Invalid host`（**本次遇到的就是这个**） | 环境 + 服务名拼不出可路由 host：环境不属于该小程序 / 服务名下没有线上版本 / 环境 id 或服务名错 |
| `-601027 Environment not found` | 环境 id 错（填了环境名） |
| `-601031 EnvDbId [], ServiceName [] not exist` | 环境里没这个服务，或该环境不归当前小程序 |
| `-601034 没有权限，请先开通云托管` | 小程序没开通云托管，也没被同主体「资源复用」 |
| `Invalid AppId in host` | `resourceAppid` 与「资源复用」不匹配 |

**最快的归属自查（不用进控制台）**：开发者工具左侧「云开发」面板能否看到并切换到
`prod-d2gmec6wl77c62d83`。看不到 → 这个环境不是用当前 AppID 开通的，`callContainer` 永远不会通，
只能走 B 或在小程序侧重新开通云托管。

代码层面已做兼容：`utils/config.js` 的 `CLOUD_VIA: 'auto'` —— 先试 `callContainer`，一旦判定
host/服务不可路由，本次运行内自动降级到 `wx.request`（并记住选择，不重复失败）。
`utils/request.js` 还会识别 `url not in domain list`：**不重试**（以前白等 3.6s 并弹「正在唤醒服务…」），
Console 打印要配置的域名，页面提示「服务器域名未加入白名单」，避免误判成「后端没启动」。

### 6.3 根因确认：云托管环境与小程序**不同主体**（2026-11-10 14:22）

在云托管控制台「设置 → 资源复用 → 添加关联」里填 AppID `wx3de365140274c5f6` + 环境
`prod-d2gmec6wl77c62d83`，控制台直接红字拒绝：**「不同主体不支持资源复用」**。

这一条把前面所有现象一次性解释完了：

| 现象 | 真正原因 |
|---|---|
| `callContainer` 404 `INVALID_HOST` | 环境不属于本小程序，网关不给路由（与密码、网络、服务名无关） |
| 默认公网域名加不进 request 白名单 | 官方本就禁止；即便允许，也不该拿他人主体的服务当自己的用 |
| 公网域名一切正常（health/home 200） | 公网是匿名访问，与环境归属无关 |

> 也就是说：环境 ID、服务名、`DB_*`、TLS、冷启动**全都没错**，卡在「主体」这一层。
> 云托管环境不支持改主体，也不支持跨主体「资源复用」。

两条出路：

| 方案 | 条件 | 耗时 |
|---|---|---|
| **A. 用本小程序重新开一个云托管环境**（推荐） | 该小程序能开通云托管/云开发（个人主体也可） | 当天，30~60 分钟 |
| B. 给现有服务绑自定义域名，改走 `wx.request` | 需一个**自己名下已备案**的域名 + 证书 | 域名备案 1~20 天 |

#### 6.3.1 方案 A 迁移步骤（数据库**不需要**动）

关键前提：数据库是**外部 CynosDB**，不随云托管环境迁移 —— **不用重跑迁移脚本**。

> 2026-11-10 14:40 **最终在用的环境与库**：
> 环境 ID `prod-d8g08o83h02a961c3`（由 `wx3de365140274c5f6` 自己开通，同主体）；
> 库外网 `sh-cynosdbmysql-grp-ak4ysgny.sql.tencentcdb.com:23729`、内网 `10.5.110.101:3306`、`root/xuzhe-153289653`。
> 已从本地库完整迁移：**novels 85 / chapters 4424 / users 8 / categories 15 / bookshelves 6**（16.2s），
> 本地 `verify:cloud` 实测 6 项全 ✓（含全网搜索 2172 条）。
> 容器先用**外网地址**；跑通后再把 `DB_HOST`/`DB_PORT` 换成内网 `10.5.110.101:3306`
> 可省外网流量费、降 10~40ms —— 若换内网后日志报 `ETIMEDOUT`，说明云托管 VPC 与该 CynosDB 未打通，换回外网即可。

> 迁移踩坑：本地 `novels` 表残留一列 `category_idCopy`（85 行全 NULL、代码无引用），会让 `INSERT` 报
> `Unknown column ...` 中断迁移。已 `ALTER TABLE novel.novels DROP COLUMN category_idCopy` 清理；
> 若以后换库迁移，先 `SHOW COLUMNS` 比对两边结构。

> 本机坑：运营商 DNS（`10.249.244.125`）解析不了 `grp-ak4ysgny` 这个新域名（`dig @8.8.8.8` 正常，
> Node 报 `ENOTFOUND`）。本地跑迁移/验收时用 `--host=43.145.127.38` 或
> `DB_HOST=43.145.127.38 npm run dev:cloud` 覆盖即可；**容器里用域名没问题**（腾讯云内网 DNS 正常）。

1. 用小程序 `wx3de365140274c5f6` 登录微信云托管 → **新建环境**（地域建议上海；与数据库不同地域也能用，反正走公网）；
2. 记下**新环境 ID**（`prod-xxxxxxxx`，控制台「设置 → 环境信息」有复制按钮）；
3. 新建服务，**服务名仍叫 `nove-service`**（这样只改环境 ID 一处），端口 80、1 核 2G、最小实例 0；
4. 「部署发布」→ 上传代码包 `novel-api-deploy.zip`（内含 `container.config.json`，`dockerfilePath: Dockerfile.lite`，镜像约 330MB）；
5. 环境变量：控制台该项支持 **「环境变量 JSON」** 粘贴，直接粘贴 `server/.cloudrun-env.json`（含全部 16 项，已 gitignore）；
6. 发布，日志应依次出现 `准备连库：...` → `数据库连接成功（第 1 次尝试）` → `API 已启动，监听端口 80`；
7. 改 `miniprogram/utils/config.js`：仅 `CLOUD_ENV` 换成新环境 ID（`CLOUD_SERVICE` 不变）；
8. 开发者工具重新编译 → Console 探针应输出 `✅ callContainer 连通（HTTP 200 code=0）`；
9. **重新上传体验版** —— 此时走内网通道，**不需要任何域名白名单**，`CLOUD_VIA` 保持 `'auto'` 会自动用容器；
10. 确认新环境跑通后，再删旧环境/旧服务，避免重复计费。

#### 6.3.2 历次环境/库变更（避免对不上号）

| 时间 | 环境 ID | 数据库外网 | 结果 |
|---|---|---|---|
| 11:00 | `prod-d2gmec6wl77c62d83` | `grp-qcog9b86:24246` | 服务 007 跑通，但环境**跨主体** → `callContainer` 不通 |
| 14:35 | 同上 | `grp-3fmbpvpu:29166` | 新库迁好，环境主体问题未解，废弃 |
| **14:40** | **`prod-d8g08o83h02a961c3`** | **`grp-ak4ysgny:23729`** | **同主体，当前在用** |

> 教训：每次换库都要同步三处 —— `server/.cloudrun-env.json`（控制台粘贴）、`server/.env.cloud`（本地调试）、
> 以及控制台里的实际环境变量；换环境则还要改 `miniprogram/utils/config.js` 的 `CLOUD_ENV`。

### 6.4 登录报 `fetch failed`（2026-11-10 15:35 实踩）

**好消息先说**：能走到这一步，说明 `callContainer` 已经通了 —— 请求确实进了容器，
不再是 6.1/6.2/6.3 那些网关层的错误。

现象：登录页红框 `登录没有成功 / fetch failed`。

定位：`fetch failed` 是 **Node（undici）的报错文案**，不是小程序的。链路是

```
小程序 → callContainer → POST /api/auth/login → services/wechat.js
       → fetch('https://api.weixin.qq.com/sns/jscode2session')  ← 这里挂了
       → errorHandler 把 err.message 原样返回 → 前端显示
```

`wechat.js` 原实现用的是全局 `fetch`。Node 20 的 fetch（undici）会同时尝试 AAAA 记录，
容器没有 IPv6 路由时连接直接失败，而 `fetch` 只抛一句 `fetch failed`，
真实原因藏在 `err.cause` 里，日志根本看不到 —— 这就是「后端明明活着、数据库也连上了、
偏偏只有登录挂」的来源。注意容器连外网 MySQL 走的是 `net` 模块，与 undici 的解析策略不同，
所以**「能连数据库」不能证明「fetch 能用」**。

两处修复（`server/services/wechat.js`、`server/routes/auth.js`）：

1. **优先用网关注入的 openid，根本不调微信接口**
   小程序走 `callContainer` 时，微信网关会在请求头注入 `X-WX-OPENID` / `X-WX-APPID`。
   后端直接取用，省一次外网往返（冷启动能省 1~2 秒），也不再依赖容器出网。
   安全约束：必须 `X-WX-APPID === WX_APPID` 才采信，防止公网直连伪造该头冒充他人账号；
   不匹配或缺失则自动回退到 `jscode2session`。
2. **回退路径换成 `https` 模块**：显式 `family: 4` + 8s 超时 + 重试 1 次，
   失败时把 `err.cause` 打出来；微信返回 `errcode`（如 `40029 invalid code`）直接抛，不重试。

三条路径实测（本地连云库）：

| 场景 | 结果 |
|---|---|
| 带 `X-WX-OPENID` + 正确 `X-WX-APPID` | ✅ `code:0` 直接发 token，日志 `[auth] 使用网关注入的 openid 登录` |
| 带 `X-WX-OPENID` + **错误** `X-WX-APPID` | ✅ 被拒（`缺少 code`），未冒充成功 |
| 不带头、`code=fake` | ✅ `微信登录失败：40029 invalid code, rid: ...`（链路正常，中文可读） |

若部署后仍报 `无法连接微信登录服务（容器访问 api.weixin.qq.com 失败）`，
说明该环境连微信接口确实出不去，去云托管「设置 → 网络」确认允许公网出口；
此时代码头那条路（`X-WX-OPENID`）仍然有效，登录不受影响。

## 7. 上线验证清单

- [ ] **云托管环境必须由本小程序 `wx3de365140274c5f6` 自己开通**（跨主体无法 `callContainer`，实测报「不同主体不支持资源复用」，见 6.3）
- [x] `cd server && npm run check:cloud` 无 ✗
- [x] 旧环境 `prod-d2gmec6wl77c62d83` 里 007 版本连库成功、监听 80（沿用同一套镜像与环境变量）
- [x] **新库 6 项冒烟全 ✓**（`grp-ak4ysgny:23729`，见 6.3.1）
- [x] 小程序 `MODE='cloud'`、`ENABLE_DEMO=false`、`CLOUD_ENV` 已换新环境
- [ ] **新环境 `prod-d8g08o83h02a961c3` 上传代码包 + 粘贴 `server/.cloudrun-env.json` 并发布**
- [ ] 新环境日志：`数据库连接成功（第 1 次尝试）` + `API 已启动，监听端口 80`
- [ ] 开发者工具 Console 探针：`✅ callContainer 连通` → 重新上传体验版
- [ ] 开发者工具编译：首页/分类有真实数据，封面不空白
- [ ] 书籍详情、目录、正文能正常阅读
- [ ] 登录能拿到 token（真机 `wx.login` 的 code 只有真机能用，模拟器只能拿到 mock）
- [!] 冷启动：闲置后首个请求实测 **20~30s**（最小实例 0 的代价），小程序会先看到「正在唤醒服务…」→ 建议把最小实例调成 1（见 7.1）

### 7.1 冷启动实测：小程序「网络异常」的真正原因（2026-11-10 13:47）

开发者工具里 `callContainer /api/home` 返回 **500**、页面弹「网络异常，请稍后重试」。
同一时刻从公网连续探测的结果：

| 时刻 | 结果 |
|---|---|
| 闲置约 1 小时后第 1 次 | **30s 超时**（容器在拉起 + 走公网连库） |
| 第 2 次 | 10.3s 得到 `503 Service Temporarily Unavailable`（nginx，容器仍没就绪） |
| `/api/health` | 3.1s → 200 |
| `/api/home` | 260ms → 200，数据完整 |
| 预热后连续 8 次 | **60 ~ 100ms**，全部 200 |

结论：**服务本身没问题，是「最小实例 0」+ 冷启动 20~30s**，微信网关等不到就把 500 抛给小程序。
三档处理，建议 1+2 一起上：

1. **把最小实例改成 1**（约 63 元/月）—— 彻底没有冷启动，这是唯一根治办法；
2. **客户端冷启动重试**（已实现）：`miniprogram/utils/request.js` 的 `WAKE_RETRY = 2`，
   遇网络失败或 HTTP 5xx 自动重试 2 次（间隔 1.2s / 2.4s），期间 Toast「正在唤醒服务…」，
   最终仍失败才提示「服务正在启动，请稍后再试」。**只能覆盖 5 秒左右的抖动**，救不了 25 秒的冷启动；
3. **DB 换回内网地址**（见 2.2）—— 冷启动里的连库环节能省 1~3 秒。

> 想省钱又不想白屏，还有个折中：工作时段（8:00~24:00）用控制台「定时伸缩/固定实例」，夜间回落到 0。


### 7.2 2026-11-10 12:41 线上验收实测

```
✓ /api/health              HTTP 200 · 361ms
✓ /api/home                hot 10 / latest 12 / 分类 15
✓ /api/categories          15 个分类
✓ /api/novels/100/chapters 《皇帝之书：朱元璋集》21 章
! /api/online/search       code=500 书源需要人机验证，正在自动恢复，请稍后重试
✓ 不存在的接口返回 code=404
通过 5 项，1 项告警
```

**唯一告警的解释**：七猫对**云托管出口 IP** 触发了人机验证（本机家宽 IP 同样的请求能返回 2172 条）。
这不是镜像能力问题（`PW_DISABLED` 那段提示不会出现在这里），是源站按 IP 做风控。三个选项：

| 方案 | 成本 | 效果 |
|---|---|---|
| 接受现状：搜索在云端不可用，只在**本机**跑搜索/导入/补章 | 0 | 阅读/登录/书架全不受影响 |
| 换完整镜像（`Dockerfile`，带 headless Chromium）赌一次 | 镜像 1.31GB，推送易超时 | 有机会过 WAF，但不保证 |
| 给抓取配代理出口（`HTTP_PROXY` 类环境变量） | 需自备代理 | 换掉被风控的 IP，最可控 |


### 7.3 `npm run verify:cloud`（2026-11-10 新增）

`server/scripts/verify-cloud.mjs`，直接打真实域名，不依赖控制台：

```bash
cd server
npm run verify:cloud -- https://xxx-yyy.sh.run.tcloudbase.com
# 可调超时（冷启动首次访问慢）：--timeout=25000
```

| 检查项 | 判什么 |
|---|---|
| `/api/health` | 容器在监听、Express 活着；返回 HTML 就是网关/端口不对 |
| `/api/home` | 数据库通了**且有数据**（hot/latest 数量），空数组会判失败 |
| `/api/categories` | 15 个分类 |
| `/api/novels/:id/chapters` | 取首页第一本书查目录，章数 > 0 |
| `/api/online/search` | 全网搜索（lite 走 HTTP API）；失败只**告警**不阻断 |
| `/api/__not_exist__` | 必须返回 `code=404`——否则说明域名指向了别的服务 |

退出码 0 = 可以切 `MODE='cloud'`；非 0 会打印每项的中文修法（DB 密码错 / 端口错 / 没有数据）。
2026-11-10 本地（连云库）实测 6 项全过：hot 10 / latest 12 / 分类 15 / 《皇帝之书：朱元璋集》21 章 / 搜索 2172 条。

## 8. 成本参考

| 形态 | 月成本 |
|---|---|
| 最小实例 0 + 外部 MySQL | 容器几元 + 数据库 30~60 元 |
| 最小实例 1 常驻 + 外部 MySQL | 容器约 63 元 + 数据库 30~60 元 |
| 全部用云托管 MySQL | 容器 63 元 + 数据库约 246 元 |

新环境前 3 个月有免费额度：CPU 720 核时、内存 1440 GB时、MySQL 720 个时、公网流量 5GB、构建 600 分钟。

## 9. 已知限制

- **内容抓取**：线上容器带 Chromium，能跑「全网搜索/在线导入」；但每周定时爬虫建议仍在本机跑（`npm run crawl` 指向云库），云上只负责读。
- **图片**：`/static` 在容器里是临时盘，重启即丢。目前封面走 `/api/cover` 远程代理 + base64，不依赖本地文件，所以没问题。
- **日志**：`LOG_TO_FILE=false`，日志统一进云托管日志检索；本地开发仍然写 `server/logs/app.log`。
