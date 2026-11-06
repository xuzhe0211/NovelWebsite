Component({
  properties: {
    text: { type: String, value: '暂无数据' },
    showButton: { type: Boolean, value: false },
    buttonText: { type: String, value: '去逛逛' },
  },
  methods: {
    onButton() {
      this.triggerEvent('button');
    },
  },
});
