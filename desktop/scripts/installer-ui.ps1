# Drive and inspect a running installer window.
#
# Used by scripts/accept-install.mjs to verify what each installer page actually
# shows: every static label, every button, and — critically — whether 「下一步」
# is enabled. Reading a page this way is more precise than a screenshot (it
# proves the enabled state and the exact strings) and needs no image support.
#
# Usage:
#   pwsh -File scripts/installer-ui.ps1 -ProcessName test-setup
#   pwsh -File scripts/installer-ui.ps1 -ProcessName test-setup -SendKeys '{ENTER}'
#   pwsh -File scripts/installer-ui.ps1 -ProcessName test-setup -ClickId 1205
#   pwsh -File scripts/installer-ui.ps1 -ProcessName test-setup -ClickText '更改安装位置…'
#
# Output is UTF-8 JSON on stdout:
#   { "title": ..., "pid": ..., "controls": [ { class, text, enabled, visible, id, x, y, w, h } ] }
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [string]$SendKeys = '',
  [int]$ClickId = 0,
  [string]$ClickText = '',
  [int]$TimeoutSeconds = 10,
  [switch]$NoDump
)

$ErrorActionPreference = 'Stop'

# PowerShell encodes redirected stdout in the OEM code page by default, so the
# Chinese page text arrives as mojibake at any UTF-8 reader. Force UTF-8 so the
# JSON this script emits is decodable.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace DshUi -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
[DllImport("user32.dll")]
public static extern bool IsWindowEnabled(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern int GetDlgCtrlID(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")]
public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
'@

function Get-Text([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 2048
  [void][DshUi.Native]::GetWindowTextW($h, $sb, $sb.Capacity)
  $sb.ToString()
}
function Get-Class([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][DshUi.Native]::GetClassNameW($h, $sb, $sb.Capacity)
  $sb.ToString()
}

# Every descendant of the given window, however deep.
#
# EnumChildWindows already walks the whole subtree, so a single call covers MUI's
# nested page dialog. (Iterating FindWindowEx instead does NOT work here: passing
# $null for the class name binds as an empty string rather than NULL, so it
# matches nothing.)
function Get-Descendants([IntPtr]$root) {
  $script:descendants = New-Object System.Collections.ArrayList
  $script:descCallback = [DshUi.Native+EnumProc] {
    param([IntPtr]$h, [IntPtr]$l)
    [void]$script:descendants.Add($h)
    return $true
  }
  [void][DshUi.Native]::EnumChildWindows($root, $script:descCallback, [IntPtr]::Zero)
  return $script:descendants
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $proc) {
  Write-Output '{"error":"no window found"}'
  exit 1
}
$root = $proc.MainWindowHandle

if ($SendKeys -ne '') {
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate($proc.Id)
  Start-Sleep -Milliseconds 350
  $shell.SendKeys($SendKeys)
  Start-Sleep -Milliseconds 900
}

# BM_CLICK is POSTed rather than sent. A sent message blocks until the button's
# handler returns, and a page's leave function can raise a modal dialog — which
# would hang this process with the installer waiting on it. Posting also means the
# click works regardless of which window has focus, unlike SendKeys.
if ($ClickId -ne 0 -or $ClickText -ne '') {
  $target = [IntPtr]::Zero
  foreach ($h in Get-Descendants $root) {
    if ($ClickId -ne 0 -and [DshUi.Native]::GetDlgCtrlID($h) -eq $ClickId) { $target = $h; break }
    if ($ClickText -ne '' -and (Get-Text $h) -eq $ClickText) { $target = $h; break }
  }
  if ($target -eq [IntPtr]::Zero) {
    Write-Output '{"error":"control not found"}'
    exit 1
  }
  # A disabled button ignores BM_CLICK, which is exactly what the Node.js gate
  # assertions need to observe.
  [void][DshUi.Native]::PostMessageW($target, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
  Start-Sleep -Milliseconds 900
}

if ($NoDump) { Write-Output '{"ok":true}'; exit 0 }

$controls = New-Object System.Collections.ArrayList
foreach ($h in Get-Descendants $root) {
  $text = Get-Text $h
  $class = Get-Class $h
  if ($text -eq '' -and $class -notmatch 'Button|Edit') { continue }
  $rect = New-Object DshUi.Native+RECT
  [void][DshUi.Native]::GetWindowRect($h, [ref]$rect)
  [void]$controls.Add([ordered]@{
    class   = $class
    text    = $text
    enabled = [DshUi.Native]::IsWindowEnabled($h)
    visible = [DshUi.Native]::IsWindowVisible($h)
    id      = [DshUi.Native]::GetDlgCtrlID($h)
    x       = $rect.Left
    y       = $rect.Top
    w       = $rect.Right - $rect.Left
    h       = $rect.Bottom - $rect.Top
  })
}

$result = [ordered]@{
  title    = Get-Text $root
  pid      = $proc.Id
  controls = @($controls)
}
$result | ConvertTo-Json -Depth 5 -Compress
