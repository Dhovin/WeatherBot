#!/bin/bash

# Ensure running as root/sudo for systemd commands
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or using sudo (e.g., sudo ./update.sh)"
  exit 1
fi

SUDO_USER_NAME=${SUDO_USER:-$USER}

# Detect directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
if [ ! -f "$DIR/package.json" ]; then
  # Try to detect via systemd service WorkingDirectory
  SYSTEMD_DIR=""
  if [ -f "/etc/systemd/system/weatherbot.service" ]; then
    SYSTEMD_DIR=$(grep -E "^WorkingDirectory=" /etc/systemd/system/weatherbot.service | cut -d= -f2 | xargs)
  fi
  if [ -z "$SYSTEMD_DIR" ]; then
    SYSTEMD_DIR=$(systemctl show weatherbot.service -p WorkingDirectory 2>/dev/null | cut -d= -f2 | xargs)
  fi

  if [ -n "$SYSTEMD_DIR" ] && [ -f "$SYSTEMD_DIR/package.json" ]; then
    DIR="$SYSTEMD_DIR"
  elif [ -f "$(pwd)/package.json" ]; then
    DIR="$(pwd)"
  elif [ -f "/opt/weatherbot/package.json" ]; then
    DIR="/opt/weatherbot"
  else
    # Fallback to current directory, it will fail but we have no choice
    DIR="$(pwd)"
  fi
fi

echo "--------------------------------------------------"
echo "         US WeatherBot Upgrade Script             "
echo "--------------------------------------------------"
echo "Working directory: $DIR"

# 1. Stop service if active to release file locks during update
WAS_ACTIVE=0
if systemctl is-active --quiet weatherbot.service; then
  echo "Stopping weatherbot service for update..."
  systemctl stop weatherbot.service
  WAS_ACTIVE=1
fi

# 2. Pull latest code from Git as original user to preserve file ownerships
echo "Pulling latest code from GitHub..."
sudo -u "$SUDO_USER_NAME" git -C "$DIR" pull
if [ $? -ne 0 ]; then
  echo "Warning: git pull failed. Proceeding with local file updates."
fi

# 3. Update dependencies as original user
echo "Updating npm dependencies..."
sudo -u "$SUDO_USER_NAME" npm install --prefix "$DIR"
if [ $? -ne 0 ]; then
  echo "Error: npm install failed."
  # Try to restart service if it was running before exit
  if [ $WAS_ACTIVE -eq 1 ]; then
    systemctl start weatherbot.service
  fi
  exit 1
fi

# 4. Restart or start weatherbot systemd service
if [ $WAS_ACTIVE -eq 1 ]; then
  echo "Starting weatherbot service..."
  systemctl start weatherbot.service
  if [ $? -eq 0 ]; then
    echo "WeatherBot service started successfully!"
  else
    echo "Error: Failed to start weatherbot service."
    exit 1
  fi
else
  echo "WeatherBot service is not active. Enabling and starting..."
  systemctl enable weatherbot.service
  systemctl start weatherbot.service
fi

echo "--------------------------------------------------"
echo "Upgrade complete! Current service status:"
echo "--------------------------------------------------"
systemctl status weatherbot.service --no-pager
