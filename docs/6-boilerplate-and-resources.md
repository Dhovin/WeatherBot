# Developer Guide: Boilerplate Template & Resources

This guide provides a complete, ready-to-copy boilerplate template for creating a new MeshCore bot, along with external references and advanced development tips.

---

## 1. Minimal Bot Boilerplate Template

You can use the following three files to start any new MeshCore bot project.

### File 1: `package.json`
```json
{
  "name": "meshcore-custom-bot",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs",
  "dependencies": {
    "@liamcottle/meshcore.js": "^1.10.0"
  },
  "devDependencies": {
    "serialport": "^13.0.0"
  }
}
```

### File 2: `config.json`
```json
{
  "port": "/dev/ttyACM0",
  "monitoredChannel": "#general"
}
```

### File 3: `index.mjs`
```javascript
import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { readFileSync } from 'fs';

// 1. Load config
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));

// 2. Initialize Serial Port auto-detect helper
async function detectSerialPort(defaultPort) {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();
    const usb = ports.filter(p => p.vendorId || p.productId || p.serialNumber);
    if (usb.length > 0) return usb[0].path;
  } catch (err) {
    console.warn("Serial auto-detect skipped:", err.message);
  }
  return defaultPort;
}

const port = await detectSerialPort(config.port);
console.log(`Initializing connection to MeshCore node on ${port}...`);

const connection = new NodeJSSerialConnection(port);
let channelIdx = null;

// 3. Register Event Handlers
connection.on('connected', async () => {
  console.log(`Connected successfully to node!`);
  
  // Resolve channel index dynamically
  const channel = await connection.findChannelByName(config.monitoredChannel);
  if (channel) {
    channelIdx = channel.channelIdx;
    console.log(`Monitoring channel: ${config.monitoredChannel} (Index: ${channelIdx})`);
  } else {
    console.warn(`Channel ${config.monitoredChannel} not found. Channel commands will be ignored.`);
  }
});

// Incoming message listener
connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const messages = await connection.getWaitingMessages();
    for (const msg of messages) {
      if (!msg.text) continue;
      
      const cleanText = msg.text.replace(/^[A-Za-z0-9_.-]+:\s+/, '').trim().toLowerCase();
      
      // A. Handle Direct Message (DM)
      if (msg.channelIdx === 0xFF) {
        const contact = await connection.findContactByPublicKeyPrefix(msg.pubKeyPrefix);
        if (contact) {
          console.log(`DM from ${contact.name}: ${cleanText}`);
          if (cleanText === 'ping') {
            await connection.sendTextMessage(contact.publicKey, "Pong!", Constants.TxtTypes.Plain);
          }
        }
      } 
      // B. Handle Monitored Channel message
      else if (channelIdx !== null && msg.channelIdx === channelIdx) {
        console.log(`Channel message: ${cleanText}`);
        if (cleanText === '!ping') {
          await connection.sendChannelTextMessage(msg.channelIdx, "Pong!");
        }
      }
    }
  } catch (err) {
    console.error("Error reading waiting messages:", err.message);
  }
});

// Start the connection
await connection.connect();
```

---

## 2. Advanced Tips & Common Pitfalls

### Connection Retries & Reconnects
USB connections to microcontrollers can drop due to power cycles, loose cables, or firmware reboots. By default, `NodeJSSerialConnection` might crash or halt if the port disconnects. Wrap the connection in a supervisory retry loop:

```javascript
async function startBot() {
  const connection = new NodeJSSerialConnection(port);
  
  connection.on('close', () => {
    console.warn("Serial connection closed. Reconnecting in 10 seconds...");
    setTimeout(startBot, 10000);
  });

  connection.on('error', (err) => {
    console.error("Serial error occurred:", err.message);
  });

  try {
    await connection.connect();
  } catch (err) {
    console.error("Failed to connect:", err.message);
    setTimeout(startBot, 10000);
  }
}
```

### LoRa Transmission Duty Cycle
In many regions, transmitting on public ISM sub-GHz bands (915MHz, 868MHz) is legally restricted to a **1% duty cycle** (the radio can only transmit for 36 seconds per hour).
* **Do not poll frequently**: Avoid creating commands that trigger large responses repeatedly.
* **Keep replies short**: Condense information into abbreviations and symbols.
* **Pace messages**: Build a queue mechanism if your bot needs to send multi-part updates.

---

## 3. External API and Library References

*   **`@liamcottle/meshcore.js` Library**:
    *   NPM registry: [npm/@liamcottle/meshcore.js](https://www.npmjs.com/package/@liamcottle/meshcore.js)
    *   Official MeshCore site: [meshcore.io](https://meshcore.io/)
*   **National Weather Service (NWS) API**:
    *   API Documentation & Endpoints: [weather.gov web service documentation](https://www.weather.gov/documentation/services-web-api)
    *   API Policy Guide: [NWS API FAQ & Guidelines](https://api.weather.gov/)
*   **Node SerialPort**:
    *   Documentation & CLI utilities: [node-serialport github](https://github.com/serialport/node-serialport)
*   **OpenStreetMap (OSM) Nominatim Geocoding**:
    *   Usage & Attribution policy: [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)
*   **Zippopotam.us (Postal Code Lookup)**:
    *   API details (no-limits ZIP code locator): [zippopotam.us](https://www.zippopotam.us/)
