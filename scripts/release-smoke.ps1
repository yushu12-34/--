param(
  [switch]$SkipIsolatedTokenCheck
)

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

function Invoke-HttpCheck {
  param(
    [string]$Url,
    [string]$Method = "GET",
    [hashtable]$Headers = @{}
  )

  try {
    $parameters = @{
      Uri = $Url
      Method = $Method
      UseBasicParsing = $true
      TimeoutSec = 15
    }
    if ($Headers.Count -gt 0) {
      $parameters.Headers = $Headers
    }
    $response = Invoke-WebRequest @parameters
    return @{
      StatusCode = [int]$response.StatusCode
      Content = [string]$response.Content
      Headers = $response.Headers
    }
  } catch {
    $statusCode = 0
    $content = ""
    $responseHeaders = @{}
    if ($_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      $responseHeaders = $_.Exception.Response.Headers
      $stream = $_.Exception.Response.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        try {
          $content = $reader.ReadToEnd()
        } finally {
          $reader.Dispose()
        }
      }
    }
    return @{
      StatusCode = $statusCode
      Content = $content
      Headers = $responseHeaders
      Error = $_.Exception.Message
    }
  }
}

function Assert-SuccessStatus {
  param(
    [hashtable]$Response,
    [string]$Name
  )

  if ($Response.StatusCode -lt 200 -or $Response.StatusCode -ge 300) {
    throw "$Name returned HTTP $($Response.StatusCode). $($Response.Content)"
  }
}

function Convert-JsonContent {
  param(
    [string]$Name,
    [string]$Content
  )

  try {
    return $Content | ConvertFrom-Json
  } catch {
    throw "$Name did not return valid JSON. $($_.Exception.Message)"
  }
}

function Assert-HasProperties {
  param(
    [object]$Value,
    [string]$Name,
    [string[]]$Properties
  )

  if ($null -eq $Value) {
    throw "$Name is null."
  }

  $actual = @($Value.PSObject.Properties.Name)
  foreach ($property in $Properties) {
    if ($actual -notcontains $property) {
      throw "$Name is missing property '$property'."
    }
  }
}

function Get-InternalHeaders {
  param([string]$Token)

  if ($Token) {
    return @{ authorization = "Bearer $Token" }
  }
  return @{}
}

function Assert-NoProviderSecrets {
  param([object[]]$Providers)

  $forbidden = @("secretValue", "encryptedSecret", "secret")
  foreach ($provider in $Providers) {
    $keys = @($provider.PSObject.Properties.Name)
    $matches = @($keys | Where-Object { $forbidden -contains $_ })
    if ($matches.Count -gt 0) {
      throw "Internal provider response exposes secret fields: $($matches -join ', ')"
    }
  }
}

function Assert-TaskEnrichmentShape {
  param([object[]]$Tasks)

  if ($Tasks.Count -eq 0) {
    Write-Host "No tasks found; task detail smoke skipped."
    return
  }

  $firstTask = $Tasks[0]
  Assert-HasProperties -Value $firstTask -Name "GET /internal/tasks first task" -Properties @(
    "id",
    "status",
    "modelDisplayName",
    "providerName",
    "inputSummary"
  )
}

function Assert-SystemEventPayload {
  param(
    [object]$Payload,
    [string]$Name
  )

  Assert-HasProperties -Value $Payload -Name $Name -Properties @("events", "summary")
  Assert-HasProperties -Value $Payload.summary -Name "$Name summary" -Properties @("total", "byLevel", "byCategory", "latestErrorAt", "latestWarningAt")
  Assert-HasProperties -Value $Payload.summary.byLevel -Name "$Name summary.byLevel" -Properties @("info", "warning", "error")
  Assert-HasProperties -Value $Payload.summary.byCategory -Name "$Name summary.byCategory" -Properties @("system", "api", "security", "task", "model", "backup")

  $events = @($Payload.events)
  if ([int]$Payload.summary.total -lt $events.Count) {
    throw "$Name summary total is smaller than returned events count."
  }

  foreach ($event in $events) {
    Assert-HasProperties -Value $event -Name "$Name event" -Properties @("id", "level", "category", "source", "message", "createdAt")
  }
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Remove-TempDirectory {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path $Path)) {
    return
  }

  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $targetPath = [System.IO.Path]::GetFullPath($Path)
  $leaf = Split-Path -Leaf $targetPath
  if (-not $targetPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not $leaf.StartsWith("anime-canvas-smoke-")) {
    throw "Refusing to remove unexpected temporary directory: $targetPath"
  }

  Remove-Item -LiteralPath $targetPath -Recurse -Force
}

$envValues = Read-EnvFile
$apiPort = Get-Setting -EnvValues $envValues -Name "API_PORT" -DefaultValue "8787"
$webPort = Get-Setting -EnvValues $envValues -Name "WEB_PORT" -DefaultValue "5180"
$adminPort = Get-Setting -EnvValues $envValues -Name "ADMIN_PORT" -DefaultValue "5190"
$internalToken = Get-Setting -EnvValues $envValues -Name "INTERNAL_ADMIN_TOKEN" -DefaultValue ""
$apiBaseUrl = "http://127.0.0.1:$apiPort"
$webBaseUrl = "http://127.0.0.1:$webPort"
$adminBaseUrl = "http://127.0.0.1:$adminPort"
$internalHeaders = Get-InternalHeaders -Token $internalToken

Invoke-Step "Release candidate service smoke" {
  $apiHealth = Invoke-HttpCheck -Url "$apiBaseUrl/api/health"
  Assert-SuccessStatus -Response $apiHealth -Name "GET /api/health"
  $healthPayload = Convert-JsonContent -Name "GET /api/health" -Content $apiHealth.Content
  if ($healthPayload.ok -ne $true) {
    throw "GET /api/health returned ok=false."
  }

  $web = Invoke-HttpCheck -Url "$webBaseUrl/"
  Assert-SuccessStatus -Response $web -Name "GET customer web"
  if (-not $web.Content.Contains("root")) {
    throw "Customer web response does not contain root mount."
  }

  $admin = Invoke-HttpCheck -Url "$adminBaseUrl/"
  Assert-SuccessStatus -Response $admin -Name "GET admin web"
  if (-not $admin.Content.Contains("root")) {
    throw "Admin web response does not contain root mount."
  }

  Write-Host "API, customer web and admin web are reachable"
}

Invoke-Step "Customer public model contract" {
  $response = Invoke-HttpCheck -Url "$apiBaseUrl/api/models"
  Assert-SuccessStatus -Response $response -Name "GET /api/models"
  $payload = Convert-JsonContent -Name "GET /api/models" -Content $response.Content
  Assert-HasProperties -Value $payload -Name "GET /api/models" -Properties @("models")
  $models = @($payload.models)

  foreach ($model in $models) {
    Assert-HasProperties -Value $model -Name "public model" -Properties @("id", "displayName", "type", "capabilities", "publicParamSchema", "defaultPublicParams", "enabled")
  }

  Write-Host "Public model contract returned $($models.Count) model(s)"
}

Invoke-Step "Admin internal read contracts" {
  $providersResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/providers" -Headers $internalHeaders
  Assert-SuccessStatus -Response $providersResponse -Name "GET /internal/providers"
  $providersPayload = Convert-JsonContent -Name "GET /internal/providers" -Content $providersResponse.Content
  Assert-HasProperties -Value $providersPayload -Name "GET /internal/providers" -Properties @("providers")
  Assert-NoProviderSecrets -Providers @($providersPayload.providers)

  $modelsResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/models" -Headers $internalHeaders
  Assert-SuccessStatus -Response $modelsResponse -Name "GET /internal/models"
  $modelsPayload = Convert-JsonContent -Name "GET /internal/models" -Content $modelsResponse.Content
  Assert-HasProperties -Value $modelsPayload -Name "GET /internal/models" -Properties @("models")

  $tasksResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/tasks" -Headers $internalHeaders
  Assert-SuccessStatus -Response $tasksResponse -Name "GET /internal/tasks"
  $tasksPayload = Convert-JsonContent -Name "GET /internal/tasks" -Content $tasksResponse.Content
  Assert-HasProperties -Value $tasksPayload -Name "GET /internal/tasks" -Properties @("tasks")
  $tasks = @($tasksPayload.tasks)
  Assert-TaskEnrichmentShape -Tasks $tasks

  if ($tasks.Count -gt 0) {
    $taskId = [uri]::EscapeDataString([string]$tasks[0].id)
    $taskDetailResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/tasks/$taskId" -Headers $internalHeaders
    Assert-SuccessStatus -Response $taskDetailResponse -Name "GET /internal/tasks/:taskId"
    $taskDetailPayload = Convert-JsonContent -Name "GET /internal/tasks/:taskId" -Content $taskDetailResponse.Content
    Assert-HasProperties -Value $taskDetailPayload -Name "GET /internal/tasks/:taskId" -Properties @("task")
    Assert-TaskEnrichmentShape -Tasks @($taskDetailPayload.task)
  }

  Write-Host "Admin contracts returned $(@($providersPayload.providers).Count) provider(s), $(@($modelsPayload.models).Count) model(s), $($tasks.Count) task(s)"
}

Invoke-Step "Runtime log contract" {
  $eventsResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/system-events?limit=20" -Headers $internalHeaders
  Assert-SuccessStatus -Response $eventsResponse -Name "GET /internal/system-events"
  $eventsPayload = Convert-JsonContent -Name "GET /internal/system-events" -Content $eventsResponse.Content
  Assert-SystemEventPayload -Payload $eventsPayload -Name "GET /internal/system-events"

  $infoResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/system-events?level=info&limit=10" -Headers $internalHeaders
  Assert-SuccessStatus -Response $infoResponse -Name "GET /internal/system-events?level=info"
  $infoPayload = Convert-JsonContent -Name "GET /internal/system-events?level=info" -Content $infoResponse.Content
  foreach ($event in @($infoPayload.events)) {
    if ($event.level -ne "info") {
      throw "Level filter returned non-info event '$($event.id)'."
    }
  }

  $systemResponse = Invoke-HttpCheck -Url "$apiBaseUrl/internal/system-events?category=system&limit=10" -Headers $internalHeaders
  Assert-SuccessStatus -Response $systemResponse -Name "GET /internal/system-events?category=system"
  $systemPayload = Convert-JsonContent -Name "GET /internal/system-events?category=system" -Content $systemResponse.Content
  foreach ($event in @($systemPayload.events)) {
    if ($event.category -ne "system") {
      throw "Category filter returned non-system event '$($event.id)'."
    }
  }

  Write-Host "Runtime log contract returned $(@($eventsPayload.events).Count) event(s)"
}

Invoke-Step "Customer admin route guard source" {
  $appSource = Get-Content (Join-Path $root "apps\web\src\App.tsx") -Encoding UTF8 -Raw
  if (-not $appSource.Contains("window.location.pathname.startsWith(""/admin"")")) {
    throw "Customer App.tsx no longer contains the /admin route guard."
  }
  if ($appSource.Contains("AdminPage")) {
    throw "Customer App.tsx should not import or render AdminPage."
  }
  Write-Host "Customer /admin route guard is present in source"
}

if (-not $SkipIsolatedTokenCheck) {
  Invoke-Step "Isolated token and security log smoke" {
    $nodeCommand = (Get-Command node -ErrorAction Stop).Source
    $token = "release-smoke-token"
    $tempData = Join-Path ([System.IO.Path]::GetTempPath()) ("anime-canvas-smoke-" + [guid]::NewGuid().ToString("N"))
    $tempPort = Get-FreeTcpPort
    $stdout = Join-Path $tempData "api.out.log"
    $stderr = Join-Path $tempData "api.err.log"
    New-Item -ItemType Directory -Force -Path $tempData | Out-Null

    $previousApiPort = $env:API_PORT
    $previousDataDir = $env:DATA_DIR
    $previousToken = $env:INTERNAL_ADMIN_TOKEN
    $process = $null

    try {
      $env:API_PORT = [string]$tempPort
      $env:DATA_DIR = $tempData
      $env:INTERNAL_ADMIN_TOKEN = $token

      $process = Start-Process `
        -FilePath $nodeCommand `
        -ArgumentList @("src/server.js") `
        -WorkingDirectory (Join-Path $root "apps\api") `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr

      $ready = $false
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($process.HasExited) {
          break
        }
        $health = Invoke-HttpCheck -Url "http://127.0.0.1:$tempPort/api/health"
        if ($health.StatusCode -eq 200) {
          $ready = $true
          break
        }
        Start-Sleep -Milliseconds 300
      }

      if (-not $ready) {
        $outTail = if (Test-Path $stdout) { Get-Content $stdout -Tail 30 } else { @() }
        $errTail = if (Test-Path $stderr) { Get-Content $stderr -Tail 30 } else { @() }
        throw "Temporary API did not become ready on port $tempPort.`nSTDOUT:`n$($outTail -join "`n")`nSTDERR:`n$($errTail -join "`n")"
      }

      $unauthorized = Invoke-HttpCheck -Url "http://127.0.0.1:$tempPort/internal/providers"
      if ($unauthorized.StatusCode -ne 401) {
        throw "Temporary internal endpoint without token should return 401, got HTTP $($unauthorized.StatusCode)."
      }

      $headers = @{ authorization = "Bearer $token" }
      $authorized = Invoke-HttpCheck -Url "http://127.0.0.1:$tempPort/internal/providers" -Headers $headers
      Assert-SuccessStatus -Response $authorized -Name "Temporary authorized GET /internal/providers"

      $eventsResponse = Invoke-HttpCheck -Url "http://127.0.0.1:$tempPort/internal/system-events" -Headers $headers
      Assert-SuccessStatus -Response $eventsResponse -Name "Temporary GET /internal/system-events"
      $eventsPayload = Convert-JsonContent -Name "Temporary GET /internal/system-events" -Content $eventsResponse.Content
      Assert-SystemEventPayload -Payload $eventsPayload -Name "Temporary GET /internal/system-events"

      $securityEvents = @($eventsPayload.events | Where-Object { $_.level -eq "warning" -and $_.category -eq "security" })
      if ($securityEvents.Count -lt 1) {
        throw "Temporary API did not record a security warning after unauthorized internal access."
      }

      Write-Host "Temporary API recorded $($securityEvents.Count) security warning event(s)"
    } finally {
      if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      }
      $env:API_PORT = $previousApiPort
      $env:DATA_DIR = $previousDataDir
      $env:INTERNAL_ADMIN_TOKEN = $previousToken
      Remove-TempDirectory -Path $tempData
    }
  }
}

Write-Host ""
Write-Host "Release candidate smoke passed."
