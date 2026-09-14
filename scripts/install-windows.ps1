# Install Hive as a Windows scheduled task (starts at logon, auto-restarts).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\src\index.js`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName "HiveAgent" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Hive personal AI agent" -Force | Out-Null

Write-Host "Installed scheduled task 'HiveAgent' (starts at logon)."
Write-Host "  Start now : Start-ScheduledTask HiveAgent"
Write-Host "  Stop      : Stop-ScheduledTask  HiveAgent"
Write-Host "  Remove    : Unregister-ScheduledTask HiveAgent"
Write-Host "  Logs      : see console / Agent_Logs in your vault"
