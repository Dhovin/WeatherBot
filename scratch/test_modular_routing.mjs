import WeatherModule from '../modules/weather.mjs';
import PingModule from '../modules/ping.mjs';
import TestingModule from '../modules/testing.mjs';
import * as utils from '../utils.mjs';

async function runTest() {
  console.log("--------------------------------------------------");
  console.log("   Starting Modular Bot Framework Verification    ");
  console.log("--------------------------------------------------");

  // 1. Setup Mock Host environment
  const mockHost = {
    VERSION: "1.1.0",
    utils: utils,
    channels: {
      alerts: { channelIdx: 1, name: "#weather" },
      weather: { channelIdx: 1, name: "#weather" },
      test: { channelIdx: 2, name: "#test" },
      testing: { channelIdx: 3, name: "#testing" }
    },
    sentDMs: [],
    sentChannelMessages: [],
    
    async sendDM(publicKey, text) {
      console.log(`[Mock Host] DM Sent to ${Buffer.from(publicKey).toString('hex')}: ${text}`);
      this.sentDMs.push({ publicKey, text });
    },
    
    async sendChannelMessage(channelIdx, text) {
      console.log(`[Mock Host] Channel Broadcast to Index ${channelIdx}: ${text}`);
      this.sentChannelMessages.push({ channelIdx, text });
    }
  };

  // 2. Instantiate and Initialize Modules
  console.log("Loading modules...");
  
  const pingConfig = { replyUppercase: true };
  const pingMod = new PingModule();
  await pingMod.init(mockHost, pingConfig);
  pingMod.name = "ping";

  const weatherConfig = {
    weatherAlarm: "06:00",
    zipCode: "20001",
    userAgent: "MeshCoreWeatherBot/1.1.0 (contact@example.com)",
    timers: {
      blitzCollection: 600000,
      meteoAlerts: 600000
    },
    compasNames: {
      "N": "North", "NE": "North-East", "E": "East", "SE": "South-East",
      "S": "South", "SW": "South-West", "W": "West", "NW": "North-West"
    },
    meteoAlerts: {
      enabled: false // disable alerts checking during tests
    }
  };
  const weatherMod = new WeatherModule();
  await weatherMod.init(mockHost, weatherConfig);
  weatherMod.name = "weather";

  const testingMod = new TestingModule();
  await testingMod.init(mockHost, {});
  testingMod.name = "testing";

  const activeModules = [pingMod, weatherMod, testingMod];

  // Helper to simulate incoming command dispatching
  async function simulateDispatch(text, contact = null, channelIdx = 1) {
    console.log(`\nSimulating command: "${text}" on channel index ${channelIdx}`);
    let repliedText = null;
    const replyCallback = async (reply) => {
      repliedText = reply;
    };

    for (const mod of activeModules) {
      await mod.handleMessage(text, replyCallback, contact, { channelIdx });
    }
    return repliedText;
  }

  // 3. Test Routing Cases
  let failed = false;

  // Test Case A: Ping Module command
  const pingReply = await simulateDispatch("ping");
  if (pingReply === "PONG") {
    console.log("PASS: Ping command routed and replied correctly.");
  } else {
    console.error(`FAIL: Expected 'PONG', got '${pingReply}'`);
    failed = true;
  }

  // Test Case B: Unknown command should not throw or reply
  const randomReply = await simulateDispatch("hello world");
  if (randomReply === null) {
    console.log("PASS: Unrecognized text ignored correctly.");
  } else {
    console.error(`FAIL: Unrecognized command returned response: '${randomReply}'`);
    failed = true;
  }

  // Test Case C: Weather ZIP query on weather channel (index 1)
  const weatherReply = await simulateDispatch("wx 90210", null, 1);
  if (weatherReply !== null) {
    console.log(`PASS: Weather ZIP query processed on #weather. Response chunk 1: "${weatherReply}"`);
  } else {
    console.error("FAIL: Weather ZIP query did not return any forecast on #weather.");
    failed = true;
  }

  // Test Case D: Weather ZIP query on test channel (index 2) - should be ignored by weather module
  const weatherIgnoredReply = await simulateDispatch("wx 90210", null, 2);
  if (weatherIgnoredReply === null) {
    console.log("PASS: Weather query on #test channel was successfully ignored.");
  } else {
    console.error(`FAIL: Weather query leaked onto #test channel with reply: "${weatherIgnoredReply}"`);
    failed = true;
  }

  // Test Case E: Testing Module response on test channel (index 2)
  const testReply = await simulateDispatch("this is a test message", null, 2);
  if (testReply === "Test OK") {
    console.log("PASS: Test command successfully processed and replied on #test.");
  } else {
    console.error(`FAIL: Expected 'Test OK' on #test, got '${testReply}'`);
    failed = true;
  }

  // Test Case F: Testing Module response on testing channel (index 3)
  const testingReply = await simulateDispatch("TESTING 123", null, 3);
  if (testingReply === "Test OK") {
    console.log("PASS: Test command successfully processed and replied on #testing.");
  } else {
    console.error(`FAIL: Expected 'Test OK' on #testing, got '${testingReply}'`);
    failed = true;
  }

  // Test Case G: Testing Module response on weather channel (index 1) - should be ignored
  const testingIgnoredReply = await simulateDispatch("test", null, 1);
  if (testingIgnoredReply === null) {
    console.log("PASS: Test command on #weather channel was successfully ignored.");
  } else {
    console.error(`FAIL: Test command leaked onto #weather channel with reply: "${testingIgnoredReply}"`);
    failed = true;
  }

  console.log("--------------------------------------------------");
  if (failed) {
    console.error("Framework routing tests FAILED!");
    process.exit(1);
  } else {
    console.log("All framework routing tests PASSED successfully!");
    process.exit(0);
  }
}

runTest().catch(err => {
  console.error("Execution error during verification:", err);
  process.exit(1);
});
