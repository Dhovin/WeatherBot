# MeshBot Windows Setup and Configuration Script
# Author: Antigravity

$ErrorActionPreference = "Stop"

# Detect Node.js installation
$NodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodePath) {
    Write-Error "Error: Node.js was not found. Please install Node.js 18+ first from https://nodejs.org/"
    Exit 1
}

Write-Host "Found Node.js path: $($NodePath.Source)"

# Determine workspace directory
$Dir = Get-Location
Write-Host "Working directory: $Dir"

# Install npm dependencies
Write-Host "Installing dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "Error: Failed to install npm packages."
    Exit 1
}

# Interactive Configuration Wizard
Write-Host "`n--------------------------------------------------"
Write-Host "               MeshBot Config Wizard              "
Write-Host "--------------------------------------------------"

# Load current config values
$ConfigExists = Test-Path "config.json"
if ($ConfigExists) {
    $CurrentPort = node -e "import fs from 'fs'; console.log(JSON.parse(fs.readFileSync('config.json')).port || '')"
    $CurrentZip = node -e "import fs from 'fs'; const cfg = JSON.parse(fs.readFileSync('config.json')); console.log(cfg.modules?.weather?.zipCode || cfg.zipCode || '')"
    $CurrentRepeater = node -e "import fs from 'fs'; const cfg = JSON.parse(fs.readFileSync('config.json')); console.log(cfg.modules?.mapper?.localRepeater || '')"
} else {
    $CurrentPort = "COM11"
    $CurrentZip = "20001"
    $CurrentRepeater = "Dhovin-rptr"
}

$CurrentPort = $CurrentPort.Trim()
$CurrentZip = $CurrentZip.Trim()
$CurrentRepeater = $CurrentRepeater.Trim()
$CurrentEmail = "contact@example.com"

# Try to list active COM ports to help the user choose
Write-Host "Active Serial Ports detected on this system:"
$SerialPorts = [System.IO.Ports.SerialPort]::GetPortNames()
if ($SerialPorts.Count -gt 0) {
    foreach ($p in $SerialPorts) {
        Write-Host " - $p"
    }
} else {
    Write-Host " - No active COM ports detected (make sure device is plugged in)"
}
Write-Host ""

$UserPort = Read-Host "Enter serial port for MeshCore device [$CurrentPort]"
if ([string]::IsNullOrWhiteSpace($UserPort)) { $UserPort = $CurrentPort }

$UserZip = Read-Host "Enter your local US ZIP code [$CurrentZip]"
if ([string]::IsNullOrWhiteSpace($UserZip)) { $UserZip = $CurrentZip }

$UserEmail = Read-Host "Enter email address (required for NWS API User-Agent) [$CurrentEmail]"
if ([string]::IsNullOrWhiteSpace($UserEmail)) { $UserEmail = $CurrentEmail }

$UserRepeater = Read-Host "Enter local repeater node name or ID prefix [$CurrentRepeater]"
if ([string]::IsNullOrWhiteSpace($UserRepeater)) { $UserRepeater = $CurrentRepeater }

# Update config.json
node -e "
    import fs from 'fs';
    const config = fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json')) : { modules: {} };
    config.port = process.argv[1];
    if (!config.modules) config.modules = {};
    if (!config.modules.weather) config.modules.weather = {};
    config.modules.weather.zipCode = process.argv[2];
    config.modules.weather.userAgent = 'MeshBot/1.1.0 (' + process.argv[3] + ')';
    if (!config.modules.mapper) config.modules.mapper = {};
    config.modules.mapper.localRepeater = process.argv[4];
    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
" "$UserPort" "$UserZip" "$UserEmail" "$UserRepeater"

Write-Host "Configuration updated successfully!"
Write-Host "--------------------------------------------------`n"

# Offer to register startup shortcut
$CreateStartup = Read-Host "Would you like to register this bot to run automatically on Windows startup? (y/n) [n]"
if ($CreateStartup -like "y*") {
    try {
        $StartupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
        $ShortcutPath = [System.IO.Path]::Combine($StartupFolder, "MeshBot.lnk")
        
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
        
        # Target node to run the bot index script
        $Shortcut.TargetPath = "node.exe"
        $IndexScript = [System.IO.Path]::GetFullPath("index.mjs")
        $Shortcut.Arguments = "`"$IndexScript`""
        $Shortcut.WorkingDirectory = [System.IO.Path]::GetFullPath(".")
        $Shortcut.Description = "MeshBot Service"
        $Shortcut.Save()
        
        Write-Host "Successfully registered MeshBot in Windows Startup directory!"
        Write-Host "Shortcut created at: $ShortcutPath"
    } catch {
        Write-Warning "Failed to create startup shortcut: $_"
    }
}

Write-Host "`nSetup completed successfully!"
Write-Host "You can run the bot manually using: npm run cli start"
Write-Host "Or run the interactive CLI tools using: npm run cli"
