# 设计说明

## 架构

```
微信小程序 (miniprogram/)
        │  HTTP + JWT
        ▼
Node.js API (server/app.js)
  ├─ routes/       业务接口
  ├─ models/       Sequelize → MySQL
  └─ jobs/weekly   node-cron 每周末
        │
        ▼
  scraper/        Playwright 抓 twkan.com → 解析 → opencc 繁转简 → 入库
```

## 数据模型

- `users`：openid 唯一，微信用户
- `categories`：分类（seed 15 个）
- `novels`：小说，`source_id` 唯一（站点小说ID）
- `chapters`：章节，`(novel_id, source_chapter_id)` 唯一，正文存简体，`chapter_no` 排序
- `bookshelves`：书架，`(user_id, novel_id)` 唯一，记录最近章节与滚动百分比

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | code(+deviceId) → token |
| GET | /api/auth/profile | 当前用户（需登录） |
| GET | /api/home | 首页聚合（缓存 1 天） |
| GET | /api/categories | 分类列表（缓存 1 天） |
| GET | /api/novels | 列表：category/status/keyword/sort/page |
| GET | /api/novels/:id | 详情 |
| GET | /api/novels/:id/chapters | 章节列表 |
| GET | /api/chapters/:id | 正文 + 上/下一章 |
| GET | /api/ranking | 排行：type=week/month/total |
| GET | /api/bookshelf | 我的书架（需登录） |
| POST | /api/bookshelf | 加入书架（需登录，幂等） |
| DELETE | /api/bookshelf/:novelId | 移出书架（需登录） |
| PUT | /api/bookshelf/progress | 更新进度（需登录） |

统一响应：`{ code, message, data }`，`code === 0` 成功。

## 登录

- 正式：`wx.login` → code → 后端 `jscode2session` → openid → JWT
- 开发（未配 AppSecret）：后端用前端稳定的 `deviceId` 作为 `mock_<id>` openid，保证多次登录同一用户
- 前端 token 过期（401）自动静默重登并重放请求

## 爬虫策略（多数据源）

数据源在 `services/scraper/sources.js` 定义，支持 `qimao`（七猫，默认）、`fanqie`（番茄）、`twkan`。每个源包含：URL 规则（book/chapter）、链接识别（bookIdFromHref / chapterIdFromHref）、发现选择器、以及标题/作者/简介/封面/正文的选择器提示。

1. **抓取**：Playwright（stealth + 持久化上下文 `.playwright-profile/`，真实 UA、zh-TW、Asia/Taipei）渲染页面后交给 cheerio 解析；页面被关闭会自动重启上下文重试。
2. **验证处理**：七猫/番茄一般无需人工验证，可无人值守；`twkan` 有 Cloudflare，需首次有头人工过一次（`--headful`），会话落盘复用。抓取时轮询页面标题判断挑战是否通过。
3. **解析**：优先用源的选择器提示；命中不足时用通用启发式——章节链接按 URL 规则识别并按“第N章”数字排序，正文取“汉字最多且链接占比低”的块，去广告/导航噪声行。
4. **发现**：无 `CRAWL_SEED_IDS` 时，从 `CRAWL_LIST_URL`（或源首页）按 `discoverSelector` 自动发现书籍，最多 `CRAWL_MAX_BOOKS` 本。
5. **增量**：按 `(novel_id, source_chapter_id)` 跳过已抓章节；空正文/VIP 章节跳过并记录。
6. **繁简**：opencc-js `tw→cn`；七猫/番茄本就是简体（转换无副作用），twkan 繁转简后入库。
7. **兜底**：无法自动抓取时，人工保存 HTML 后用 `import-html.js` 导入。

### 已知不确定项（需实测确认）

- 七猫/番茄的真实 DOM、章节列表是否分页、正文是否服务端渲染（需 `probe` 实测）
- 番茄 `reader` 链接不含书籍ID，跨书推荐链接可能混入，需 probe 确认目录容器
- 封面图是否防盗链（如防盗链：爬虫下载封面到 `public/` 或服务端代理）
- 章节排序是否依赖“第X章”阿拉伯数字（当前按数字排序，否则按 DOM 顺序）

## 阅读器

- 正文按 `\n` 拆成段落数组，`<text selectable>` 整章一次渲染（不用 rich-text）
- 字号 26–48rpx、白/黄/黑三主题，设置存 storage
- 两种阅读方式（`reader_settings.pageMode`）：
  - `scroll`：整章连续滚动，滚动节流保存进度（2s），`onUnload` 再存一次
  - `flip`：一屏一页，离屏 canvas 量字宽折行（含避头标点处理）→ 按 `floor(高度/行高)` 装页；
    左右点按/滑动翻页，跨章自动续读；页脚显示页码与百分比
- 进入阅读自动加入书架；从书架「继续阅读」带 `position` 进入时恢复位置（翻页模式下按百分比映射到页）

## 小程序前端结构

- tabBar：首页 / 排行 / 完本 / 分类 / 我的；图标在 `assets/tabbar/`（81×81 PNG，普通态 + 选中态）
- 「我的」承载用户体系：登录入口、书架统计、最近在读、退出登录、清缓存；「我的书架」为二级页
- 列表页统一结构：筛选区 → 演示提示条 → 列表卡片 → 骨架屏 → 空状态（带重试）
- 设计规范：主色 `#e8733b`（渐变 `#ff9457 → #e8733b`），卡片圆角 20rpx，文字三级灰 `#1f2329 / #61666d / #9aa0a6`

### 演示数据兜底

`utils/demo.js` 内置 23 本小说、15 个分类、每本 18 章正文与本地书架，`utils/request.js` 在两种情况下启用：

1. 请求失败（网络异常 / 5xx）→ 命中路由则返回演示数据；
2. 请求成功但列表为空（页面传 `demoFill: true`）→ 用演示数据填充。

启用后模块级 `demoMode` 置真，页面顶部显示 `demo-tip` 提示条并支持重试；上线前置 `utils/config.js` 的 `ENABLE_DEMO = false` 即可关闭。演示模式下登录降级为本地体验用户（`demo-local-token`），书架走本地 storage，避免后端不可用时整个流程断掉。

### 封面策略

- 所有封面统一用 `components/novel-cover`，尺寸由 `size`（rpx）决定，高度按 3:4 计算；
- 有 `coverUrl` 且加载成功 → 显示原图；为空 / 404 / 防盗链 403 → 用书名 hash 选一组深色渐变，渲染「分类 + 书名 + 作者 + 水印字」的排版封面，列表里不会出现空白块；
- 相对路径补 `BASE_URL`；外链默认经后端 `GET /api/cover?url=` 代理（服务端带 Referer、6h 内存缓存、3MB 上限、内网地址拦截），可用 `USE_COVER_PROXY = false` 关闭。
- 小程序 3.8.7+ 的 `image` 组件在开发版/体验版不加载 `http://` 图片（真机预览静默空白、不触发 `binderror`），所以外链封面默认改走 data URI：
  `wx.request GET /api/cover?url=...&b64=1&w=<像素宽>` 取回 `data:image/jpeg;base64,...` 再赋给 `<image src>`；
  服务端用 `sharp` 缩到显示宽度 ×2.2、JPEG 66%（单张约 20KB），取失败再退回代理地址，最后才用文字封面。开关 `COVER_INLINE`。

### 登录态

- `novel_token` + `novel_user` 存 storage，请求统一带 `Authorization: Bearer`；
- 登录失败时区分「网络不可达」与「服务端返回错误」，登录页直接展示原因，并提供显式「先用本地体验账号」入口；
- 未登录访问书架 / 加入书架不再静默自动登录，统一弹窗或空态引导；
- 登录后可设置头像（`chooseAvatar` + 本地 `saveFile` 持久化）与昵称（`type=nickname`，`PUT /api/auth/profile` 同步到 `users` 表）。

## 开发环境

- 微信开发者工具：勾选「不校验合法域名」
- 后端 `BASE_URL` 在 `miniprogram/utils/config.js`（默认 `http://127.0.0.1:3000`，与 `server/.env` 的 `DB_HOST` 保持一致）
- MySQL 8（utf8mb4_0900_ai_ci）；未启动时前端自动走演示数据
