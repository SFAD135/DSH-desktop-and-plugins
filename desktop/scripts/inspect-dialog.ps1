# Read back what a native dialog ACTUALLY renders.
#
# Why this exists: `dialog.showMessageBox` does not interpret Markdown, so a `detail`
# string containing emphasis markers shows literal asterisks. That shipped once — the
# first-run import prompt told every new user their data would be ``**复制**`` — and it is
# invisible to source review, because the *source* string is perfectly correct UTF-8.
# Only the rendered dialog can answer the question, so this dumps the dialog's UI
# Automation tree and reports whether any text still contains `**`.
#
# The app is launched against a scratch data root with a synthetic source home, so the
# user's real ~/.dsh is never read or written. ESC is sent at the end (不导入 = copy
# nothing) and the instance is killed, leaving nothing behind but the scratch tree.
#
# Usage: npm run inspect:dialog

$ErrorActionPreference = 'Continue'
# Derived from the script's own location, so it works from any working directory.
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\DeepSeek Harness'
$work = Join-Path $root 'build\inspect-dialog'
$port = 9342
$label = 'dump'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class IDlg {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<string> Dump() {
    List<string> rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (t.Length == 0) return true;
      rows.Add(t.ToString() + "\t" + h.ToString());
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@

if (-not (Test-Path $dist)) { Write-Output "没有构建产物：$dist（先跑 npm run build）"; exit 1 }

# A synthetic source home: `sessions/` stays an empty directory on purpose. It still
# counts as an import highlight, and it cannot poison the boot the way a fabricated
# session log does (the workspace plugin treats a bad Zstandard frame as fatal).
$data = Join-Path $work "$label\data"
$targetHome = Join-Path $work "$label\home"
$fakeUser = Join-Path $work "$label\user"
Remove-Item (Join-Path $work $label) -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $data 'shell') | Out-Null
New-Item -ItemType Directory -Force $targetHome | Out-Null
'{"port":0}' | Set-Content (Join-Path $data 'shell\shell-settings.json') -Encoding ASCII

$src = Join-Path $fakeUser '.dsh'
New-Item -ItemType Directory -Force (Join-Path $src 'sessions') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $src 'profiles\web') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $src 'storages') | Out-Null
'port: 0' | Set-Content (Join-Path $src 'settings.yaml') -Encoding ASCII
'{}' | Set-Content (Join-Path $src '.credentials.yaml') -Encoding ASCII

$env:DSH_DESKTOP_DATA = $data
$env:DSH_DESKTOP_HOME = $targetHome
$env:USERPROFILE = $fakeUser
$lp = Start-Process -FilePath (Join-Path $dist 'DeepSeek Harness.exe') -ArgumentList "--remote-debugging-port=$port" -PassThru
$lp.WaitForExit(20000) | Out-Null

Write-Output "== 等「导入已有数据」对话框 =="
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  foreach ($row in [IDlg]::Dump()) {
    $p = $row.Split("`t")
    if ($p[0].StartsWith('导入已有数据')) { $hwnd = [IntPtr][int64]$p[1] }
  }
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 500
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "  ✗ 没出现（应用可能没能启动）"; exit 1 }
Write-Output "  hwnd = $hwnd"

Write-Output ""
Write-Output "== 对话框实际渲染出的所有文本元素 =="
$rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$all = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  $name = $el.Current.Name
  $type = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
  if ($name -and $name.Trim().Length -gt 0) { Write-Output "  [$type] $name" }
}

Write-Output ""
$hasStars = $false
foreach ($el in $all) { if ($el.Current.Name -match '\*\*') { $hasStars = $true } }
Write-Output "== 含字面 '**' 的元素 = $hasStars （应为 False：原生对话框不渲染 Markdown） =="

[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Seconds 2
$ours = @(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" })
foreach ($p in $ours) { & taskkill /PID $p.ProcessId /T /F > $null 2>&1 }
Start-Sleep -Seconds 2
Write-Output "残留实例 = $(@(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" }).Count)"
Write-Output "用户真实 ~/.dsh 未被使用（USERPROFILE 已重定向到合成 home）"
