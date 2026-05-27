#!/bin/bash

# Ensure running as root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or using sudo (e.g., sudo ./uninstall.sh)"
  exit 1
fi

echo "Stopping weatherbot service..."
systemctl stop weatherbot.service

echo "Disabling weatherbot service..."
systemctl disable weatherbot.service

echo "Removing systemd service file..."
SERVICE_FILE="/etc/systemd/system/weatherbot.service"
if [ -f "$SERVICE_FILE" ]; then
  rm "$SERVICE_FILE"
  echo "Removed $SERVICE_FILE"
else
  echo "Service file $SERVICE_FILE not found."
fi

echo "Reloading systemd daemon..."
systemctl daemon-reload

if [ -d "/opt/weatherbot" ]; then
  if [ -t 0 ]; then
    read -p "Do you want to remove the installation directory /opt/weatherbot? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      rm -rf /opt/weatherbot
      echo "Removed /opt/weatherbot"
    else
      echo "Kept /opt/weatherbot"
    fi
  else
    echo "Installation directory /opt/weatherbot exists. You can manually delete it using: sudo rm -rf /opt/weatherbot"
  fi
fi

echo "Uninstallation complete!"
