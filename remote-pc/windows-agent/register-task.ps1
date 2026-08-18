# Registers the remote-pc windows-agent to start automatically at logon.
# Run this once, interactively, as the user that will be logged in when the
# PC wakes (an elevated PowerShell prompt is recommended: Run as Administrator).
#
# Usage: powershell -ExecutionPolicy Bypass -File register-task.ps1

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "agent.py"
$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue)
$exe = if ($pythonw) { $pythonw.Source } else { "python.exe" }

$action = New-ScheduledTaskAction -Execute $exe -Argument "`"$scriptPath`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "RemotePCAgent" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force

Write-Host "Scheduled task 'RemotePCAgent' registered."
Write-Host "It will run '$exe $scriptPath' automatically at your next logon."
Write-Host ""
Write-Host "Reminder: create windows-agent\config.json from config.example.json before logging in again,"
Write-Host "and open a firewall rule restricted to the Tailscale range (100.64.0.0/10), e.g.:"
Write-Host '  New-NetFirewallRule -DisplayName "RemotePCAgent" -Direction Inbound -Protocol TCP -LocalPort 8788 -RemoteAddress 100.64.0.0/10 -Action Allow'
