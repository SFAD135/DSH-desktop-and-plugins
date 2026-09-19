# Create a desktop shortcut for the portable DeepSeek Harness build.
#
# Usage: right-click -> "Run with PowerShell", or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "创建桌面快捷方式.ps1"

$ErrorActionPreference = 'Stop'

$target = Join-Path $PSScriptRoot 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $target)) {
  $fallback = Join-Path $PSScriptRoot 'electron-core.exe'
  if (Test-Path -LiteralPath $fallback) { $target = $fallback }
  else { throw "找不到 DeepSeek Harness.exe，请在解压后的完整目录中运行本脚本。" }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'DeepSeek Harness.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = "$target,0"
$shortcut.Description = 'DeepSeek Harness 桌面版'
$shortcut.Save()

Write-Host "已创建桌面快捷方式：$link"
Write-Host "目标：$target"
