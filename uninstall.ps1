# MeshBot Windows Uninstallation Script
# Author: Antigravity

$ErrorActionPreference = "Stop"

Write-Host "--------------------------------------------------"
Write-Host "             MeshBot Windows Uninstall            "
Write-Host "--------------------------------------------------"

# 1. Remove Windows Startup shortcut
$StartupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$ShortcutPath = [System.IO.Path]::Combine($StartupFolder, "MeshBot.lnk")

if (Test-Path $ShortcutPath) {
    Write-Host "Removing startup shortcut..."
    Remove-Item $ShortcutPath -Force
    Write-Host "Successfully removed startup shortcut."
} else {
    Write-Host "No startup shortcut found to remove."
}

# 2. Offer to remove configuration files
$DeleteConfig = Read-Host "`nWould you like to delete configuration files (config.json & test_config.json)? (y/n) [n]"
if ($DeleteConfig -like "y*") {
    if (Test-Path "config.json") {
        Remove-Item "config.json" -Force
        Write-Host "Deleted config.json"
    }
    if (Test-Path "scratch/test_config.json") {
        Remove-Item "scratch/test_config.json" -Force
        Write-Host "Deleted scratch/test_config.json"
    }
}

# 3. Offer to clean up node_modules
$DeleteDeps = Read-Host "`nWould you like to delete installed dependencies (node_modules)? (y/n) [n]"
if ($DeleteDeps -like "y*") {
    if (Test-Path "node_modules") {
        Write-Host "Deleting node_modules (this may take a few moments)..."
        Remove-Item "node_modules" -Recurse -Force
        Write-Host "Deleted node_modules."
    }
}

Write-Host "`n--------------------------------------------------"
Write-Host "Uninstallation completed successfully!"
Write-Host "--------------------------------------------------"
