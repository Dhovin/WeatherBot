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
  start [port]             Start the bot runtime (equivalent to node index.mjs)
  list                     List all enabled modules
  config                   Run the interactive wizard for core connection settings
  service <action>         Manage the systemd service (install, uninstall, status, restart)
  update                   Pull updates from GitHub and install dependencies
  weather                  Run configuration wizard for the Weather module
  help                     Show this help message
`);
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
      const portArg = args[1];
      const indexMjs = join(rootDir, 'index.mjs');
      const startArgs = portArg ? [indexMjs, portArg] : [indexMjs];
      
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
      else if (action === 'status') shellCmd = 'sudo systemctl status weatherbot.service --no-pager';
      else if (action === 'restart') shellCmd = 'sudo systemctl restart weatherbot.service';

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

    default:
      console.error(`Unknown command: "${cmd}". Type "meshbot help" to view usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error("CLI Execution Error:", err);
  process.exit(1);
});
