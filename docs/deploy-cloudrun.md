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

## 1. 开通云托管并创建环境

1. 微信开发者工具右上角「云托管」→ 开通；
2. 创建环境：地域选 **上海** 或 **广州**（离用户近），环境 ID 记下来（形如 `prod-1gxxxxxx`）；
3. 在环境里**新建服务**，服务名填 `novel-api`（与 `miniprogram/utils/config.js` 的 `CLOUD_SERVICE` 对应）；
4. 服务设置：端口 **80**，CPU **1 核**，内存 **2 GB**（Chromium 需要至少 2G，1G 会 OOM），最小实例 **0**（省钱），最大实例 5。

> 仓库根目录的 `container.config.json` 已经写好了上述参数，上传时工具会自动读。

## 2. 准备数据库

二选一：

**A. 云托管自带 MySQL（省事但贵）**
控制台 →「数据库」→ 新建 MySQL 8.0 实例。算力 0.342 元/个·小时，常驻约 **246 元/月**，免费额度只覆盖第一个月。

**B. 外部 MySQL（省钱，推荐）**
腾讯云「轻量数据库」或「云数据库 MySQL 基础版」，约 30~60 元/月。
在云托管控制台把该实例加入**内网访问/白名单**，容器就能内网直连。

拿到四项：`host`、`port`、`user`、`password`，库名用 `novel`。

## 3. 配置环境变量

云托管控制台 → 服务 → 版本配置 → 环境变量：

| 变量 | 值 | 必填 |
|---|---|---|
| `DB_HOST` | 数据库内网地址 | ✅ |
| `DB_PORT` | 3306 | ✅ |
| `DB_NAME` | novel | ✅ |
| `DB_USER` | root | ✅ |
| `DB_PASS` | 数据库密码 | ✅ |
| `JWT_SECRET` | 强随机串（**不要用本地那个**） | ✅ |
| `WX_APPID` | wx3de365140274c5f6 | ✅ |
| `WX_SECRET` | 小程序 AppSecret | ✅ |
| `NODE_ENV` | production | ✅ |
| `PORT` | 80 | ✅ |
| `TRUST_PROXY` | true | ✅ |
| `LOG_TO_FILE` | false | ✅ |
| `ENABLE_CRON` | false | ✅ |

`ENABLE_CRON=false` 是必须的：容器多实例 + 缩容到 0，内置 cron 会重复跑或漏跑。

## 4. 上传部署

开发者工具「云托管」面板 → 选择**仓库根目录**（有 `Dockerfile` 的那层）→ 上传。
云端构建，本地不需要 Docker。首次构建约 5~8 分钟（要装 Chromium）。

构建失败常见原因：
- `npm ci` 报锁文件不一致 → 本地执行 `npm install` 重新生成 `package-lock.json` 再传；
- 内存不足 → 构建规格调到 2G。

## 5. 迁移数据

在本地 `server/` 目录执行（用云数据库的**外网地址**）：

```bash
npm run db:migrate -- --host=<云库外网地址> --port=3306 --user=root --pass=<密码> --name=novel
```

脚本会建库、按外键顺序建表、分批复制、最后逐表打印行数对比，可重复执行（`INSERT IGNORE`）。

## 6. 小程序切到云端

改 `miniprogram/utils/config.js`：

```js
const MODE = 'cloud';
CLOUD_ENV: 'prod-1gxxxxxx',          // 第 1 步的环境 ID
CLOUD_SERVICE: 'novel-api',          // 第 1 步的服务名
CLOUD_BASE_URL: 'https://xxx-yyy.sh.run.tcloudbase.com', // 控制台「访问域名」
ENABLE_DEMO: false,                  // 上线前关掉演示数据
```

`CLOUD_BASE_URL` 只有图片（封面）用得到；接口全部走 `callContainer`，不做域名校验。

## 7. 上线验证清单

- [ ] 云托管日志出现 `数据库连接成功（第 1 次尝试）` 与 `API 已启动，监听端口 80`
- [ ] 浏览器打开 `https://<访问域名>/api/health` 返回 `{"code":0,...}`
- [ ] 小程序首页有真实数据（不是演示数据）
- [ ] 搜索「剑来」能出结果（首次可能 3~7 秒，要过 WAF）
- [ ] 书籍详情、目录、正文能正常阅读
- [ ] 登录能拿到 token（真机 `wx.login` 的 code 只有真机能用）
- [ ] 冷启动：闲置 10 分钟后再访问，首屏 1~3 秒（最小实例 0 的代价，可调成 1 消除）

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
