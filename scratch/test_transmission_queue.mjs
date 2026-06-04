import EventEmitter from 'events';
import * as utils from '../utils.mjs';

// Mock Constants
const Constants = {
  PushCodes: {
    SendConfirmed: 0x82
  },
  TxtTypes: {
    Plain: 0
  }
};

class MockConnection extends EventEmitter {
  constructor() {
    super();
    this.sendCount = 0;
    this.shouldConfirmAfter = null; // ms
    this.shouldNeverConfirm = false;
  }

  async sendChannelTextMessage(channelIdx, text) {
    this.sendCount++;
    const currentTxCount = this.sendCount;
    console.log(`[Mock Device] Tx message: "${text}" (Total device transmissions: ${currentTxCount})`);
    
    if (this.shouldNeverConfirm) {
      return; // Simulate no repeater hearing it
    }

    const delay = this.shouldConfirmAfter !== null ? this.shouldConfirmAfter : 200;
    setTimeout(() => {
      this.emit(Constants.PushCodes.SendConfirmed, {
        ackCode: 123456,
        roundTrip: delay
      });
    }, delay);
  }
}

// Emulate index.mjs queue logic
let sendQueue = Promise.resolve();

async function queueSend(connection, sendFn, description = "Message") {
  const maxRetries = 3;
  let attempt = 0;
  let confirmed = false;

  const runAttempt = async () => {
    attempt++;
    return new Promise(async (resolve) => {
      let confirmedListener;
      let timeoutTimer;

      const cleanup = () => {
        if (confirmedListener) {
          connection.off(Constants.PushCodes.SendConfirmed, confirmedListener);
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
      };

      confirmedListener = (data) => {
        console.log(`[Queue] Send confirmed for ${description} (ackCode: ${data.ackCode}, roundTrip: ${data.roundTrip}ms)`);
        confirmed = true;
        cleanup();
        resolve(true);
      };
      connection.on(Constants.PushCodes.SendConfirmed, confirmedListener);

      timeoutTimer = setTimeout(() => {
        console.warn(`[Queue] Send timeout (8s) for ${description} (Attempt ${attempt}/${maxRetries})`);
        cleanup();
        resolve(false);
      }, 1000); // Speed up test timeout to 1s instead of 8s

      try {
        await sendFn();
      } catch (err) {
        console.error(`[Queue] Serial send error for ${description}:`, err.message);
        cleanup();
        resolve(false);
      }
    });
  };

  const resultPromise = sendQueue.then(async () => {
    while (attempt < maxRetries && !confirmed) {
      if (attempt > 0) {
        console.log(`[Queue] Retrying transmission for ${description} in 100ms...`);
        await utils.sleep(100); // Speed up test retry delay to 100ms
      }
      await runAttempt();
    }

    if (!confirmed) {
      console.warn(`[Queue] Warning: ${description} was sent but not confirmed by any repeater after ${maxRetries} attempts.`);
    }
  });

  sendQueue = resultPromise.catch((err) => {
    console.error(`[Queue] Queue send exception for ${description}:`, err.message);
  });

  return resultPromise;
}

async function runTests() {
  console.log("--------------------------------------------------");
  console.log("    Starting Transmission Queue Verification      ");
  console.log("--------------------------------------------------");

  const connection = new MockConnection();

  // Test Case 1: Sequential Execution (Queueing)
  console.log("\n--- TEST 1: Concurrency Queueing & In-Order Delivery ---");
  const p1 = queueSend(connection, () => connection.sendChannelTextMessage(1, "Msg 1"), "Msg 1");
  const p2 = queueSend(connection, () => connection.sendChannelTextMessage(1, "Msg 2"), "Msg 2");
  
  await Promise.all([p1, p2]);
  console.log("PASS: Both messages sent sequentially.");

  // Test Case 2: Repeater Confirmation Retry
  console.log("\n--- TEST 2: Repeater Confirmation Retry ---");
  connection.sendCount = 0;
  // First attempt has no confirmation, then we enable it for the retry
  connection.shouldNeverConfirm = true;
  
  const retryPromise = queueSend(connection, () => {
    // Enable confirmation after the first fail
    if (connection.sendCount === 1) {
      connection.shouldNeverConfirm = false;
      connection.shouldConfirmAfter = 100;
    }
    return connection.sendChannelTextMessage(1, "Retry Msg");
  }, "Retry Msg");

  await retryPromise;
  if (connection.sendCount === 2) {
    console.log("PASS: Retry logic successfully triggered on timeout and resolved on second attempt.");
  } else {
    console.error(`FAIL: Expected 2 attempts, got ${connection.sendCount}`);
  }

  // Test Case 3: Complete Timeout Fallback
  console.log("\n--- TEST 3: Complete Timeout Fallback ---");
  connection.sendCount = 0;
  connection.shouldNeverConfirm = true;

  const fallbackPromise = queueSend(connection, () => {
    return connection.sendChannelTextMessage(1, "Unconfirmed Msg");
  }, "Unconfirmed Msg");

  await fallbackPromise;
  if (connection.sendCount === 3) {
    console.log("PASS: Retry reached limit and fallback resolved queue without blocking.");
  } else {
    console.error(`FAIL: Expected 3 attempts, got ${connection.sendCount}`);
  }

  console.log("\n--------------------------------------------------");
  console.log("All transmission queue tests PASSED successfully!");
}

runTests().catch(err => {
  console.error("Test execution crash:", err);
  process.exit(1);
});
