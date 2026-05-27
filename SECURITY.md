# Security Policy

This document outlines the security controls, validation mechanisms, and safe execution practices implemented in the US MeshCore Weather Bot.

## 1. Security Architecture & Protections

| Area | Threat Model | Status | Control Details |
| :--- | :--- | :--- | :--- |
| **MQTT Data Parser** | Query Injection / Malformed Flooding | **Mitigated** | Strict parsing via `parseFloat` and rejection of coordinates using `isNaN()` to prevent parameters injection on Nominatim queries. |
| **MeshCore Input (DMs/Channels)** | Malicious Commands / Code Injection | **Mitigated** | Inputs are validated using rigorous regex patterns: `/^\d{5}$/` (exactly 5 digits) or keyword parsing. |
| **Installer Wizard** | Command Injection | **Mitigated** | User inputs in the Wizard are passed to NodeJS as safe command-line arguments using `process.argv` instead of raw shell concatenation. |
| **Linux Service Setup** | Privilege Escalation / Ownership Hijacking | **Mitigated** | Scripts drop privileges for network/file operations (`git clone`, `npm install`), running them under the original non-root user. |
| **Dependency Audits** | Vulnerabilities in Third-Party Packages | **Mitigated** | Run periodic audits; `npm audit` currently reports `0 vulnerabilities`. |

---

## 2. Hardening Measures Implemented

### Input Validation & Coordinate Sanitization
The bot connects to the public Blitzortung MQTT network to track lightning strikes. To ensure a compromised or malicious broker cannot inject malicious queries when geocoding strike coordinates, coordinates are strictly validated as float numbers:

```javascript
const lat = parseFloat(rawData.lat);
const lon = parseFloat(rawData.lon);

if (isNaN(lat) || isNaN(lon)) {
  return;
}
```

This prevents special characters (e.g. `&`, `?`, `=`, `/`) from making their way to the OSM Nominatim API endpoints.

### Interactive LoRa Query Safety
Commands from the MeshCore network are filtered strictly. The ZIP code parser ensures that only numeric values can be processed:

```javascript
const match = cleanText.match(/^subscribe\s+(\d{5})$/i);
// and
if (/^\d{5}$/.test(cleanText)) { ... }
```

No other arbitrary commands are executed, preventing typical input-handling exploits.

### Safe Shell Script Privilege Management
To install and update as a systemd service, root permissions are required. However, compiling code or downloading modules as root causes file ownership conflicts and increases execution privilege risk. 
Both `install.sh` and `update.sh` drop root privileges and run git/npm tasks as the original user:

```bash
SUDO_USER_NAME=${SUDO_USER:-$USER}
sudo -u "$SUDO_USER_NAME" npm install --prefix "$DIR"
```

---

## 3. Reporting a Vulnerability

If you discover a security vulnerability within this project, please open an issue in this repository or contact the maintainer directly. We aim to review and address all reported security issues within 48 hours.
