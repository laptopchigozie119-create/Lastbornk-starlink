$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content (Join-Path $Here "config.json") | ConvertFrom-Json
$Port = [int]$Config.port

Write-Host "`nLastbornk local captive test" -ForegroundColor Cyan
Write-Host "1. Open Windows Settings > Network & internet > Mobile hotspot."
Write-Host "2. Turn Mobile hotspot ON and connect your phone to its Wi-Fi name."
Write-Host "3. Keep this window open during the test.`n"

try {
  $Rule = Get-NetFirewallRule -DisplayName "Lastbornk Local Captive Portal" -ErrorAction SilentlyContinue
  if (-not $Rule) { New-NetFirewallRule -DisplayName "Lastbornk Local Captive Portal" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null }
  Write-Host "Windows Firewall allows TCP port $Port." -ForegroundColor Green
} catch {
  Write-Warning "Could not add the firewall rule automatically. Re-run this script as Administrator if the phone cannot open the page."
}

$HotspotIP = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "192.168.137.*" -or $_.InterfaceAlias -like "*Local Area Connection*" } | Select-Object -First 1 -ExpandProperty IPAddress
if (-not $HotspotIP) { $HotspotIP = "192.168.137.1" }
Write-Host "`nOn your phone open: http://${HotspotIP}:$Port" -ForegroundColor Yellow
Write-Host "The page will verify OTP + voucher PIN against your deployed Supabase/Lastbornk API.`n"
Set-Location $Here
node server.mjs
