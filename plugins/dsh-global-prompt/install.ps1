# Install the "global-prompt" DSH plugin into a profile.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome 'D:\tools\DSH Desktop\data\dsh-home' -ProfileName web
#
# Idempotent: copies the package into <profile>/node_modules and inserts one
# Loader row into <profile>/cordis.patch.yml, backing that file up first.
# Run uninstall.ps1 to revert both.

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

$packageName = 'dsh-global-prompt'
$rowId = 'global-prompt'
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

Write-Host "[1/3] copying plugin -> $targetDir"
New-Item -ItemType Directory -Force -Path (Join-Path $targetDir 'lib') | Out-Null
Copy-Item (Join-Path $sourceDir 'package.json') (Join-Path $targetDir 'package.json') -Force
Copy-Item (Join-Path $sourceDir 'lib\index.js') (Join-Path $targetDir 'lib\index.js') -Force
Copy-Item (Join-Path $sourceDir 'lib\client.js') (Join-Path $targetDir 'lib\client.js') -Force
foreach ($extra in @('verify.mjs', 'preflight.mjs')) {
  if (Test-Path (Join-Path $sourceDir $extra)) {
    Copy-Item (Join-Path $sourceDir $extra) (Join-Path $targetDir $extra) -Force
  }
}

Write-Host "[2/3] patching $patchPath"
if ((Test-Path $patchPath) -and -not (Test-Path $backupPath)) {
  Copy-Item $patchPath $backupPath -Force
  Write-Host "      backup written: $backupPath"
}

$yaml = if (Test-Path $patchPath) { Get-Content $patchPath -Raw } else { '' }
if ($null -eq $yaml) { $yaml = '' }

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

Write-Host "[3/3] done"
Write-Host ''
Write-Host "Next: restart DeepSeek Harness Desktop (a new Loader row is composed at startup)."
Write-Host "Then refresh the Web GUI and look for the '$rowId' button at the left of the composer."
Write-Host "Settings live in: $(Join-Path $DshHome 'settings.yaml')  (namespace: $rowId)"
