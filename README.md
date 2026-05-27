# MeshCore Weather Bot (US Market)

A Node.js weather alert and lightning tracking bot for MeshCore networks, specifically tailored for the United States market using the free **National Weather Service (NWS) API** (provided by NOAA at `api.weather.gov`) and global lightning telemetry.

## Features

-   **US-Local Forecasts**: Queries NWS points API for daily forecasts (no API key required) and sends daily summaries to your designated MeshCore weather channel.
-   **Minimized LoRa Transmission**: Forecasts are aggregated by weekday and compressed using emojis (e.g., `today: ⛈️ low: 65`, `Wed: ⛈️ hi: 80 low: 64`) to fit a full 3-day report within a single 150-character MeshCore packet.
-   **Active Weather Alerts & Clearance**: Polls NWS active alerts for your exact GPS coordinates, broadcasts matching warnings (e.g., Tornado, Severe Thunderstorm, Flood Warnings), and automatically posts a **Clearance Notification** (e.g., `🟢 CLEAR: Tornado Warning has ended/been cleared...`) when warnings expire or get canceled.
-   **Lightning Proximity Alerts**: Monitors global lightning strikes in real-time using the Blitzortung MQTT network, reporting active cells in your area with heading and distance (e.g., `Lightning: Arlington, VA (10km East)`).
-   **Interactive Queries**: Users can send a message directly to the bot or on a monitored channel containing a US ZIP code (e.g., `90210`, `!weather 90210`, or `/wx 30303`), and the bot will dynamically geocode the ZIP code and reply with the local forecast for that location.

## Requirements

-   **Node.js**: Version 18 or higher (LTS recommended).
-   **MeshCore Device**: A radio device (such as a Heltec, T-Beam, etc.) running MeshCore companion USB firmware connected to the host machine.
-   **Internet Connection**: Required for the host machine to reach the NWS API and geocoding services.

---

## Configuration (`config.json`)

Configure your location, serial port, and alert behavior by editing `config.json`:

```json
{
  "port": "/dev/ttyACM0", // The serial port for your MeshCore USB device (e.g., COM3 on Windows)
  "weatherAlarm": "06:00", // Time of day to broadcast the daily forecast (24-hour HH:MM format)
  "userAgent": "MeshCoreWeatherBot/1.0 (your-email@example.com)", // NWS API requires a valid User-Agent
  "zipCode": "20001", // US ZIP code for auto-geocoding (replaces myPosition and blitzArea if set)
  "myPosition": {
    "lat": 38.9072, // Your decimal latitude (fallback if zipCode is empty)
    "lon": -77.0369 // Your decimal longitude (fallback if zipCode is empty)
  },
  "channels": {
    "alerts": "#weather", // MeshCore channel to broadcast lightning and weather alerts to
    "weather": "#weather" // MeshCore channel to broadcast the scheduled forecast to
  },
  "timers": {
    "blitzCollection": 600000, // Time window (in ms) to group lightning strikes (10 mins)
    "meteoAlerts": 600000 // How often (in ms) to poll the NWS alerts API (10 mins)
  },
  "blitzRadiusMiles": 10, // Lightning tracking radius in miles (replaces blitzArea if set)
  "blitzArea": { // Bounding box for lightning reporting (fallback if blitzRadiusMiles or zipCode is empty)
    "minLat": 37.9072,
    "minLon": -78.5369,
    "maxLat": 39.9072,
    "maxLon": -75.5369
  },
  "compasNames": {
    "N": "North",
    "NE": "North-East",
    "E": "East",
    "SE": "South-East",
    "S": "South",
    "SW": "South-West",
    "W": "West",
    "NW": "North-West"
  },
  "meteoAlerts": {
    "enabled": true,
    "timeout": 180, // Suppress repeating alerts for this many minutes (3 hours)
    "severityFilter": ["severe", "extreme"], // Which NWS alert severities to report
    "certaintyFilter": ["observed", "likely"], // Which NWS alert certainties to report
    "messageTemplate": "{event} Alert for {region}\nEffective: {start} to {end}\nSeverity: {severity}\n{headline}"
  }
}
```

> [!TIP]
> **Easy Location Setup**: If you set the `"zipCode"` parameter to a US ZIP code, the bot will automatically resolve the GPS coordinates at startup and populate `"myPosition"`. Additionally, by configuring `"blitzRadiusMiles"` (defaults to 10 miles), the bot will automatically calculate a precise bounding box (`"blitzArea"`) centered on your position, adjusting for latitude. You do not need to manually enter any coordinates or bounding boxes!

> [!IMPORTANT]
> **NWS API Policy**: To request weather data, the NWS API requires a custom `User-Agent` header that identifies your bot and includes contact information (such as an email address). Please ensure you update the `userAgent` field in `config.json` with your email.

---

## Linux Background Service Setup (systemd)

The bot includes scripts to easily install and run it as a background service on Linux that auto-starts on system boot and restarts automatically if it crashes.

During installation, an interactive **Configuration Wizard** will guide you through entering your **Serial Port**, **ZIP Code**, and **NWS User-Agent email**, dynamically writing them to `config.json` and setting permissions.

### Option A: One-Liner Installation (via curl)

You can download and run the installer directly using `curl`. This standalone mode will automatically clone the repository into `/opt/weatherbot`, run the Configuration Wizard, install dependencies, and register the systemd service:

```bash
curl -sSL https://raw.githubusercontent.com/Dhovin/WeatherBot/main/install.sh | sudo bash
```

To uninstall:
```bash
curl -sSL https://raw.githubusercontent.com/Dhovin/WeatherBot/main/uninstall.sh | sudo bash
```

### Option B: Local Installation

If you have already cloned the repository manually, run the installation script directly from the project directory:

1.  Make the scripts executable:
    ```bash
    chmod +x install.sh uninstall.sh
    ```

2.  Run the installer (which will start the Configuration Wizard):
    ```bash
    sudo ./install.sh
    ```

3.  To uninstall:
    ```bash
    sudo ./uninstall.sh
    ```

---

### Service Management

Once installed, you can manage the background service using:

```bash
# Check service logs/status:
sudo systemctl status weatherbot.service

# Stop the service:
sudo systemctl stop weatherbot.service

# Start the service:
sudo systemctl start weatherbot.service

# Restart the service:
sudo systemctl restart weatherbot.service
```

---

## Manual Execution (Windows / macOS)

### 1. Install dependencies:
```bash
npm install
```

### 2. Run the bot:
```bash
node index.mjs
```

You can optionally override the configuration port via CLI argument:
```bash
node index.mjs COM3
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
sudo journalctl -u weatherbot.service -f -n 50
```
