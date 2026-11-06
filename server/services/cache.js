// 极简内存缓存：爬虫每周才更新，首页/排行等接口缓存 1 天足够
const store = new Map();

export function cacheGet(key) {
  const item = store.get(key);
  if (!item) return null;
  if (Date.now() > item.expireAt) {
    store.delete(key);
    return null;
  }
  return item.value;
}

export function cacheSet(key, value, ttlMs = 24 * 60 * 60 * 1000) {
  store.set(key, { value, expireAt: Date.now() + ttlMs });
}

export function cacheClear() {
  store.clear();
}
