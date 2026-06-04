#!/usr/bin/env node

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const configPath = join(rootDir, 'config.json');

// Helper to ask interactive questions
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

// Load config
function loadConfig() {
  if (!existsSync(configPath)) {
    return { port: "COM11", channels: {}, enabledModules: [], modules: {} };
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error("Error reading config.json:", err.message);
    process.exit(1);
  }
}

// Save config
function saveConfig(cfg) {
  try {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
    console.log("Configuration saved successfully.");
  } catch (err) {
    console.error("Error writing config.json:", err.message);
    process.exit(1);
  }
}

// Print help
function printHelp() {
  console.log(`
MeshBot Command-Line Interface (v1.1.0)
Usage: meshbot <command> [args]

Commands:
  start [port] [-S]        Start the bot runtime (use -S to scan/select device port)
  list                     List all enabled modules
  config                   Run the interactive wizard for core connection settings
  service <action>         Manage the systemd service (install, uninstall, status, restart)
  update                   Pull updates from GitHub and install dependencies
  weather                  Run configuration wizard for the Weather module
  mqtt                     Run configuration wizard for the MQTT module
  help                     Show this help message
`);
}

// Interactive selection menu
function selectOption(title, options) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(0);
      return;
    }
    let selectedIndex = 0;
    
    function render() {
      // Clear console screen cleanly and move cursor to top-left
      process.stdout.write('\x1bc'); 
      console.log("\x1b[36m==================================================\x1b[0m");
      console.log(`\x1b[1m\x1b[35m  ${title}\x1b[0m`);
      console.log("\x1b[36m==================================================\x1b[0m");
      
      options.forEach((opt, idx) => {
        if (idx === selectedIndex) {
          console.log(` \x1b[32m➔ [●] ${opt}\x1b[0m`);
        } else {
          console.log(`   [ ] ${opt}`);
        }
      });
      console.log("\x1b[36m--------------------------------------------------\x1b[0m");
      console.log("\x1b[90mUse Arrow Keys (↑/↓) to navigate, Enter to select.\x1b[0m");
    }

    render();

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    
    const onKeypress = (str, key) => {
      if (key) {
        if (key.ctrl && key.name === 'c') {
          cleanup();
          process.exit(0);
        }
        if (key.name === 'up') {
          selectedIndex = (selectedIndex - 1 + options.length) % options.length;
          render();
        } else if (key.name === 'down') {
          selectedIndex = (selectedIndex + 1) % options.length;
          render();
        } else if (key.name === 'return' || key.name === 'enter') {
          cleanup();
          process.stdout.write('\x1bc'); 
          resolve(selectedIndex);
        }
      }
    };

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    }

    process.stdin.on('keypress', onKeypress);
  });
}

// Port selection helper
async function runPortSelection() {
  let ports = [];
  try {
    const { SerialPort } = await import('serialport');
    ports = await SerialPort.list();
  } catch (err) {
    console.warn("Could not list serial ports:", err.message);
  }

  if (ports.length === 0) {
    console.log("\x1b[33mNo active serial ports were auto-detected.\x1b[0m");
    if (!process.stdin.isTTY) {
      console.log("Non-interactive environment detected. Using default port COM11.");
      return "COM11";
    }
    const manualPort = await askQuestion("Enter device serial port path manually (e.g. COM3 or /dev/ttyACM0): ");
    if (!manualPort) {
      console.error("No port entered. Exiting.");
      process.exit(1);
    }
    const cfg = loadConfig();
    cfg.port = manualPort;
    saveConfig(cfg);
    return manualPort;
  }

  const options = ports.map(p => `${p.path} - ${p.friendlyName || p.manufacturer || 'Generic Device'}`);
  options.push("[ Enter custom port name manually ]");

  const selectedIdx = await selectOption("Select MeshCore Serial Device", options);

  if (selectedIdx === options.length - 1) {
    const manualPort = await askQuestion("Enter custom serial port path: ");
    if (!manualPort) {
      console.error("No port entered. Exiting.");
      process.exit(1);
    }
    const cfg = loadConfig();
    cfg.port = manualPort;
    saveConfig(cfg);
    return manualPort;
  } else {
    const chosenPort = ports[selectedIdx].path;
    const cfg = loadConfig();
    cfg.port = chosenPort;
    saveConfig(cfg);
    return chosenPort;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ? args[0].toLowerCase() : 'help';

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    case 'start':
      const hasSelectFlag = args.includes('-S') || args.includes('--select');
      let selectedPort = null;

      if (hasSelectFlag) {
        selectedPort = await runPortSelection();
      } else {
        const nonFlagArgs = args.slice(1).filter(a => a !== '-S' && a !== '--select');
        if (nonFlagArgs.length > 0) {
          selectedPort = nonFlagArgs[0];
        }
      }
      
      const indexMjs = join(rootDir, 'index.mjs');
      const startArgs = selectedPort ? [indexMjs, selectedPort] : [indexMjs];
      
      console.log(`Starting MeshBot subprocess...`);
      const child = spawn('node', startArgs, {
        cwd: rootDir,
        stdio: 'inherit'
      });
      child.on('exit', (code) => {
        process.exit(code || 0);
      });
      break;

    case 'list':
      const listCfg = loadConfig();
      console.log("Enabled modules:");
      if (listCfg.enabledModules && listCfg.enabledModules.length > 0) {
        listCfg.enabledModules.forEach(mod => console.log(` - ${mod}`));
      } else {
        console.log(" (None)");
      }
      break;

    case 'config':
      const coreCfg = loadConfig();
      console.log("--------------------------------------------------");
      console.log("       MeshBot Core Configuration Wizard          ");
      console.log("--------------------------------------------------");
      
      const defaultPort = coreCfg.port || "COM11";
      const inputPort = await askQuestion(`Enter serial port for MeshCore device [${defaultPort}]: `);
      coreCfg.port = inputPort || defaultPort;

      const enabledStr = (coreCfg.enabledModules || []).join(', ');
      const inputModules = await askQuestion(`Enter enabled modules comma-separated (e.g. weather, ping) [${enabledStr}]: `);
      if (inputModules) {
        coreCfg.enabledModules = inputModules.split(',').map(s => s.trim()).filter(Boolean);
      }

      saveConfig(coreCfg);
      break;

    case 'service':
      const action = args[1] ? args[1].toLowerCase() : '';
      if (!['install', 'uninstall', 'status', 'restart'].includes(action)) {
        console.error("Usage: meshbot service [install | uninstall | status | restart]");
        process.exit(1);
      }

      let shellCmd = '';
      if (action === 'install') shellCmd = 'sudo ./install.sh';
      else if (action === 'uninstall') shellCmd = 'sudo ./uninstall.sh';
      else if (action === 'status') shellCmd = 'sudo systemctl status meshbot.service --no-pager';
      else if (action === 'restart') shellCmd = 'sudo systemctl restart meshbot.service';

      console.log(`Running: ${shellCmd}`);
      const shellProc = spawn('sh', ['-c', shellCmd], {
        cwd: rootDir,
        stdio: 'inherit'
      });
      shellProc.on('exit', (code) => {
        process.exit(code || 0);
      });
      break;

    case 'update':
      console.log(`Running update script...`);
      const updateProc = spawn('sh', ['-c', 'sudo ./update.sh'], {
        cwd: rootDir,
        stdio: 'inherit'
      });
      updateProc.on('exit', (code) => {
        process.exit(code || 0);
      });
      break;

    case 'weather':
      const wCfg = loadConfig();
      try {
        const weatherMjs = join(rootDir, 'modules', 'weather.mjs');
        const weatherClass = (await import(`file://${weatherMjs}`)).default;
        
        if (typeof weatherClass.configure !== 'function') {
          console.error("Error: Weather module does not support interactive CLI configuration.");
          process.exit(1);
        }

        console.log("--------------------------------------------------");
        console.log("         Weather Module Configuration             ");
        console.log("--------------------------------------------------");

        if (!wCfg.modules) wCfg.modules = {};
        if (!wCfg.modules.weather) wCfg.modules.weather = {};

        const updatedWeatherCfg = await weatherClass.configure(askQuestion, wCfg.modules.weather);
        wCfg.modules.weather = updatedWeatherCfg;
        saveConfig(wCfg);
      } catch (err) {
        console.error("Failed to run weather module wizard:", err.message);
        process.exit(1);
      }
      break;

    case 'mqtt':
      const mCfg = loadConfig();
      try {
        const mqttMjs = join(rootDir, 'modules', 'mqtt.mjs');
        const mqttClass = (await import(`file://${mqttMjs}`)).default;
        
        if (typeof mqttClass.configure !== 'function') {
          console.error("Error: MQTT module does not support interactive CLI configuration.");
          process.exit(1);
        }

        console.log("--------------------------------------------------");
        console.log("          MQTT Module Configuration               ");
        console.log("--------------------------------------------------");

        if (!mCfg.modules) mCfg.modules = {};
        if (!mCfg.modules.mqtt) mCfg.modules.mqtt = {};

        const updatedMqttCfg = await mqttClass.configure(askQuestion, mCfg.modules.mqtt);
        mCfg.modules.mqtt = updatedMqttCfg;
        saveConfig(mCfg);
      } catch (err) {
        console.error("Failed to run MQTT module wizard:", err.message);
        process.exit(1);
      }
      break;



    default:
      console.error(`Unknown command: "${cmd}". Type "meshbot help" to view usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error("CLI Execution Error:", err);
  process.exit(1);
});
