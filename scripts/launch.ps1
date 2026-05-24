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

if (Test-Web2SvgServer) {
  if (Test-Path (Join-Path $root "dist\open-panel.js")) {
    Start-Process `
      -FilePath "node.exe" `
      -ArgumentList @((Join-Path $root "dist\open-panel.js"), $url) `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $root "logs\panel.out.log") `
      -RedirectStandardError (Join-Path $root "logs\panel.err.log")
  } else {
    Start-Process $url
  }
  return
}

if (-not (Test-Path "node_modules")) {
  corepack pnpm install
}

New-Item -ItemType Directory -Path "logs" -Force | Out-Null

$env:WEB2SVG_NO_AUTO_OPEN = "1"
Start-Process `
  -FilePath "corepack.cmd" `
  -ArgumentList @("pnpm", "app") `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root "logs\server.out.log") `
  -RedirectStandardError (Join-Path $root "logs\server.err.log")

for ($i = 0; $i -lt 40; $i += 1) {
  if (Test-Web2SvgServer) {
    Start-Process `
      -FilePath "node.exe" `
      -ArgumentList @((Join-Path $root "dist\open-panel.js"), $url) `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $root "logs\panel.out.log") `
      -RedirectStandardError (Join-Path $root "logs\panel.err.log")
    return
  }
  Start-Sleep -Milliseconds 500
}

Write-Host "Web2SVG server could not start. Check logs\server.err.log"
Read-Host "Press Enter to close"
