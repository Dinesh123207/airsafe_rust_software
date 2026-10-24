# Starts the whole AIRSAFE stack (PostgreSQL, local chain, API + web app) with Docker Desktop.
# Run from PowerShell:   .\scripts\start-windows.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail 'Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ , start it, then run this script again.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Fail 'Docker is installed but not running. Start Docker Desktop, wait until it shows "running", then run this script again.'
}

Write-Host 'Building and starting AIRSAFE. The first build downloads the Rust and Node images and can take 10-25 minutes.' -ForegroundColor Cyan
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
  Fail 'docker compose failed. Read the error above; docs/HARDWARE_BRINGUP.md (Troubleshooting) lists what to send if the build stops.'
}

Write-Host 'Waiting for the API' -NoNewline
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:8000/api/health' -TimeoutSec 3
    if ($h.ok) { $ready = $true; break }
  } catch { }
  Write-Host '.' -NoNewline
  Start-Sleep -Seconds 2
}
Write-Host ''
if (-not $ready) { Fail 'The API did not become ready. Run:  docker compose logs api db' }

$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress)
Write-Host ''
Write-Host 'AIRSAFE is running.' -ForegroundColor Green
Write-Host '  Web app on this PC : http://localhost:8000'
foreach ($ip in $ips) { Write-Host "  From other devices : http://${ip}:8000   (the ESP32 uses this address)" }
Write-Host ''
Write-Host 'Next: register an account in the web app, then run (once, as Administrator):  .\scripts\open-firewall.ps1'
Write-Host 'Then:  node tools/connect_hardware.mjs setup --email you@example.com --password YOURPASSWORD --room iso1 --wifi-ssid YOURWIFI --wifi-pass YOURWIFIPASSWORD --sign'
Start-Process 'http://localhost:8000'
