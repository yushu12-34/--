$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$pidFile = "$root\.local\pids.json"

function Stop-ProcessTree {
  param([int]$ProcessId)

  if (-not $ProcessId) {
    return
  }

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId"
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }

  Stop-Process -Id $ProcessId -Force
  Write-Host "Stopped process $ProcessId"
}

function Stop-PortOwner {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen
  foreach ($connection in $connections) {
    Stop-ProcessTree -ProcessId $connection.OwningProcess
  }

  $netstatRows = netstat -ano | Select-String -Pattern ":$Port\s+.*LISTENING\s+(\d+)"
  foreach ($row in $netstatRows) {
    if ($row.Matches.Count -gt 0) {
      $owner = [int]$row.Matches[0].Groups[1].Value
      Stop-ProcessTree -ProcessId $owner
    }
  }
}

function Read-LocalPorts {
  $ports = @{
    api = 8787
    web = 5180
  }

  $envFile = "$root\.env"
  if (Test-Path $envFile) {
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
      $line = $_.Trim()
      if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $key, $value = $line.Split("=", 2)
        if ($key.Trim() -eq "API_PORT") { $ports.api = [int]$value.Trim() }
        if ($key.Trim() -eq "WEB_PORT") { $ports.web = [int]$value.Trim() }
      }
    }
  }

  return $ports
}

if (Test-Path $pidFile) {
  $pids = Get-Content $pidFile -Raw | ConvertFrom-Json
  foreach ($processId in @($pids.api, $pids.web)) {
    Stop-ProcessTree -ProcessId $processId
  }
  Remove-Item $pidFile -Force
} else {
  Write-Host "No local pid file found. Falling back to port cleanup."
}

$ports = Read-LocalPorts
Stop-PortOwner -Port $ports.api
Stop-PortOwner -Port $ports.web

Write-Host "Local services stopped."
