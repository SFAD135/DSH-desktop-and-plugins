# First-run import flow, end to end.
#
# Why this exists: the ordinary boot/acceptance paths all seed `imported-from.json` so the
# native "导入已有数据" dialog does not block them — which means the dialog every real new
# user meets is the one path nothing else covers. This script is that coverage: it starts
# from an empty home so the offer must appear, and exercises both answers.
#
# Two properties make it safe to run on a working machine:
#   * USERPROFILE is redirected for the child process, so DEFAULT_DSH_HOME resolves to a
#     synthetic source home. Nobody's real sessions or credentials are copied anywhere.
#   * The fixture keeps `sessions/` as an EMPTY directory. It still counts as an import
#     highlight, but it cannot poison the boot: the workspace plugin treats a bad
#     Zstandard frame in a session log as fatal (`invalid frame magic`), and a fabricated
#     log is exactly how that was discovered. `.credentials.yaml` must likewise be a YAML
#     *mapping*, not a scalar, or the credentials plugin refuses and the host never starts.
#
# Usage: npm run verify:first-run  [-- -Only decline|import]

param([string]$Only = '')

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\DeepSeek Harness'
$work = Join-Path $root 'build\first-run-test'
$port = 9341

$script:passed = 0
$script:failed = 0
function check([bool]$ok, [string]$label) {
  if ($ok) { $script:passed += 1; Write-Output "  ok   $label" }
  else { $script:failed += 1; Write-Output "  FAIL $label" }
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FR {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Dump() {
    List<string> rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (t.Length == 0) return true;
      StringBuilder c = new StringBuilder(256); GetClassNameW(h, c, 256);
      rows.Add(c.ToString() + "\t" + t.ToString() + "\t" + h.ToString());
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@

function Find-Window([string]$titlePrefix) {
  foreach ($row in [FR]::Dump()) {
    $parts = $row.Split("`t")
    if ($parts[1].StartsWith($titlePrefix)) {
      return @{ Handle = [IntPtr][int64]$parts[2]; Class = $parts[0]; Title = $parts[1] }
    }
  }
  return $null
}

function New-SyntheticSource([string]$fakeUser) {
  $src = Join-Path $fakeUser '.dsh'
  Remove-Item $src -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force (Join-Path $src 'sessions') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $src 'profiles\web') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $src 'storages') | Out-Null
  'workspace registry placeholder' | Set-Content (Join-Path $src 'storages\registry.txt') -Encoding ASCII
  'port: 0' | Set-Content (Join-Path $src 'settings.yaml') -Encoding ASCII
  'synthetic profile' | Set-Content (Join-Path $src 'profiles\web\marker.txt') -Encoding ASCII
  '{}' | Set-Content (Join-Path $src '.credentials.yaml') -Encoding ASCII
  return $src
}

function Run-Case([string]$label, [string]$key, [bool]$expectImport) {
  Write-Output ""
  Write-Output "[verify-first-run] $label (sending $key)"
  $data = Join-Path $work "$label\data"
  $targetHome = Join-Path $work "$label\home"
  $fakeUser = Join-Path $work "$label\user"

  Remove-Item (Join-Path $work $label) -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force (Join-Path $data 'shell') | Out-Null
  New-Item -ItemType Directory -Force $targetHome | Out-Null
  '{"port":0}' | Set-Content (Join-Path $data 'shell\shell-settings.json') -Encoding ASCII
  $source = New-SyntheticSource $fakeUser

  $env:DSH_DESKTOP_DATA = $data
  $env:DSH_DESKTOP_HOME = $targetHome
  $env:USERPROFILE = $fakeUser
  $lp = Start-Process -FilePath (Join-Path $dist 'DeepSeek Harness.exe') -ArgumentList "--remote-debugging-port=$port" -PassThru
  $lp.WaitForExit(20000) | Out-Null

  $dlg = $null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $dlg = Find-Window '导入已有数据'
    if ($dlg) { break }
    Start-Sleep -Milliseconds 500
  }
  check ($null -ne $dlg) '检测到已有数据时，首次启动会弹出导入询问'
  if (-not $dlg) {
    foreach ($row in [FR]::Dump()) { $parts = $row.Split("`t"); Write-Output "    [$($parts[0])] $($parts[1])" }
    return
  }
  check ($dlg.Class -eq '#32770') '对话框是原生 TaskDialog（class #32770）'

  # Read what the user actually sees. `showMessageBox` does not render Markdown, so a
  # `**emphasised**` run in the source text shows up as literal asterisks — the bug this
  # assertion exists to prevent from coming back.
  $r = New-Object FR+RECT
  [void][FR]::GetWindowRect($dlg.Handle, [ref]$r)
  [void][FR]::SetForegroundWindow($dlg.Handle)
  Start-Sleep -Milliseconds 700
  $wpx = $r.Right - $r.Left; $hpx = $r.Bottom - $r.Top
  if ($wpx -gt 0 -and $hpx -gt 0) {
    # Kept in its own directory rather than under $work: the case scratch is deleted after
    # a green run, and this is the only picture of a screen a user sees exactly once.
    $shotDir = Join-Path $root 'build\first-run-dialogs'
    New-Item -ItemType Directory -Force $shotDir | Out-Null
    $shot = Join-Path $shotDir "$label-dialog.png"
    $bmp = New-Object System.Drawing.Bitmap $wpx, $hpx
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($wpx, $hpx)))
    $g.Dispose(); $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Output "        截图 $shot"
  }
  $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($dlg.Handle)
  $els = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $text = ($els | ForEach-Object { $_.Current.Name }) -join "`n"
  check ($text -match '检测到已有 dsh 数据') '对话框正文是给用户看的说明'
  check ($text -match '来源：' -and $text -match '目标：') '对话框同时给出源与目标目录'
  $stars = $false
  foreach ($el in $els) { if ($el.Current.Name -match '\*\*') { $stars = $true } }
  check (-not $stars) '对话框文本里没有未渲染的 Markdown 标记'

  [void][FR]::SetForegroundWindow($dlg.Handle)
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait($key)
  Start-Sleep -Seconds 3

  $marker = Join-Path $targetHome 'imported-from.json'
  check (Test-Path $marker) '作答后写下了标记（不会重复询问）'
  if (Test-Path $marker) {
    $raw = Get-Content $marker -Raw
    if ($expectImport) { check ($raw -match 'importedFrom') '标记记录了导入来源' }
    else { check ($raw -match 'declinedAt') '标记记录了「不导入」' }
  }
  $hasSessions = Test-Path (Join-Path $targetHome 'sessions')
  if ($expectImport) {
    check (Test-Path (Join-Path $targetHome 'sessions')) '选择导入后会话目录出现在目标 home'
    check (Test-Path (Join-Path $targetHome 'settings.yaml')) '选择导入后设置出现在目标 home'
    check (Test-Path (Join-Path $targetHome '.credentials.yaml')) '选择导入后凭据出现在目标 home'
  } else {
    check (-not (Test-Path (Join-Path $targetHome 'sessions\ws'))) '选择不导入时没有复制任何会话'
  }
  check (Test-Path (Join-Path $source 'settings.yaml')) '源 home 只被读取，未被改动'

  $served = $false
  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    try {
      $list = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/list" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
      foreach ($t in $list) { if ($t.type -eq 'page' -and $t.url -like 'http://127.0.0.1*') { $served = $true } }
    } catch { }
    if ($served) { break }
    Start-Sleep -Seconds 2
  }
  check $served '作答后应用继续进入真实界面（导入的 home 可用）'

  $ours = @(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" })
  foreach ($p in $ours) { & taskkill /PID $p.ProcessId /T /F > $null 2>&1 }
  Start-Sleep -Seconds 3
  $left = @(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" })
  check ($left.Count -eq 0) '结束时没有残留实例'
}

if (-not (Test-Path $dist)) { Write-Output "没有构建产物：$dist（先跑 npm run build）"; exit 1 }
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

$realHome = Join-Path $env:USERPROFILE '.dsh'
$before = @(Get-ChildItem $realHome -Recurse -File -ErrorAction SilentlyContinue).Count

if ($Only -eq '' -or $Only -eq 'decline') { Run-Case 'decline' '{ESC}' $false }
if ($Only -eq '' -or $Only -eq 'import') { Run-Case 'import' '{ENTER}' $true }

Write-Output ""
Write-Output "[verify-first-run] confirming the real home was not involved"
$after = @(Get-ChildItem $realHome -Recurse -File -ErrorAction SilentlyContinue).Count
check ($after -eq $before) "用户真实 ~/.dsh 的文件数没有变化（$before -> $after）"
check (-not (Test-Path (Join-Path $realHome 'storages\registry.txt'))) '合成内容没有被写进用户的 home'

Write-Output ""
Write-Output "$script:passed/$($script:passed + $script:failed) checks passed"
if ($script:failed -gt 0) {
  Write-Output "[verify-first-run] kept $work for diagnosis (a failing run is worth reading)"
  exit 1
}
# ~14 MB per case is Chromium profile state, not evidence. The dialog screenshots were
# written to their own directory above and are deliberately not deleted with this.
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
exit 0
