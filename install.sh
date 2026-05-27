#!/bin/bash

# Ensure running as root/sudo for systemd setup
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or using sudo (e.g., sudo ./install.sh)"
  exit 1
fi

# Determine original user if run with sudo
SUDO_USER_NAME=${SUDO_USER:-$USER}

# Detect Node.js installation
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
  # Try common NVM path if node is not found in global path
  if [ -f "/home/$SUDO_USER_NAME/.nvm/nvm.sh" ]; then
    NODE_PATH=$(sudo -u "$SUDO_USER_NAME" bash -c 'source ~/.nvm/nvm.sh && which node')
  fi
fi

if [ -z "$NODE_PATH" ]; then
  echo "Error: Node.js was not found. Please install Node.js 18+ first."
  exit 1
fi

echo "Found Node.js path: $NODE_PATH"

# Detect directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# If run via pipe/stdin, DIR might be /dev or empty. Fall back to current working directory
if [ -z "$DIR" ] || [ "$DIR" = "/dev" ]; then
  DIR="$(pwd)"
fi

# Check if we are running in standalone mode (package.json not found in script dir or pwd)
if [ ! -f "$DIR/package.json" ] && [ ! -f "$(pwd)/package.json" ]; then
  INSTALL_DIR="/opt/weatherbot"
  echo "Standalone mode detected (package.json not found in $DIR or $(pwd))."
  echo "Installing to $INSTALL_DIR..."
  
  if ! command -v git &> /dev/null; then
    echo "Error: git is required to clone the repository. Please install git first."
    exit 1
  fi

  # Create directory and set ownership to original user
  mkdir -p "$INSTALL_DIR"
  chown "$SUDO_USER_NAME:$SUDO_USER_NAME" "$INSTALL_DIR"
  
  # Clone repo if it hasn't been cloned already
  if [ ! -f "$INSTALL_DIR/package.json" ]; then
    echo "Cloning repository to $INSTALL_DIR..."
    sudo -u "$SUDO_USER_NAME" git clone https://github.com/dhovi/weatherbot.git "$INSTALL_DIR"
    if [ $? -ne 0 ]; then
      echo "Error: Failed to clone repository."
      exit 1
    fi
  fi
  
  DIR="$INSTALL_DIR"
else
  # If package.json is in pwd but not in DIR, adjust DIR to pwd
  if [ ! -f "$DIR/package.json" ] && [ -f "$(pwd)/package.json" ]; then
    DIR="$(pwd)"
  fi
fi

echo "Working directory: $DIR"

# Install npm dependencies as original user to preserve folder permissions
echo "Installing dependencies..."
sudo -u "$SUDO_USER_NAME" npm install --prefix "$DIR"
if [ $? -ne 0 ]; then
  echo "Error: Failed to install npm packages."
  exit 1
fi

echo "Creating systemd service file..."
SERVICE_FILE="/etc/systemd/system/weatherbot.service"

cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=MeshCore US Weather Bot Service
After=network.target

[Service]
Type=simple
User=$SUDO_USER_NAME
WorkingDirectory=$DIR
ExecStart=$NODE_PATH index.mjs
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "$SERVICE_FILE"

echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling weatherbot service..."
systemctl enable weatherbot.service

echo "Starting weatherbot service..."
systemctl start weatherbot.service

echo "Installation complete! Weather bot service status:"
systemctl status weatherbot.service --no-pager
