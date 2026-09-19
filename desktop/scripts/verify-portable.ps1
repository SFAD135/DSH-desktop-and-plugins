# Portability: copy the green build elsewhere and run it there, in both data layouts.
#
# `app/data-root.js` resolves the data root in this order: an explicit DSH_DESKTOP_DATA,
# then `<exeDir>\data` **if that directory already exists**, otherwise the shared `~/.dsh`.
# So a copied build has two distinct behaviours and both are claims worth testing:
#
#   shared     — no `data` directory: the shell shares the dsh home with a command-line
#                `dsh`, which is the interop the desktop version exists to provide.
#   portable   — a `data` directory beside the executable: everything stays inside the
#                copied folder, and the existing home is offered for import exactly once.
#
# USERPROFILE is redirected for both runs, so "the shared home" is a synthetic one and the
# user's real ~/.dsh is neither read for import nor written to. The copy goes to another
# volume when one has room, because "copy it anywhere and double-click" is the actual claim.
#
# Usage: npm run verify:portable  [-- -Keep]

param([switch]$Keep)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\DeepSeek Harness'
$work = Join-Path $root 'build\portable-test'
$port = 9343

$script:passed = 0
$script:failed = 0
function check([bool]$ok, [string]$label) {
  if ($ok) { $script:passed += 1; Write-Output "  ok   $label" }
  else { $script:failed += 1; Write-Output "  FAIL $label" }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class PT {
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
      rows.Add(t.ToString());
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@

if (-not (Test-Path $dist)) { Write-Output "没有构建产物：$dist（先跑 npm run build）"; exit 1 }

# ── pick a target, preferring another volume ────────────────────────────────
$sourceDrive = (Get-Item $dist).PSDrive.Name
$target = $null
foreach ($d in (Get-PSDrive -PSProvider FileSystem)) {
  if ($d.Name -eq $sourceDrive -or $null -eq $d.Free -or $d.Free -lt 2GB) { continue }
  # Build the root by concatenation, NOT with `"${d.Name}:\"`. `${...}` is
  # variable-*name* syntax, so `${d.Name}` names a variable called `d.Name` — it does not
  # read the property, it expands to the empty string. That silently made this whole loop
  # fall through to the in-project fallback on every run (and would have produced the
  # nonsense path `:\dsh-portable-test\...` had the guard not caught it first).
  $volumeRoot = $d.Name + ':\'
  if (-not (Test-Path -LiteralPath $volumeRoot)) { continue }
  $target = Join-Path (Join-Path $volumeRoot 'dsh-portable-test') 'DeepSeek Harness'
  Write-Output "[verify-portable] copying to $volumeRoot ($([math]::Round($d.Free/1GB,1)) GB free); source is on ${sourceDrive}:"
  break
}
if (-not $target) {
  $target = Join-Path (Join-Path $work 'copy') 'DeepSeek Harness'
  Write-Output "[verify-portable] no second volume with room; copying inside the project instead"
}
$holder = Split-Path $target -Parent
# Qualified straight off the path, because $holder does not exist yet at this point.
$targetDrive = (Split-Path -Qualifier $holder).TrimEnd(':')
# Stated as a check, not just a log line: the claim is "copy it to any folder on any
# volume and double-click", and the volume-selection loop above silently degraded to the
# in-project fallback for a while without anything turning red. If a second volume with
# room exists, the copy MUST land there.
$secondVolume = @(Get-PSDrive -PSProvider FileSystem |
  Where-Object { $_.Name -ne $sourceDrive -and $null -ne $_.Free -and $_.Free -ge 2GB }).Count -gt 0
if ($secondVolume) {
  check ($targetDrive -ne $sourceDrive) "副本落在了另一个卷上（${targetDrive}: ,源在 ${sourceDrive}:）"
} else {
  Write-Output "        （本机没有第二个有空间的卷，跳过跨卷断言）"
}
Remove-Item $holder -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $holder | Out-Null

Write-Output ""
Write-Output "[verify-portable] copying"
$t0 = Get-Date
& robocopy $dist $target /E /NFL /NDL /NJH /NJS /MT:16 /R:1 /W:1 > $null 2>&1
$rc = $LASTEXITCODE
check ($rc -lt 8) "robocopy 成功（退出码 $rc）"
$srcCount = @(Get-ChildItem $dist -Recurse -File -ErrorAction SilentlyContinue).Count
$dstCount = @(Get-ChildItem $target -Recurse -File -ErrorAction SilentlyContinue).Count
check ($srcCount -eq $dstCount) "副本文件数与源一致（$dstCount）"
Write-Output "        $([math]::Round(((Get-Date) - $t0).TotalSeconds,1)) 秒"

$shellApp = Join-Path $target 'resources\app'
$hits = @(Get-ChildItem $shellApp -Recurse -File -Include *.js,*.json,*.html -ErrorAction SilentlyContinue |
  Select-String -Pattern [regex]::Escape($root) -List -ErrorAction SilentlyContinue)
check ($hits.Count -eq 0) '副本的外壳里没有指向构建目录的绝对路径'

# ── one launch: USERPROFILE redirected, shell state relocated only where needed ──
function Invoke-Copy([string]$label, [bool]$expectDialog, [bool]$expectPortableLayout, [bool]$isolateShell) {
  Write-Output ""
  Write-Output "[verify-portable] $label"
  # `sessions/` plus a settings file make a believable existing home. The profile
  # directory is deliberately NOT pre-created: an empty `profiles/web` is not something a
  # real home contains, and it changes what the shell initializes for itself.
  $fakeUser = Join-Path $work "$label\user"
  New-Item -ItemType Directory -Force (Join-Path $fakeUser '.dsh\sessions') | Out-Null
  'port: 0' | Set-Content (Join-Path $fakeUser '.dsh\settings.yaml') -Encoding ASCII
  '{}' | Set-Content (Join-Path $fakeUser '.dsh\.credentials.yaml') -Encoding ASCII

  # In the shared layout this shell's own state (settings, logs, Chromium profile) would go
  # under the real %APPDATA% — Electron does not take that path from USERPROFILE — so that
  # run relocates it explicitly with `--user-data-dir`. The portable layout already keeps
  # it inside the copy, and asserting exactly that is one of the checks, so there the flag
  # is deliberately NOT passed. Either way the dsh home still comes from the data-root rule
  # under test, which is the point of the run.
  $shellState = Join-Path $work "$label\shellstate"
  New-Item -ItemType Directory -Force $shellState | Out-Null
  $launchArgs = @("--remote-debugging-port=$port")
  if ($isolateShell) { $launchArgs += "--user-data-dir=`"$shellState`"" }

  $env:USERPROFILE = $fakeUser
  Remove-Item Env:DSH_DESKTOP_DATA -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_DESKTOP_HOME -ErrorAction SilentlyContinue
  $lp = Start-Process -FilePath (Join-Path $target 'DeepSeek Harness.exe') -ArgumentList $launchArgs -PassThru
  $lp.WaitForExit(20000) | Out-Null
  check ($lp.ExitCode -eq 0) '从副本启动、启动器退出码 0'

  $seen = $false
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    foreach ($t in [PT]::Dump()) { if ($t.StartsWith('导入已有数据')) { $seen = $true } }
    if ($seen) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($seen) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Seconds 3 }
  if ($expectDialog) { check $seen '便携布局下弹出一次导入询问（源与目标不同）' }
  else { check (-not $seen) '共享布局下不弹询问（源与目标都是同一个 home）' }

  $served = $false; $url = ''
  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    try {
      $list = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/list" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
      foreach ($t in $list) { if ($t.type -eq 'page' -and $t.url -like 'http://127.0.0.1*') { $served = $true; $url = $t.url } }
    } catch { }
    if ($served) { break }
    Start-Sleep -Seconds 2
  }
  check $served "副本进入真实界面（$url）"
  if (-not $served) {
    Write-Output "        --- 外壳日志尾部（诊断） ---"
    $logDir = if ($isolateShell) { Join-Path $shellState 'logs' } else { Join-Path $target 'data\shell\logs' }
    $newest = Get-ChildItem $logDir -Filter 'desktop-*' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime | Select-Object -Last 1
    if ($newest) {
      [System.IO.File]::ReadAllLines($newest.FullName, [System.Text.Encoding]::UTF8) |
        Select-Object -Last 20 | ForEach-Object { Write-Output "        $_" }
    } else { Write-Output "        （$logDir 下没有日志）" }
  }
  if ($served) {
    # A page can be navigated but not yet painted, so verify-gui is retried rather than
    # judged on whichever instant the poll above happened to land on.
    $guiOk = $false
    for ($i = 0; $i -lt 6 -and -not $guiOk; $i++) {
      $out = & node (Join-Path $root 'scripts\verify-gui.mjs') --port $port --mode harness 2>&1
      $guiOk = $LASTEXITCODE -eq 0
      if (-not $guiOk) { Start-Sleep -Seconds 10 }
    }
    if (-not $guiOk) { $out | Select-Object -Last 14 | ForEach-Object { Write-Output "        $_" } }
    check $guiOk 'verify-gui 通过（真实渲染的页面）'
  }

  $copyData = Join-Path $target 'data'
  if ($expectPortableLayout) {
    check (Test-Path (Join-Path $copyData 'dsh-home')) '便携布局：会话与设置落在副本旁边的 data\dsh-home'
    check (Test-Path (Join-Path $copyData 'shell')) '便携布局：外壳状态落在副本旁边的 data\shell'
    check (-not (Test-Path (Join-Path $fakeUser '.dsh\imported-from.json'))) '便携布局：没有往共享 home 写标记'
  } else {
    check (-not (Test-Path $copyData)) '共享布局：副本旁边没有被创建 data 目录'
  }

  @(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" }) |
    ForEach-Object { & taskkill /PID $_.ProcessId /T /F > $null 2>&1 }
  Start-Sleep -Seconds 3
  $left = @(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" })
  check ($left.Count -eq 0) '结束时没有残留实例'
}

Invoke-Copy 'shared' $false $false $true

Write-Output ""
Write-Output "[verify-portable] creating a data directory beside the executable (the portable switch)"
New-Item -ItemType Directory -Force (Join-Path $target 'data') | Out-Null
Invoke-Copy 'portable' $true $true $false

check (-not (Test-Path 'HKCU:\Software\DeepSeek Harness')) '不需要注册表安装项'
check (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeek Harness')) '不需要「应用和功能」卸载项'

Write-Output ""
if ($Keep) { Write-Output "[verify-portable] kept the copy at $holder" }
else {
  Remove-Item $holder -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "[verify-portable] removed the copy at $holder"
}
if ($script:failed -gt 0) {
  Write-Output "[verify-portable] kept $work for diagnosis (a failing run is worth reading)"
} else {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "$script:passed/$($script:passed + $script:failed) checks passed"
if ($script:failed -gt 0) { exit 1 }
exit 0
