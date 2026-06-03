# Developer Guide: Modular Bot Architecture

To run multiple features (like weather monitoring, utilities, and admin commands) under a single serial port connection, the codebase uses a **Modular Bot Framework**. 

A single **Host Bot** controller opens the serial port and dispatches incoming LoRa DMs or channel messages to registered **Modules**.

---

## 1. How the Host Bot Works

The host bot (`index.mjs`) is responsible for:
1. Connecting to the MeshCore serial port.
2. Checking `config.json` for the `"enabledModules"` array.
3. Loading each module dynamically via `import()`.
4. Passing messages (DMs and channel messages) to all active modules.

---

## 2. Configuration Settings

To register and configure modules, update `config.json`. Place general connection parameters at the root level, and module-specific settings under the `"modules"` object:

```json
{
  "port": "/dev/ttyACM0",
  "channels": {
    "alerts": "#weather",
    "weather": "#weather"
  },
  "enabledModules": [
    "weather",
    "ping"
  ],
  "modules": {
    "weather": {
      "weatherAlarm": "06:00",
      "zipCode": "20001"
    },
    "ping": {
      "replyUppercase": false
    }
  }
}
```

---

## 3. Creating a Custom Module

All modules must be stored in the `modules/` directory as ES Modules (using `.mjs` extensions). 

A module is structured as a class exporting a `default` definition. It implements two main lifecycle hooks:
*   `init(host, config)`: Called once when the host bot initializes. Use this hook to register cron alarms, connect to external databases/APIs, or calculate values.
*   `handleMessage(cleanText, replyCallback, contact)`: Called whenever a message matching the monitored channel index or a DM is received.

### Code Example: `modules/ping.mjs`
```javascript
export default class PingModule {
  async init(host, config) {
    this.host = host;
    this.config = config; // receives config.modules.ping
    this.utils = host.utils;
    
    console.log("[Ping] Module initialized.");
  }

  async handleMessage(cleanText, replyCallback, contact = null) {
    const text = cleanText.toLowerCase();
    
    if (text === 'ping') {
      const reply = this.config.replyUppercase ? "PONG" : "pong";
      await replyCallback(reply);
    }
  }
}
```

## 4. Interactive CLI Configuration Wizard Hook

To support configuring modules interactively via the CLI (e.g., `meshbot weather`), a module can export a static `configure` method:

```javascript
static async configure(askQuestion, currentConfig)
```

- `askQuestion(prompt)`: An async helper that prints a prompt to stdout and returns the trimmed user response.
- `currentConfig`: The current configuration object for this module from `config.json`.
- The method must return the updated configuration object, which is then automatically saved back to `config.json`.

### Example configure hook:
```javascript
static async configure(askQuestion, currentConfig) {
  const config = { ...currentConfig };
  
  const defaultZip = config.zipCode || "20001";
  const zip = await askQuestion(`Enter ZIP code [${defaultZip}]: `);
  config.zipCode = zip || defaultZip;

  return config;
}
```

---

## 5. The Host Bot API Reference

Inside `init(host, config)`, the module receives the `host` context. You can use the following methods and properties to interact with the MeshCore node and other modules:

*   `host.VERSION`: The version string of the host bot framework (e.g. `1.1.0`).
*   `host.channels`: Object containing resolved channels (e.g. `host.channels.weather` / `host.channels.alerts`).
*   `host.utils`: References helper functions from `utils.mjs` (e.g., `sleep(ms)`, `formatDate()`, `shortenToBytes()`).
*   `host.sendDM(publicKey, text)`: Sends a direct message back to a contact.
*   `host.sendChannelMessage(channelIdx, text)`: Broadcasts a text message to a specific channel index.
*   `host.findChannelByName(name)`: Resolves a channel index by its name string (e.g. `"#weather"`).
