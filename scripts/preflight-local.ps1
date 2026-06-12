$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Read-EnvFile {
  $values = @{}
  $envFile = Join-Path $root ".env"
  if (-not (Test-Path $envFile)) {
    return $values
  }

  Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $key, $value = $line.Split("=", 2)
      $values[$key.Trim()] = $value.Trim()
    }
  }

  return $values
}

function Get-Setting {
  param(
    [hashtable]$EnvValues,
    [string]$Name,
    [string]$DefaultValue
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($processValue) {
    return $processValue
  }
  if ($EnvValues.ContainsKey($Name) -and $EnvValues[$Name]) {
    return $EnvValues[$Name]
  }
  return $DefaultValue
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Name"
  & $Action
  Write-Host "OK  $Name"
}

function Test-HttpEndpoint {
  param(
    [string]$Name,
    [string]$Url,
    [string]$ExpectedText = ""
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 15
  } catch {
    throw "$Name is not reachable at $Url. Start local services with 'npm run dev' and retry. $($_.Exception.Message)"
  }

  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
    throw "$Name returned HTTP $($response.StatusCode) at $Url."
  }

  if ($ExpectedText -and -not $response.Content.Contains($ExpectedText)) {
    throw "$Name response at $Url did not contain expected text '$ExpectedText'."
  }

  Write-Host "$Name $Url -> HTTP $($response.StatusCode)"
}

function Invoke-NpmScript {
  param([string]$ScriptName)

  $npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npmCommand) {
    $npmCommand = (Get-Command npm -ErrorAction Stop).Source
  }

  & $npmCommand run $ScriptName
  if ($LASTEXITCODE -ne 0) {
    throw "npm run $ScriptName failed with exit code $LASTEXITCODE."
  }
}

$envValues = Read-EnvFile
$apiPort = Get-Setting -EnvValues $envValues -Name "API_PORT" -DefaultValue "8787"
$webPort = Get-Setting -EnvValues $envValues -Name "WEB_PORT" -DefaultValue "5180"
$adminPort = Get-Setting -EnvValues $envValues -Name "ADMIN_PORT" -DefaultValue "5190"

Invoke-Step "Node.js runtime" {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeVersion = node -v
  Write-Host "Node: $nodeVersion ($($nodeCommand.Source))"
}

Invoke-Step "Dependency folders" {
  $requiredPaths = @(
    "apps\api\node_modules",
    "apps\web\node_modules"
  )
  foreach ($path in $requiredPaths) {
    $fullPath = Join-Path $root $path
    if (-not (Test-Path $fullPath)) {
      throw "Missing $path. Run 'npm run setup' first."
    }
    Write-Host "Found $path"
  }
}

Invoke-Step "Local service health" {
  Test-HttpEndpoint -Name "API" -Url "http://127.0.0.1:$apiPort/api/health"
  Test-HttpEndpoint -Name "Web" -Url "http://127.0.0.1:$webPort/" -ExpectedText "root"
  Test-HttpEndpoint -Name "Admin" -Url "http://127.0.0.1:$adminPort/" -ExpectedText "root"
}

Invoke-Step "Canvas benchmark" {
  Invoke-NpmScript "benchmark:canvas"
}

Invoke-Step "Workspace check" {
  Invoke-NpmScript "check"
}

Invoke-Step "Security preflight" {
  Invoke-NpmScript "security:preflight"
}

Invoke-Step "Release candidate smoke" {
  Invoke-NpmScript "smoke:release"
}

Invoke-Step "Recovery drill" {
  Invoke-NpmScript "recovery:drill"
}

Write-Host ""
Write-Host "Preflight passed."
