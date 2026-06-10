$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (Test-Path "$root\.env") {
  Get-Content "$root\.env" -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $key, $value = $line.Split("=", 2)
      [Environment]::SetEnvironmentVariable($key.Trim(), $value.Trim(), "Process")
    }
  }
}

$env:API_PORT = if ($env:API_PORT) { $env:API_PORT } else { "8787" }
$env:WEB_PORT = if ($env:WEB_PORT) { $env:WEB_PORT } else { "5180" }
$env:ADMIN_PORT = if ($env:ADMIN_PORT) { $env:ADMIN_PORT } else { "5190" }
$env:DATA_DIR = if ($env:DATA_DIR) { $env:DATA_DIR } else { "$root\data" }
if (-not [System.IO.Path]::IsPathRooted($env:DATA_DIR)) {
  $env:DATA_DIR = Join-Path $root $env:DATA_DIR
}
$env:VITE_API_BASE_URL = if ($env:VITE_API_BASE_URL) { $env:VITE_API_BASE_URL } else { "http://localhost:$($env:API_PORT)/api" }
$env:VITE_INTERNAL_API_BASE_URL = if ($env:VITE_INTERNAL_API_BASE_URL) { $env:VITE_INTERNAL_API_BASE_URL } else { "/internal" }
$env:VITE_INTERNAL_ADMIN_TOKEN = if ($env:VITE_INTERNAL_ADMIN_TOKEN) { $env:VITE_INTERNAL_ADMIN_TOKEN } else { $env:INTERNAL_ADMIN_TOKEN }

if (-not (Test-Path "$root\apps\web\node_modules")) {
  Write-Host "Frontend dependencies missing, running setup..."
  & "$PSScriptRoot\setup-local.ps1"
}

$logDir = "$root\.local\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$apiOut = "$logDir\api.out.log"
$apiErr = "$logDir\api.err.log"
$webOut = "$logDir\web.out.log"
$webErr = "$logDir\web.err.log"
$adminOut = "$logDir\admin.out.log"
$adminErr = "$logDir\admin.err.log"
$npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCommand) {
  $npmCommand = (Get-Command npm -ErrorAction Stop).Source
}

function Start-LocalService {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$Command,
    [string]$Arguments,
    [string]$StdOut,
    [string]$StdErr
  )

  $script = @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath "$WorkingDirectory"
& "$Command" $Arguments
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  Write-Host "Starting $Name"
  return Start-Process `
    -FilePath "powershell" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdOut `
    -RedirectStandardError $StdErr
}

$apiProcess = Start-LocalService `
  -Name "API on http://localhost:$($env:API_PORT)" `
  -WorkingDirectory "$root\apps\api" `
  -Command $npmCommand `
  -Arguments "run dev" `
  -StdOut $apiOut `
  -StdErr $apiErr

$webProcess = Start-LocalService `
  -Name "Web on http://localhost:$($env:WEB_PORT)" `
  -WorkingDirectory "$root\apps\web" `
  -Command $npmCommand `
  -Arguments "run dev -- --port $($env:WEB_PORT)" `
  -StdOut $webOut `
  -StdErr $webErr

$adminProcess = Start-LocalService `
  -Name "Admin on http://localhost:$($env:ADMIN_PORT)" `
  -WorkingDirectory "$root\apps\admin" `
  -Command $npmCommand `
  -Arguments "run dev -- --port $($env:ADMIN_PORT)" `
  -StdOut $adminOut `
  -StdErr $adminErr

$stateDir = "$root\.local"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  api = $apiProcess.Id
  web = $webProcess.Id
  admin = $adminProcess.Id
  apiPort = $env:API_PORT
  webPort = $env:WEB_PORT
  adminPort = $env:ADMIN_PORT
} | ConvertTo-Json | Set-Content "$stateDir\pids.json" -Encoding UTF8

Write-Host ""
Write-Host "Local services started."
Write-Host "Canvas: http://localhost:$($env:WEB_PORT)"
Write-Host "Admin : http://localhost:$($env:ADMIN_PORT)"
Write-Host "API   : http://localhost:$($env:API_PORT)/api/health"
Write-Host ""
Write-Host "Logs  : $logDir"
Write-Host "Stop  : npm run stop"
