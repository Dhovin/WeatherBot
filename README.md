# MeshCore Weather Bot (US Market)

A Node.js weather alert and lightning tracking bot for MeshCore networks, specifically tailored for the United States market using the free **National Weather Service (NWS) API** (provided by NOAA at `api.weather.gov`) and global lightning telemetry.

## Features

-   **US-Local Forecasts**: Queries NWS points API for daily forecasts (no API key required) and sends daily summaries to your designated MeshCore weather channel.
-   **Minimized LoRa Transmission**: Forecasts are aggregated by weekday and compressed using emojis (e.g., `today: ⛈️ low: 65`, `Wed: ⛈️ hi: 80 low: 64`) to fit a full 3-day report within a single 150-character MeshCore packet.
-   **Active Weather Alerts & Clearance**: Polls NWS active alerts for your exact GPS coordinates, broadcasts matching warnings (e.g., Tornado, Severe Thunderstorm, Flood Warnings), and automatically posts a **Clearance Notification** (e.g., `🟢 CLEAR: Tornado Warning has ended/been cleared...`) when warnings expire or get canceled.
-   **Lightning Proximity Alerts**: Monitors global lightning strikes in real-time using the Blitzortung MQTT network, reporting active cells in your area with heading and distance (e.g., `Lightning: Arlington, VA (10km East)`).
-   **Interactive Queries**: Users can send a message directly to the bot or on a monitored channel containing a US ZIP code (e.g., `90210`, `!weather 90210`, or `/wx 30303`) to query the local forecast, or send `version`/`info` to get the bot's current software version.
-   **One-Way MQTT Telemetry Forwarder**: Automatically listens to raw RX/TX serial frames and forwards them in real-time to public and private mapping databases (supporting 20 presets including LetsMesh, MeshMapper, and `ntxmesh`) using TCP (`mqtt://`), TLS (`mqtts://`), or WebSockets (`ws://`/`wss://`) with automatic protocol detection probing.
-   **Network Topology Crawler**: Periodically polls the local contacts database and crawls remote repeaters (`getNeighbours`) with retry logic to build a network-wide database (`topology.json`) and exports a fully interactive, CORS-safe, Leaflet-based map (`mesh_map.html`) showing repeaters and interconnect links colored by SNR signal quality.

## Requirements

-   **Node.js**: Version 18 or higher (LTS recommended).
-   **MeshCore Device**: A radio device (such as a Heltec, T-Beam, etc.) running MeshCore companion USB firmware connected to the host machine.
-   **Internet Connection**: Required for the host machine to reach the NWS API and geocoding services.

---

## Configuration (`config.json`)

MeshBot operates as a Host Bot controller loading separate Module Plugins. General connection settings are at the root level, and module-specific configurations are placed inside the `"modules"` object.

Configure your device port, active channels, and modules by editing `config.json`:

```json
{
  "port": "COM11", // The serial port for your MeshCore device (e.g. COM3 or /dev/ttyACM0)
  "channels": {
    "alerts": "#weather",
    "weather": "#weather",
    "test": "#test",
    "testing": "#testing"
  },
  "enabledModules": [
    "weather",
    "testing"
  ],
  "modules": {
    "weather": {
      "weatherAlarm": "06:00", // Daily forecast broadcast time (24-hour format)
      "userAgent": "MeshBot/1.1.0 (contact@example.com)", // Required for NWS API policy
      "zipCode": "20001", // US ZIP code for auto-geocoding (replaces myPosition and blitzArea if set)
      "myPosition": {
        "lat": 38.9072,
        "lon": -77.0369
      },
      "timers": {
        "blitzCollection": 600000,
        "meteoAlerts": 600000
      },
      "blitzRadiusMiles": 10,
      "blitzArea": {
        "minLat": 37.9072,
        "minLon": -78.5369,
        "maxLat": 39.9072,
        "maxLon": -75.5369
      },
      "compasNames": {
        "N": "North", "NE": "North-East", "E": "East", "SE": "South-East",
        "S": "South", "SW": "South-West", "W": "West", "NW": "North-West"
      },
      "meteoAlerts": {
        "enabled": true,
        "timeout": 180, // Suppress repeating alerts for 3 hours
        "severityFilter": ["severe", "extreme"],
        "certaintyFilter": ["observed", "likely"],
        "messageTemplate": "{event} Alert for {region}\nEffective: {start} to {end}\nSeverity: {severity}\n{headline}"
      }
    },
    "testing": {}
  }
}
```

> [!TIP]
> **Easy Location Setup**: If you set the `"zipCode"` parameter under `"modules.weather"`, the bot will automatically resolve the GPS coordinates at startup and populate `"myPosition"`. Additionally, by configuring `"blitzRadiusMiles"` (defaults to 10 miles), the bot will automatically calculate a precise bounding box (`"blitzArea"`) centered on your position, adjusting for latitude.

> [!IMPORTANT]
> **NWS API Policy**: To request weather data, the NWS API requires a custom `User-Agent` header that identifies your bot and includes contact information (such as an email address). Please ensure you update the `userAgent` field under `"modules.weather"` in `config.json` with your email.

---

## MeshBot CLI Tool (`meshbot`)

The bot includes a unified command-line tool `meshbot` to manage the lifecycle, configure settings, run service daemons, and perform updates.

### Commands

*   `meshbot start [port] [-S]`: Starts the bot host runtime (use `-S` to scan and select device port interactively).
*   `meshbot list`: Lists all currently enabled/active modules.
*   `meshbot config`: Runs the interactive configuration wizard for core connection settings (serial port and enabled modules).
*   `meshbot weather`: Runs the interactive configuration wizard for the Weather module (ZIP code, alert toggles, alarm time, and NWS User-Agent email).
*   `meshbot mqtt`: Runs the interactive configuration wizard for the MQTT module (IATA code, preset brokers, custom brokers url/token/audience).
*   `meshbot service <action>`: Manages the Linux systemd background service:
    *   `meshbot service install`: Installs and registers the systemd daemon.
    *   `meshbot service uninstall`: Removes the systemd daemon.
    *   `meshbot service status`: Checks active service logs and status.
    *   `meshbot service restart`: Restarts the background service.
*   `meshbot update`: Upgrades the bot (pulls code from Git and updates dependencies).
*   `meshbot help`: Displays usage instructions.

---

## Linux Background Service Setup (systemd)

You can install MeshBot as a background service on Linux that auto-starts on system boot and restarts automatically if it crashes.

### Option A: One-Liner Installation (via curl)

You can download and run the installer directly using `curl`. This standalone mode will automatically clone the repository into `/opt/meshbot`, run the Configuration Wizard, install dependencies, and register the systemd service:

```bash
curl -sSL https://raw.githubusercontent.com/Dhovin/WeatherBot/main/install.sh | sudo bash
```

To update or uninstall, you can use the CLI or run scripts:
- **Update**: `sudo meshbot update`
- **Uninstall**: `sudo meshbot service uninstall`

### Option B: Local Installation

If you have already cloned the repository manually, run the installation script directly:

1.  Make the scripts executable:
    ```bash
    chmod +x install.sh uninstall.sh update.sh
    ```

2.  Run the installer (which will start the Configuration Wizard):
    ```bash
    sudo ./install.sh
    ```

---

## Windows Installation & Configuration

You can configure and install MeshBot on Windows using the PowerShell setup wizard script.

### 1. Run the Setup Wizard:
Open PowerShell in the project directory and run the installation script:
```powershell
.\install.ps1
```
This wizard will:
* Detect your Node.js environment.
* Install npm dependencies (`npm install`).
* Scan and list all active COM port connections on your system.
* Walk you through the interactive configuration wizard (setting serial port, ZIP code, email, and local repeater).
* Write configuration updates to `config.json`.
* Optionally register the bot to run automatically on Windows startup by creating a shortcut in your Startup directory.

### 2. Running & Uninstalling on Windows:
* **Running**: Double-click `run.bat` in the root workspace folder to launch the bot runtime directly in a command prompt window.
* **Uninstalling**: Run the PowerShell uninstaller script to remove the startup shortcut and optionally delete the node dependencies and configurations:
  ```powershell
  .\uninstall.ps1
  ```

### 3. Manual/macOS Execution:
If running on macOS or executing manually:

```bash
# Install dependencies
npm install

# Link and run globally
npm link
meshbot start

# Or run via local package runner
npm run cli -- start
```

---

## Troubleshooting

### 1. Serial Port Connection Issues
* **Error: Port Busy / Locked**: Ensure no other application (like a terminal emulator, the MeshCore Web Flasher, or another instance of the bot) is currently accessing the serial port.
* **Permission Denied (Linux)**: By default, normal users cannot read/write serial ports. You can grant access by adding your user to the `dialout` group:
  ```bash
  sudo usermod -aG dialout $USER
  ```
  *(Log out and log back in for changes to take effect.)*
* **Automatic Port Detection**: If your configured port changes or is disconnected, the bot will attempt to automatically scan the system for ESP32 / USB-UART bridge devices at startup.

### 2. Message Replies Do Not Work in Channels
If the bot successfully responds to direct messages (DMs) but ignores commands sent in channels:
* **Channel Name Mismatch**: Check that the channel name under `config.json` (`"channels": { "weather": "#weather" }`) matches the channel name configured on the device **exactly** (including case sensitivity and the `#` prefix).
* **Verify Resolved Index**: Start the bot manually using `node index.mjs` and look at the logs when you send a message to the channel. The bot logs:
  `Channel message details: message.channelIdx=X (type: ...), channels.weather.channelIdx=Y (type: ...)`
  If the indices `X` and `Y` do not match, the bot will ignore the query and log:
  `Ignored channel message on channel index X (not #weather channel index Y)`
  Ensure the channel name matches exactly so the bot resolves it to the correct index.

### 3. NWS API or Geocoding Failures
* **403 Forbidden / API Blocks**: The National Weather Service (NWS) API requires a valid user-agent. If requests are blocked or fail, ensure the `"userAgent"` field in `config.json` contains a valid email address inside the identifier.
* **OSM Geocoding Blocking**: If geocoding fails due to OSM Nominatim API rate limits or blocks (common in cloud VM environments), the bot automatically falls back to raw GPS coordinates or parses ZIP codes using `zippopotam.us` as a redundant service.

### 4. Viewing Background Service Logs
If you installed the bot as a systemd service, you can follow its live runtime logs using `journalctl`:
```bash
sudo journalctl -u meshbot.service -f -n 50
```
