import * as mqtt from 'mqtt';
import readline from 'readline';
import { Constants } from '@liamcottle/meshcore.js';
import { createAuthToken } from './auth_token.mjs';

const PRESETS = {
  "analyzer-us": { name: "LetsMesh USA Analyzer", url: "wss://mqtt-us-v1.letsmesh.net:443/mqtt", audience: "mqtt-us-v1.letsmesh.net", requiresAuth: true },
  "analyzer-eu": { name: "LetsMesh EU Analyzer", url: "wss://mqtt-eu-v1.letsmesh.net:443/mqtt", audience: "mqtt-eu-v1.letsmesh.net", requiresAuth: true },
  "nz-analyzer": { name: "Baird NZ Analyzer", url: "wss://meshcore-mqtt-1.baird.io:443" },
  "meshmapper": { name: "MeshMapper Server", url: "wss://mqtt.meshmapper.net:443/mqtt", audience: "mqtt.meshmapper.net", requiresAuth: true },
  "meshrank": { name: "MeshRank", url: "mqtts://meshrank.net:8883" },
  "waev": { name: "Waev", url: "wss://mqtt.waev.app:443/mqtt" },
  "meshomatic": { name: "Meshomatic US East", url: "wss://us-east.meshomatic.net:443/mqtt" },
  "cascadiamesh": { name: "Cascadia Mesh (Pacific NW)", url: "wss://mqtt-v1.cascadiamesh.org:443/mqtt" },
  "tennmesh": { name: "TennMesh (Tennessee)", url: "mqtt://mqtt.tennmesh.com:1883" },
  "nashmesh": { name: "NashMesh (Nashville)", url: "mqtt://mqtt.nashme.sh:1883" },
  "chimesh": { name: "ChiMesh (Chicago)", url: "wss://mqtt.chimesh.org:443" },
  "meshat.se": { name: "MeshAt (Sweden)", url: "mqtts://mqtt.meshat.se:8883" },
  "eastidahomesh": { name: "East Idaho Mesh", url: "wss://broker.eastidahomesh.net:443" },
  "coloradomesh": { name: "Colorado Mesh", url: "wss://mqtt.meshcore.coloradomesh.org:1883" },
  "dutchmeshcore-1": { name: "Dutch MeshCore Collector 1", url: "wss://collector1.dutchmeshcore.nl:443/mqtt" },
  "dutchmeshcore-2": { name: "Dutch MeshCore Collector 2", url: "wss://collector2.dutchmeshcore.nl:443/mqtt" },
  "meshcore-ca-1": { name: "Canada MeshCore 1", url: "wss://mqtt1.meshcore.ca:443/mqtt" },
  "meshcore-ca-2": { name: "Canada MeshCore 2", url: "wss://mqtt2.meshcore.ca:443/mqtt" },
  "inwmesh": { name: "Indiana/Illinois INWMesh", url: "mqtts://scope.inwmesh.org:8883" },
  "ntxmesh": { name: "NTXMesh", url: "mqtt://ntxmesh.dhovin.me:1883", audience: "meshcore/#" }
};

function hasProtocol(url) {
  return /^[a-z]+:\/\//i.test(url);
}

function parseHostPort(brokerUrl) {
  let host = brokerUrl;
  let port = null;
  
  const slashIdx = host.indexOf('/');
  if (slashIdx !== -1) {
    host = host.slice(0, slashIdx);
  }
  
  const colonIdx = host.lastIndexOf(':');
  if (colonIdx !== -1) {
    const pStr = host.slice(colonIdx + 1);
    if (/^\d+$/.test(pStr)) {
      port = parseInt(pStr, 10);
      host = host.slice(0, colonIdx);
    }
  }
  
  return { host, port };
}

async function probeBroker(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let client;
    const timer = setTimeout(() => {
      if (client) client.end(true);
      resolve(false);
    }, timeoutMs);

    try {
      client = mqtt.connect(url, {
        connectTimeout: timeoutMs,
        reconnectPeriod: 0,
      });

      client.on('connect', () => {
        clearTimeout(timer);
        client.end(true);
        resolve(true);
      });

      client.on('error', () => {
        clearTimeout(timer);
        if (client) client.end(true);
        resolve(false);
      });
    } catch (err) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function autoDetectUrl(brokerUrl) {
  if (hasProtocol(brokerUrl)) {
    return brokerUrl;
  }
  
  const { host, port } = parseHostPort(brokerUrl);
  console.log(`[MQTT Prober] Probing protocols for ${host}:${port || 'default'} in order: wss, ws, mqtts, mqtt...`);
  
  const probes = [];
  if (port) {
    probes.push({ protocol: 'wss', url: `wss://${host}:${port}/mqtt` });
    probes.push({ protocol: 'ws', url: `ws://${host}:${port}/mqtt` });
    probes.push({ protocol: 'mqtts', url: `mqtts://${host}:${port}` });
    probes.push({ protocol: 'mqtt', url: `mqtt://${host}:${port}` });
  } else {
    probes.push({ protocol: 'wss', url: `wss://${host}:443/mqtt` });
    probes.push({ protocol: 'ws', url: `ws://${host}:80/mqtt` });
    probes.push({ protocol: 'mqtts', url: `mqtts://${host}:8883` });
    probes.push({ protocol: 'mqtt', url: `mqtt://${host}:1883` });
  }
  
  for (const p of probes) {
    const success = await probeBroker(p.url);
    if (success) {
      console.log(`[MQTT Prober] Auto-detected protocol: ${p.protocol} -> ${p.url}`);
      return p.url;
    }
  }
  
  console.warn(`[MQTT Prober] Detection failed. Defaulting to: mqtt://${host}:${port || 1883}`);
  return `mqtt://${host}:${port || 1883}`;
}

export default class MqttModule {
  static async configure(askQuestion, currentConfig, selectMultipleOptions) {
    const config = { ...currentConfig };

    const defaultIata = config.iataCode || "ORD";
    const iata = await askQuestion(`Enter local airport IATA code [${defaultIata}]: `);
    config.iataCode = (iata || defaultIata).toUpperCase();

    const defaultPrivateKey = config.privateKey || "";
    const pKey = await askQuestion(`Enter optional 64-byte private key hex (leave blank to query device) [${defaultPrivateKey}]: `);
    config.privateKey = pKey || defaultPrivateKey;

    // Prompts for presets
    let selectedPresets;
    if (typeof selectMultipleOptions === 'function') {
      const allPresets = Object.keys(PRESETS);
      const defaultEnabledPresets = config.enabledPresets || ["ntxmesh", "meshmapper", "analyzer-us"];
      selectedPresets = await selectMultipleOptions(
        "Select Preset MQTT Brokers to Enable",
        allPresets,
        defaultEnabledPresets
      );
    } else {
      const presetNames = Object.keys(PRESETS).join(', ');
      console.log(`\nAvailable presets: ${presetNames}`);
      
      const defaultEnabledPresets = (config.enabledPresets || ["ntxmesh", "meshmapper", "analyzer-us"]).join(', ');
      const presetsInput = await askQuestion(`Enter preset brokers to enable (comma-separated) [${defaultEnabledPresets}]: `);
      
      selectedPresets = presetsInput
        ? presetsInput.split(',').map(s => s.trim().toLowerCase()).filter(s => PRESETS[s])
        : (config.enabledPresets || ["ntxmesh", "meshmapper", "analyzer-us"]);
    }
    
    config.enabledPresets = selectedPresets;

    // Optional custom broker
    const hasEnabledCustom = config.customBrokers && config.customBrokers.length > 0 && config.customBrokers.some(cb => cb.enabled);
    const customPrompt = hasEnabledCustom ? "y" : "n";
    const addCustomInput = await askQuestion(`Configure custom/private MQTT broker? (y/n) [${customPrompt}]: `);
    const addCustom = addCustomInput ? addCustomInput.toLowerCase().startsWith('y') : (customPrompt === 'y');
    if (addCustom) {
      const existingCustom = config.customBrokers?.[0] || {};
      const customUrl = await askQuestion(`Enter custom broker URL or Host (e.g. mqtt://localhost:1883 or localhost:1883) [${existingCustom.url || ''}]: `);
      if (customUrl) {
        const customName = await askQuestion(`Enter custom broker friendly name [${existingCustom.name || 'Custom Broker'}]: `);
        const customAudience = await askQuestion(`Enter custom token audience (or leave blank) [${existingCustom.audience || ''}]: `);
        const customToken = await askQuestion(`Enter custom JWT auth token (or leave blank) [${existingCustom.token || ''}]: `);
        
        config.customBrokers = [
          {
            name: customName || "Custom Broker",
            url: customUrl,
            enabled: true,
            audience: customAudience || undefined,
            token: customToken || undefined
          }
        ];
      }
    } else {
      config.customBrokers = [];
    }

    return config;
  }

  async init(host, config) {
    this.host = host;
    this.config = config;
    this.clients = [];
    this.publicKeyHex = "unknown";
    this.privateKeyHex = this.config.privateKey || null;

    console.log("[MQTT Forwarder] Module initializing...");

    // Resolve public key and name
    try {
      const selfInfo = await this.host.connection.getSelfInfo(8000);
      if (selfInfo) {
        if (selfInfo.publicKey) {
          this.publicKeyHex = Buffer.from(selfInfo.publicKey).toString('hex');
          console.log(`[MQTT Forwarder] Resolved node public key: ${this.publicKeyHex}`);
        }
        if (selfInfo.name) {
          this.nodeName = selfInfo.name;
          console.log(`[MQTT Forwarder] Resolved node name: ${this.nodeName}`);
        }
      }
    } catch (err) {
      console.warn("[MQTT Forwarder] Could not retrieve node identity automatically:", err.message);
    }

    // Try to export private key from the device if not configured manually
    if (!this.privateKeyHex) {
      try {
        console.log("[MQTT Forwarder] Attempting to export private key from device...");
        const privateKeyData = await new Promise(async (resolve, reject) => {
          const timer = setTimeout(() => {
            this.host.connection.off(Constants.ResponseCodes.PrivateKey, onKey);
            this.host.connection.off(Constants.ResponseCodes.Disabled, onDisabled);
            this.host.connection.off(Constants.ResponseCodes.Err, onErr);
            reject(new Error("Timeout waiting for private key export"));
          }, 5000);

          const self = this;
          function onKey(data) {
            clearTimeout(timer);
            self.host.connection.off(Constants.ResponseCodes.PrivateKey, onKey);
            self.host.connection.off(Constants.ResponseCodes.Disabled, onDisabled);
            self.host.connection.off(Constants.ResponseCodes.Err, onErr);
            resolve(data.privateKey);
          }

          function onDisabled() {
            clearTimeout(timer);
            self.host.connection.off(Constants.ResponseCodes.PrivateKey, onKey);
            self.host.connection.off(Constants.ResponseCodes.Disabled, onDisabled);
            self.host.connection.off(Constants.ResponseCodes.Err, onErr);
            resolve(null);
          }

          function onErr(data) {
            clearTimeout(timer);
            self.host.connection.off(Constants.ResponseCodes.PrivateKey, onKey);
            self.host.connection.off(Constants.ResponseCodes.Disabled, onDisabled);
            self.host.connection.off(Constants.ResponseCodes.Err, onErr);
            resolve(null);
          }

          this.host.connection.on(Constants.ResponseCodes.PrivateKey, onKey);
          this.host.connection.on(Constants.ResponseCodes.Disabled, onDisabled);
          this.host.connection.on(Constants.ResponseCodes.Err, onErr);
          
          if (typeof this.host.connection.sendCommandExportPrivateKey === 'function') {
            await this.host.connection.sendCommandExportPrivateKey();
          } else {
            clearTimeout(timer);
            this.host.connection.off(Constants.ResponseCodes.PrivateKey, onKey);
            this.host.connection.off(Constants.ResponseCodes.Disabled, onDisabled);
            this.host.connection.off(Constants.ResponseCodes.Err, onErr);
            resolve(null);
          }
        });

        if (privateKeyData) {
          this.privateKeyHex = Buffer.from(privateKeyData).toString('hex');
          console.log("[MQTT Forwarder] ✓ Successfully exported private key from device.");
        } else {
          console.log("[MQTT Forwarder] ✗ Private key export is disabled on this device. Will use on-device signing.");
        }
      } catch (err) {
        console.warn("[MQTT Forwarder] ✗ Could not export private key from device:", err.message);
      }
    } else {
      console.log("[MQTT Forwarder] ✓ Using private key from configuration.");
    }

    const iata = (this.config.iataCode || "ORD").toUpperCase();
    const enabledPresets = this.config.enabledPresets || [];
    const customBrokers = this.config.customBrokers || [];

    // Compile targets to process
    const targets = [];

    for (const pName of enabledPresets) {
      const preset = PRESETS[pName];
      if (preset) {
        targets.push({
          name: preset.name,
          url: preset.url,
          audience: preset.audience,
          requiresAuth: preset.requiresAuth,
          token: this.config.token // can fall back to global token if set
        });
      }
    }

    for (const cb of customBrokers) {
      if (cb.enabled && cb.url) {
        targets.push({
          name: cb.name,
          url: cb.url,
          audience: cb.audience,
          requiresAuth: cb.requiresAuth,
          token: cb.token
        });
      }
    }

    // Connect to each target
    for (const target of targets) {
      try {
        // Run auto-detection probe sequence if host lacks protocol prefix
        const finalUrl = await autoDetectUrl(target.url);
        
        const options = {
          reconnectPeriod: 5000,
          connectTimeout: 30 * 1000,
          rejectUnauthorized: false,
        };

        // Handle JWT token authentication dynamically or via custom static token
        if (target.requiresAuth) {
          try {
            console.log(`[MQTT Forwarder] Generating JWT auth token for ${target.name}...`);
            const token = await createAuthToken(
              this.publicKeyHex,
              this.privateKeyHex,
              86400,
              this.host.connection,
              { aud: target.audience }
            );
            options.username = `v1_${this.publicKeyHex.toUpperCase()}`;
            options.password = token;
          } catch (err) {
            console.error(`[MQTT Forwarder] Failed to generate auth token for ${target.name}:`, err.message);
          }
        } else if (target.token) {
          options.username = `v1_${this.publicKeyHex.toUpperCase()}`;
          options.password = target.token;
        }

        console.log(`[MQTT Forwarder] Connecting to ${target.name} (${finalUrl})...`);
        const client = mqtt.connect(finalUrl, options);

        client.on('connect', () => {
          console.log(`[MQTT Forwarder] Connected to ${target.name}`);
          const statusTopic = `meshcore/${iata}/${this.publicKeyHex}/status`;
          client.publish(statusTopic, JSON.stringify({
            status: "online",
            timestamp: new Date().toISOString(),
            name: this.nodeName || "MeshBot Observer"
          }), { retain: true });
        });

        client.on('error', (err) => {
          console.error(`[MQTT Forwarder] Error on ${target.name}:`, err.message);
        });

        this.clients.push({ client, target });
      } catch (err) {
        console.error(`[MQTT Forwarder] Failed to connect to target ${target.name}:`, err.message);
      }
    }

    // Register event listeners
    this.host.connection.on('rx', (frame) => this.forwardFrame('rx', frame));
    this.host.connection.on('tx', (frame) => this.forwardFrame('tx', frame));

    // Start periodic JWT token refresh interval (every 6 hours)
    this.refreshInterval = setInterval(async () => {
      console.log("[MQTT Forwarder] Refreshing active MQTT JWT tokens...");
      for (const item of this.clients) {
        if (item.target.requiresAuth) {
          try {
            const token = await createAuthToken(
              this.publicKeyHex,
              this.privateKeyHex,
              86400,
              this.host.connection,
              { aud: item.target.audience }
            );
            item.client.options.password = token;
            console.log(`[MQTT Forwarder] Refreshed JWT token in client options for ${item.target.name}`);
          } catch (err) {
            console.error(`[MQTT Forwarder] Failed to refresh token for ${item.target.name}:`, err.message);
          }
        }
      }
    }, 6 * 60 * 60 * 1000);

    // Register shutdown hooks
    this.shutdownHandler = () => {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
      }
      console.log("\n[MQTT Forwarder] Gracefully disconnecting from brokers...");
      const statusTopic = `meshcore/${iata}/${this.publicKeyHex}/status`;
      
      for (const { client, target } of this.clients) {
        if (client.connected) {
          client.publish(statusTopic, JSON.stringify({
            status: "offline",
            timestamp: new Date().toISOString(),
            name: this.nodeName || "MeshBot Observer"
          }), { retain: true }, () => {
            client.end();
            console.log(`[MQTT Forwarder] Closed connection to ${target.name}`);
          });
        } else {
          client.end();
        }
      }
    };

    process.on('SIGINT', this.shutdownHandler);
    process.on('SIGTERM', this.shutdownHandler);

    console.log("[MQTT Forwarder] Module initialized.");
  }

  forwardFrame(direction, frame) {
    if (!frame || !(frame instanceof Uint8Array || Buffer.isBuffer(frame)) || frame.length === 0) return;
    if (frame.length > 65535) {
      console.warn(`[MQTT Forwarder] Skipped excessively large frame allocation: ${frame.length} bytes`);
      return;
    }
    const rawHex = Buffer.from(frame).toString('hex');
    const iata = (this.config.iataCode || "ORD").toUpperCase();
    const packetsTopic = `meshcore/${iata}/${this.publicKeyHex}/packets`;

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      direction: direction,
      raw: rawHex
    });

    for (const { client } of this.clients) {
      if (client.connected) {
        client.publish(packetsTopic, payload);
      }
    }
  }
}
