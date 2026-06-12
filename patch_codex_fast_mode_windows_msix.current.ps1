param(
  [string]$AppPath,
  [string]$OutputRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\codex-msix-repack'),
  [switch]$InstallPrerequisites,
  [switch]$Install,
  [switch]$Launch,
  [switch]$NoLaunch,
  [switch]$ForceRebuild,
  [switch]$KeepWorkDir,
  [switch]$CleanupAfter,
  [switch]$CleanupWindowsSdkAfterInstall,
  [switch]$AddLocalPluginMarketplace,
  [string]$LocalPluginMarketplaceSource = (Join-Path $env:USERPROFILE '.codex\.tmp\plugins'),
  [string]$LocalPluginMarketplaceName = 'openai-curated-local',
  [switch]$VerifyFastModeRequest,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$LogPrefix = '[codex-msix-patch-win]'

function Write-Log {
  param([string]$Message)
  Write-Host "$LogPrefix $Message"
}

function Fail {
  param([string]$Message)
  throw "$LogPrefix error: $Message"
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RequiredCommand {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) {
    Fail "required command not found: $Name"
  }
  return $cmd
}

function Normalize-AppPath {
  param([string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $null
  }
  $resolved = Resolve-Path -LiteralPath $Candidate -ErrorAction SilentlyContinue
  if ($resolved) {
    $Candidate = $resolved.ProviderPath
  }
  if ((Split-Path -Leaf $Candidate) -ne 'app') {
    $nested = Join-Path $Candidate 'app'
    if (Test-Path -LiteralPath $nested -PathType Container) {
      $Candidate = $nested
    }
  }
  return $Candidate
}

function Test-CodexAppPath {
  param([string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $false
  }
  $app = Normalize-AppPath $Candidate
  return (
    (Test-Path -LiteralPath $app -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $app 'Codex.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $app 'resources\app.asar') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $app 'resources\rg.exe') -PathType Leaf)
  )
}

function Find-CodexAppPath {
  if ($AppPath) {
    $manual = Normalize-AppPath $AppPath
    if (-not (Test-CodexAppPath $manual)) {
      Fail "-AppPath is not a Codex app directory: $AppPath"
    }
    return $manual
  }

  $pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($pkg -and $pkg.InstallLocation) {
    $candidate = Join-Path $pkg.InstallLocation 'app'
    if (Test-CodexAppPath $candidate) {
      return (Normalize-AppPath $candidate)
    }
  }

  $running = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\Codex.exe' } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
  if ($running) {
    $candidate = Split-Path -Parent $running.Path
    if (Test-CodexAppPath $candidate) {
      return (Normalize-AppPath $candidate)
    }
  }

  $windowsApps = Join-Path $env:ProgramFiles 'WindowsApps'
  $dirs = Get-ChildItem -LiteralPath $windowsApps -Directory -Filter 'OpenAI.Codex_*_x64__*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  foreach ($dir in $dirs) {
    $candidate = Join-Path $dir.FullName 'app'
    if (Test-CodexAppPath $candidate) {
      return (Normalize-AppPath $candidate)
    }
  }

  Fail 'could not find Windows Store/MSIX Codex app. Pass -AppPath explicitly.'
}

function Get-PackageRoot {
  param([string]$App)
  return (Split-Path -Parent $App)
}

function Get-PackageShortId {
  param([string]$PackageRoot)
  $name = Split-Path -Leaf $PackageRoot
  if ($name -match '^(OpenAI\.Codex_[^_]+)_') {
    return $matches[1]
  }
  return $name
}

function Find-WindowsSdkTool {
  param([string]$ToolName)
  $roots = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
    (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($root in $roots) {
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter $ToolName -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($hit) {
      return $hit.FullName
    }
  }
  return $null
}

function Install-WindowsSdkPrerequisites {
  Write-Log 'installing Windows SDK via winget'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $winget) {
    Fail 'winget.exe not found; install Windows SDK manually or install App Installer first'
  }
  & $winget.Source install --id Microsoft.WindowsSDK.10.0.26100 -e --source winget --accept-source-agreements --accept-package-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Fail "winget Windows SDK install failed with exit code $LASTEXITCODE"
  }
}

function Require-WindowsSdkTool {
  param([string]$ToolName)
  $tool = Find-WindowsSdkTool $ToolName
  if (-not $tool -and $InstallPrerequisites) {
    Install-WindowsSdkPrerequisites
    $tool = Find-WindowsSdkTool $ToolName
  }
  if (-not $tool) {
    Fail "$ToolName not found. Re-run with -InstallPrerequisites or install Windows SDK manually."
  }
  return [string]$tool
}

function Copy-PackageLayout {
  param(
    [string]$SourcePackageRoot,
    [string]$WorkPackageRoot
  )
  if ((Test-Path -LiteralPath $WorkPackageRoot) -and $ForceRebuild) {
    Remove-Item -LiteralPath $WorkPackageRoot -Recurse -Force
  }
  if (-not (Test-Path -LiteralPath $WorkPackageRoot)) {
    New-Item -ItemType Directory -Force -Path $WorkPackageRoot | Out-Null
    Write-Log "copying package layout to: $WorkPackageRoot"
    & robocopy.exe $SourcePackageRoot $WorkPackageRoot /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) {
      Fail "robocopy failed with exit code $LASTEXITCODE"
    }
  } else {
    Write-Log "using existing work package layout: $WorkPackageRoot"
  }
}

function Remove-OldPackageArtifacts {
  param([string]$WorkPackageRoot)
  foreach ($rel in @('AppxSignature.p7x', 'AppxBlockMap.xml', 'AppxMetadata\CodeIntegrity.cat')) {
    $path = Join-Path $WorkPackageRoot $rel
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Invoke-CommandChecked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$FailureMessage (exit code $LASTEXITCODE)"
  }
}

function Invoke-NpxAsar {
  param(
    [string]$Action,
    [string]$Source,
    [string]$Target
  )
  $npx = (Get-RequiredCommand 'npx').Source
  & $npx --yes asar $Action $Source $Target
  if ($LASTEXITCODE -ne 0) {
    Fail "npx asar $Action failed with exit code $LASTEXITCODE"
  }
}

function Invoke-RgList {
  param(
    [string]$RgPath,
    [string]$Pattern,
    [string]$Directory
  )
  $matches = New-Object System.Collections.Generic.List[string]
  foreach ($file in (Get-ChildItem -LiteralPath $Directory -File -Filter '*.js' -Force)) {
    if (Select-String -LiteralPath $file.FullName -Pattern $Pattern -Quiet) {
      [void]$matches.Add($file.FullName)
    }
  }
  return @($matches)
}

function Invoke-RgListRecursive {
  param(
    [string]$RgPath,
    [string]$Pattern,
    [string]$Directory
  )
  $matches = New-Object System.Collections.Generic.List[string]
  foreach ($file in (Get-ChildItem -LiteralPath $Directory -File -Filter '*.js' -Recurse -Force)) {
    if (Select-String -LiteralPath $file.FullName -Pattern $Pattern -Quiet) {
      [void]$matches.Add($file.FullName)
    }
  }
  return @($matches)
}

function Write-PatcherFiles {
  param([string]$WorkDir)

  $fastPatcherPath = Join-Path $WorkDir 'PatchFastMode.cjs'
  $pluginsPatcherPath = Join-Path $WorkDir 'PatchPlugins.cjs'
  $browserPatcherPath = Join-Path $WorkDir 'PatchBrowserUse.cjs'
  $goalPatcherPath = Join-Path $WorkDir 'PatchGoal.cjs'
  $nodeReplPatcherPath = Join-Path $WorkDir 'PatchNodeReplSandbox.cjs'

  Set-Content -LiteralPath $fastPatcherPath -Encoding UTF8 -Value @'
const fs = require('node:fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');

const legacyPatchedRe = /function L\(e\)\{let (\w+)=v\(x\),(\w+)=e\?\.hostId\?\?\1,\{data:(\w+)\}=d\(E,\2\);return \3\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1\}/;
const currentDirectPatchedRe = /featureRequirements\?\.fast_mode===!1;return!\w+\}/;
const currentAsyncPatchedRe = /async function \w+\(\w+,\w+\)\{let \w+=await \w+\(\w+,\w+\);return \(await \w+\.query\.fetch\(\w+,\{authMethod:\w+,hostId:\w+\}\)\)\.requirements\?\.featureRequirements\?\.fast_mode!==!1\}/;
const currentUiPatchedRe = /(\w+)=!!\w+\?\.isLoading\|\|\w+,\w+=!\1&&\w+\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1/;
const legacyOriginalRe = /function L\(e\)\{let (\w+)=v\(x\),(\w+)=e\?\.hostId\?\?\1,(\w+)=O\(\2\),\{data:(\w+)\}=d\(E,\2\);return!\(\3\?\.authMethod!==`chatgpt`\|\|\4\?\.requirements\?\.featureRequirements\?\.fast_mode===!1\)\}/;
const currentDirectOriginalRe = /function (\w+)\(e\)\{let (\w+)=([^,;]+),(\w+)=e\?\.hostId\?\?\2,(\w+)=(\w+\(\4\)),\{data:(\w+)\}=(\w+\(\w+,\4\)),(\w+)=\7\?\.requirements\?\.featureRequirements\?\.fast_mode===!1;return!\(\5\?\.authMethod!==`chatgpt`\|\|\9\)\}/;
const currentAsyncOriginalRe = /async function (\w+)\((\w+),(\w+)\)\{let (\w+)=await (\w+)\(\2,\3\);return \4===`chatgpt`\?\(await \2\.query\.fetch\((\w+),\{authMethod:\4,hostId:\3\}\)\)\.requirements\?\.featureRequirements\?\.fast_mode!==!1:!1\}/;
const currentUiOriginalRe = /(\w+)=!!(\w+)\?\.isLoading\|\|(\w+)&&(\w+),(\w+)=\3&&!\1&&(\w+)!=null&&\6\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1/;
const currentSplitConditionRe = /if\((\w+)\?\.authMethod!==`chatgpt`\|\|(\w+)\)\{/;

if (legacyPatchedRe.test(text) || currentAsyncPatchedRe.test(text) || currentUiPatchedRe.test(text) || (currentDirectPatchedRe.test(text) && !legacyOriginalRe.test(text) && !currentDirectOriginalRe.test(text) && !currentAsyncOriginalRe.test(text) && !currentUiOriginalRe.test(text) && !currentSplitConditionRe.test(text))) {
  process.stdout.write('already-patched');
  process.exit(0);
}

let next = text;
let patched = false;
const legacyMatch = next.match(legacyOriginalRe);
if (legacyMatch) {
  const [, rootVar, hostVar, , dataVar] = legacyMatch;
  next = next.replace(legacyOriginalRe, `function L(e){let ${rootVar}=v(x),${hostVar}=e?.hostId??${rootVar},{data:${dataVar}}=d(E,${hostVar});return ${dataVar}?.requirements?.featureRequirements?.fast_mode!==!1}`);
  patched = true;
}

if (!patched) {
  const currentMatch = next.match(currentDirectOriginalRe);
  if (currentMatch) {
    const [, fn, rootVar, rootExpr, hostVar, , , dataVar, dataCall, disabledVar] = currentMatch;
    next = next.replace(currentDirectOriginalRe, `function ${fn}(e){let ${rootVar}=${rootExpr},${hostVar}=e?.hostId??${rootVar},{data:${dataVar}}=${dataCall},${disabledVar}=${dataVar}?.requirements?.featureRequirements?.fast_mode===!1;return!${disabledVar}}`);
    patched = true;
  }
}

if (!patched) {
  const currentAsyncMatch = next.match(currentAsyncOriginalRe);
  if (currentAsyncMatch) {
    const [, fn, clientVar, hostVar, authVar, authFn, configQueryVar] = currentAsyncMatch;
    next = next.replace(currentAsyncOriginalRe, `async function ${fn}(${clientVar},${hostVar}){let ${authVar}=await ${authFn}(${clientVar},${hostVar});return (await ${clientVar}.query.fetch(${configQueryVar},{authMethod:${authVar},hostId:${hostVar}})).requirements?.featureRequirements?.fast_mode!==!1}`);
    patched = true;
  }
}

if (!patched) {
  const currentUiMatch = next.match(currentUiOriginalRe);
  if (currentUiMatch) {
    const [, loadingVar, authStateVar, chatgptGateVar, pendingVar, allowedVar, dataVar] = currentUiMatch;
    next = next.replace(currentUiOriginalRe, `${loadingVar}=!!${authStateVar}?.isLoading||${pendingVar},${allowedVar}=!${loadingVar}&&${dataVar}?.requirements?.featureRequirements?.fast_mode!==!1`);
    patched = true;
  }
}

if (!patched) {
  if (/canUseFastMode:!1/.test(next)) {
    const splitNext = next.replace(currentSplitConditionRe, 'if($2){');
    if (splitNext === next) {
      process.stderr.write('split-gate-target-not-found\n');
      process.exit(2);
    }
    next = splitNext;
    patched = true;
  }
}

if (!patched) {
  process.stderr.write('patch-target-not-found\n');
  process.exit(2);
}
fs.writeFileSync(file, next);
process.stdout.write('patched');
'@

  Set-Content -LiteralPath $pluginsPatcherPath -Encoding UTF8 -Value @'
const fs = require('node:fs');
const args = process.argv.slice(2);
let changed = false;

function rewriteFile(label, file, patchedRe, originalRe, replacement) {
  const text = fs.readFileSync(file, 'utf8');
  if (patchedRe.test(text)) return;
  const next = text.replace(originalRe, replacement);
  if (next === text) {
    process.stderr.write(`${label}-target-not-found\n`);
    process.exit(2);
  }
  fs.writeFileSync(file, next);
  changed = true;
}

if (args[0] === '--current-marketplace-auth') {
  const [, marketplaceAuthFile] = args;
  rewriteFile(
    'plugin-marketplace-auth-gate',
    marketplaceAuthFile,
    /function (\w+)\(e\)\{return !1\}/,
    /function (\w+)\(e\)\{return e!==`chatgpt`\}/,
    (_match, fn) => `function ${fn}(e){return !1}`
  );
  process.stdout.write(changed ? 'patched' : 'already-patched');
  process.exit(0);
}

const [sidebarFile, skillsFile, detailFile] = args;

rewriteFile(
  'plugin-sidebar-gate',
  sidebarFile,
  /\{authMethod:(\w+)\}=([A-Za-z_$][\w$]*)\(\),(\w+)=([A-Za-z_$][\w$]*)\(`533078438`\),(\w+)=!1,(\w+)=e&&\3&&\5,(\w+)=([A-Za-z_$][\w$]*)\(\{hostId:([A-Za-z_$][\w$]*)\}\),(\w+)=e&&\7&&!\5,/,
  /\{authMethod:(\w+)\}=([A-Za-z_$][\w$]*)\(\),(\w+)=([A-Za-z_$][\w$]*)\(`533078438`\),(\w+)=([A-Za-z_$][\w$]*)\(\1\),(\w+)=e&&\3&&\5,(\w+)=([A-Za-z_$][\w$]*)\(\{hostId:([A-Za-z_$][\w$]*)\}\),(\w+)=e&&\8&&!\5,/,
  (_match, authMethodVar, authHook, flagVar, featureFlagHook, apiKeyGateVar, _apiKeyGateHook, disabledVar, availabilityVar, availabilityHook, hostIdVar, enabledVar) =>
    `{authMethod:${authMethodVar}}=${authHook}(),${flagVar}=${featureFlagHook}(\`533078438\`),${apiKeyGateVar}=!1,${disabledVar}=e&&${flagVar}&&${apiKeyGateVar},${availabilityVar}=${availabilityHook}({hostId:${hostIdVar}}),${enabledVar}=e&&${availabilityVar}&&!${apiKeyGateVar},`
);

rewriteFile(
  'plugin-skills-page-gate',
  skillsFile,
  /let (\w+)=!1,(\w+),(\w+);if\(e\[(\d+)\]!==(\w+)\|\|e\[(\d+)\]!==\1\|\|e\[(\d+)\]!==(\w+)\?/,
  /let (\w+)=(\w+),(\w+),(\w+);if\(e\[(\d+)\]!==(\w+)\|\|e\[(\d+)\]!==\1\|\|e\[(\d+)\]!==(\w+)\?/,
  (_match, pluginAuthBlockedVar, _sourceVar, effectFnVar, effectDepsVar, slotA, deepLinkBlockedVar, slotB, slotC, toastApiVar) =>
    `let ${pluginAuthBlockedVar}=!1,${effectFnVar},${effectDepsVar};if(e[${slotA}]!==${deepLinkBlockedVar}||e[${slotB}]!==${pluginAuthBlockedVar}||e[${slotC}]!==${toastApiVar}?`
);

rewriteFile(
  'plugin-detail-gate',
  detailFile,
  /\{authMethod:(\w+)\}=([A-Za-z_$][\w$]*)\(\);if\(!1\)\{let (\w+);return/,
  /\{authMethod:(\w+)\}=([A-Za-z_$][\w$]*)\(\);if\(([A-Za-z_$][\w$]*)\(\1\)\)\{let (\w+);return/,
  (_match, authMethodVar, authHook, _isAuthBlockedHook, redirectElementVar) =>
    `{authMethod:${authMethodVar}}=${authHook}();if(!1){let ${redirectElementVar};return`
);

process.stdout.write(changed ? 'patched' : 'already-patched');
'@

  Set-Content -LiteralPath $browserPatcherPath -Encoding UTF8 -Value @'
const fs = require('node:fs');
const [
  pluginAvailabilityFile,
  sidebarAvailabilityFile,
  pluginListFile,
  browserSettingsFile,
  mentionItemFile,
  localeSettingsFile,
] = process.argv.slice(2);
let changed = false;

function rewriteFile(label, file, patchedRe, originalRe, replacement) {
  const text = fs.readFileSync(file, 'utf8');
  if (patchedRe.test(text)) return;
  const next = text.replace(originalRe, replacement);
  if (next === text) {
    process.stderr.write(`${label}-target-not-found\n`);
    process.exit(2);
  }
  fs.writeFileSync(file, next);
  changed = true;
}

function rewriteOptionalFile(label, file, patchedRe, originalRe, replacement) {
  const text = fs.readFileSync(file, 'utf8');
  if (patchedRe.test(text)) return;
  const next = text.replace(originalRe, replacement);
  if (next === text) {
    process.stderr.write(`${label}-target-not-found-skipped\n`);
    return;
  }
  fs.writeFileSync(file, next);
  changed = true;
}

function replaceLiteral(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) return;
  fs.writeFileSync(file, text.split(from).join(to));
  changed = true;
}

rewriteFile(
  'browser-use-plugin-availability',
  pluginAvailabilityFile,
  /function (\w+)\(\{isBrowserAgentGateEnabled:(\w+),isBrowserSidebarEnabled:(\w+),isBrowserUseEnabled:(\w+),isLoading:(\w+),runCodexInWsl:(\w+),windowType:(\w+)\}\)\{return \7===`chrome-extension`\?`window-type-disabled`:`available`\}/,
  /function (\w+)\(\{isBrowserAgentGateEnabled:(\w+),isBrowserSidebarEnabled:(\w+),isBrowserUseEnabled:(\w+),isLoading:(\w+),runCodexInWsl:(\w+),windowType:(\w+)\}\)\{return \7===`chrome-extension`\?`window-type-disabled`:\5\?`loading`:\3\?\2\?\4\?\6\?`wsl-disabled`:`available`:`config-requirement-disabled`:`statsig-disabled`:`browser-pane-disabled`\}/,
  (_match, fn, agentGateVar, sidebarGateVar, browserUseVar, loadingVar, wslVar, windowTypeVar) =>
    `function ${fn}({isBrowserAgentGateEnabled:${agentGateVar},isBrowserSidebarEnabled:${sidebarGateVar},isBrowserUseEnabled:${browserUseVar},isLoading:${loadingVar},runCodexInWsl:${wslVar},windowType:${windowTypeVar}}){return ${windowTypeVar}===\`chrome-extension\`?\`window-type-disabled\`:\`available\`}`
);

rewriteFile(
  'in-app-browser-sidebar-availability',
  sidebarAvailabilityFile,
  /return !0\}\);export\{\w+ as t\}/,
  /return \w+!=null&&\w+\?\.enabled!==!1\}\);export\{\w+ as t\}/,
  match => match.replace(/return \w+!=null&&\w+\?\.enabled!==!1/, 'return !0')
);

rewriteFile(
  'browser-plugin-list-filter',
  pluginListFile,
  /function \w+\(e,\{isComputerUseAvailable:\w+,isExternalBrowserUseAvailable:\w+,isInAppBrowserUseAvailable:\w+\}\)\{return \w+\(e\)\?!0:!\(!\w+&&\w+\(e\)\|\|!\w+&&\w+\(e\)\)\}/,
  /function (\w+)\(e,\{isComputerUseAvailable:(\w+),isExternalBrowserUseAvailable:(\w+),isInAppBrowserUseAvailable:(\w+)\}\)\{return!\(!\4&&(\w+)\(e\)\|\|!\3&&(\w+)\(e\)\|\|!\2&&(\w+)\(e\)\)\}/,
  (_match, fn, computerUseVar, externalBrowserVar, inAppBrowserVar, browserCheckFn, externalCheckFn, computerCheckFn) =>
    `function ${fn}(e,{isComputerUseAvailable:${computerUseVar},isExternalBrowserUseAvailable:${externalBrowserVar},isInAppBrowserUseAvailable:${inAppBrowserVar}}){return ${browserCheckFn}(e)?!0:!(!${externalBrowserVar}&&${externalCheckFn}(e)||!${computerUseVar}&&${computerCheckFn}(e))}`
);

rewriteOptionalFile(
  'browser-settings-installed-fallback',
  browserSettingsFile,
  /(\w+)=kt\(\[\.\.\.\w+\.availablePlugins,\.\.\.\w+\.installedPlugins\],\w+,\w+\)/,
  /(\w+)=kt\((\w+)\.availablePlugins,(\w+),(\w+)\)/,
  (_match, resultVar, pluginsQueryVar, pluginNameVar, homeVar) =>
    `${resultVar}=kt([...${pluginsQueryVar}.availablePlugins,...${pluginsQueryVar}.installedPlugins],${pluginNameVar},${homeVar})`
);

rewriteOptionalFile(
  'browser-settings-installed-fallback-memo',
  browserSettingsFile,
  /\w+=kt\(\[\.\.\.\w+\.availablePlugins,\.\.\.\w+\.installedPlugins\],\w+,\w+\);let \w+=\w+,\w+;/,
  /(\w+)\[\d+\]!==(\w+)\|\|\1\[\d+\]!==(\w+)\.availablePlugins\?\((\w+)=kt\(\[\.\.\.\3\.availablePlugins,\.\.\.\3\.installedPlugins\],(\w+),\2\),\1\[\d+\]=\2,\1\[\d+\]=\3\.availablePlugins,\1\[\d+\]=\4\):\4=\1\[\d+\];let (\w+)=\4,(\w+);/,
  (_match, cacheVar, homeVar, pluginsQueryVar, resultVar, pluginNameVar, rowPluginVar, listVar) =>
    `${resultVar}=kt([...${pluginsQueryVar}.availablePlugins,...${pluginsQueryVar}.installedPlugins],${pluginNameVar},${homeVar});let ${rowPluginVar}=${resultVar},${listVar};`
);

rewriteOptionalFile(
  'browser-settings-hide-empty-unavailable',
  browserSettingsFile,
  /if\(A===0\)return null;let j;/,
  /if\(A===0\)\{let e;return t\[12\]===n\?e=t\[13\]:\(e=\(0,Q\.jsx\)\(J,\{children:\(0,Q\.jsx\)\(Ze,\{children:n\}\)\}\),t\[12\]=n,t\[13\]=e\),e\}let j;/,
  () => 'if(A===0)return null;let j;'
);

replaceLiteral(mentionItemFile, 'defaultMessage:`Browser`', 'defaultMessage:`浏览器`');
replaceLiteral(mentionItemFile, 'defaultMessage:`Disabled by your organization or unavailable in your region`', 'defaultMessage:`已被组织禁用，或在当前地区不可用`');

for (const [from, to] of [
  ['defaultMessage:`Extensions settings`', 'defaultMessage:`扩展设置`'],
  ['defaultMessage:`Password manager settings`', 'defaultMessage:`密码管理器设置`'],
  ['defaultMessage:`Site settings`', 'defaultMessage:`网站设置`'],
  ['defaultMessage:`Settings`', 'defaultMessage:`设置`'],
  ['defaultMessage:`Browser`', 'defaultMessage:`浏览器`'],
  ['defaultMessage:`In-app browser plugin unavailable`', 'defaultMessage:`应用内浏览器插件不可用`'],
  ['defaultMessage:`Install`', 'defaultMessage:`安装`'],
  ['defaultMessage:`Let Codex control the built-in browser`', 'defaultMessage:`让 Codex 控制内置浏览器`'],
  ['defaultMessage:`Manage`', 'defaultMessage:`管理`'],
  ['defaultMessage:`Passwords`', 'defaultMessage:`密码`'],
  ['defaultMessage:`Extensions`', 'defaultMessage:`扩展`'],
  ['defaultMessage:`Data`', 'defaultMessage:`数据`'],
  ['defaultMessage:`Permissions`', 'defaultMessage:`权限`'],
  ['defaultMessage:`Approval`', 'defaultMessage:`审批`'],
  ['defaultMessage:`Always ask`', 'defaultMessage:`始终询问`'],
  ['defaultMessage:`Always allow`', 'defaultMessage:`始终允许`'],
  ['defaultMessage:`History`', 'defaultMessage:`历史记录`'],
  ['defaultMessage:`Browsing data`', 'defaultMessage:`浏览数据`'],
  ['defaultMessage:`Clear all browsing data`', 'defaultMessage:`清除所有浏览数据`'],
  ['defaultMessage:`Cookies`', 'defaultMessage:`Cookie`'],
  ['defaultMessage:`Site data`', 'defaultMessage:`网站数据`'],
  ['defaultMessage:`Cached images and files`', 'defaultMessage:`缓存的图片和文件`'],
  ['defaultMessage:`Delete cookies`', 'defaultMessage:`删除 Cookie`'],
  ['defaultMessage:`Delete site data`', 'defaultMessage:`删除网站数据`'],
  ['defaultMessage:`Delete cached images and files`', 'defaultMessage:`删除缓存的图片和文件`'],
]) {
  replaceLiteral(browserSettingsFile, from, to);
}

replaceLiteral(
  browserSettingsFile,
  "defaultMessage:`Manage Codex's browser. Google Chrome can be set up in <computerUseSettingsLink>computer use settings</computerUseSettingsLink>`",
  "defaultMessage:`管理 Codex 的浏览器。Google Chrome 可在 <computerUseSettingsLink>Computer Use 设置</computerUseSettingsLink>中配置`"
);

rewriteFile(
  'default-locale-zh-cn',
  localeSettingsFile,
  /localeOverride:\w+\(\{agentAccess:`read-write`,default:`zh-CN`,description:`Explicit locale override`,key:`localeOverride`/,
  /localeOverride:(\w+)\(\{agentAccess:`read-write`,default:null,description:`Explicit locale override`,key:`localeOverride`/,
  (_match, settingsFn) =>
    `localeOverride:${settingsFn}({agentAccess:\`read-write\`,default:\`zh-CN\`,description:\`Explicit locale override\`,key:\`localeOverride\``
);

process.stdout.write(changed ? 'patched' : 'already-patched');
'@

  Set-Content -LiteralPath $goalPatcherPath -Encoding UTF8 -Value @'
const fs = require('node:fs');
const args = process.argv.slice(2);
const slashOnly = args[0] === '--slash-only';
const file = slashOnly ? args[1] : args[0];
const text = fs.readFileSync(file, 'utf8');

const goalPatchedRe = /(\w+)=([A-Za-z_$][\w$]*)!==`cloud`(?:&&!?\w+)?,(\w+)=([^,]+),/;
const goalOriginalRe = /(\w+)=([A-Za-z_$][\w$]*)\(`3074100722`\)&&([A-Za-z_$][\w$]*)\((\w+)\?\.config,`goals`\)===!0&&(\w+)!==`cloud`,(\w+)=([^,]+),/;
const currentGoalOriginalRe = /(\w+)=([A-Za-z_$][\w$]*)\(`3074100722`\)&&([A-Za-z_$][\w$]*)\((\w+)\?\.config,`goals`\)===!0&&(\w+)!==`cloud`(&&!\w+)?,(\w+)=([^,]+),/;
const slashOriginal = 'function Nx(e,t){let n=t.trim();if(n.length===0)return e;let r=new Map;return e.forEach(e=>{let t=e.group??null;r.has(t)||r.set(t,r.size)}),(0,Tx.default)(e.map(e=>({command:e,score:zi(e.title,n)})).filter(e=>e.score>0),[e=>r.get(e.command.group??null)??2**53-1,e=>-e.score,e=>e.command.title]).map(e=>e.command)}';
const slashPatched = 'function Nx(e,t){let n=t.trim().replace(/^\\/+/,"");if(n.length===0)return e;let r=new Map;return e.forEach(e=>{let t=e.group??null;r.has(t)||r.set(t,r.size)}),(0,Tx.default)(e.map(e=>({command:e,score:Math.max(zi(e.title,n),zi(e.id,n))})).filter(e=>e.score>0),[e=>r.get(e.command.group??null)??2**53-1,e=>-e.score,e=>e.command.title]).map(e=>e.command)}';
const slashOriginalRe = /function (\w+)\(e,t\)\{let (\w+)=t\.trim\(\);if\(\2\.length===0\)return e;let (\w+)=new Map;return e\.forEach\(e=>\{let t=e\.group\?\?null;\3\.has\(t\)\|\|\3\.set\(t,\3\.size\)\}\),\(0,([A-Za-z_$][\w$]*)\.default\)\(e\.map\(e=>\(\{command:e,score:([A-Za-z_$][\w$]*)\(e\.title,\2\)\}\)\)\.filter\(e=>e\.score>0\),\[e=>\3\.get\(e\.command\.group\?\?null\)\?\?2\*\*53-1,e=>-e\.score,e=>e\.command\.title\]\)\.map\(e=>e\.command\)\}/;
const slashPatchedRe = /score:Math\.max\([A-Za-z_$][\w$]*\(e\.title,\w+\),[A-Za-z_$][\w$]*\(e\.id,\w+\)\)/;

let next = text;
let changed = false;
if (!next.includes(slashPatched) && !slashPatchedRe.test(next)) {
  const slashMatch = next.match(slashOriginalRe);
  if (slashMatch) {
    const [, fn, queryVar, groupOrderVar, sortByVar, scoreFn] = slashMatch;
    next = next.replace(slashOriginalRe, `function ${fn}(e,t){let ${queryVar}=t.trim().replace(/^\\/+/,"");if(${queryVar}.length===0)return e;let ${groupOrderVar}=new Map;return e.forEach(e=>{let t=e.group??null;${groupOrderVar}.has(t)||${groupOrderVar}.set(t,${groupOrderVar}.size)}),(0,${sortByVar}.default)(e.map(e=>({command:e,score:Math.max(${scoreFn}(e.title,${queryVar}),${scoreFn}(e.id,${queryVar}))})).filter(e=>e.score>0),[e=>${groupOrderVar}.get(e.command.group??null)??2**53-1,e=>-e.score,e=>e.command.title]).map(e=>e.command)}`);
  } else if (next.includes(slashOriginal)) {
    next = next.replace(slashOriginal, slashPatched);
  } else {
    process.stderr.write('slash-match-patch-target-not-found\n');
    process.exit(2);
  }
  changed = true;
}

if (!slashOnly) {
  if (goalOriginalRe.test(next)) {
    next = next.replace(goalOriginalRe, (_match, goalGateVar, _statsigFn, _configAccessFn, _configVar, modeVar, hasGoalVar, hasGoalExpr) => `${goalGateVar}=${modeVar}!==\`cloud\`,${hasGoalVar}=${hasGoalExpr},`);
    changed = true;
  } else if (currentGoalOriginalRe.test(next)) {
    next = next.replace(currentGoalOriginalRe, (_match, goalGateVar, _statsigFn, _configAccessFn, _configVar, modeVar, sideChatGuard = '', hasGoalVar, hasGoalExpr) => `${goalGateVar}=${modeVar}!==\`cloud\`${sideChatGuard},${hasGoalVar}=${hasGoalExpr},`);
    changed = true;
  } else if (!goalPatchedRe.test(next)) {
    process.stderr.write('goal-patch-target-not-found\n');
    process.exit(2);
  }
}

if (!changed) {
  process.stdout.write('already-patched');
  process.exit(0);
}
fs.writeFileSync(file, next);
process.stdout.write('patched');
'@

  Set-Content -LiteralPath $nodeReplPatcherPath -Encoding UTF8 -Value @'
const fs = require('node:fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');

const patchedRe = /\{\[`mcp_servers\.\$\{[A-Za-z_$][\w$]*\}`\]:\{args:\[(?:`|")--disable-sandbox(?:`|")\],command:[A-Za-z_$][\w$]*,env:[A-Za-z_$][\w$]*,startup_timeout_sec:120\}\}/;
const originalRe = /(\{\[`mcp_servers\.\$\{[A-Za-z_$][\w$]*\}`\]:\{)args:\[\](,command:[A-Za-z_$][\w$]*,env:[A-Za-z_$][\w$]*,startup_timeout_sec:120\}\})/;

if (patchedRe.test(text)) {
  process.stdout.write('already-patched');
  process.exit(0);
}

const next = text.replace(originalRe, '$1args:[`--disable-sandbox`]$2');
if (next === text) {
  process.stderr.write('node-repl-disable-sandbox-target-not-found\n');
  process.exit(2);
}

fs.writeFileSync(file, next);
process.stdout.write('patched');
'@

  return [pscustomobject]@{
    Fast = $fastPatcherPath
    Plugins = $pluginsPatcherPath
    Browser = $browserPatcherPath
    Goal = $goalPatcherPath
    NodeRepl = $nodeReplPatcherPath
  }
}

function Find-PatchTargets {
  param(
    [string]$RgPath,
    [string]$ExtractDir
  )
  $assetsDir = Join-Path $ExtractDir 'webview\assets'
  if (-not (Test-Path -LiteralPath $assetsDir -PathType Container)) {
    Fail "assets directory not found in extracted asar: $assetsDir"
  }

  $fastModeTargets = @(Invoke-RgList $RgPath 'featureRequirements\?\.fast_mode' $assetsDir)
  if ($fastModeTargets.Count -eq 0) {
    Fail 'could not find patch target: fastModeTarget'
  }

  $pluginSidebarTarget = Invoke-RgList $RgPath '533078438' $assetsDir | Select-Object -First 1
  $pluginSkillsTarget = Invoke-RgList $RgPath 'pluginDeepLinkAuthBlocked===!0' $assetsDir | Select-Object -First 1
  $pluginDetailTarget = Invoke-RgList $RgPath 'pluginDeepLinkAuthBlocked:!0' $assetsDir | Select-Object -First 1
  $legacyPluginTargets = @($pluginSidebarTarget, $pluginSkillsTarget, $pluginDetailTarget)
  $legacyPluginTargetCount = @($legacyPluginTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
  $pluginPatchMode = 'LegacyAuthGates'
  $pluginMarketplaceAuthTarget = $null

  if ($legacyPluginTargetCount -eq 0) {
    $pluginPatchMode = 'CurrentMarketplaceAuth'
    $pluginMarketplaceAuthTarget = Invoke-RgList $RgPath 'openai-curated-marketplaces-hidden' $assetsDir | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($pluginMarketplaceAuthTarget)) {
      Fail 'could not find patch target: pluginMarketplaceAuthTarget'
    }
  } elseif ($legacyPluginTargetCount -ne 3) {
    Fail 'found only some legacy plugin patch targets; cannot safely patch plugin gates'
  }

  $browserUseAvailabilityTarget = Invoke-RgList $RgPath 'browser-pane-disabled' $assetsDir | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($browserUseAvailabilityTarget)) {
    foreach ($candidate in (Invoke-RgList $RgPath 'window-type-disabled' $assetsDir)) {
      $text = Get-Content -Raw -LiteralPath $candidate
      if (($text -match 'isBrowserAgentGateEnabled') -and
          ($text -match 'return \w+===`chrome-extension`\?`window-type-disabled`:`available`')) {
        $browserUseAvailabilityTarget = $candidate
        break
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($browserUseAvailabilityTarget)) {
    Fail 'could not find patch target: browserUseAvailabilityTarget'
  }

  $browserPluginListTarget = $null
  foreach ($candidate in (Invoke-RgList $RgPath 'isInAppBrowserUseAvailable' $assetsDir)) {
    $text = Get-Content -Raw -LiteralPath $candidate
    if ($text -match 'function \w+\(e,\{isComputerUseAvailable:\w+,isExternalBrowserUseAvailable:\w+,isInAppBrowserUseAvailable:\w+\}\)') {
      $browserPluginListTarget = $candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($browserPluginListTarget)) {
    Fail 'could not find patch target: browserPluginListTarget'
  }

  $browserSidebarAvailabilityTarget = $null
  foreach ($candidate in (Invoke-RgList $RgPath 'in_app_browser' $assetsDir)) {
    $text = Get-Content -Raw -LiteralPath $candidate
    if (($text -match 'return \w+!=null&&\w+\?\.enabled!==!1') -or
        ($text -match 'return !0\}\);export\{\w+ as t\}')) {
      $browserSidebarAvailabilityTarget = $candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($browserSidebarAvailabilityTarget)) {
    Fail 'could not find patch target: browserSidebarAvailabilityTarget'
  }

  $browserSettingsTarget = $null
  foreach ($candidate in (Invoke-RgList $RgPath 'settings.browserUse.install.empty' $assetsDir)) {
    $text = Get-Content -Raw -LiteralPath $candidate
    if (($text -match 'browserUsePlugins') -and ($text -match 'function \w+\(e\)\{.*unavailableBrowserUsePlugins')) {
      $browserSettingsTarget = $candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($browserSettingsTarget)) {
    Fail 'could not find patch target: browserSettingsTarget'
  }

  $browserMentionTarget = $null
  $browserMentionCandidates = @(Get-ChildItem -LiteralPath $assetsDir -File -Filter 'mention-item-*.js' -Force | Select-Object -ExpandProperty FullName)
  if ($browserMentionCandidates.Count -eq 0) {
    $browserMentionCandidates = @(Invoke-RgList $RgPath 'composer.pluginMention.browserUse.label' $assetsDir)
  }
  foreach ($candidate in $browserMentionCandidates) {
    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($candidate))
    if ($text.Contains('composer.pluginMention.browserUse.label') -and $text.Contains('restrictedAvailabilityDescription')) {
      $browserMentionTarget = $candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($browserMentionTarget)) {
    Fail 'could not find patch target: browserMentionTarget'
  }

  $localeSettingsTarget = Invoke-RgList $RgPath 'key:`localeOverride`' $assetsDir | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($localeSettingsTarget)) {
    Fail 'could not find patch target: localeSettingsTarget'
  }

  $nodeReplSandboxTarget = $null
  foreach ($candidate in (Invoke-RgListRecursive $RgPath 'mcp_servers\.\$\{' $ExtractDir)) {
    $text = [System.IO.File]::ReadAllText($candidate)
    if (($text -match 'startup_timeout_sec:120') -and
        ($text -match 'mcp_servers\.\$\{') -and
        (($text -match 'args:\[\]') -or ($text -match '--disable-sandbox'))) {
      $nodeReplSandboxTarget = $candidate
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($nodeReplSandboxTarget)) {
    Fail 'could not find patch target: nodeReplSandboxTarget'
  }

  $goalTarget = $null
  $goalPatchMode = 'LegacyGoalAndSlash'
  foreach ($candidate in (Invoke-RgList $RgPath 'threadGoalObjective' $assetsDir)) {
    $text = Get-Content -Raw -LiteralPath $candidate
    if (($text.Contains('3074100722') -and $text.Contains('goals')) -or
        ($text -match 'score:Math\.max\([A-Za-z_$][\w$]*\(e\.title,\w+\),[A-Za-z_$][\w$]*\(e\.id,\w+\)\)') -or
        ($text -match 'score:[A-Za-z_$][\w$]*\(e\.title,\w+\)')) {
      $goalTarget = $candidate
      break
    }
  }

  if ([string]::IsNullOrWhiteSpace($goalTarget)) {
    $goalPatchMode = 'SlashOnly'
    $goalTarget = Invoke-RgList $RgPath 'score:[A-Za-z_$][\w$]*\(e\.title,\w+\)' $assetsDir | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($goalTarget)) {
      $goalTarget = Invoke-RgList $RgPath 'score:Math\.max\([A-Za-z_$][\w$]*\(e\.title,\w+\),[A-Za-z_$][\w$]*\(e\.id,\w+\)\)' $assetsDir | Select-Object -First 1
    }
  }

  if ([string]::IsNullOrWhiteSpace($goalTarget)) {
    $goalPatchMode = 'Skip'
    Write-Log 'goal slash-command gate not found; skipping optional goal patch for this Codex build'
  }

  foreach ($fastModeTarget in $fastModeTargets) {
    Write-Log "fast-mode patch target: $fastModeTarget"
  }
  if ($pluginPatchMode -eq 'LegacyAuthGates') {
    Write-Log "plugin sidebar patch target: $pluginSidebarTarget"
    Write-Log "plugin skills-page patch target: $pluginSkillsTarget"
    Write-Log "plugin detail patch target: $pluginDetailTarget"
  } else {
    Write-Log "plugin marketplace auth patch target: $pluginMarketplaceAuthTarget"
  }
  Write-Log "browser-use availability patch target: $browserUseAvailabilityTarget"
  Write-Log "browser plugin list patch target: $browserPluginListTarget"
  Write-Log "in-app browser sidebar patch target: $browserSidebarAvailabilityTarget"
  Write-Log "browser settings zh-CN patch target: $browserSettingsTarget"
  Write-Log "browser mention zh-CN patch target: $browserMentionTarget"
  Write-Log "locale default zh-CN patch target: $localeSettingsTarget"
  Write-Log "node_repl disable-sandbox patch target: $nodeReplSandboxTarget"
  Write-Log "goal patch mode: $goalPatchMode"
  if (-not [string]::IsNullOrWhiteSpace($goalTarget)) {
    Write-Log "goal patch target: $goalTarget"
  }

  return [pscustomobject]@{
    FastMode = @($fastModeTargets)
    PluginPatchMode = $pluginPatchMode
    PluginSidebar = $pluginSidebarTarget
    PluginSkills = $pluginSkillsTarget
    PluginDetail = $pluginDetailTarget
    PluginMarketplaceAuth = $pluginMarketplaceAuthTarget
    BrowserUseAvailability = $browserUseAvailabilityTarget
    BrowserPluginList = $browserPluginListTarget
    BrowserSidebarAvailability = $browserSidebarAvailabilityTarget
    BrowserSettings = $browserSettingsTarget
    BrowserMention = $browserMentionTarget
    LocaleSettings = $localeSettingsTarget
    NodeReplSandbox = $nodeReplSandboxTarget
    GoalPatchMode = $goalPatchMode
    Goal = $goalTarget
  }
}

function Invoke-NodePatcher {
  param(
    [string]$NodePath,
    [string]$ScriptPath,
    [string[]]$Arguments
  )
  $output = & $NodePath $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "node patcher failed: $ScriptPath"
  }
  return ($output -join "`n").Trim()
}

function Invoke-PatchAppAsar {
  param(
    [string]$WorkAppPath,
    [string]$SourceAppPath,
    [string]$WorkDir
  )
  $asarPath = Join-Path $WorkAppPath 'resources\app.asar'
  $extractDir = Join-Path $WorkDir 'asar-extracted'
  $newAsarPath = Join-Path $WorkDir 'app.asar'
  $rgPath = Join-Path $WorkAppPath 'resources\rg.exe'
  if (-not (Test-Path -LiteralPath $rgPath)) {
    $rgPath = Join-Path $SourceAppPath 'resources\rg.exe'
  }
  if (-not (Test-Path -LiteralPath $rgPath)) {
    $rgPath = (Get-RequiredCommand 'rg').Source
  }
  $nodePath = (Get-RequiredCommand 'node').Source

  if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
  }
  Write-Log 'extracting app.asar'
  Invoke-NpxAsar 'extract' $asarPath $extractDir
  $patchers = Write-PatcherFiles $WorkDir
  $targets = Find-PatchTargets $rgPath $extractDir

  $fastDetails = @()
  foreach ($fastTarget in @($targets.FastMode)) {
    $fastDetails += Invoke-NodePatcher $nodePath $patchers.Fast @($fastTarget)
  }
  $fast = if ($fastDetails -contains 'patched') { 'patched' } else { 'already-patched' }
  Write-Log "fast-mode patch result: $($fastDetails -join ', ')"
  if ($targets.PluginPatchMode -eq 'CurrentMarketplaceAuth') {
    $plugins = Invoke-NodePatcher $nodePath $patchers.Plugins @('--current-marketplace-auth', $targets.PluginMarketplaceAuth)
  } else {
    $plugins = Invoke-NodePatcher $nodePath $patchers.Plugins @($targets.PluginSidebar, $targets.PluginSkills, $targets.PluginDetail)
  }
  Write-Log "plugin patch result: $plugins"
  $browser = Invoke-NodePatcher $nodePath $patchers.Browser @(
    $targets.BrowserUseAvailability,
    $targets.BrowserSidebarAvailability,
    $targets.BrowserPluginList,
    $targets.BrowserSettings,
    $targets.BrowserMention,
    $targets.LocaleSettings
  )
  Write-Log "browser-use patch result: $browser"
  $nodeReplSandbox = Invoke-NodePatcher $nodePath $patchers.NodeRepl @($targets.NodeReplSandbox)
  Write-Log "node_repl disable-sandbox patch result: $nodeReplSandbox"
  if ($targets.GoalPatchMode -eq 'Skip') {
    $goal = 'already-patched'
    Write-Log 'goal patch result: skipped'
  } elseif ($targets.GoalPatchMode -eq 'SlashOnly') {
    $goal = Invoke-NodePatcher $nodePath $patchers.Goal @('--slash-only', $targets.Goal)
    Write-Log "goal patch result: $goal"
  } else {
    $goal = Invoke-NodePatcher $nodePath $patchers.Goal @($targets.Goal)
    Write-Log "goal patch result: $goal"
  }

  if ($DryRun) {
    Write-Log 'dry run: patch targets matched; no package was changed'
    return $false
  }

  if ($fast -eq 'already-patched' -and $plugins -eq 'already-patched' -and $browser -eq 'already-patched' -and $nodeReplSandbox -eq 'already-patched' -and $goal -eq 'already-patched') {
    Write-Log 'asar patch already present'
    return $false
  }

  Write-Log 'repacking app.asar'
  Invoke-NpxAsar 'pack' $extractDir $newAsarPath
  Copy-Item -LiteralPath $newAsarPath -Destination $asarPath -Force
  return $true
}

function Convert-BytesToHex {
  param([byte[]]$Bytes)
  return (($Bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-AsarHeaderSha256 {
  param([string]$AsarPath)
  $fs = [System.IO.File]::Open($AsarPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $pickleHeader = New-Object byte[] 16
    if ($fs.Read($pickleHeader, 0, 16) -ne 16) {
      Fail 'could not read asar pickle header'
    }
    # Electron hashes the ASAR JSON header, not the outer pickle-size fields.
    $headerSize = [BitConverter]::ToUInt32($pickleHeader, 12)
    if ($headerSize -le 0 -or $headerSize -gt ($fs.Length - 16)) {
      Fail "invalid asar JSON header size: $headerSize"
    }
    $headerBytes = New-Object byte[] $headerSize
    if ($fs.Read($headerBytes, 0, [int]$headerSize) -ne [int]$headerSize) {
      Fail 'could not read asar header bytes'
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return (Convert-BytesToHex $sha.ComputeHash($headerBytes))
    } finally {
      $sha.Dispose()
    }
  } finally {
    $fs.Dispose()
  }
}

function Update-CodexExeAsarIntegrity {
  param(
    [string]$ExePath,
    [string]$AsarHash
  )
  $bytes = [System.IO.File]::ReadAllBytes($ExePath)
  $text = [System.Text.Encoding]::ASCII.GetString($bytes)
  $pattern = '\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-fA-F]{64})"\}\]'
  $match = [regex]::Match($text, $pattern)
  if (-not $match.Success) {
    Write-Log 'Codex.exe ASAR integrity JSON not found; skipping ASAR integrity hash update'
    return
  }
  $oldHash = $match.Groups[1].Value
  if ($oldHash -eq $AsarHash) {
    Write-Log "Codex.exe asar integrity already current: $AsarHash"
    return
  }
  $oldBytes = [System.Text.Encoding]::ASCII.GetBytes($oldHash)
  $newBytes = [System.Text.Encoding]::ASCII.GetBytes($AsarHash)
  $pos = -1
  for ($i = 0; $i -le $bytes.Length - $oldBytes.Length; $i++) {
    $ok = $true
    for ($j = 0; $j -lt $oldBytes.Length; $j++) {
      if ($bytes[$i + $j] -ne $oldBytes[$j]) {
        $ok = $false
        break
      }
    }
    if ($ok) {
      $pos = $i
      break
    }
  }
  if ($pos -lt 0) {
    Fail 'could not locate ASAR integrity hash bytes in Codex.exe'
  }
  [Array]::Copy($newBytes, 0, $bytes, $pos, $newBytes.Length)
  [System.IO.File]::WriteAllBytes($ExePath, $bytes)
  Write-Log "updated Codex.exe asar integrity: $oldHash -> $AsarHash"
}

function Update-BrowserPluginManifest {
  param([string]$WorkPackageRoot)
  $manifestPath = Join-Path $WorkPackageRoot 'app\resources\plugins\openai-bundled\plugins\browser\.codex-plugin\plugin.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Fail "browser plugin manifest not found: $manifestPath"
  }

  $json = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $changed = $false
  if (-not $json.interface) {
    $json | Add-Member -NotePropertyName interface -NotePropertyValue ([pscustomobject]@{})
    $changed = $true
  }

  $desired = @{
    description = "Browser / browser-use 插件`n`n别名：@browser、@browser-use、browser-use、Browser、应用内浏览器。`n`n当用户要求打开、检查、导航、测试、点击、输入或截图 localhost、127.0.0.1、::1、file:// URL，或当前应用内浏览器标签页时，使用 Browser。"
  }
  foreach ($entry in $desired.GetEnumerator()) {
    $current = $json.PSObject.Properties[$entry.Key].Value
    if ($current -ne $entry.Value) {
      $json | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force
      $changed = $true
    }
  }

  $interfaceDesired = @{
    displayName = '浏览器'
    shortDescription = '让 Codex 控制应用内浏览器'
    longDescription = 'Browser 让 Codex 打开并控制应用内浏览器，主要用于本地开发页面和文件。它可以在 Codex 内导航、检查、点击、输入并截图。'
    developerName = 'OpenAI'
    category = '工程'
    defaultPrompt = @('测试我的 localhost 页面')
  }
  foreach ($entry in $interfaceDesired.GetEnumerator()) {
    if ($entry.Key -eq 'defaultPrompt') {
      $current = @($json.interface.defaultPrompt)
      if (($current -join "`n") -ne ($entry.Value -join "`n")) {
        $json.interface | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force
        $changed = $true
      }
    } else {
      $current = $json.interface.PSObject.Properties[$entry.Key].Value
      if ($current -ne $entry.Value) {
        $json.interface | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force
        $changed = $true
      }
    }
  }

  if ($changed) {
    $json | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-Log "browser plugin manifest localized: $manifestPath"
  } else {
    Write-Log 'browser plugin manifest already localized'
  }
}

function Get-ManifestPublisher {
  param([string]$WorkPackageRoot)
  $manifestPath = Join-Path $WorkPackageRoot 'AppxManifest.xml'
  [xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath
  return $manifest.Package.Identity.Publisher
}

function Get-OrCreateSigningCertificate {
  param([string]$Publisher)
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $Publisher } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if ($cert) {
    Write-Log "using existing signing certificate: $($cert.Thumbprint)"
    return $cert
  }
  Write-Log "creating signing certificate: $Publisher"
  return New-SelfSignedCertificate -Type CodeSigningCert -Subject $Publisher -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
}

function Trust-SigningCertificate {
  param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert)
  $tempCert = Join-Path $env:TEMP ('codex-msix-signing-' + $Cert.Thumbprint + '.cer')
  Export-Certificate -Cert $Cert -FilePath $tempCert -Force | Out-Null
  Import-Certificate -FilePath $tempCert -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
  if (Test-IsAdministrator) {
    Import-Certificate -FilePath $tempCert -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
  }
  Remove-Item -LiteralPath $tempCert -Force -ErrorAction SilentlyContinue
}

function Invoke-MakeAppxPack {
  param(
    [string]$MakeAppx,
    [string]$WorkPackageRoot,
    [string]$MsixPath
  )
  if (Test-Path -LiteralPath $MsixPath) {
    Remove-Item -LiteralPath $MsixPath -Force
  }
  Write-Log "packing MSIX: $MsixPath"
  & $MakeAppx pack /d $WorkPackageRoot /p $MsixPath /o
  if ($LASTEXITCODE -ne 0) {
    Fail "makeappx pack failed with exit code $LASTEXITCODE"
  }
}

function Invoke-SignPackage {
  param(
    [string]$SignTool,
    [string]$MsixPath,
    [System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert
  )
  Write-Log 'signing MSIX'
  & $SignTool sign /fd SHA256 /sha1 $Cert.Thumbprint $MsixPath
  if ($LASTEXITCODE -ne 0) {
    Fail "signtool sign failed with exit code $LASTEXITCODE"
  }
}

function Stop-CodexDesktopProcesses {
  param([string]$InstallLocation)
  $targetRoot = if ($InstallLocation) { $InstallLocation.TrimEnd('\') } else { $null }
  $processes = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and (
      ($targetRoot -and $_.Path.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) -or
      $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\Codex.exe'
    )
  }
  foreach ($p in $processes) {
    Write-Log "stopping Codex desktop process pid=$($p.Id)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
}

function Install-PatchedPackage {
  param(
    [string]$MsixPath,
    [string]$PackageFamilyName
  )
  $existing = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) {
    Stop-CodexDesktopProcesses $existing.InstallLocation
    Write-Log "removing existing package: $($existing.PackageFullName)"
    try {
      Remove-AppxPackage -Package $existing.PackageFullName -PreserveApplicationData -ErrorAction Stop
    } catch {
      Write-Log 'PreserveApplicationData is not supported here; retrying normal Remove-AppxPackage'
      Remove-AppxPackage -Package $existing.PackageFullName -ErrorAction Stop
    }
  }
  Write-Log "installing patched MSIX: $MsixPath"
  Add-AppxPackage -Path $MsixPath -ErrorAction Stop
  $installed = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Select-Object -First 1
  Write-Log "installed package: $($installed.PackageFullName)"
  if ($Launch -and -not $NoLaunch) {
    $exe = Join-Path $installed.InstallLocation 'app\Codex.exe'
    Write-Log "launching Codex: $exe"
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
  }
}

function Find-CodexCli {
  $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $binRoot) {
    $hit = Get-ChildItem -LiteralPath $binRoot -Recurse -Filter 'codex.exe' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($hit) {
      return $hit.FullName
    }
  }
  $cmd = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Add-LocalMarketplace {
  param(
    [string]$Source,
    [string]$Name
  )
  if (-not (Test-Path -LiteralPath (Join-Path $Source '.agents\plugins\marketplace.json'))) {
    Fail "local marketplace source does not contain .agents\plugins\marketplace.json: $Source"
  }
  $dest = Join-Path (Join-Path $env:USERPROFILE '.codex\marketplaces') $Name
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Write-Log "copying local marketplace: $Source -> $dest"
  & robocopy.exe $Source $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) {
    Fail "robocopy marketplace failed with exit code $LASTEXITCODE"
  }
  $jsonPath = Join-Path $dest '.agents\plugins\marketplace.json'
  $json = Get-Content -Raw -LiteralPath $jsonPath | ConvertFrom-Json
  $json.name = $Name
  if ($json.metadata -and $json.metadata.displayName -eq 'Codex official') {
    $json.metadata.displayName = 'Codex official local'
  }
  $json | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
  $codex = Find-CodexCli
  if (-not $codex) {
    Write-Log "codex CLI not found; marketplace copied but not registered: $dest"
    return
  }
  Write-Log "registering local marketplace: $Name"
  & $codex plugin marketplace add $dest
  if ($LASTEXITCODE -ne 0) {
    Write-Log "warning: marketplace registration returned exit code $LASTEXITCODE"
  }
}

function Invoke-FastModeVerification {
  $codex = Find-CodexCli
  if (-not $codex) {
    Write-Log 'fast verification skipped: codex CLI not found'
    return
  }

  $node = (Get-RequiredCommand 'node').Source
  $captureDir = Join-Path $env:TEMP ('codex-fast-wire-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $captureDir | Out-Null
  $serverPath = Join-Path $captureDir 'ws-capture-server.cjs'
  $logPath = Join-Path $captureDir 'frames.jsonl'
  $readyPath = $logPath + '.ready'

  $serverSource = @'
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");

const port = Number(process.argv[2]);
const outPath = process.argv[3];

function write(obj) {
  fs.appendFileSync(outPath, JSON.stringify(obj) + "\n");
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const b1 = buffer[offset++];
    const b2 = buffer[offset++];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let length = b2 & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.length) return { frames, rest: buffer.subarray(frameStart) };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) return { frames, rest: buffer.subarray(frameStart) };
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      offset += 8;
      length = high * 4294967296 + low;
    }
    let mask;
    if (masked) {
      if (offset + 4 > buffer.length) return { frames, rest: buffer.subarray(frameStart) };
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) return { frames, rest: buffer.subarray(frameStart) };
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, text: payload.toString("utf8") });
  }
  return { frames, rest: buffer.subarray(offset) };
}

const server = http.createServer((req, res) => {
  write({ kind: "http", method: req.method, url: req.url });
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket, head) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  write({ kind: "upgrade", url: req.url });
  let pending = Buffer.from(head || []);
  function consume(chunk) {
    if (chunk.length > 0) pending = Buffer.concat([pending, chunk]);
    const decoded = decodeFrames(pending);
    pending = Buffer.from(decoded.rest);
    for (const frame of decoded.frames) {
      if (frame.opcode === 1) write({ kind: "frame", text: frame.text });
      if (frame.opcode === 8) socket.destroy();
    }
  }
  if (pending.length > 0) consume(Buffer.alloc(0));
  socket.on("data", consume);
  setTimeout(() => socket.destroy(), 8000);
});

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(outPath + ".ready", "ready");
});

setTimeout(() => server.close(() => process.exit(0)), 15000).unref();
'@

  Set-Content -LiteralPath $serverPath -Value $serverSource -Encoding ASCII
  $port = Get-Random -Minimum 41000 -Maximum 49000
  $server = Start-Process -FilePath $node -ArgumentList @($serverPath, [string]$port, $logPath) -PassThru -WindowStyle Hidden
  $codexJob = $null

  try {
    $deadline = (Get-Date).AddSeconds(8)
    while (-not (Test-Path -LiteralPath $readyPath)) {
      if ($server.HasExited) {
        Fail 'fast verification capture server exited before it became ready'
      }
      if ((Get-Date) -gt $deadline) {
        Fail 'fast verification capture server did not become ready'
      }
      Start-Sleep -Milliseconds 100
    }

    Write-Log 'verifying Fast Mode by capturing Codex wire request service_tier'
    $baseUrlConfig = 'openai_base_url="http://127.0.0.1:' + $port + '/v1"'
    $wireTier = $null
    $codexJob = Start-Job -ScriptBlock {
      param([string]$CodexPath, [string]$BaseUrlConfig)
      & $CodexPath exec --json --skip-git-repo-check -c $BaseUrlConfig -c 'service_tier="fast"' -c 'model_reasoning_effort="low"' 'wire capture only' 2>&1 | Out-Null
    } -ArgumentList $codex, $baseUrlConfig

    $requestDeadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $requestDeadline -and -not $wireTier) {
      Start-Sleep -Milliseconds 200
      if (-not (Test-Path -LiteralPath $logPath)) {
        continue
      }
      foreach ($line in (Get-Content -LiteralPath $logPath)) {
        try {
          $entry = $line | ConvertFrom-Json -ErrorAction Stop
        } catch {
          continue
        }
        if ($entry.kind -ne 'frame' -or -not $entry.text) {
          continue
        }
        $match = [regex]::Match([string]$entry.text, '"service_tier"\s*:\s*"([^"]+)"')
        if ($match.Success) {
          $wireTier = $match.Groups[1].Value
          break
        }
      }
      if ($codexJob.State -in @('Completed', 'Failed', 'Stopped') -and -not $wireTier) {
        Start-Sleep -Milliseconds 300
        if ((Get-Date) -lt $requestDeadline) {
          continue
        }
        break
      }
    }

    if ($codexJob -and $codexJob.State -eq 'Running') {
      Stop-Job -Job $codexJob -ErrorAction SilentlyContinue
    }
    if (-not $wireTier) {
      Fail 'fast verification did not find service_tier in the captured request'
    }
    if ($wireTier -eq 'priority') {
      Write-Log 'fast verification: request wire service_tier=priority (Codex Fast Mode)'
    } elseif ($wireTier -eq 'fast') {
      Write-Log 'fast verification: request wire service_tier=fast'
    } else {
      Fail "fast verification captured unexpected service_tier=$wireTier"
    }

    if ($KeepWorkDir) {
      Write-Log "fast verification capture kept at: $captureDir"
    }
  } finally {
    if ($codexJob -and $codexJob.State -eq 'Running') {
      Stop-Job -Job $codexJob -ErrorAction SilentlyContinue
    }
    if ($codexJob) {
      Remove-Job -Job $codexJob -Force -ErrorAction SilentlyContinue
    }
    if ($server -and -not $server.HasExited) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $KeepWorkDir -and (Test-Path -LiteralPath $captureDir)) {
      Remove-Item -LiteralPath $captureDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Cleanup-WindowsSdk {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($winget) {
    Write-Log 'uninstalling Windows SDK via winget'
    & $winget.Source uninstall --id Microsoft.WindowsSDK.10.0.26100 -e --source winget --accept-source-agreements | Out-Host
  }
  $temp = Join-Path $env:TEMP 'windowssdk'
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$sourceApp = Find-CodexAppPath
$sourcePackageRoot = Get-PackageRoot $sourceApp
$packageShortId = Get-PackageShortId $sourcePackageRoot
$workRoot = Join-Path $OutputRoot $packageShortId
$workPackageRoot = Join-Path $workRoot 'package'
$workApp = Join-Path $workPackageRoot 'app'
$artifactsDir = Join-Path $workRoot 'artifacts'
$tempWork = Join-Path $workRoot ('work-' + [guid]::NewGuid().ToString('N'))
$msixPath = Join-Path $artifactsDir ($packageShortId + '_patched.msix')

Write-Log "source app: $sourceApp"
Write-Log "source package: $sourcePackageRoot"
Write-Log "output root: $workRoot"

if ($AddLocalPluginMarketplace) {
  Add-LocalMarketplace $LocalPluginMarketplaceSource $LocalPluginMarketplaceName
}

New-Item -ItemType Directory -Force -Path $artifactsDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempWork | Out-Null

try {
  Copy-PackageLayout $sourcePackageRoot $workPackageRoot
  Remove-OldPackageArtifacts $workPackageRoot

  $patched = Invoke-PatchAppAsar $workApp $sourceApp $tempWork
  $asar = Join-Path $workApp 'resources\app.asar'
  $exe = Join-Path $workApp 'Codex.exe'
  if (-not $DryRun) {
    Update-BrowserPluginManifest $workPackageRoot
    $asarHash = Get-AsarHeaderSha256 $asar
    Write-Log "app.asar header sha256: $asarHash"
    Update-CodexExeAsarIntegrity $exe $asarHash

    $makeappx = Require-WindowsSdkTool 'makeappx.exe'
    $signtool = Require-WindowsSdkTool 'signtool.exe'
    $publisher = Get-ManifestPublisher $workPackageRoot
    $cert = Get-OrCreateSigningCertificate $publisher
    Trust-SigningCertificate $cert
    Invoke-MakeAppxPack $makeappx $workPackageRoot $msixPath
    Invoke-SignPackage $signtool $msixPath $cert
    Write-Log "patched MSIX: $msixPath"

    if ($Install) {
      Install-PatchedPackage $msixPath 'OpenAI.Codex'
    }
  }

  if ($VerifyFastModeRequest) {
    Invoke-FastModeVerification
  }

  if ($CleanupWindowsSdkAfterInstall) {
    Cleanup-WindowsSdk
  }

  if ($CleanupAfter -and (Test-Path -LiteralPath $workRoot)) {
    Write-Log "cleanup build root: $workRoot"
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Log 'done'
} finally {
  if ($KeepWorkDir) {
    Write-Log "keeping workdir: $tempWork"
  } elseif (Test-Path -LiteralPath $tempWork) {
    Remove-Item -LiteralPath $tempWork -Recurse -Force -ErrorAction SilentlyContinue
  }
}
