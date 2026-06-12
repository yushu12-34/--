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

function Normalize-ProcessPathEnvironment {
  $pathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  $upperPathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  if (-not $pathValue -and $upperPathValue) {
    $pathValue = $upperPathValue
  }
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  if ($pathValue) {
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
    $env:Path = $pathValue
  }
}

Normalize-ProcessPathEnvironment

Get-ChildItem Env:npm_* | ForEach-Object {
  [Environment]::SetEnvironmentVariable($_.Name, $null, "Process")
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
$nodeCommand = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeCommand) {
  $nodeCommand = (Get-Command node -ErrorAction Stop).Source
}
$viteCli = "$root\apps\web\node_modules\vite\bin\vite.js"

function Start-LocalService {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$Command,
    [string[]]$Arguments,
    [string]$StdOut,
    [string]$StdErr
  )

  Write-Host "Starting $Name"
  return Start-Process `
    -FilePath $Command `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdOut `
    -RedirectStandardError $StdErr
}

function Wait-HttpEndpoint {
  param(
    [string]$Name,
    [string]$Url,
    [System.Diagnostics.Process]$Process,
    [string]$StdOut,
    [string]$StdErr,
    [string]$ExpectedText = ""
  )

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($Process.HasExited) {
      break
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        if (-not $ExpectedText -or $response.Content.Contains($ExpectedText)) {
          Write-Host "$Name ready: $Url"
          return
        }
      }
    } catch {
      Start-Sleep -Milliseconds 500
      continue
    }
    Start-Sleep -Milliseconds 500
  }

  Write-Host ""
  Write-Host "$Name failed to become ready: $Url"
  if (Test-Path $StdOut) {
    Write-Host "--- $Name stdout ---"
    Get-Content $StdOut -Tail 40
  }
  if (Test-Path $StdErr) {
    Write-Host "--- $Name stderr ---"
    Get-Content $StdErr -Tail 40
  }
  throw "$Name did not become ready. See logs in $logDir"
}

$apiProcess = Start-LocalService `
  -Name "API on http://localhost:$($env:API_PORT)" `
  -WorkingDirectory "$root\apps\api" `
  -Command $nodeCommand `
  -Arguments @("--watch", "src/server.js") `
  -StdOut $apiOut `
  -StdErr $apiErr

$webProcess = Start-LocalService `
  -Name "Web on http://localhost:$($env:WEB_PORT)" `
  -WorkingDirectory "$root\apps\web" `
  -Command $nodeCommand `
  -Arguments @($viteCli, "--host", "0.0.0.0", "--port", $env:WEB_PORT) `
  -StdOut $webOut `
  -StdErr $webErr

$adminProcess = Start-LocalService `
  -Name "Admin on http://localhost:$($env:ADMIN_PORT)" `
  -WorkingDirectory "$root\apps\admin" `
  -Command $nodeCommand `
  -Arguments @($viteCli, "--host", "0.0.0.0", "--port", $env:ADMIN_PORT) `
  -StdOut $adminOut `
  -StdErr $adminErr

Wait-HttpEndpoint `
  -Name "API" `
  -Url "http://127.0.0.1:$($env:API_PORT)/api/health" `
  -Process $apiProcess `
  -StdOut $apiOut `
  -StdErr $apiErr

Wait-HttpEndpoint `
  -Name "Web" `
  -Url "http://127.0.0.1:$($env:WEB_PORT)/" `
  -Process $webProcess `
  -StdOut $webOut `
  -StdErr $webErr `
  -ExpectedText "root"

Wait-HttpEndpoint `
  -Name "Admin" `
  -Url "http://127.0.0.1:$($env:ADMIN_PORT)/" `
  -Process $adminProcess `
  -StdOut $adminOut `
  -StdErr $adminErr `
  -ExpectedText "root"

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
