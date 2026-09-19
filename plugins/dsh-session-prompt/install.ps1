# Install the "session-prompt" DSH plugin into a profile.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome 'D:\tools\DSH Desktop\data\dsh-home' -ProfileName web
#
# Idempotent: copies the package into <profile>/node_modules and inserts one
# Loader row into <profile>/cordis.patch.yml, backing that file up first.
# It also removes the superseded "dsh-global-prompt" plugin (both its package
# directory and its Loader row) when that earlier version is still installed --
# leaving it in place would keep injecting a global prompt into every session.
# Run uninstall.ps1 to revert.

[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 has no `utf8NoBOM` encoding name; write UTF-8 without a
# BOM explicitly so the YAML parser never sees one.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

$packageName = 'dsh-session-prompt'
$rowId = 'session-prompt'
$legacyPackage = 'dsh-global-prompt'
$legacyRowId = 'global-prompt'
$sourceDir = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
  Write-Host "DSH_HOME is not set; falling back to $DshHome" -ForegroundColor Yellow
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "profile directory not found: $profileDir (is '$ProfileName' the right profile name?)"
}

$modulesDir = Join-Path $profileDir 'node_modules'
$targetDir = Join-Path $modulesDir $packageName
$legacyDir = Join-Path $modulesDir $legacyPackage
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$backupPath = "$patchPath.bak-$rowId"

# -- 0. migrate away from the superseded global-prompt plugin ----------------
if (Test-Path $legacyDir) {
  Write-Host "[0/4] removing superseded plugin -> $legacyDir"
  Remove-Item $legacyDir -Recurse -Force
} else {
  Write-Host "[0/4] no superseded plugin installed"
}

# -- 1. copy this plugin ----------------------------------------------------
Write-Host "[1/4] copying plugin -> $targetDir"
New-Item -ItemType Directory -Force -Path (Join-Path $targetDir 'lib') | Out-Null
Copy-Item (Join-Path $sourceDir 'package.json') (Join-Path $targetDir 'package.json') -Force
Copy-Item (Join-Path $sourceDir 'lib\index.js') (Join-Path $targetDir 'lib\index.js') -Force
Copy-Item (Join-Path $sourceDir 'lib\client.js') (Join-Path $targetDir 'lib\client.js') -Force
foreach ($extra in @('verify.mjs', 'preflight.mjs', 'uninstall.ps1', 'README.md', 'VERIFICATION.md')) {
  if (Test-Path (Join-Path $sourceDir $extra)) {
    Copy-Item (Join-Path $sourceDir $extra) (Join-Path $targetDir $extra) -Force
  }
}

# -- 2. patch the loader row ------------------------------------------------
Write-Host "[2/4] patching $patchPath"
if ((Test-Path $patchPath) -and -not (Test-Path $backupPath)) {
  Copy-Item $patchPath $backupPath -Force
  Write-Host "      backup written: $backupPath"
}

$yaml = if (Test-Path $patchPath) { Get-Content $patchPath -Raw } else { '' }
if ($null -eq $yaml) { $yaml = '' }

# Drop the legacy row, if the earlier install put one here.
if ($yaml -match [regex]::Escape($legacyPackage)) {
  $legacyPattern = "(?m)^- insert:\r?\n[ \t]*- id: $legacyRowId\r?\n[ \t]*name: '$legacyPackage'\r?\n"
  $yaml = [regex]::Replace($yaml, $legacyPattern, '')
  Write-Host "      removed the superseded '$legacyRowId' row"
}

if ($yaml -match [regex]::Escape($packageName)) {
  Write-Host "      row already present; leaving the patch layer untouched"
} else {
  $block = "- insert:`n    - id: $rowId`n      name: '$packageName'"
  if ($yaml -match '(?m)^[ \t]*\[[ \t]*\][ \t]*\r?$') {
    $yaml = [regex]::Replace($yaml, '(?m)^[ \t]*\[[ \t]*\][ \t]*\r?$', $block, 1)
  } else {
    if ($yaml.Length -gt 0 -and -not $yaml.EndsWith("`n")) { $yaml += "`n" }
    $yaml += $block + "`n"
  }
  if (-not $yaml.EndsWith("`n")) { $yaml += "`n" }
  Write-TextNoBom $patchPath $yaml
  Write-Host "      inserted row: id=$rowId name=$packageName"
}

# -- 3. done ----------------------------------------------------------------
Write-Host "[3/4] done"
Write-Host ''
Write-Host "Next: restart DeepSeek Harness Desktop (a new Loader row is composed at startup)."
Write-Host "Then refresh the Web GUI and look for the session-prompt button (labelled in Chinese) at the left of the composer."
Write-Host "Settings live in: $(Join-Path $DshHome 'settings.yaml')  (namespace: $rowId)"
Write-Host ''
$settingsPath = Join-Path $DshHome 'settings.yaml'
if ((Test-Path $settingsPath) -and ((Get-Content $settingsPath -Raw) -match '(?m)^global-prompt:')) {
  Write-Host "Note: a leftover 'global-prompt:' section is still in settings.yaml. It is inert"
  Write-Host "      now that the plugin is gone, and can be deleted by hand."
}
