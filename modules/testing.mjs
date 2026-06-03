export default class TestingModule {
  async init(host, config) {
    this.host = host;
    this.config = config;
    console.log("[Testing] Module initialized.");
  }

  async handleMessage(cleanText, replyCallback, contact = null, info = {}) {
    // Only respond to channel messages on the test or testing channels
    if (!contact) {
      const testIdx = this.host.channels.test?.channelIdx;
      const testingIdx = this.host.channels.testing?.channelIdx;

      if (info.channelIdx !== undefined && (info.channelIdx === testIdx || info.channelIdx === testingIdx)) {
        if (cleanText.toLowerCase().includes('test')) {
          await replyCallback("Test OK");
        }
      }
    }
  }
}
