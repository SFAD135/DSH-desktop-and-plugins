# Install the "workspace-health" DSH plugin into a profile.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome 'D:\tools\DSH Desktop\data\dsh-home' -ProfileName web
#
# Idempotent: copies the package into <profile>/node_modules and inserts one
# Loader row into <profile>/cordis.patch.yml, backing that file up first.
# Run uninstall.ps1 to revert.
#
# Only the files this package ships are copied -- never the whole directory --
# so a development `node_modules` junction (used to run verify.mjs offline)
# stays out of the installed tree.
#
# This package has both halves: the host half publishes the scan, the browser
# half renders the Settings page. Both files are copied below.

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

$packageName = 'dsh-workspace-health'
$rowId = 'workspace-health'
$sourceDir = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
  Write-Host "DSH_HOME is not set; falling back to $DshHome" -ForegroundColor Yellow
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "profile directory not found: $profileDir (is '$ProfileName' the right profile name?)"
}

$targetDir = Join-Path (Join-Path $profileDir 'node_modules') $packageName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$backupPath = "$patchPath.bak-$rowId"

# -- 1. copy this plugin ----------------------------------------------------
Write-Host "[1/3] copying plugin -> $targetDir"
New-Item -ItemType Directory -Force -Path (Join-Path $targetDir 'lib') | Out-Null
Copy-Item (Join-Path $sourceDir 'package.json') (Join-Path $targetDir 'package.json') -Force
Copy-Item (Join-Path $sourceDir 'lib\index.js') (Join-Path $targetDir 'lib\index.js') -Force
Copy-Item (Join-Path $sourceDir 'lib\client.js') (Join-Path $targetDir 'lib\client.js') -Force
foreach ($extra in @('verify.mjs', 'uninstall.ps1', 'README.md')) {
  if (Test-Path (Join-Path $sourceDir $extra)) {
    Copy-Item (Join-Path $sourceDir $extra) (Join-Path $targetDir $extra) -Force
  }
}

# -- 2. patch the loader row ------------------------------------------------
Write-Host "[2/3] patching $patchPath"
if ((Test-Path $patchPath) -and -not (Test-Path $backupPath)) {
  Copy-Item $patchPath $backupPath -Force
  Write-Host "      backup written: $backupPath"
}

# Read as UTF-8 explicitly: the patch layer carries Chinese comments and a
# default-encoding read would mangle them on a non-UTF-8 code page.
$yaml = ''
if (Test-Path $patchPath) {
  $yaml = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
}

if ($yaml -match [regex]::Escape($packageName)) {
  Write-Host "      row already present; leaving the patch layer untouched"
} else {
  $block = "- insert:`n    - id: $rowId`n      name: '$packageName'"
  if ($yaml -match '(?m)^[ \t]*\[[ \t]*\]\s*\r?$') {
    # An empty entry list is the profile's initial state; replace it in place.
    $yaml = [regex]::Replace($yaml, '(?m)^[ \t]*\[[ \t]*\]\s*\r?$', $block, 1)
  } else {
    if ($yaml.Length -gt 0 -and -not $yaml.EndsWith("`n")) { $yaml += "`n" }
    $yaml += $block + "`n"
  }
  if (-not $yaml.EndsWith("`n")) { $yaml += "`n" }
  Write-TextNoBom $patchPath $yaml
  Write-Host "      inserted row: id=$rowId name=$packageName"
}

# -- 3. done ----------------------------------------------------------------
Write-Host "[3/3] done"
Write-Host ''
Write-Host "The 'web' profile reloads user patches live, so the host half normally"
Write-Host "hot-mounts. Refresh the Web GUI, then open Settings -- a page labelled"
Write-Host "'工作区健康' appears next to the shipped ones. Restart the desktop app if it"
Write-Host "does not show up. The page stays empty until the first scan publishes,"
Write-Host "which happens at load and every 10 seconds after."
