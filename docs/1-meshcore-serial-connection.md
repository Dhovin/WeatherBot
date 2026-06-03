# Developer Guide: MeshCore Serial Connection

This guide explains how to establish a Node.js-based serial connection to a MeshCore USB companion device (like a Heltec or T-Beam running companion firmware) to build interactive bots.

---

## 1. Prerequisites & Dependencies

To connect to a MeshCore radio node over serial in Node.js, your project requires the `@liamcottle/meshcore.js` library:

```bash
npm install @liamcottle/meshcore.js
```

In your main entry script, import the necessary modules:

```javascript
import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
```

---

## 2. Dynamic Serial Port Auto-Detection

Serial ports vary between operating systems (e.g., `COM3` on Windows, `/dev/ttyACM0` or `/dev/ttyUSB0` on Linux). Implementing auto-detection prevents crashes when ports change.

Here is a robust method to resolve ports using the optional `serialport` module:

```javascript
async function resolveSerialPort(configuredPort) {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();

    if (ports.length === 0) return configuredPort;

    // 1. If configured port exists, use it
    if (ports.some(p => p.path === configuredPort)) {
      return configuredPort;
    }

    // 2. Filter for USB UART serial devices (e.g. ESP32, Heltec, T-Beam)
    const usbPorts = ports.filter(p => p.vendorId || p.productId || p.serialNumber);

    if (usbPorts.length > 0) {
      // Prioritize known ESP32 / USB UART VIDs (Silicon Labs CP210x, WCH CH340, Espressif)
      const espPort = usbPorts.find(p => {
        const vid = (p.vendorId || '').toLowerCase();
        return vid === '303a' || vid === '239a' || vid === '10c4' || vid === '1a86';
      });

      const selectedPort = espPort ? espPort.path : usbPorts[0].path;
      console.log(`Auto-detected MeshCore USB device on port: "${selectedPort}"`);
      return selectedPort;
    }
  } catch (err) {
    console.warn("Serial port auto-detection failed, falling back to configuration:", err.message);
  }
  return configuredPort;
}
```

---

## 3. Establishing Connection

Create the serial connection class and register standard event listeners:

```javascript
const connection = new NodeJSSerialConnection(port);

// 1. Connection Event
connection.on('connected', async () => {
  console.log(`Connected to MeshCore node on ${port}`);
  
  // You can resolve channel structures here
  const myChannel = await connection.findChannelByName("#weather");
  if (!myChannel) {
    console.warn("Monitored channel #weather was not found on this node.");
  }
});

// 2. Event when new messages are waiting
connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const waitingMessages = await connection.getWaitingMessages();
    for (const msg of waitingMessages) {
      // Differentiate between Direct Messages (DMs) and Channels
      if (msg.channelIdx === 0xFF) {
        await handleDirectMessage(msg);
      } else {
        await handleChannelMessage(msg);
      }
    }
  } catch (e) {
    console.error('Error handling waiting messages:', e);
  }
});

// Start the connection
await connection.connect();
```

---

## 4. Message Routing & Verification

### Handling Direct Messages (DMs)
DMs must resolve the sender's details to authorize commands (e.g., subscriptions) or send direct replies:

```javascript
async function handleDirectMessage(message) {
  if (!message.text) return;

  // Resolve contact detail using public key prefix
  const contact = await connection.findContactByPublicKeyPrefix(message.pubKeyPrefix);
  if (!contact) {
    console.warn("Direct message received from unknown contact.");
    return;
  }

  console.log(`DM from ${contact.name || 'Unknown'}: ${message.text}`);

  // Process message and send a DM reply
  const replyText = "Hello from the bot!";
  await connection.sendTextMessage(contact.publicKey, replyText, Constants.TxtTypes.Plain);
}
```

### Handling Channel Messages
Channel messages must check the channel index to ensure the bot only processes and replies to messages inside its monitored channel:

```javascript
async function handleChannelMessage(message) {
  if (!message.text) return;

  const targetChannelName = "#weather";
  const myChannel = await connection.findChannelByName(targetChannelName);
  
  if (!myChannel || message.channelIdx !== myChannel.channelIdx) {
    // Ignore messages on other channels
    return;
  }

  console.log(`Channel #${targetChannelName} message: ${message.text}`);

  // Broadcast reply back to the channel
  const replyText = "Forecast command received!";
  await connection.sendChannelTextMessage(message.channelIdx, replyText);
}
```
