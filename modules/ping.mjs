export default class PingModule {
  async init(host, config) {
    this.host = host;
    this.config = config;
    console.log("[Ping] Module initialized.");
  }

  async handleMessage(cleanText, replyCallback, contact = null) {
    if (cleanText.toLowerCase() === 'ping') {
      const reply = this.config.replyUppercase ? "PONG" : "pong";
      await replyCallback(reply);
    }
  }
}
