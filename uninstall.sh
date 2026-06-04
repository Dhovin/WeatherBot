#!/bin/bash

# Ensure running as root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or using sudo (e.g., sudo ./uninstall.sh)"
  exit 1
fi

echo "Stopping meshbot service..."
systemctl stop meshbot.service

echo "Disabling meshbot service..."
systemctl disable meshbot.service

echo "Removing systemd service file..."
SERVICE_FILE="/etc/systemd/system/meshbot.service"
if [ -f "$SERVICE_FILE" ]; then
  rm "$SERVICE_FILE"
  echo "Removed $SERVICE_FILE"
else
  echo "Service file $SERVICE_FILE not found."
fi

echo "Reloading systemd daemon..."
systemctl daemon-reload

if [ -d "/opt/meshbot" ]; then
  if [ -t 0 ]; then
    read -p "Do you want to remove the installation directory /opt/meshbot? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      rm -rf /opt/meshbot
      echo "Removed /opt/meshbot"
    else
      echo "Kept /opt/meshbot"
    fi
  else
    echo "Installation directory /opt/meshbot exists. You can manually delete it using: sudo rm -rf /opt/meshbot"
  fi
fi

echo "Uninstallation complete!"
