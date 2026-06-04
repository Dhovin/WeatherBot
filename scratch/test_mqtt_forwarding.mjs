import * as net from 'net';
import EventEmitter from 'events';
import MqttModule from '../modules/mqtt.mjs';

console.log("--------------------------------------------------");
console.log("      Starting MQTT Forwarder Module Tests        ");
console.log("--------------------------------------------------");

// 1. Create a minimal mock MQTT broker
const mockBrokerPort = 18883;
let publishedData = [];

const mockServer = net.createServer((socket) => {
  socket.on('data', (data) => {
    // Parse MQTT control packet type
    const packetType = data[0] >> 4;
    
    if (packetType === 1) { // CONNECT
      // Send CONNACK: 0x20 (CONNACK packet type), 0x02 (remaining length), 0x00 (session present), 0x00 (success)
      socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
    } else if (packetType === 3) { // PUBLISH
      // Parse publish payload to track what was sent
      const dataStr = data.toString('utf8');
      publishedData.push(dataStr);
    }
  });
});

mockServer.listen(mockBrokerPort, '127.0.0.1', async () => {
  console.log(`Mock MQTT Broker listening on port ${mockBrokerPort}`);
  
  let failed = false;

  try {
    // 2. Set up mock host context
    const mockConnection = new EventEmitter();
    mockConnection.getSelfInfo = async () => {
      return {
        publicKey: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
        name: "Test Companion Node"
      };
    };

    const mockHost = {
      connection: mockConnection,
      VERSION: "1.1.0"
    };

    // 3. Configure and initialize MqttModule
    const config = {
      iataCode: "LAX",
      enabledPresets: [],
      customBrokers: [
        {
          name: "Test Local Mock",
          url: `127.0.0.1:${mockBrokerPort}`, // Test protocol auto-detection (lacks prefix)
          enabled: true
        }
      ]
    };

    const mqttMod = new MqttModule();
    await mqttMod.init(mockHost, config);

    // Wait a brief moment for the connection to establish and send the status payload
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Assert status message was published
    const statusPayload = publishedData.find(d => d.includes('"status":"online"'));
    if (statusPayload && statusPayload.toLowerCase().includes("lax") && statusPayload.toLowerCase().includes("aabbccdd") && statusPayload.includes('"name":"Test Companion Node"')) {
      console.log("  PASS: Connection status and human-readable name published correctly.");
    } else {
      console.error(`  FAIL: Connection status or name not found or incorrect. Published data:`, publishedData);
      failed = true;
    }

    // 4. Simulate a received frame (rx) from connection
    console.log("Simulating RX frame event...");
    const mockRxFrame = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    mockConnection.emit('rx', mockRxFrame);

    // Wait for publication
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Assert raw frame was forwarded
    const rxPayload = publishedData.find(d => d.includes('"direction":"rx"') && d.includes('"raw":"11223344"'));
    if (rxPayload) {
      console.log("  PASS: RX raw packet forwarded successfully.");
    } else {
      console.error(`  FAIL: RX raw packet forwarding check failed. Received:`, publishedData);
      failed = true;
    }

    // 5. Clean up module shutdown hooks
    if (typeof mqttMod.shutdownHandler === 'function') {
      mqttMod.shutdownHandler();
    }

  } catch (err) {
    console.error("  FAIL: MQTT Forwarder test encountered error:", err.message);
    failed = true;
  } finally {
    // 6. Close the mock server
    mockServer.close(() => {
      console.log("Mock MQTT Broker shut down.");
      console.log("--------------------------------------------------");
      if (failed) {
        console.error("MQTT Forwarder tests FAILED!");
        process.exit(1);
      } else {
        console.log("All MQTT Forwarder tests PASSED successfully!");
        process.exit(0);
      }
    });
  }
});
