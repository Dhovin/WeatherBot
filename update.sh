#!/bin/bash

# Ensure running as root/sudo for systemd commands
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or using sudo (e.g., sudo ./update.sh)"
  exit 1
fi

SUDO_USER_NAME=${SUDO_USER:-$USER}

# Detect directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
if [ -z "$DIR" ] || [ "$DIR" = "/dev" ]; then
  DIR="$(pwd)"
fi

echo "--------------------------------------------------"
echo "         US WeatherBot Upgrade Script             "
echo "--------------------------------------------------"
echo "Working directory: $DIR"

# 1. Pull latest code from Git as original user to preserve file ownerships
echo "Pulling latest code from GitHub..."
sudo -u "$SUDO_USER_NAME" git -C "$DIR" pull
if [ $? -ne 0 ]; then
  echo "Warning: git pull failed. Proceeding with local file updates."
fi

# 2. Update dependencies as original user
echo "Updating npm dependencies..."
sudo -u "$SUDO_USER_NAME" npm install --prefix "$DIR"
if [ $? -ne 0 ]; then
  echo "Error: npm install failed."
  exit 1
fi

# 3. Restart weatherbot systemd service
if systemctl is-active --quiet weatherbot.service; then
  echo "Restarting weatherbot service..."
  systemctl restart weatherbot.service
  if [ $? -eq 0 ]; then
    echo "WeatherBot service restarted successfully!"
  else
    echo "Error: Failed to restart weatherbot service."
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
