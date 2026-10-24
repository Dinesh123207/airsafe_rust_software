# Lets the ESP32 (and your phone) reach the AIRSAFE API on this PC. Run ONCE as Administrator:
#   right-click PowerShell -> "Run as administrator", then   .\scripts\open-firewall.ps1
# Add -IncludePublic only if your WiFi is classed as a Public network (less safe; prefer switching the network to Private).
param([switch]$IncludePublic)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this script as Administrator (right-click PowerShell -> Run as administrator).' -ForegroundColor Red
  exit 1
}

$name = 'AIRSAFE API (port 8000)'
if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
  Write-Host 'The firewall rule already exists. Nothing to do.' -ForegroundColor Green
} else {
  $profiles = 'Private,Domain'
  if ($IncludePublic) { $profiles = 'Private,Domain,Public' }
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile $profiles | Out-Null
  Write-Host "Firewall rule created for profiles: $profiles" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Your current network profile(s):'
Get-NetConnectionProfile | ForEach-Object { Write-Host ('  {0}: {1}' -f $_.Name, $_.NetworkCategory) }
Write-Host 'If your WiFi shows Public, the rule above will not apply: Settings -> Network & Internet -> WiFi -> your network -> set Network profile to Private.'
Write-Host 'Test from a phone on the same WiFi:  http://<this PC IP>:8000/api/health   must show {"ok":true,...}'
