param(
  [switch]$RequireInternalToken
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
    $headers = @{}
    if ($_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      $headers = $_.Exception.Response.Headers
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
      Headers = $headers
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

function Find-ForbiddenKeys {
  param(
    [object]$Value,
    [string]$Path,
    [string[]]$ForbiddenKeys
  )

  $matches = @()
  if ($null -eq $Value) {
    return $matches
  }
  if ($Value -is [string] -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    return $matches
  }
  if ($Value -is [System.Collections.IDictionary]) {
    foreach ($key in $Value.Keys) {
      $childPath = if ($Path) { "$Path.$key" } else { "$key" }
      if ($ForbiddenKeys -contains [string]$key) {
        $matches += $childPath
      }
      $matches += Find-ForbiddenKeys -Value $Value[$key] -Path $childPath -ForbiddenKeys $ForbiddenKeys
    }
    return $matches
  }
  if ($Value -is [System.Collections.IEnumerable]) {
    $index = 0
    foreach ($item in $Value) {
      $matches += Find-ForbiddenKeys -Value $item -Path "${Path}[$index]" -ForbiddenKeys $ForbiddenKeys
      $index += 1
    }
    return $matches
  }

  foreach ($property in $Value.PSObject.Properties) {
    $childPath = if ($Path) { "$Path.$($property.Name)" } else { $property.Name }
    if ($ForbiddenKeys -contains [string]$property.Name) {
      $matches += $childPath
    }
    $matches += Find-ForbiddenKeys -Value $property.Value -Path $childPath -ForbiddenKeys $ForbiddenKeys
  }
  return $matches
}

function Assert-NoForbiddenPatterns {
  param(
    [string]$Name,
    [string]$Path,
    [string[]]$Patterns
  )

  if (-not (Test-Path $Path)) {
    Write-Host "$Name path not found, skipped: $Path"
    return
  }

  $extensions = @(".ts", ".tsx", ".js", ".jsx", ".html", ".css")
  $violations = @()
  Get-ChildItem -Path $Path -Recurse -File | Where-Object { $extensions -contains $_.Extension } | ForEach-Object {
    $content = Get-Content $_.FullName -Encoding UTF8 -Raw
    foreach ($pattern in $Patterns) {
      if ($content.Contains($pattern)) {
        $relativePath = Resolve-Path -Path $_.FullName -Relative
        $violations += "$relativePath contains '$pattern'"
      }
    }
  }

  if ($violations.Count -gt 0) {
    throw "$Name contains internal API or token references:`n$($violations -join "`n")"
  }
  Write-Host "$Name has no internal API or token references"
}

$envValues = Read-EnvFile
$apiPort = Get-Setting -EnvValues $envValues -Name "API_PORT" -DefaultValue "8787"
$internalToken = Get-Setting -EnvValues $envValues -Name "INTERNAL_ADMIN_TOKEN" -DefaultValue ""
$apiBaseUrl = "http://127.0.0.1:$apiPort"

Invoke-Step "Public model API sanitization" {
  $response = Invoke-HttpCheck -Url "$apiBaseUrl/api/models"
  Assert-SuccessStatus -Response $response -Name "GET /api/models"
  $payload = Convert-JsonContent -Name "GET /api/models" -Content $response.Content
  if ($null -eq $payload.models) {
    throw "GET /api/models response is missing models array."
  }

  $allowedTopLevelKeys = @("id", "displayName", "type", "capabilities", "publicParamSchema", "defaultPublicParams", "enabled")
  $forbiddenKeys = @(
    "providerId",
    "name",
    "baseUrl",
    "secretValue",
    "encryptedSecret",
    "secret",
    "secretStorage",
    "adapter",
    "requestTemplate",
    "bodyTemplate",
    "submitTemplate",
    "pollingTemplate",
    "pollBodyTemplate",
    "pollTemplate",
    "taskPathTemplate",
    "taskIdPath",
    "statusPath",
    "resultPath",
    "b64Path",
    "base64Path",
    "imageUrlPath",
    "errorPath",
    "defaultParams",
    "paramSchema",
    "allowMockFallback",
    "sortOrder",
    "publicVisible"
  )

  $models = @($payload.models)
  foreach ($model in $models) {
    $unexpectedKeys = @($model.PSObject.Properties.Name | Where-Object { $allowedTopLevelKeys -notcontains $_ })
    if ($unexpectedKeys.Count -gt 0) {
      throw "Public model '$($model.id)' contains unexpected top-level keys: $($unexpectedKeys -join ', ')"
    }
  }

  $forbiddenMatches = Find-ForbiddenKeys -Value $payload.models -Path "models" -ForbiddenKeys $forbiddenKeys
  if ($forbiddenMatches.Count -gt 0) {
    throw "GET /api/models exposes internal fields:`n$($forbiddenMatches -join "`n")"
  }

  Write-Host "GET /api/models returned $($models.Count) sanitized model(s)"
}

Invoke-Step "Internal endpoint authorization" {
  $internalUrl = "$apiBaseUrl/internal/providers"
  $legacyInternalUrl = "$apiBaseUrl/api/admin/providers"

  $optionsResponse = Invoke-HttpCheck -Url $internalUrl -Method "OPTIONS"
  if ($optionsResponse.StatusCode -ne 204) {
    throw "OPTIONS /internal/providers returned HTTP $($optionsResponse.StatusCode)."
  }
  $allowedHeaders = [string]$optionsResponse.Headers["access-control-allow-headers"]
  if (-not $allowedHeaders.ToLowerInvariant().Contains("authorization")) {
    throw "OPTIONS /internal/providers does not allow Authorization header."
  }

  $unauthorizedInternal = Invoke-HttpCheck -Url $internalUrl
  $unauthorizedLegacy = Invoke-HttpCheck -Url $legacyInternalUrl

  if ($internalToken) {
    if ($unauthorizedInternal.StatusCode -ne 401) {
      throw "GET /internal/providers without token should return 401 when INTERNAL_ADMIN_TOKEN is configured, got HTTP $($unauthorizedInternal.StatusCode). Restart local services after changing .env."
    }
    if ($unauthorizedLegacy.StatusCode -ne 401) {
      throw "GET /api/admin/providers without token should return 401 when INTERNAL_ADMIN_TOKEN is configured, got HTTP $($unauthorizedLegacy.StatusCode)."
    }

    $headers = @{ authorization = "Bearer $internalToken" }
    $authorizedInternal = Invoke-HttpCheck -Url $internalUrl -Headers $headers
    $authorizedLegacy = Invoke-HttpCheck -Url $legacyInternalUrl -Headers $headers
    Assert-SuccessStatus -Response $authorizedInternal -Name "Authorized GET /internal/providers"
    Assert-SuccessStatus -Response $authorizedLegacy -Name "Authorized GET /api/admin/providers"
    Write-Host "Internal endpoints reject missing token and accept configured token"
  } else {
    if ($RequireInternalToken) {
      throw "INTERNAL_ADMIN_TOKEN is required for release security preflight."
    }
    Assert-SuccessStatus -Response $unauthorizedInternal -Name "Local fallback GET /internal/providers"
    Assert-SuccessStatus -Response $unauthorizedLegacy -Name "Local fallback GET /api/admin/providers"
    Write-Host "WARN  INTERNAL_ADMIN_TOKEN is not configured; localhost fallback is active. Configure a token before release."
  }
}

Invoke-Step "Customer web bundle isolation" {
  $patterns = @(
    "VITE_INTERNAL_API_BASE_URL",
    "VITE_INTERNAL_ADMIN_TOKEN",
    "INTERNAL_ADMIN_TOKEN",
    "x-internal-admin-token",
    "/internal",
    "/api/admin"
  )

  Assert-NoForbiddenPatterns -Name "apps/web/src" -Path (Join-Path $root "apps\web\src") -Patterns $patterns
  Assert-NoForbiddenPatterns -Name "apps/web/dist" -Path (Join-Path $root "apps\web\dist") -Patterns $patterns
}

Write-Host ""
Write-Host "Security preflight passed."
