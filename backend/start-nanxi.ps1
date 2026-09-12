$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = Join-Path $root 'desktop'

function Test-Port($port) {
  try { return (Test-NetConnection 127.0.0.1 -Port $port -InformationLevel Quiet) } catch { return $false }
}

if (-not (Test-Port 8000)) {
  Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy Bypass", "-Command", "Set-Location '$root'; python -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
  Start-Sleep -Seconds 2
}

if (-not (Test-Path (Join-Path $desktop 'node_modules'))) {
  Start-Process powershell -Wait -ArgumentList "-NoExit", "-ExecutionPolicy Bypass", "-Command", "Set-Location '$desktop'; npm install"
}

Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy Bypass", "-Command", "Set-Location '$desktop'; npm start"
