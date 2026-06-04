$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Please install Node.js 20+ and run npm run setup again."
}

$nodeVersion = node -v
Write-Host "Node.js: $nodeVersion"

Write-Host "Installing API dependencies..."
Push-Location "$root\apps\api"
npm install
Pop-Location

Write-Host "Installing Web dependencies..."
Push-Location "$root\apps\web"
npm install
Pop-Location

if (-not (Test-Path "$root\.env")) {
  Copy-Item "$root\.env.example" "$root\.env"
  Write-Host "Created .env from .env.example"
}

Write-Host "Local environment is ready."
