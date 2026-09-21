# Remove the "workspace-health" DSH plugin from a profile.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# Deletes <profile>/node_modules/dsh-workspace-health and reverts the Loader row
# in <profile>/cordis.patch.yml (from the install-time backup when one exists,
# otherwise by removing the inserted lines).
#
# Its settings namespace goes away with the plugin: nothing else reads it, and
# the scan is republished from scratch on any future install.

[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 has no `utf8NoBOM` encoding name.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$packageName = 'dsh-workspace-health'
$rowId = 'workspace-health'

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$targetDir = Join-Path (Join-Path $profileDir 'node_modules') $packageName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$backupPath = "$patchPath.bak-$rowId"

Write-Host "[1/2] removing $targetDir"
if (Test-Path $targetDir) {
  Remove-Item $targetDir -Recurse -Force
  Write-Host "      removed"
} else {
  Write-Host "      not installed; nothing to remove"
}

Write-Host "[2/2] reverting $patchPath"
if (Test-Path $backupPath) {
  Copy-Item $backupPath $patchPath -Force
  Remove-Item $backupPath -Force
  Write-Host "      restored from backup"
} elseif (Test-Path $patchPath) {
  $yaml = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
  if ($yaml -match [regex]::Escape($packageName)) {
    $pattern = "(?m)^- insert:\r?\n[ \t]*- id: $rowId\r?\n[ \t]*name: '$packageName'\r?\n"
    $yaml = [regex]::Replace($yaml, $pattern, '')
    if ($yaml -notmatch '(?m)^[ \t]*-') { $yaml = $yaml.TrimEnd() + "`n[]`n" }
    [System.IO.File]::WriteAllText($patchPath, $yaml, $utf8NoBom)
    Write-Host "      removed the inserted row"
  } else {
    Write-Host "      no row found; nothing to revert"
  }
}

Write-Host ''
Write-Host "Restart DeepSeek Harness Desktop to unload the plugin."
