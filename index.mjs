import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { readFileSync } from 'fs';
import * as utils from './utils.mjs';

const VERSION = "1.1.0";

// Load config (supports optional custom config file as command-line argument ending with .json)
let configPath = new URL('./config.json', import.meta.url);
for (const arg of process.argv.slice(2)) {
  if (arg.endsWith('.json')) {
    configPath = new URL(arg, `file://${process.cwd()}/`);
    console.log(`Using custom configuration file: ${arg}`);
    break;
  }
}
const config = JSON.parse(readFileSync(configPath));
const botName = config.name || "MeshBot";

// Auto-detect serial port if the configured one is not available
async function resolveSerialPort(configuredPort) {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();

    if (ports.length === 0) return configuredPort;
    if (ports.some(p => p.path === configuredPort)) return configuredPort;

    console.warn(`Configured port "${configuredPort}" not found. Auto-detecting...`);
    const usbPorts = ports.filter(p => p.vendorId || p.productId || p.serialNumber);

    if (usbPorts.length > 0) {
      const espPort = usbPorts.find(p => {
        const vid = (p.vendorId || '').toLowerCase();
        return vid === '303a' || vid === '239a' || vid === '10c4' || vid === '1a86';
      });
      const selectedPort = espPort ? espPort.path : usbPorts[0].path;
      console.log(`Auto-detected MeshCore USB device on port: "${selectedPort}"`);
      return selectedPort;
    }
  } catch (err) {
    console.warn("Serial port auto-detection failed:", err.message);
  }
  return configuredPort;
}

const nonConfigArgs = process.argv.slice(2).filter(arg => !arg.endsWith('.json'));
const configuredPort = nonConfigArgs[0] ?? config.port;
const port = await resolveSerialPort(configuredPort);

console.log(`${botName} v${VERSION} starting...`);
console.log(`Connecting to ${port}`);
const connection = new NodeJSSerialConnection(port);

const channels = {};
const activeModules = [];

let sendQueue = Promise.resolve();

async function queueSend(sendFn, description = "Message") {
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

      // Set up confirmation listener
      confirmedListener = (data) => {
        console.log(`[Host] Send confirmed for ${description} (ackCode: ${data.ackCode}, roundTrip: ${data.roundTrip}ms)`);
        confirmed = true;
        cleanup();
        resolve(true);
      };
      connection.on(Constants.PushCodes.SendConfirmed, confirmedListener);

      // Set up timeout (15 seconds)
      timeoutTimer = setTimeout(() => {
        console.warn(`[Host] Send timeout (15s) for ${description} (Attempt ${attempt}/${maxRetries})`);
        cleanup();
        resolve(false);
      }, 15000);

      try {
        await sendFn();
      } catch (err) {
        console.error(`[Host] Serial send error for ${description}:`, err.message);
        cleanup();
        resolve(false);
      }
    });
  };

  const resultPromise = sendQueue.then(async () => {
    while (attempt < maxRetries && !confirmed) {
      if (attempt > 0) {
        console.log(`[Host] Retrying transmission for ${description} in 3 seconds...`);
        await utils.sleep(3000);
      }
      await runAttempt();
    }

    if (!confirmed) {
      console.warn(`[Host] Warning: ${description} was sent but not confirmed by any repeater after ${maxRetries} attempts.`);
    }
  });

  sendQueue = resultPromise.catch((err) => {
    console.error(`[Host] Queue send exception for ${description}:`, err.message);
  });

  return resultPromise;
}

const host = {
  VERSION,
  config,
  connection,
  channels,
  utils,
  
  async sendDM(publicKey, text) {
    const shortPub = Buffer.from(publicKey).toString('hex').slice(0, 8);
    await queueSend(
      () => connection.sendTextMessage(publicKey, text, Constants.TxtTypes.Plain),
      `DM to ${shortPub}`
    );
  },
  
  async sendChannelMessage(channelIdx, text) {
    await queueSend(
      () => connection.sendChannelTextMessage(channelIdx, text),
      `Channel msg on ch index ${channelIdx}`
    );
  },
  
  async findChannelByName(name) {
    return await connection.findChannelByName(name);
  }
};

async function dispatchMessage(text, replyCallback, contact = null, info = {}) {
  if (!text || typeof text !== 'string') return;
  // Limit input length to prevent excessive memory usage or ReDoS
  const safeText = text.length > 1000 ? text.slice(0, 1000) : text;
  let cleanText = safeText.trim();
  
  // Strip MeshCore username prefix (e.g. "Dhovin: 76244" -> "76244")
  cleanText = cleanText.replace(/^[A-Za-z0-9_.-]+:\s+/, '').trim();
  const lowerText = cleanText.toLowerCase();

  // Core Host Commands
  if (lowerText === 'version' || lowerText === 'info') {
    await replyCallback(`${botName} v${VERSION}`);
    return;
  }

  // Route to active modules
  for (const mod of activeModules) {
    try {
      if (typeof mod.handleMessage === 'function') {
        await mod.handleMessage(cleanText, replyCallback, contact, info);
      }
    } catch (err) {
      console.error(`Error in module [${mod.name}] handling message:`, err);
    }
  }
}

connection.on('connected', async () => {
  console.log(`Connected to ${port}`);

  // Resolve channels configured at the root level (forgivingly)
  if (config.channels) {
    for (const [channelType, channelName] of Object.entries(config.channels)) {
      const resolvedChannel = await connection.findChannelByName(channelName);
      if (resolvedChannel) {
        channels[channelType] = resolvedChannel;
        console.log(`Resolved channel "${channelType}" as "${channelName}" (index: ${resolvedChannel.channelIdx})`);
      } else {
        console.warn(`Warning: Configured channel "${channelType}" ("${channelName}") not found on device.`);
      }
    }
  }

  // Load modules dynamically
  await loadModules();
});

connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const waitingMessages = await connection.getWaitingMessages();
    for (const wrapper of waitingMessages) {
      if (wrapper.contactMessage) {
        const msg = wrapper.contactMessage;
        console.log(`[Host] Received DM: "${msg.text}"`);
        
        const contact = await connection.findContactByPublicKeyPrefix(msg.pubKeyPrefix);
        if (!contact) {
          console.log("Did not find contact for received message");
          continue;
        }
        await dispatchMessage(msg.text, async (replyText) => {
          await host.sendDM(contact.publicKey, replyText);
          console.log(`Sent contact reply: ${replyText}`);
        }, contact, { channelIdx: 0xFF });
      } else if (wrapper.channelMessage) {
        const msg = wrapper.channelMessage;
        console.log(`[Host] Received channel message: "${msg.text}" (channelIdx: ${msg.channelIdx})`);
        
        await dispatchMessage(msg.text, async (replyText) => {
          try {
            await host.sendChannelMessage(msg.channelIdx, replyText);
            console.log(`Sent channel reply to index ${msg.channelIdx}: ${replyText}`);
          } catch (err) {
            console.error(`Failed to send channel reply to index ${msg.channelIdx}:`, err);
          }
        }, null, { channelIdx: msg.channelIdx });
      }
    }
  } catch (e) {
    console.error('Error handling waiting messages:', e);
  }
});

async function loadModules() {
  if (!config.enabledModules || !Array.isArray(config.enabledModules)) {
    console.log("No modules configured in enabledModules.");
    return;
  }

  for (const modName of config.enabledModules) {
    if (typeof modName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(modName)) {
      console.error(`Invalid module name skipped to prevent path traversal: ${modName}`);
      continue;
    }
    try {
      console.log(`Loading module: ${modName}...`);
      const modPath = `./modules/${modName}.mjs`;
      const moduleClass = (await import(modPath)).default;
      const modInstance = new moduleClass();
      
      const modConfig = config.modules?.[modName] || {};
      
      if (typeof modInstance.init === 'function') {
        await modInstance.init(host, modConfig);
      }
      
      modInstance.name = modName;
      activeModules.push(modInstance);
      console.log(`Module [${modName}] loaded successfully.`);
    } catch (err) {
      console.error(`Failed to load module [${modName}]:`, err);
    }
  }
}

// Connect to the MeshCore serial connection if run directly
if (process.argv[1] && (process.argv[1].endsWith('index.mjs') || process.argv[1].endsWith('index.js'))) {
  await connection.connect();
}
