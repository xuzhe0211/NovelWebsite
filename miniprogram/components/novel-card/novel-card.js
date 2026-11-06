const { formatWordCount, formatCount } = require('../../utils/util');

Component({
  properties: {
    novel: { type: Object, value: {} },
    showIntro: { type: Boolean, value: true },
    rank: { type: Number, value: 0 },
  },
  data: {
    initial: '书',
    wordText: '',
    hotText: '',
  },
  observers: {
    novel(n) {
      if (!n) return;
      this.setData({
        initial: (n.title || '书')[0],
        wordText: n.wordCount ? formatWordCount(n.wordCount) : '',
        hotText: n.clickCount ? formatCount(n.clickCount) : '',
      });
    },
  },
  methods: {
    onTap() {
      const id = this.data.novel && this.data.novel.id;
      if (!id) return;
      wx.navigateTo({ url: `/pages/novel-detail/novel-detail?id=${id}` });
    },
  },
});
