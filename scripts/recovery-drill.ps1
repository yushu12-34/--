param(
  [switch]$KeepTempData
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

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
    [object]$BodyObject = $null,
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
    if ($null -ne $BodyObject) {
      $parameters.ContentType = "application/json"
      $parameters.Body = $BodyObject | ConvertTo-Json -Depth 50
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
  if (-not $targetPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not $leaf.StartsWith("anime-canvas-recovery-")) {
    throw "Refusing to remove unexpected temporary directory: $targetPath"
  }

  Remove-Item -LiteralPath $targetPath -Recurse -Force
}

function Get-JsonFile {
  param([string]$Path)
  return Get-Content $Path -Encoding UTF8 -Raw | ConvertFrom-Json
}

function Get-ProjectCount {
  param([object]$Db)
  return @($Db.projects).Count
}

function Get-CanvasPrompt {
  param(
    [object]$Db,
    [string]$CanvasId
  )

  $canvas = @($Db.canvases | Where-Object { $_.id -eq $CanvasId })[0]
  if (-not $canvas) {
    throw "Canvas $CanvasId not found in db."
  }
  $node = @($canvas.snapshot.nodes)[0]
  return [string]$node.data.prompt
}

function Assert-BackupPath {
  param(
    [string]$BackupFile,
    [string]$TempData
  )

  if (-not $BackupFile) {
    throw "Backup response did not include a file path."
  }

  $backupFullPath = [System.IO.Path]::GetFullPath($BackupFile)
  $tempFullPath = [System.IO.Path]::GetFullPath($TempData)
  if (-not $backupFullPath.StartsWith($tempFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Backup file is outside temporary DATA_DIR: $backupFullPath"
  }
  if (-not (Test-Path $backupFullPath)) {
    throw "Backup file does not exist: $backupFullPath"
  }

  return $backupFullPath
}

function New-TestSnapshot {
  param([string]$Prompt)

  $timestamp = "2026-06-11T00:00:00.000Z"
  return @{
    nodes = @(
      @{
        id = "node:prompt"
        type = "text.input"
        title = "Prompt"
        position = @{ x = 80; y = 120 }
        data = @{ prompt = $Prompt }
        runtime = @{ status = "idle" }
        createdAt = $timestamp
        updatedAt = $timestamp
      }
    )
    edges = @()
    groups = @()
    viewport = @{ x = 0; y = 0; zoom = 1 }
  }
}

function Start-TempApi {
  param(
    [string]$TempData,
    [int]$Port
  )

  $nodeCommand = (Get-Command node -ErrorAction Stop).Source
  $stdout = Join-Path $TempData "api.out.log"
  $stderr = Join-Path $TempData "api.err.log"
  $previousApiPort = $env:API_PORT
  $previousDataDir = $env:DATA_DIR
  $previousToken = $env:INTERNAL_ADMIN_TOKEN

  $env:API_PORT = [string]$Port
  $env:DATA_DIR = $TempData
  $env:INTERNAL_ADMIN_TOKEN = ""

  try {
    $process = Start-Process `
      -FilePath $nodeCommand `
      -ArgumentList @("src/server.js") `
      -WorkingDirectory (Join-Path $root "apps\api") `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr
  } finally {
    $env:API_PORT = $previousApiPort
    $env:DATA_DIR = $previousDataDir
    $env:INTERNAL_ADMIN_TOKEN = $previousToken
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($process.HasExited) {
      break
    }
    $health = Invoke-HttpCheck -Url "http://127.0.0.1:$Port/api/health"
    if ($health.StatusCode -eq 200) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 300
  }

  if (-not $ready) {
    $outTail = if (Test-Path $stdout) { Get-Content $stdout -Tail 30 } else { @() }
    $errTail = if (Test-Path $stderr) { Get-Content $stderr -Tail 30 } else { @() }
    throw "Temporary API did not become ready on port $Port.`nSTDOUT:`n$($outTail -join "`n")`nSTDERR:`n$($errTail -join "`n")"
  }

  return $process
}

function Stop-TempApi {
  param([System.Diagnostics.Process]$Process)

  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

$tempData = Join-Path ([System.IO.Path]::GetTempPath()) ("anime-canvas-recovery-" + [guid]::NewGuid().ToString("N"))
$port = Get-FreeTcpPort
$apiBaseUrl = "http://127.0.0.1:$port"
$dbFile = Join-Path $tempData "db.json"
$apiProcess = $null

try {
  New-Item -ItemType Directory -Force -Path $tempData | Out-Null
  $apiProcess = Start-TempApi -TempData $tempData -Port $port

  $script:sourceProjectId = ""
  $script:sourceCanvasId = ""
  $script:exportedBundle = $null
  $script:historyBackupFile = ""

  Invoke-Step "Create isolated project and baseline snapshot" {
    $createResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/projects" -Method "POST" -BodyObject @{
      name = "Recovery Drill Source"
      ownerId = "default-user"
    }
    Assert-SuccessStatus -Response $createResponse -Name "POST /api/projects"
    $created = Convert-JsonContent -Name "POST /api/projects" -Content $createResponse.Content
    Assert-HasProperties -Value $created -Name "created project response" -Properties @("project", "canvas")

    $script:sourceProjectId = [string]$created.project.id
    $script:sourceCanvasId = [string]$created.canvas.id
    $baselineSnapshot = New-TestSnapshot -Prompt "before history restore"

    $saveResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/canvases/$([uri]::EscapeDataString($script:sourceCanvasId))/snapshot" -Method "PUT" -BodyObject @{
      snapshot = $baselineSnapshot
    }
    Assert-SuccessStatus -Response $saveResponse -Name "PUT /api/canvases/:id/snapshot"

    $db = Get-JsonFile -Path $dbFile
    $prompt = Get-CanvasPrompt -Db $db -CanvasId $script:sourceCanvasId
    if ($prompt -ne "before history restore") {
      throw "Baseline snapshot was not saved. Prompt: $prompt"
    }
    Write-Host "Created project $script:sourceProjectId and canvas $script:sourceCanvasId"
  }

  Invoke-Step "Export project bundle" {
    $exportResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/projects/$([uri]::EscapeDataString($script:sourceProjectId))/export"
    Assert-SuccessStatus -Response $exportResponse -Name "GET /api/projects/:id/export"
    $exportPayload = Convert-JsonContent -Name "GET /api/projects/:id/export" -Content $exportResponse.Content
    Assert-HasProperties -Value $exportPayload -Name "export response" -Properties @("bundle")
    Assert-HasProperties -Value $exportPayload.bundle -Name "project bundle" -Properties @("version", "project", "canvases", "assets", "workflowUpdates", "workflowSnapshots")

    $script:exportedBundle = $exportPayload.bundle
    if (@($script:exportedBundle.canvases).Count -ne 1) {
      throw "Exported bundle should contain one canvas."
    }
    Write-Host "Exported bundle version $($script:exportedBundle.version)"
  }

  Invoke-Step "Backup failure blocks project import" {
    $blockedBackupPath = Join-Path $tempData "backups"
    Set-Content -LiteralPath $blockedBackupPath -Encoding UTF8 -Value "not a directory"
    $beforeDb = Get-JsonFile -Path $dbFile
    $beforeProjectCount = Get-ProjectCount -Db $beforeDb

    $failedImportResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/projects/import" -Method "POST" -BodyObject @{
      bundle = $script:exportedBundle
      name = "Should Not Import"
      ownerId = "default-user"
    }
    if ($failedImportResponse.StatusCode -ne 503) {
      throw "Import should fail with HTTP 503 when backups path is not writable, got HTTP $($failedImportResponse.StatusCode)."
    }

    Remove-Item -LiteralPath $blockedBackupPath -Force

    $afterDb = Get-JsonFile -Path $dbFile
    $afterProjectCount = Get-ProjectCount -Db $afterDb
    if ($afterProjectCount -ne $beforeProjectCount) {
      throw "Project import mutated db after backup failure. Before: $beforeProjectCount After: $afterProjectCount"
    }

    $backupEvents = @($afterDb.systemEvents | Where-Object { $_.level -eq "error" -and $_.category -eq "backup" })
    if ($backupEvents.Count -lt 1) {
      throw "Backup failure did not record a backup error event."
    }

    Write-Host "Backup failure returned 503, blocked mutation, and recorded $($backupEvents.Count) backup event(s)"
  }

  Invoke-Step "Project import creates restorable backup" {
    $beforeDb = Get-JsonFile -Path $dbFile
    $beforeProjectCount = Get-ProjectCount -Db $beforeDb

    $importResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/projects/import" -Method "POST" -BodyObject @{
      bundle = $script:exportedBundle
      name = "Recovery Drill Imported"
      ownerId = "default-user"
    }
    Assert-SuccessStatus -Response $importResponse -Name "POST /api/projects/import"
    $importPayload = Convert-JsonContent -Name "POST /api/projects/import" -Content $importResponse.Content
    Assert-HasProperties -Value $importPayload -Name "import response" -Properties @("project", "canvases", "backup")
    if ($importPayload.backup.operation -ne "project-import") {
      throw "Import backup operation should be project-import, got '$($importPayload.backup.operation)'."
    }

    $importBackupFile = Assert-BackupPath -BackupFile ([string]$importPayload.backup.file) -TempData $tempData
    $backupDb = Get-JsonFile -Path $importBackupFile
    if ((Get-ProjectCount -Db $backupDb) -ne $beforeProjectCount) {
      throw "Project import backup does not contain pre-import project count."
    }

    $afterDb = Get-JsonFile -Path $dbFile
    if ((Get-ProjectCount -Db $afterDb) -ne ($beforeProjectCount + 1)) {
      throw "Project import did not add exactly one project."
    }

    Write-Host "Project import backup: $importBackupFile"
  }

  Invoke-Step "History restore creates backup of previous snapshot" {
    $restoredSnapshot = New-TestSnapshot -Prompt "after history restore"
    $restoreResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/canvases/$([uri]::EscapeDataString($script:sourceCanvasId))/snapshot" -Method "PUT" -BodyObject @{
      snapshot = $restoredSnapshot
      backupOperation = "history-restore"
    }
    Assert-SuccessStatus -Response $restoreResponse -Name "PUT /api/canvases/:id/snapshot history restore"
    $restorePayload = Convert-JsonContent -Name "PUT /api/canvases/:id/snapshot history restore" -Content $restoreResponse.Content
    Assert-HasProperties -Value $restorePayload -Name "history restore response" -Properties @("canvas", "backup")
    if ($restorePayload.backup.operation -ne "history-restore") {
      throw "History restore backup operation should be history-restore, got '$($restorePayload.backup.operation)'."
    }

    $script:historyBackupFile = Assert-BackupPath -BackupFile ([string]$restorePayload.backup.file) -TempData $tempData
    $historyBackupDb = Get-JsonFile -Path $script:historyBackupFile
    $backupPrompt = Get-CanvasPrompt -Db $historyBackupDb -CanvasId $script:sourceCanvasId
    if ($backupPrompt -ne "before history restore") {
      throw "History restore backup should contain the previous snapshot, got '$backupPrompt'."
    }

    $afterDb = Get-JsonFile -Path $dbFile
    $afterPrompt = Get-CanvasPrompt -Db $afterDb -CanvasId $script:sourceCanvasId
    if ($afterPrompt -ne "after history restore") {
      throw "History restore did not write the target snapshot, got '$afterPrompt'."
    }

    Write-Host "History restore backup: $script:historyBackupFile"
  }

  Invoke-Step "Restore db.json from backup and verify after API restart" {
    Stop-TempApi -Process $apiProcess
    $apiProcess = $null

    Copy-Item -LiteralPath $script:historyBackupFile -Destination $dbFile -Force
    $restoredDb = Get-JsonFile -Path $dbFile
    $restoredPrompt = Get-CanvasPrompt -Db $restoredDb -CanvasId $script:sourceCanvasId
    if ($restoredPrompt -ne "before history restore") {
      throw "Manual db restore did not restore the previous snapshot, got '$restoredPrompt'."
    }

    $script:apiProcess = Start-TempApi -TempData $tempData -Port $port
    $canvasResponse = Invoke-HttpCheck -Url "$apiBaseUrl/api/canvases/$([uri]::EscapeDataString($script:sourceCanvasId))"
    Assert-SuccessStatus -Response $canvasResponse -Name "GET /api/canvases/:id after manual restore"
    $canvasPayload = Convert-JsonContent -Name "GET /api/canvases/:id after manual restore" -Content $canvasResponse.Content
    $node = @($canvasPayload.canvas.snapshot.nodes)[0]
    if ([string]$node.data.prompt -ne "before history restore") {
      throw "Restarted API did not read restored db.json, got '$($node.data.prompt)'."
    }

    Write-Host "Manual restore survived API restart"
  }

  Invoke-Step "Backup directory summary" {
    $backupDir = Join-Path $tempData "backups"
    $backupFiles = @(Get-ChildItem -LiteralPath $backupDir -Filter "*.db.json" -File)
    if ($backupFiles.Count -lt 2) {
      throw "Expected at least two backup files, found $($backupFiles.Count)."
    }
    Write-Host "Created $($backupFiles.Count) backup file(s) in isolated DATA_DIR"
  }

  Write-Host ""
  Write-Host "Recovery drill passed."
} finally {
  Stop-TempApi -Process $apiProcess
  if ($KeepTempData) {
    Write-Host "Kept temporary DATA_DIR: $tempData"
  } else {
    Remove-TempDirectory -Path $tempData
  }
}
