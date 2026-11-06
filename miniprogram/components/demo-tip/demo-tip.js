Component({
  properties: {
    show: { type: Boolean, value: false },
    text: { type: String, value: '未连接后端或数据为空，当前展示演示数据' },
  },
  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },
  },
});
