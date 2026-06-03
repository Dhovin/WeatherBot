import * as mqtt from 'mqtt';
import readline from 'readline';

const PRESETS = {
  "analyzer-us": { name: "LetsMesh USA Analyzer", url: "wss://mqtt-us-v1.letsmesh.net:443/mqtt" },
  "analyzer-eu": { name: "LetsMesh EU Analyzer", url: "wss://mqtt-eu-v1.letsmesh.net:443/mqtt" },
  "nz-analyzer": { name: "Baird NZ Analyzer", url: "wss://meshcore-mqtt-1.baird.io:443" },
  "meshmapper": { name: "MeshMapper Server", url: "wss://mqtt.meshmapper.cc:443/mqtt" },
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
  static async configure(askQuestion, currentConfig) {
    const config = { ...currentConfig };

    const defaultIata = config.iataCode || "ORD";
    const iata = await askQuestion(`Enter local airport IATA code [${defaultIata}]: `);
    config.iataCode = (iata || defaultIata).toUpperCase();

    // Prompts for presets
    const presetNames = Object.keys(PRESETS).join(', ');
    console.log(`\nAvailable presets: ${presetNames}`);
    
    const defaultEnabledPresets = (config.enabledPresets || ["ntxmesh"]).join(', ');
    const presetsInput = await askQuestion(`Enter preset brokers to enable (comma-separated) [${defaultEnabledPresets}]: `);
    
    const selectedPresets = presetsInput
      ? presetsInput.split(',').map(s => s.trim().toLowerCase()).filter(s => PRESETS[s])
      : (config.enabledPresets || ["ntxmesh"]);
    
    config.enabledPresets = selectedPresets;

    // Optional custom broker
    const customPrompt = config.customBrokers && config.customBrokers.length > 0 ? "y" : "n";
    const addCustom = await askQuestion(`Configure custom/private MQTT broker? (y/n) [${customPrompt}]: `);
    if (addCustom.toLowerCase().startsWith('y')) {
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

    console.log("[MQTT Forwarder] Module initializing...");

    // Resolve public key
    try {
      const selfInfo = await this.host.connection.getSelfInfo(8000);
      if (selfInfo && selfInfo.publicKey) {
        this.publicKeyHex = Buffer.from(selfInfo.publicKey).toString('hex');
        console.log(`[MQTT Forwarder] Resolved node public key: ${this.publicKeyHex}`);
      }
    } catch (err) {
      console.warn("[MQTT Forwarder] Could not retrieve node public key automatically:", err.message);
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
        };

        // If JWT token is present, configure auth
        if (target.token) {
          options.username = `v1_${this.publicKeyHex.toUpperCase()}`;
          options.password = target.token;
        }

        console.log(`[MQTT Forwarder] Connecting to ${target.name} (${finalUrl})...`);
        const client = mqtt.connect(finalUrl, options);

        client.on('connect', () => {
          console.log(`[MQTT Forwarder] Connected to ${target.name}`);
          const statusTopic = `meshcore/${iata}/${this.publicKeyHex}/status`;
          client.publish(statusTopic, JSON.stringify({ status: "online", timestamp: new Date().toISOString() }), { retain: true });
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

    // Register shutdown hooks
    this.shutdownHandler = () => {
      console.log("\n[MQTT Forwarder] Gracefully disconnecting from brokers...");
      const statusTopic = `meshcore/${iata}/${this.publicKeyHex}/status`;
      
      for (const { client, target } of this.clients) {
        if (client.connected) {
          client.publish(statusTopic, JSON.stringify({ status: "offline", timestamp: new Date().toISOString() }), { retain: true }, () => {
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
    if (!frame || frame.length === 0) return;
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
