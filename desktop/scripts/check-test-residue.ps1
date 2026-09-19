# Did the acceptance scripts leave anything behind on the real machine?
#
# The scripts under test are supposed to be isolated: USERPROFILE is redirected to a
# synthetic home, the dsh home is redirected explicitly, and (for the shared layout) the
# shell's own state is moved with --user-data-dir. "Supposed to" is exactly the kind of
# claim that quietly stops being true, so this checks it from the outside instead of
# trusting the scripts' own assertions.
#
# Read-only: it reports, it does not clean. Deciding what is mine and what is the user's
# is a judgement call, and an automated cleaner would get it wrong eventually.

$script:bad = 0
function bad([string]$msg) { $script:bad += 1; Write-Output "  ⚠ $msg" }
function ok([string]$msg) { Write-Output "  ok $msg" }

# Derived from the script's own location so the check keeps working after the project is
# moved. It is only used for display, but a hardcoded path here would be a landmine: the
# whole point of this script is to be trustworthy evidence, and a stale path makes the
# "which directory is this about?" answer silently wrong.
$project = Split-Path -Parent $PSScriptRoot
$scratchMarkers = @(
  'dsh-portable-test',
  'build\portable-test',
  'build\first-run-test',
  'build\boot-test',
  'build\inspect-dialog'
)
function Test-Scratch([string]$text) {
  foreach ($m in $scratchMarkers) { if ($text -like "*$m*") { return $true } }
  return $false
}

Write-Output "== 1. 真实 %APPDATA%\DeepSeek Harness 里有没有指向测试目录的痕迹 =="
$appData = Join-Path $env:APPDATA 'DeepSeek Harness'
if (-not (Test-Path $appData)) { ok '目录不存在' }
else {
  $hit = 0
  Get-ChildItem $appData -Recurse -File -Include *.log,*.json -ErrorAction SilentlyContinue | ForEach-Object {
    $txt = ''
    try { $txt = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8) } catch { }
    if (Test-Scratch $txt) { $hit += 1; bad "日志/配置里出现测试路径：$($_.FullName.Replace($appData,'.'))" }
  }
  if ($hit -eq 0) { ok "没有指向测试目录的日志或配置（共扫描 $(@(Get-ChildItem $appData -Recurse -File -Include *.log,*.json -ErrorAction SilentlyContinue).Count) 个文件）" }
  # DevToolsActivePort is created by --remote-debugging-port; if a test instance used the
  # real profile this file's timestamp moves. Report it, do not judge it.
  $dap = Join-Path $appData 'DevToolsActivePort'
  if (Test-Path $dap) { Write-Output "     （参考）DevToolsActivePort 修改于 $((Get-Item $dap).LastWriteTime)" }
}

Write-Output ""
Write-Output "== 2. 用户真实 ~/.dsh =="
$realHome = Join-Path $env:USERPROFILE '.dsh'
if (-not (Test-Path $realHome)) { ok '目录不存在' }
else {
  $files = @(Get-ChildItem $realHome -Recurse -File -ErrorAction SilentlyContinue)
  $sessions = @(Get-ChildItem (Join-Path $realHome 'sessions') -Recurse -File -ErrorAction SilentlyContinue)
  ok "文件数 $($files.Count)，其中 sessions $($sessions.Count)"
  $marker = Join-Path $realHome 'imported-from.json'
  if (Test-Path $marker) { bad "真实 home 里被写了 imported-from.json：$((Get-Content $marker -Raw).Trim())" }
  else { ok '没有被写入 imported-from.json（导入测试没有碰真实 home）' }
  foreach ($m in @('storages\registry.txt','profiles\web\marker.txt')) {
    if (Test-Path (Join-Path $realHome $m)) { bad "合成夹具内容出现在真实 home：$m" }
  }
  $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 3
  Write-Output "     （参考）最近修改："
  $newest | ForEach-Object { Write-Output "       $($_.LastWriteTime)  $($_.FullName.Replace($realHome,'.'))" }
}

Write-Output ""
Write-Output "== 3. 测试用的临时目录（失败时应当保留，成功时应当清掉） =="
foreach ($d in @('build\portable-test','build\first-run-test','build\inspect-dialog','C:\dsh-portable-test')) {
  if (Test-Path $d) {
    $sz = [math]::Round((@(Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue) | Measure-Object Length -Sum).Sum/1MB, 1)
    Write-Output "     存在 $d  ($sz MB)"
  } else { Write-Output "     已清理 $d" }
}

Write-Output ""
Write-Output "== 4. 归属测试进程的残留实例 =="
$strays = @(Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match 'remote-debugging-port=(9339|9341|9342|9343|9344)'
})
if ($strays.Count -eq 0) { ok '没有残留的测试实例' }
else { foreach ($p in $strays) { bad "残留 pid=$($p.ProcessId)：$($p.CommandLine)" } }

Write-Output ""
Write-Output "== 5. 注册表（便携版不该碰） =="
foreach ($k in @('HKCU:\Software\DeepSeek Harness','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeek Harness')) {
  if (Test-Path $k) { bad "存在键 $k" } else { ok "没有 $($k.Replace('HKCU:\',''))" }
}

Write-Output ""
if ($script:bad -eq 0) { Write-Output "干净：没有发现测试留下的外部痕迹" }
else { Write-Output "发现 $script:bad 处需要处理" }
