# Developer Guide: Deployment & Updates

This guide explains how to package your bot as a background service on Linux (`systemd`), drop privileges dynamically during installation to avoid file permission locking, and construct piped remote update scripts.

---

## 1. Systemd Service Architecture

Running your bot as a standard executable inside a shell terminal is fine for testing, but in production, it should run as a background service that auto-starts on boot and restarts automatically if it crashes.

We configure this using Linux `systemd`. A typical service configuration (`/etc/systemd/system/meshbot.service`) looks like this:

```ini
[Unit]
Description=MeshCore US Weather Bot Service
After=network.target

[Service]
Type=simple
User=dhovin                # Run under a non-root user for security
WorkingDirectory=/opt/meshbot
ExecStart=/usr/bin/node index.mjs
Restart=on-failure
RestartSec=10              # Wait 10 seconds before attempting crash recovery
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## 2. Safe Privilege Dropping during Installation

Installation scripts (`install.sh`) must run as root/sudo to write to `/etc/systemd/system/` and register the daemon. However, running operations like `git clone` or `npm install` as root changes file/folder ownership to `root:root`, preventing your bot's non-root process from editing configuration files or writing local databases.

To avoid this, detect the original non-root user who invoked `sudo` and execute git/npm commands on their behalf:

```bash
#!/bin/bash

# Ensure running as root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or using sudo"
  exit 1
fi

# Detect the original non-root user
SUDO_USER_NAME=${SUDO_USER:-$USER}

DIR="/opt/meshbot"

# Drop privileges to install npm packages as the original user
echo "Installing dependencies..."
sudo -u "$SUDO_USER_NAME" npm install --prefix "$DIR"
```

---

## 3. Dynamic Version Parsing for Services

To avoid hardcoding version details inside your scripts, extract details dynamically from `package.json` in your setup script:

```bash
# Retrieve version from package.json using grep/regex
VERSION=$(grep -o '"version": "[^"]*' "$DIR/package.json" | grep -o '[0-9.]*$' || echo "1.0.0")

# Write systemd service description with version details
cat <<EOF > "/etc/systemd/system/meshbot.service"
[Unit]
Description=MeshCore Bot Service v$VERSION
...
EOF
```

---

## 4. Piped Upgrades and Active Service Management

To update the bot, use an upgrade script (`update.sh`) that stops the active service first (releasing locks on the serial port and node modules), pulls code, recompiles dependencies, and restarts the service. 

When run via a pipe (`curl -sSL ... | sudo bash`), `${BASH_SOURCE[0]}` does not exist. We resolve this by querying the systemd service to auto-detect where the bot is running:

```bash
#!/bin/bash

# Detect directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

if [ ! -f "$DIR/package.json" ]; then
  # Running via curl pipe - resolve directory from active systemd service
  SYSTEMD_DIR=""
  if [ -f "/etc/systemd/system/meshbot.service" ]; then
    SYSTEMD_DIR=$(grep -E "^WorkingDirectory=" /etc/systemd/system/meshbot.service | cut -d= -f2 | xargs)
  fi
  if [ -z "$SYSTEMD_DIR" ]; then
    SYSTEMD_DIR=$(systemctl show meshbot.service -p WorkingDirectory 2>/dev/null | cut -d= -f2 | xargs)
  fi
  
  if [ -n "$SYSTEMD_DIR" ] && [ -f "$SYSTEMD_DIR/package.json" ]; then
    DIR="$SYSTEMD_DIR"
  else
    # Fallback to local searches
    DIR="/opt/meshbot"
  fi
fi

# 1. Stop service to clear serial port & module locks
WAS_ACTIVE=0
if systemctl is-active --quiet meshbot.service; then
  echo "Stopping active service for update..."
  systemctl stop meshbot.service
  WAS_ACTIVE=1
fi

# 2. Pull updates & build
sudo -u "$SUDO_USER" git -C "$DIR" pull
sudo -u "$SUDO_USER" npm install --prefix "$DIR"

# 3. Bring service back up
if [ $WAS_ACTIVE -eq 1 ]; then
  systemctl start meshbot.service
fi
```
This design makes upgrades safe, fast, and fully automated.
