$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$url = "http://127.0.0.1:4782"

function Test-Web2SvgServer {
  try {
    Invoke-WebRequest -Uri "$url/api/status" -UseBasicParsing -TimeoutSec 1 | Out-Null
    return $true
  } catch {
    return $false
  }
}

Set-Location $root

Write-Host ""
Write-Host "Web2SVG Server"
Write-Host "Close this window to stop the server."
Write-Host ""

$existing = Get-NetTCPConnection -LocalPort 4782 -State Listen -ErrorAction SilentlyContinue
foreach ($connection in $existing) {
  Write-Host "Stopping previous Web2SVG server process $($connection.OwningProcess)..."
  Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path "node_modules")) {
  corepack pnpm install
}

New-Item -ItemType Directory -Path "logs" -Force | Out-Null

$env:WEB2SVG_NO_AUTO_OPEN = "0"
corepack pnpm app
