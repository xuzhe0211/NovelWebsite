/**
 * 演示数据层
 * ------------------------------------------------------------
 * 作用：后端未启动 / 数据库还没抓取到小说时，列表页不再白屏。
 * 触发条件只有两种：
 *   1. 请求失败（网络异常、5xx）→ 用匹配的演示数据兜底；
 *   2. 请求成功但列表为空（页面显式传 demoFill: true）→ 用演示数据填充。
 * 所有兜底都会把 demoMode 置为 true，页面顶部展示「演示数据」提示条。
 * 上线前把 utils/config.js 的 ENABLE_DEMO 改成 false 即可完全关闭。
 */

const { ENABLE_DEMO } = require('./config');

const SHELF_KEY = 'novel_demo_shelf';

let demoMode = false;

function markDemo() {
  demoMode = true;
}
function isDemo() {
  return demoMode && ENABLE_DEMO;
}
function resetDemo() {
  demoMode = false;
}

const CATEGORIES = [
  { id: 1, name: '玄幻', slug: 'xuanhuan', sortOrder: 1 },
  { id: 2, name: '奇幻', slug: 'qihuan', sortOrder: 2 },
  { id: 3, name: '武侠', slug: 'wuxia', sortOrder: 3 },
  { id: 4, name: '仙侠', slug: 'xianxia', sortOrder: 4 },
  { id: 5, name: '都市', slug: 'dushi', sortOrder: 5 },
  { id: 6, name: '现实', slug: 'xianshi', sortOrder: 6 },
  { id: 7, name: '军事', slug: 'junshi', sortOrder: 7 },
  { id: 8, name: '历史', slug: 'lishi', sortOrder: 8 },
  { id: 9, name: '游戏', slug: 'youxi', sortOrder: 9 },
  { id: 10, name: '体育', slug: 'tiyu', sortOrder: 10 },
  { id: 11, name: '科幻', slug: 'kehuan', sortOrder: 11 },
  { id: 12, name: '悬疑', slug: 'xuanyi', sortOrder: 12 },
  { id: 13, name: '女生', slug: 'nvsheng', sortOrder: 13 },
  { id: 14, name: '二次元', slug: 'erciyuan', sortOrder: 14 },
  { id: 15, name: '言情', slug: 'yanqing', sortOrder: 15 },
];

// [书名, 作者, 分类slug, 是否完本, 字数, 点击量, 评分, 简介, 最新章节标题, 更新于几天前]
const RAW = [
  ['剑起青冥', '夜航船', 'xuanhuan', false, 1286000, 982300, 9.2, '少年林青冥在废井中得到一柄断剑，从此踏上一条与整个修真界为敌的路。剑锋所指，青冥之上，无人可挡。', '第两百一十三章 断剑归鞘', 1],
  ['星海归途', '南十字', 'kehuan', true, 962000, 764100, 9.0, '一艘失踪三百年的殖民舰突然回到太阳系，船上只有一个孩子。他带回来的，是一段被抹去的人类往事。', '终章 归途', 12],
  ['长安十二楼', '柳三更', 'lishi', false, 884000, 856200, 8.9, '天宝年间的长安城，十二座酒楼各藏一条线索。一个小小书吏，靠着一本残缺的账册，撬动了整座帝国的暗流。', '第叁百零二章 灯下黑', 3],
  ['雾都侦探社', '白鸦', 'xuanyi', true, 546000, 632700, 8.7, '雾都的雨从不停歇，失踪案也从未断过。侦探社里那位从不接案的女主人，只在深夜开门。', '尾声 雨停了', 26],
  ['我在都市当灵官', '半盏茶', 'dushi', false, 2103000, 1688200, 8.8, '白天是写字楼里最不起眼的外卖员，夜里是替这座城收拾残局的灵官。加班费和香火钱，总得赚一样。', '第1350章 加班的城隍', 1],
  ['山海食肆', '陈小满', 'xianshi', true, 398000, 421900, 8.6, '一间开在巷子深处的小馆子，老板做菜从不问客人来历。有人说，他端的每一碗面，都对应着一段人生。', '终章 打烊', 18],
  ['剑气纵横三万里', '孤鸿子', 'wuxia', true, 758000, 588300, 8.5, '江湖上最后一个用剑的人，把剑埋进了雪山。二十年后，一个放羊的孩子挖出了它。', '终章 剑在人在', 41],
  ['云上仙门', '青岚', 'xianxia', false, 1452000, 1120600, 9.1, '仙门悬于云上，收徒只看一样东西——你愿不愿意忘记自己的名字。她记住了，所以她成了异类。', '第802章 记得', 2],
  ['第七舰队', '铁马冰河', 'junshi', false, 682000, 356400, 8.4, '一支被上级放弃的舰队，一片没有补给线的海域，一场不能输的撤离。', '第441章 归航坐标', 6],
  ['云端恋人', '林小满', 'yanqing', true, 432000, 712500, 8.3, '她在地面做气象观测，他在三万英尺的高空飞。两个人的时差，是三百六十五天里错过的每一次日出。', '番外 同一天晴', 33],
  ['开局一把木剑', '老K', 'youxi', false, 1180000, 906700, 8.6, '全服第一的账号被删，只剩一把新手木剑。他决定用这把剑，重新打回排行榜第一。', '第910章 木剑问鼎', 4],
  ['篮球之魂', '三分雨', 'tiyu', false, 615000, 288900, 8.2, '被省队淘汰的那天，他在球馆里投了一千个球。十年后，这里挂着他的球衣。', '第388章 最后一投', 9],
  ['二次元事务所', '猫不理', 'erciyuan', true, 356000, 401200, 8.0, '专门替纸片人打官司的事务所，接的第一桩案子，是替一个反派讨回公道。', '终章 全员登场', 52],
  ['观星者', '南十字', 'kehuan', true, 512000, 478600, 9.0, '天文台最后一夜，他收到一段来自四十七年前的信号。发信的人，是年轻时的自己。', '终章 光年之外', 70],
  ['大明小吏', '柳三更', 'lishi', true, 996000, 823100, 8.8, '一个县衙里抄文书的小吏，靠着一手好字和一颗清醒的脑子，在洪武年间的官场里活了下来。', '终章 一纸调令', 61],
  ['诡楼夜话', '白鸦', 'xuanyi', false, 478000, 512300, 8.5, '这栋楼一共十八层，电梯里却总有第十九个按钮。按下去的人，都再没回来。', '第268章 十九层', 2],
  ['我的老板是AI', '半盏茶', 'dushi', true, 624000, 689400, 8.4, '公司新来的CEO不吃饭不睡觉，只发邮件。直到某天，它给全体员工发了一封辞职信。', '终章 关机', 44],
  ['剑宗最后一位弟子', '孤鸿子', 'xuanhuan', true, 1385000, 1024700, 9.3, '剑宗覆灭那日，师尊把宗门的名字塞进他怀里。此后百年，他一个人就是一个宗门。', '终章 山门重开', 88],
  ['逆流而上', '陈小满', 'xianshi', false, 288000, 196500, 8.1, '小城工厂关停的那年，她三十岁，带着一群下岗的姐妹重新开了一条生产线。', '第156章 新订单', 5],
  ['深空信标', '夜航船', 'kehuan', false, 742000, 534800, 8.7, '人类在宇宙边缘点亮了一座灯塔，然后等了四百年，等来了一句回应。', '第421章 回应', 7],
  ['千机变', '青岚', 'wuxia', true, 688000, 445600, 8.4, '机关城的主人死了，留下一座会自己走路的城。谁能让它停下来，谁就是下一个主人。', '终章 城停', 95],
  ['桃花渡', '林小满', 'yanqing', true, 368000, 587200, 8.6, '渡口的老船夫说，每年桃花开的时候，都会有一个穿白衣的人来等船。等了三十年。', '终章 渡', 76],
  ['全职奶爸', '老K', 'dushi', false, 862000, 731500, 8.2, '退役特种兵回家带娃，第一天就把幼儿园的三个老师送进了医院。', '第512章 家长会', 3],
  ['网游之圣殿', '三分雨', 'youxi', true, 1024000, 655300, 8.5, '十年老游戏关服前的最后一夜，全服玩家自发回到主城，站成了一排。', '终章 下线', 58],
];

const CAT_MAP = CATEGORIES.reduce((acc, c) => {
  acc[c.slug] = c;
  return acc;
}, {});

function daysAgoISO(days) {
  const d = new Date('2026-11-05T09:00:00+08:00');
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const NOVELS = RAW.map((r, i) => {
  const cat = CAT_MAP[r[2]] || CATEGORIES[0];
  return {
    id: 1001 + i,
    sourceId: `demo-${1001 + i}`,
    title: r[0],
    author: r[1],
    coverUrl: '',
    intro: r[7],
    status: r[3] ? '完结' : '连载中',
    isCompleted: r[3],
    wordCount: r[4],
    clickCount: r[5],
    rating: r[6],
    lastChapterId: (1001 + i) * 1000 + 18,
    lastChapterTitle: r[8],
    lastUpdateTime: daysAgoISO(r[9]),
    category: { id: cat.id, name: cat.name, slug: cat.slug },
  };
});

const CHAPTER_TITLES = [
  '风起', '旧梦', '夜行', '初雪', '故人来', '断刃', '长街', '灯下',
  '南渡', '归期', '无声', '惊蛰', '残局', '月落', '孤城', '黎明',
  '回望', '终局',
];

const PARA_POOL = [
  '天还没亮，屋檐下的水一滴一滴落在青石板上，声音清脆得像在数着什么。',
  '他站在门口，没有立刻推门，只是抬手拂去门环上的灰，动作很慢。',
  '风从长街另一头卷过来，带着一点潮气，还有说不清的、旧木头的气味。',
  '有人在很远的地方叫了一声他的名字，又或者只是错觉，他没有回头。',
  '屋子里很静，只有灯芯偶尔炸开一小朵火花，映得墙上的影子轻轻晃了一下。',
  '他把手里的东西放在桌上，指节在桌沿停了一停，才缓缓开口。',
  '“有些账，不是不算，是时候没到。”他说这句话的时候，语气平常得像在说今天的天气。',
  '对方沉默了很久，久到窗外的雨都小了下去，才低低地应了一声。',
  '那一瞬间，他忽然想起许多年前的一个清晨，也是这样的天色，也是这样安静。',
  '路还长，天总会亮的，只是不知道还要走多久。',
  '街角的面摊已经支起来了，热气腾腾，把整条巷子都熏得暖了些。',
  '他没有再问，转身走进了人群里，很快就被来往的身影淹没。',
  '远处的钟声敲了三下，夜更深了，城门口的火把被风吹得忽明忽暗。',
  '桌上的茶已经凉透，他端起来喝了一口，眉头几不可察地皱了一下。',
  '“你不该来的。”这句话说得很轻，却让屋里的空气一下子沉了下去。',
  '窗纸被风顶起一角，月光斜斜地铺进来，落在半张摊开的地图上。',
  '他忽然笑了一下，那笑意很浅，像是想起了什么很久以前的事。',
  '马蹄声由远及近，停在门外，紧接着是三声不轻不重的叩门。',
  '所有的线索都指向同一个地方，而那个地方，他这辈子都不想再回去。',
  '天边泛起一线灰白，雨终于停了，屋檐上还挂着未落尽的水珠。',
  '她把手缩回袖子里，指尖凉得厉害，却还是把话说完了。',
  '这一刻他忽然明白，有些路一旦走上去，就再没有回头的余地。',
];

function pickParas(seed, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(PARA_POOL[(seed * 7 + i * 3) % PARA_POOL.length]);
  }
  return out;
}

function findNovel(id) {
  return NOVELS.find((n) => String(n.id) === String(id));
}

function chapterListOf(novelId) {
  const novel = findNovel(novelId);
  if (!novel) return [];
  const total = 18;
  return Array.from({ length: total }, (_, i) => {
    const no = i + 1;
    return {
      id: Number(novelId) * 1000 + no,
      chapterNo: no,
      title: `第${no}章 ${CHAPTER_TITLES[(i + Number(novelId)) % CHAPTER_TITLES.length]}`,
      wordCount: 2200 + ((i * 137) % 900),
    };
  });
}

function chapterOf(chapterId) {
  const id = Number(chapterId);
  const novelId = Math.floor(id / 1000);
  const no = id % 1000;
  const novel = findNovel(novelId);
  if (!novel || no < 1 || no > 18) return null;
  const title = `第${no}章 ${CHAPTER_TITLES[(no - 1 + novelId) % CHAPTER_TITLES.length]}`;
  const paras = pickParas(no + novelId, 26);
  const content = `　　${paras.join('\n\n　　')}`;
  return {
    id,
    novelId,
    chapterNo: no,
    title,
    wordCount: content.length,
    content,
    prev: no > 1 ? { id: novelId * 1000 + no - 1, title: `第${no - 1}章` } : null,
    next: no < 18 ? { id: novelId * 1000 + no + 1, title: `第${no + 1}章` } : null,
  };
}

function sortNovels(list, sort) {
  const arr = list.slice();
  if (sort === 'words') return arr.sort((a, b) => b.wordCount - a.wordCount);
  if (sort === 'new') return arr.sort((a, b) => new Date(b.lastUpdateTime) - new Date(a.lastUpdateTime));
  if (sort === 'rating') return arr.sort((a, b) => b.rating - a.rating);
  return arr.sort((a, b) => b.clickCount - a.clickCount);
}

function novelPage(params) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Number(params.pageSize) || 20);
  let list = NOVELS.slice();

  if (params.status === 'completed' || params.status === '完结') {
    list = list.filter((n) => n.isCompleted);
  } else if (params.status === 'serial' || params.status === '连载中') {
    list = list.filter((n) => !n.isCompleted);
  }
  if (params.category) {
    const key = String(params.category);
    list = list.filter((n) =>
      /^\d+$/.test(key) ? n.category.id === Number(key) : n.category.slug === key
    );
  }
  if (params.keyword) {
    const kw = String(params.keyword).trim();
    list = list.filter((n) => n.title.includes(kw) || n.author.includes(kw));
  }

  list = sortNovels(list, params.sort);
  const total = list.length;
  const start = (page - 1) * pageSize;
  const rows = list.slice(start, start + pageSize).map((n) => ({ ...n }));
  return { list: rows, total, page, pageSize, hasMore: page * pageSize < total };
}

function homeData() {
  return {
    hot: sortNovels(NOVELS, 'hot').slice(0, 10).map((n) => ({ ...n })),
    latest: sortNovels(NOVELS, 'new').slice(0, 12).map((n) => ({ ...n })),
    categories: CATEGORIES.map((c) => ({ ...c })),
  };
}

function rankingData(type) {
  const sort = type === 'week' ? 'new' : type === 'month' ? 'rating' : 'hot';
  return sortNovels(NOVELS, sort)
    .slice(0, 50)
    .map((n, i) => ({ rank: i + 1, ...n }));
}

/* ---------------- 本地书架（演示模式） ---------------- */

function shelfList() {
  const raw = wx.getStorageSync(SHELF_KEY) || [];
  return raw
    .map((item) => {
      const novel = findNovel(item.novelId);
      if (!novel) return null;
      const chapters = chapterListOf(item.novelId);
      const chapter = chapters.find((c) => c.id === Number(item.lastChapterId)) || chapters[0];
      return {
        novelId: novel.id,
        lastChapterId: chapter ? chapter.id : null,
        lastChapterTitle: chapter ? chapter.title : '',
        lastPosition: item.lastPosition || 0,
        updatedAt: item.updatedAt || 0,
        novel: { ...novel },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveShelf(list) {
  wx.setStorageSync(SHELF_KEY, list);
}

function shelfAdd(novelId) {
  const id = Number(novelId);
  if (!findNovel(id)) return false;
  const list = wx.getStorageSync(SHELF_KEY) || [];
  if (!list.some((x) => Number(x.novelId) === id)) {
    list.push({ novelId: id, lastChapterId: null, lastPosition: 0, updatedAt: Date.now() });
    saveShelf(list);
  }
  return true;
}

function shelfRemove(novelId) {
  const id = Number(novelId);
  const list = (wx.getStorageSync(SHELF_KEY) || []).filter((x) => Number(x.novelId) !== id);
  saveShelf(list);
  return true;
}

function shelfProgress(body) {
  const id = Number(body.novelId);
  const list = wx.getStorageSync(SHELF_KEY) || [];
  const item = list.find((x) => Number(x.novelId) === id);
  if (!item) {
    list.push({
      novelId: id,
      lastChapterId: Number(body.chapterId),
      lastPosition: Number(body.position) || 0,
      updatedAt: Date.now(),
    });
  } else {
    item.lastChapterId = Number(body.chapterId);
    item.lastPosition = Number(body.position) || 0;
    item.updatedAt = Date.now();
  }
  saveShelf(list);
  return true;
}

/* ---------------- 路由匹配 ---------------- */

function parseQuery(qs) {
  const out = {};
  (qs || '').split('&').forEach((pair) => {
    if (!pair) return;
    const [k, v] = pair.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return out;
}

function splitUrl(url) {
  const [path, qs] = String(url).split('?');
  return { path, params: parseQuery(qs) };
}

// 请求失败时的兜底：命中返回数据，未命中返回 undefined
function fallback(method, url, body) {
  if (!ENABLE_DEMO) return undefined;
  const { path, params } = splitUrl(url);
  const m = method || 'GET';

  if (m === 'GET') {
    if (path === '/api/home') return homeData();
    if (path === '/api/categories') return CATEGORIES.map((c) => ({ ...c }));
    if (path === '/api/ranking') return rankingData(params.type);
    if (path === '/api/novels') return novelPage(params);
    if (path === '/api/bookshelf') return shelfList();

    let hit = path.match(/^\/api\/novels\/(\d+)$/);
    if (hit) {
      const novel = findNovel(hit[1]);
      return novel ? { ...novel, chapterCount: 18 } : undefined;
    }
    hit = path.match(/^\/api\/novels\/(\d+)\/chapters$/);
    if (hit) return chapterListOf(hit[1]);
    hit = path.match(/^\/api\/chapters\/(\d+)$/);
    if (hit) return chapterOf(hit[1]) || undefined;
  }

  if (m === 'POST' && path === '/api/bookshelf') {
    shelfAdd(body && body.novelId);
    return { ok: true };
  }
  if (m === 'DELETE' && /^\/api\/bookshelf\/\d+$/.test(path)) {
    shelfRemove(path.split('/').pop());
    return { ok: true };
  }
  if (m === 'PUT' && path === '/api/bookshelf/progress') {
    shelfProgress(body || {});
    return { ok: true };
  }

  return undefined;
}

// 请求成功但列表为空时的填充
function fill(url) {
  if (!ENABLE_DEMO) return undefined;
  const { path, params } = splitUrl(url);
  if (path === '/api/home') return homeData();
  if (path === '/api/categories') return CATEGORIES.map((c) => ({ ...c }));
  if (path === '/api/ranking') return rankingData(params.type);
  if (path === '/api/novels') {
    if (params.keyword) return undefined; // 搜索空结果保持为空，避免误导
    return novelPage(params);
  }
  return undefined;
}

function loginDemo() {
  const user = { id: 0, nickname: '本地体验用户', avatar: '', demo: true };
  wx.setStorageSync('novel_token', 'demo-local-token');
  wx.setStorageSync('novel_user', user);
  demoMode = true;
  return { token: 'demo-local-token', user };
}

module.exports = {
  ENABLE_DEMO,
  CATEGORIES,
  NOVELS,
  markDemo,
  isDemo,
  resetDemo,
  fallback,
  fill,
  loginDemo,
  shelfList,
};
