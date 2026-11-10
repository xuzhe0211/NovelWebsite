# 免费小说阅读微信小程序

一款支持 **首页 / 排行 / 完本 / 分类 / 我的** 五菜单的免费小说阅读小程序，带用户体系、阅读器、书架进度同步，以及每周末自动从 `twkan.com` 抓取小说（繁体自动转简体）。「我的」内含登录入口、书架与最近在读。

## 技术栈

| 层 | 技术 |
|---|---|
| 小程序 | 原生微信小程序（WXML / WXSS / JS，无构建） |
| 后端 | Node.js + Express（ESM） |
| 数据库 | MySQL 8 + Sequelize（utf8mb4） |
| 登录 | 微信登录；开发期未配置 AppSecret 时使用稳定 deviceId mock；支持头像/昵称设置 |
| 定时 | node-cron（默认每周日 03:00） |
| 爬虫 | Playwright（stealth + 持久化会话，应对 Cloudflare） |
| 繁简转换 | opencc-js（tw → cn） |

## 目录结构

```
NovelWebsite/
├── miniprogram/      # 微信小程序前端
├── server/           # Node.js 后端 + 爬虫 + 调度
├── sql/              # 建表 SQL 参考
├── docs/design.md    # 设计说明与风险记录
├── start-dev.sh      # macOS / Linux 一键启动（MySQL + API）
└── start-dev.bat     # Windows 一键启动
```

## 一、后端启动

### 1. 准备 MySQL

Docker（推荐）：

```bash
docker run --name novel-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=novel -p 3306:3306 -d mysql:8
```

或使用本机 MySQL，然后在 `server/.env` 中填写连接信息。

> **图形客户端连接**：`mysql:8.4` 默认用 `caching_sha2_password`，而
> `mysql_native_password` 在 8.4 里是**禁用**状态（只能在 mysqld 启动时用
> `--mysql-native-password=ON` 打开）。Sequel Pro 这类老客户端的内置库只认
> native，会报 `Client does not support authentication protocol requested by server`。
> 解决办法：换 **Sequel Ace**（Sequel Pro 的活跃分支，免费，支持 Apple Silicon）
> 或 TablePlus / DBeaver；连接参数 `127.0.0.1:3306` / `root` / `root` / `novel`（本机也可用 `127.0.0.1`）。
> 不改数据库认证方式，MySQL 8.4 的安全默认值保持原样。

### 2. 安装依赖

```bash
cd server
npm install
npx playwright install chromium   # 安装爬虫所需浏览器
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 按需修改 DB_* / JWT_SECRET / WX_APPID / WX_SECRET / CRAWL_SEED_IDS
```

`WX_APPID` / `WX_SECRET` 是小程序的 AppID 与 AppSecret（**服务端专用**），用于把 `wx.login()` 的 code 换成 openid：

- 获取：`https://mp.weixin.qq.com` → 登录**小程序**后台 → 开发管理 → 开发设置 → 开发者ID，AppSecret 需管理员扫码后「生成/重置」，**只显示一次**；
- AppID 必须与 `miniprogram/project.config.json` 的 `appid` 一致，否则 `jscode2session` 会报 40013；
- 两项任一为空时，`server/services/wechat.js` 走 mock：`openid = mock_<设备ID>`，能跑通登录但不能跨设备识别同一用户；
- **云托管场景优先用网关注入的 `X-WX-OPENID`**：小程序经 `callContainer` 调用时微信网关会自动带上
  `X-WX-OPENID` / `X-WX-APPID`，后端直接取用，省一次 `jscode2session` 往返，也不再依赖容器能否访问
  `api.weixin.qq.com`（曾因容器 fetch 出不去导致登录报 `fetch failed`，详见 docs 6.4）。
  只有 `X-WX-APPID` 与 `WX_APPID` 一致才采信，防止公网伪造该头冒充他人；
- AppSecret 等同于账号私钥（可换手机号、发订阅消息），只在服务端 `.env` 里放，`.env` 已被 `.gitignore` 忽略；重置密钥会让旧值立即失效。

### 4. 初始化数据库

```bash
npm run init-db
```

会自动建库、建表并写入分类种子数据。

### 5. 抓取小说（多数据源，无需人工验证）

默认数据源为**七猫免费小说**（无 Cloudflare 人工验证，可无人值守）。也支持**番茄小说** `fanqie` 与台湾 `twkan`（twkan 有 Cloudflare，需人工过一次）。

```bash
# 默认：七猫，按 .env 的 CRAWL_SOURCE / CRAWL_LIST_URL 抓取
npm run crawl

# 指定数据源 + 只抓 3 章快速验证
npm run crawl -- --source qimao --limit 3

# 番茄小说（从书库自动发现书籍）
npm run crawl -- --source fanqie --limit 3
```

抓取目标来源：
- 若 `.env` 设置了 `CRAWL_SEED_IDS`（书籍ID，逗号分隔），则抓这些书；
- 否则从 `CRAWL_LIST_URL`（或数据源首页）自动发现书籍，最多抓 `CRAWL_MAX_BOOKS` 本。

先探查结构/发现书籍，再小批量验证：

```bash
npm run probe -- --source fanqie --url https://fanqienovel.com/library
npm run probe -- --source qimao --book-id <书籍ID>
```

> 若某站点结构特殊导致解析不到，先跑 `probe` 把输出发我，我再调 `server/services/scraper/sources.js` 的选择器提示；实在无法自动抓取时，可手动保存页面后用 `npm run import-html -- --dir ./saved-html --book-id <ID> --source qimao` 兜底导入。

### 5.1 高速批量抓取（推荐，用于铺量）

`run.js` 用 Playwright 逐章开页面（约 2.5s/章），几百章就要很久。`fast.js` 换了思路：
先用浏览器过一次阿里云 WAF 拿到 `acw_sc__v2` 等 cookie，之后目录走 `qimaoapi` 接口一次拿全、
正文走并发 HTTP（约 0.35s/章），每本 200 章只要 2~9 秒。

```bash
# 扫描候选书的"免费章节数"（目录接口里 is_vip=0 的章数），挑章节最全的书
npm run crawl:scan -- --limit 60

# 给库里已有的书补齐免费章节
npm run crawl:fast -- --chapters 200

# 从榜单发现新书并抓取（不可读的 VIP 书自动跳过）
npm run crawl:fast -- --books 20 --chapters 200

# 指定书籍 ID（scan 输出的"可导入的 ID"直接粘过来）
npm run crawl:fast -- --ids 1761978,11510034 --chapters 200 --concurrency 6
```

几个必须知道的点：

- **七猫 PC 端只放出前若干章正文**，目录里 `is_vip=1` 的章节网页端读不到内容。免费章数因书而异（本库现有 20~166 章不等），这是站点限制，不是抓取 bug。
- 抓取器会先看目录里的 `is_vip`，**只抓免费章节**；单本免费章数少于 3 直接跳过。
- 偶尔会命中反爬挑战页（响应里是 `{"l1":"var arg1=..."}`）或抓到只剩导航栏的框架页，`fast.js` 与 `saveChapter` 都会识别并丢弃，不会污染正文。
- 章节为增量写入：重复执行只会补缺的章，不会重复。


### 6. 启动 API

**一键启动（macOS / Linux）**

```bash
./start-dev.sh          # 检查 MySQL（没有就拉 Docker 容器）→ 检查依赖 → 起 API
./start-dev.sh --skip-db   # 库在别处（云库/局域网）时跳过 MySQL 检查
./start-dev.sh --prod      # 用 npm start，不带 --watch
```

脚本会从 `server/.env` 读 `DB_HOST` / `DB_PORT` / `PORT`，本机没监听就调 Docker Desktop 起
`novel-mysql` 容器（mysql:8，root/root，库 novel），然后前台跑 `npm run dev`，
并打印本机与局域网两个地址（真机预览用局域网那个）。Windows 用 `start-dev.bat`。

**手动启动**

```bash
cd server
npm start          # 或 npm run dev（文件变更自动重启）
```

默认地址 `http://127.0.0.1:3000`（服务监听 `0.0.0.0`，手机/其他电脑同网可直接访问；本机也可用 `http://127.0.0.1:3000`），健康检查：`GET /api/health`。

## 二、小程序启动

1. 用「微信开发者工具」导入 `miniprogram/` 目录。
2. AppID：可先用「测试号」；正式上线前替换为自己的 AppID。
3. 详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本及 HTTPS 证书」，以便访问本机后端。
4. 后端地址在 `miniprogram/utils/config.js` 的 `BASE_URL`：**开发者工具模拟器用 `http://127.0.0.1:3000`；真机预览改成电脑的局域网 IP**（跑 `./start-dev.sh` 会直接打印当前 IP，如 `http://192.168.1.108:3000`），手机与电脑需同一网络；换网段时改这一处即可（`server/.env` 的 `DB_HOST` 仍填 `127.0.0.1`，因为库在本机）。
5. 打开「我的」→ 登录，即可测试用户体系、书架与进度同步。

### 演示数据兜底（开发期）

后端未启动、或数据库还没跑过爬虫时，列表页会自动使用内置演示数据（23 本书 / 15 个分类 / 每本 18 章），并在页面顶部显示「后端未连接，当前展示演示数据」提示条，可点「重试」重新请求接口。

- 开关：`miniprogram/utils/config.js` → `ENABLE_DEMO`，上线前改为 `false`；
- 数据：`miniprogram/utils/demo.js`（小说、章节、本地书架、体验登录都在这里）；
- 体验登录：登录时若后端不可达，会自动降级为「本地体验用户」，书架写本地 storage；登录页也提供「先用本地体验账号」的显式入口。接口恢复后重新登录即可同步云端（会换成真实 JWT）。
- 未登录访问书架不再静默自动登录，而是明确提示「登录后同步你的书架」，避免出现「莫名其妙已登录」。

### 封面

- 所有封面统一走 `components/novel-cover`：`coverUrl` 能加载就显示图片；为空、404、防盗链 403 时自动渲染按书名生成的封面（8 组配色，按书名 hash 固定），列表里不会再出现空白或只有一个字。
- 相对路径（`/static/xxx.jpg`）会自动补上 `BASE_URL`。
- 外链封面默认经后端 `GET /api/cover?url=` 代理：服务端带 `Referer` 取图并内存缓存 6 小时，解决小说站防盗链与小程序图片域名白名单问题；不需要时把 `utils/config.js` 的 `USE_COVER_PROXY` 改为 `false`。
- **真机预览为什么之前看不到封面**：微信自基础库 3.8.7 起，`<image>` 组件在开发版 / 体验版**不再加载 `http://` 图片**，而 `wx.request` 仍可用——所以表现是「数据正常、封面一片空白，且不触发 `binderror`」，跟 IP 是 `127.0.0.1` 还是 `127.0.0.1` 无关。现在外链封面改走 **data URI**：`<image src="data:image/jpeg;base64,...">`，由 `wx.request` 从 `GET /api/cover?url=&b64=1&w=220` 取回，完全不发图片请求，因此真机不打开调试也能显示。开关是 `utils/config.js` 的 `COVER_INLINE`（默认 `true`）；接口同时用 `sharp` 把封面缩到显示宽度的 2.2 倍、JPEG 66%，单张 base64 约 20KB。
- 若 `COVER_INLINE` 关掉或取 base64 失败，组件仍会退回代理地址，最后才用文字封面兜底。
- 效果预览：`docs/cover-preview.png`（同尺寸排版示意）。

### 登录与资料

- 登录态存 `novel_token` / `novel_user`；请求统一带 `Authorization: Bearer`。
- 登录页已登录状态下可改头像（`open-type="chooseAvatar"`）与昵称（`type="nickname"`）；昵称通过 `PUT /api/auth/profile` 同步到 `users` 表，头像在本机持久化保存。
- 后端不可达时进入本地体验账号（`user.demo === true`），书架只写本地；后端恢复后重新登录即切换为真实账号。

### 未登录试读限制（`FREE_CHAPTERS`）

未登录用户每本书只能读**前 10 章**，由**服务端**判定，不是前端藏起来：

- `server/config/index.js` → `freeChapters`（环境变量 `FREE_CHAPTERS`，默认 `10`，`0` = 不限制）；
- `GET /api/chapters/:id`：未登录且 `chapterNo > FREE_CHAPTERS` → `code=403`，正文**根本不下发**，
  `data` 带 `{ needLogin, freeChapters, chapterNo, novelId }`；伪造/过期 token 一样按未登录处理；
- `GET /api/novels/:id/chapters`：每条带 `locked`，前端据此显示「登录」角标；
- 阅读页遇到 403 显示整页登录引导（「试读结束 / 立即登录」），登录返回后自动续读同一章；
  本地 token 过期时会先静默重登一次，成功则不打扰用户；
- 详情页目录里锁定章节点一下直接弹「需要登录 → 去登录」，不用先进阅读页。

> 想放宽就改 `FREE_CHAPTERS`（云托管改环境变量，本地改 `server/.env`），不用改代码。

### 页面与组件

| 路径 | 说明 |
|---|---|
| `pages/index` | 首页：搜索、分类快捷入口、热门横滑、最近更新 |
| `pages/ranking` | 排行：周/月/总榜，前三名高亮，支持下拉刷新 |
| `pages/completed` | 完本：按字数/最新/人气排序，分页加载 |
| `pages/category` | 分类：横向筛选条 + 分类列表 |
| `pages/mine` | 我的：用户卡片、书架统计、最近在读、登录/退出、清缓存 |
| `pages/bookshelf` | 书架（二级页，从「我的」进入）：进度条、继续阅读、移出 |
| `pages/login` | 登录：协议确认、一键登录、本地体验入口、头像/昵称编辑、退出 |
| `pages/search` | 搜索：站内书库 / 全网搜索双模式；支持粘贴第三方链接；结果可点进在线详情 |
| `pages/novel-detail` | 书籍详情：简介 + 目录 + 阅读/书架；在线抓取的书带「继续补章」卡（可选 10/50/100/200 章），支持下拉刷新 |
| `pages/reader` | 阅读：**上下滚动 / 左右翻页**两种模式（设置里切换，记住选择）；翻页按屏切页、点按或左右滑动翻，跨章自动续；底部工具栏「目录 / 补章 / 设置」；字号三档主题，补章可选 10/50/100/200 章 |
| `pages/online-detail` | 在线详情：源站简介 / 章节数 / 已入库数，可「加入书架」或「拉取到本站」并显示进度，支持下拉刷新 |
| `components/novel-cover` | 通用封面：远程图加载失败时按书名生成排版封面（渐变底 + 书名 + 作者 + 分类），不会出现空白块 |
| `components/novel-card` | 小说列表卡片（封面、完结角标、字数格式化） |
| `components/demo-tip` | 演示数据提示条 |
| `assets/tabbar` | 5 组底部 tab 图标（普通态 + 选中态，81×81 PNG） |

## 三、联网搜索（全网搜书 → 一键入书架）

搜索页有两个模式：**站内书库**（查 MySQL 里已入库的书）和 **全网搜索**（实时查免费小说站的搜索接口）。
全网结果点「加入书架」后，服务端异步抓取详情 + 目录 + 正文入库，并自动加入当前用户书架，随后即可正常阅读/续读。

```
GET  /api/online/search?keyword=剑来&page=1      # 全网搜索，返回 inLibrary / novelId / importedChapters
GET  /api/online/detail?source=qimao&bookId=143170   # 在线详情（也可传 ?url=任意书籍链接）
GET  /api/online/resolve?url=...                 # 只识别链接归属（快）
POST /api/online/import  { bookId?, source?, url?, addToShelf?, maxChapters? }  # 异步任务 → { taskId }
GET  /api/online/import/:taskId                  # 轮询进度 { status, stage, progress, chapters, novelId, remaining, hasMore }
GET  /api/online/continue?novelId=97             # 这本书还能不能补章（含已入库章数、剩余章数、是否需要补链接）
POST /api/online/continue  { novelId, maxChapters?, url? }  # 继续补章 → { taskId }
GET  /api/online/sources                         # 可用数据源
```

页面链路：搜索结果**点击卡片 → 在线详情页**（`pages/online-detail`），展示源站简介、总章节、可抓章节、已入库章节，
底部两个动作：

- **加入书架**：抓取正文入库 + 写入当前用户书架（未登录会引导登录）；
- **拉取到本站**：只入库、不进书架，适合先攒到书库再挑着看；已入库时该按钮变为「继续补章」，增量补缺章。

实现要点：

- 搜索走七猫搜索接口 `qimaoapi/api/search/result?keyword=`（约 0.5s，一次 15 条，带总数）；
- 导入复用 `services/scraper/qimao-fetch.js` 的抓取核心（与 `crawl:fast` 同一套逻辑），只抓 `is_vip=0` 的免费章；
- 请求层优先裸 HTTP，只有命中 WAF 挑战页时才启动 Playwright 取 cookie，因此**没装浏览器也能搜索/导入**；
- 七猫的 WAF cookie（`acw_sc__v2`）有时效：现在按 6 分钟 TTL 主动续期，命中验证页还会强制刷新一次再重试，
  不会再出现「重启后能搜、过一会儿就一直提示书源限流」；
- 搜索这类低频接口在 cookie 仍失效时会用「浏览器页内 fetch」兜底（起一次 Chromium，约 2~4s），
  所以偶尔一次偏慢，但不会直接报限流；首次启动时预热约 6s；
- 任务表在内存中保留 30 分钟，同一本书并发重复点击会复用同一任务；抓取完成后 `cacheClear()` 让首页/排行立刻看到新书；
- 单本首次默认最多抓 50 章（补章每批按 10/50/100/200 选，见 3.1），免费章不足 3 章的书会明确报「暂不支持导入」；
- 已入库的书在搜索结果里标为「阅读 · N章」，点击直接进详情，不会重复抓取。

### 3.1 继续补章（增量抓取入口）

第一次导入只抓前几十章（外部站点一次 20~50 章，避免等太久），**书籍详情页**（`pages/novel-detail`）
顶部会显示一张补章卡：「已入库 N 章 · 还可补 M 章」，下面可选本次抓取 **10 / 50 / 100 / 200** 章，
点「继续补章」就再抓一批，进度条实时更新，完成后目录与已入库数自动刷新。档位与阅读页共用
`reader_settings.contBatch`，选过一次两边都记住。

- 下拉刷新（页面 `enablePullDownRefresh`）与目录右侧「刷新」都会重新拉详情 + 目录 + 补章状态；
  在线详情页下拉刷新会带 `refresh=1` 绕过服务端 10 分钟详情缓存；
- 补章写入**已有书库记录**（`forceBookId`），不会因链接写法不同新建一本书；
  目录 / 详情页互相切换、`/book/1296/` 与 `/book/1296.htm` 都算同一本；
- `novels.source_url` 记录源站链接，外部书首次导入时写入，之后一键补章无需再贴链接；
  早期没存链接的书会提示「粘贴链接补章」，补一次即记住；
- 用链接补章时会校验书名：抓到的书名与当前书籍不一致会直接报错，避免把别的内容写进这本书；
- 七猫等只有免费章可抓的源，剩余章数按「免费章 - 已入库」算，抓完自动隐藏补章入口；
- **站点限流**（69shuba 约 30 章后返回 429）：抓取端用「全局最小间隔 + 命中后全体冷却」自适应节流，
  被限流的章节放回队尾重抓（最多两次），所以 100/200 这样的大批次会慢一些但不至于中途断掉，
  实测 40 章 46s、60 章约 2 分钟；小程序轮询窗口放宽到约 10 分钟。

**阅读页也有入口**：底部工具栏「目录」弹出章节面板（自动定位当前章，点章节直接跳，不丢进度），
「补章」弹出面板可选本次抓取 **10 / 50 / 100 / 200** 章（选择会记住），带进度条；
补完后目录缓存失效、上一章/下一章状态即时刷新，正文不重载因此不会丢阅读位置。
读到最后一章时页面底部会提示「点补章继续抓取后面的章节」。

### 3.1.1 阅读方式：上下滚动 / 左右翻页

阅读页「设置」里可切换两种方式，选择写入 `reader_settings.pageMode`，下次进入沿用：

- **上下滚动**（默认）：整章连续排版，隐藏原生滚动条，按滚动比例记录进度。
- **左右翻页**：一屏一页，页脚显示 `页码 / 总页数` 与百分比；点屏幕左侧回上一屏、右侧下一屏，
  左右滑动同样可以翻。翻到本章最后一屏自动进入下一章第一屏，反之亦然。
- 切页算法：用离屏 canvas 按当前字号量字宽，把每个自然段折成定宽行（首行缩进两全角空格），
  再按可用高度 `floor(高 / 行高)` 装页；行用 `white-space: nowrap` 保证一行只占一屏内的固定一行。
- 改字号会以「当前行」为锚点重新切页；滚动↔翻页互切时用百分比互转，不会跳回开头。
- 翻页模式的容器是 `position: fixed`，所以不会出现整页滚动的回弹，背景随主题铺满。

### 3.2 粘贴第三方站点链接拉取

搜索框里直接粘贴任意小说站的**书籍详情页链接**，会自动识别站点并进入在线详情页：

- 已适配站点（七猫 `/shuku/{id}/`、番茄 `/page/{id}`）按各自的抓取器走，稳定、章节全；
- 其他站点走 `services/scraper/generic.js` 的通用解析：og 标签取书名/作者/封面/简介，
  从页面链接里挑「第N章」形状的做目录（同域、去重，能识别中文数字序号），正文用常见容器 + 「汉字最多的块」兜底；
- 支持 GBK/GB2312 老站点（自动按 `charset` 解码），也支持把正文用 `document.writeln(base64)` 混淆输出的站点（自动还原）；
- 正文首尾的站点套话（章节名重复、更新日期、「作者：xx」、「(本章完)」）会统一清掉；
- **按 TLS 指纹拦截的站点也能抓**：不少站（如 69shuba.com）对 Node/curl 一律返回 403「page not found」，
  只有浏览器能拿到内容。抓取层先走裸 HTTP，命中拦截就用常驻 Chromium 过一次人机验证拿 cookie，
  之后在同上下文里用页内 `fetch` 取原始字节（不加载图片/样式，比逐页 `page.goto` 快得多）；
- **目录页 / 详情页自动互补**：贴 `…/book/1296/`（目录）会顺带抓 `…/book/1296.htm` 补作者、简介、分类；
  贴详情页则反过来找完整目录，章节数以多的为准；链接少写斜杠导致 404 时会自动换写法重试；
- 第三方书以 `web:{链接哈希}` 作为 `sourceId` 入库。链接做过归一化（去 `.htm`、去尾斜杠、host 小写），
  `/book/1296/`、`/book/1296.htm`、`/book/1296` 视为同一本书，不会重复建库；
- 抓取有节流（并发 3 + 随机延时），连续多章失败会提前停，避免把站点打挂。

## 四、每周末自动抓取

后端启动后自动注册 `node-cron`，默认每周日 03:00 按 `.env` 配置的数据源抓取，增量更新：

- 已抓取章节按 `(novel_id, source_chapter_id)` 跳过；
- 新增章节抓取后自动入库（繁体源会转简体）；
- 失败写日志、不阻塞服务，下个周期自动补。

数据源与书籍来源均在 `.env` 配置：`CRAWL_SOURCE`、`CRAWL_SEED_IDS`、`CRAWL_LIST_URL`、`CRAWL_MAX_BOOKS`；调度表达式用 `CRAWL_SCHEDULE`（`0 3 * * 0` = 每周日 03:00）。

## 五、常用脚本

| 命令 | 说明 |
|---|---|
| `npm run init-db` | 建库建表 + 分类种子 |
| `npm run crawl` | 按配置抓取（默认七猫） |
| `npm run crawl -- --source fanqie --limit 3` | 指定数据源 / 限量抓取 |
| `npm run probe -- --source qimao --book-id <ID>` | 探查结构与书籍发现 |
| `npm run import-html -- --dir ... --book-id ... --source ...` | 本地 HTML 兜底导入 |
| `npm run verify` | 无数据库自检 |
| `npm run check:cloud` | 云托管上线前静态自检（端口/锁文件/忽略规则/小程序调用配置） |
| `npm run db:migrate -- --host=... --pass=...` | 本地库 → 云库数据迁移 |
| `npm run dev:cloud` | 本地起服务但连**云库**（读 `server/.env.cloud`） |
| `npm start` / `npm run dev` | 启动服务 |

## 六、部署上线（微信云托管）

正式对外提供访问需要公网地址。本项目已适配微信云托管：小程序用 `wx.cloud.callContainer` 走微信内网调用，
**不需要服务器域名、不需要备案、不用自己配 HTTPS**。

完整步骤见 **[docs/deploy-cloudrun.md](docs/deploy-cloudrun.md)**，要点：

- **上线前先自检**：`cd server && npm run check:cloud`（10 秒，静态核对端口/锁文件/`.dockerignore`/小程序调用配置，`✗` 项必须修）；
- **发布后验收**：`cd server && npm run verify:cloud -- https://<访问域名>`（真实打 6 个接口，含「有数据」「404 语义」，全 ✓ 才切 `MODE`）；
- **镜像二选一**（`container.config.json` 的 `dockerfilePath` 决定，当前是精简版）：
  - `Dockerfile.lite` → 镜像 ~330MB，构建 1~2 分钟；登录/书架/目录/阅读、**七猫源的搜索与导入全部可用**；仅「需要过 WAF 的第三方站点」（69shuba 等粘贴链接、这类书的补章）不可用，会返回可读错误；
  - `Dockerfile` → Node 20 + Chromium headless shell，镜像 1.31GB，功能完整，但**推送 TCR 易超时**（构建机上行只有 ~3MB/s，两个大层并发必挂一层）；
  - 现成部署包：`novel-api-deploy.zip`（精简版，先传这个）、`novel-api-deploy-full.zip`（完整版）。
- `container.config.json` 已配好端口 80 / 1 核 2G / 最小实例 0；
- 服务名与环境 ID 必须与控制台一致（当前 `CLOUD_ENV=prod-d8g08o83h02a961c3`、`CLOUD_SERVICE=nove-service`）；
  **该环境必须由本小程序 `wx3de365140274c5f6` 自己开通**——跨主体不支持资源复用，旧环境 `prod-d2gmec6wl77c62d83`
  正是因为主体不同才导致 `callContainer` 永远 404 `INVALID_HOST`（详见 docs 6.3）；
- 数据库：**当前用 `grp-ak4ysgny` 实例**（2026-11-10 14:40 迁完）外网
  `sh-cynosdbmysql-grp-ak4ysgny.sql.tencentcdb.com:23729`、内网 `10.5.110.101:3306`；
  数据 85 本 / 4424 章。旧实例 `grp-3fmbpvpu` / `grp-qcog9b86` 可停用；
- 数据迁移：`cd server && npm run db:migrate -- --host=<云库外网地址> --port=<端口> --pass=<密码>`（源库是本地库）；
  本机若报 `ENOTFOUND`（运营商 DNS 解析不了腾讯云新域名），改用 `--host=<解析出的 IP>`；
- 小程序已切云端（2026-11-10）：`MODE='cloud'`、`ENABLE_DEMO=false`、`CLOUD_VIA='auto'`、`CLOUD_BASE_URL=''`（留空）；
- **体验版只有两条可行链路**：① 环境同主体 → `callContainer` 直通（当前方案）；
  ② 云托管绑一个已备案自定义域名，填进 `CLOUD_BASE_URL` 并加入小程序 request 合法域名（官方禁止用默认公网域名）。详见 docs 6.2；
- 临时回本地开发：把 `MODE` 改回 `'local'` 即可（直连 `http://127.0.0.1:3000`）；
- 线上实测（`npm run verify:cloud`）：首页/分类/目录/health 全通；**全网搜索因七猫对云托管出口 IP 触发人机验证而失败**，属预期，需在本机跑搜索/补章，详见 docs 7.2；
- **冷启动**：最小实例 0 时闲置后首个请求要 20~30s，微信网关等不到会回 500（小程序表现为「网络异常」）。客户端已加 2 次自动重试 + 「正在唤醒服务…」提示（`utils/request.js` 的 `WAKE_RETRY`），根治办法是把最小实例调成 1，详见 docs 7.1；
- 开发期不受影响：`MODE` 保持 `'local'` 时仍然直连 `http://127.0.0.1:3000`（真机用局域网 IP）。

## 七、注意事项

- 七猫/番茄为简体内容；`twkan` 为繁体，抓取后统一用 OpenCC 转简体入库。
- `twkan` 有 Cloudflare 人工验证，仅作可选源；每周自动抓取推荐用七猫/番茄（无需人工验证）。
- 站点结构与反爬会变化，解析器采用「选择器提示 + 通用启发式」双重策略；若某站失真，跑 `probe` 后调整 `sources.js`。
- 测试号下未配置 AppSecret 时，登录为本地 mock，仅用于开发；上线务必配置 `WX_APPID` / `WX_SECRET`。
- 上线前把 `miniprogram/utils/config.js` 的 `ENABLE_DEMO` 改为 `false`，避免真实接口为空时显示演示数据。
- 请遵守各网站的使用条款与当地版权法律法规，本项目仅供学习交流。
