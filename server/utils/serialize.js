// 小说序列化：统一列表/详情返回的字段
export function serializeNovel(n) {
  const j = typeof n.toJSON === 'function' ? n.toJSON() : n;
  return {
    id: j.id,
    sourceId: j.sourceId,
    title: j.title,
    author: j.author,
    coverUrl: j.coverUrl,
    intro: j.intro,
    status: j.status,
    isCompleted: j.isCompleted,
    wordCount: Number(j.wordCount || 0),
    clickCount: j.clickCount,
    rating: j.rating,
    lastChapterId: j.lastChapterId,
    lastChapterTitle: j.lastChapterTitle,
    lastUpdateTime: j.lastUpdateTime,
    category: j.category ? { id: j.category.id, name: j.category.name } : undefined,
  };
}

// 分页参数解析：page 从 1 开始
export function parsePaging(query, { defaultSize = 20, maxSize = 50 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pagedResult(rows, total, page, pageSize) {
  return {
    list: rows,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}
