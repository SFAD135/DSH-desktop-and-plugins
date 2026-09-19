'use strict';
/**
 * Talking to the Windows desktop shell about windows.
 *
 * This is a **test-only** helper: the shell no longer probes or repairs these launches
 * (see `app/open-diagnostics.js` for why). It is what lets
 * `scripts/test-explorer-open.mjs` assert, against a real desktop, that the bundled
 * runtime's patch really produces a **visible** window — the oracle being shared is
 * what makes the assertion trustworthy, since the same enumeration proves a window is
 * visible and proves a hidden one is not.
 *
 * Two capabilities live here, both needed to tell "the user can see it" from "a window
 * exists somewhere":
 *
 *   - **ask** which Explorer windows are really on screen, and which are hidden or
 *     minimized, so a launch can be verified instead of assumed;
 *   - **open** a folder through a documented argument (`explorer.exe <folder>`), and
 *     **restore** a window that already exists, as the two repairs.
 *
 * ## Why the obvious oracle is wrong
 *
 * `Shell.Application.Windows()` is the natural way to ask "is this folder open?", but it
 * includes windows that are invisible — it lists a window whose `IsWindowVisible` is
 * false, and it lists a *minimized* window as if it were on screen. A probe built on it
 * reported "the folder is already open" for windows the user could not see, which is
 * precisely how a click turned into nothing happening. Measurements that motivated this:
 *
 *   - `Shell.Application.Windows()` returned 7 entries while 0 were visible on screen;
 *   - a launch with `windowsHide: true` produces a real `CabinetWClass` window with
 *     `visible: false` and the correct title — created, registered, never shown;
 *   - `Shell.Application`'s `HWND` values do not line up with what enumeration sees, so
 *     visibility must come from enumeration and the folder from the shell collection,
 *     joined by handle.
 *
 * Hence: `EnumWindows` + `IsWindowVisible` + `IsIconic` decide what the user can see,
 * and `Shell.Application` is used only to map a handle to the folder it displays.
 *
 * Every call is asynchronous: a synchronous PowerShell call would block the caller for
 * as long as it takes.
 *
 * @module dsh-desktop/scripts/explorer-desktop
 */
const { execFile, spawn } = require('node:child_process');

const PROBE_TIMEOUT_MS = 20000;

/**
 * The P/Invoke surface and helpers shared by every PowerShell call in this module.
 * ASCII only, and it declares the console's output encoding as UTF-8 — Windows
 * PowerShell writes a redirected stdout in the *console* codepage (`gb2312` on the
 * machine this was written for) while Node reads UTF-8, which turned non-ASCII folder
 * names into mojibake that never matched.
 */
const PS_HEADER = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -Namespace Dsh -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, System.IntPtr p);
public delegate bool EnumWindowsProc(System.IntPtr h, System.IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
function Get-DshExplorerWindows {
  $list = New-Object System.Collections.ArrayList
  $cb = [Dsh.W+EnumWindowsProc]{ param($h,$p)
    $c = New-Object System.Text.StringBuilder 256
    [void][Dsh.W]::GetClassNameW($h,$c,256)
    if($c.ToString() -eq 'CabinetWClass'){
      $t = New-Object System.Text.StringBuilder 512
      [void][Dsh.W]::GetWindowTextW($h,$t,512)
      [void]$list.Add([pscustomobject]@{
        hwnd=[int64]$h
        title=$t.ToString()
        visible=[Dsh.W]::IsWindowVisible($h)
        minimized=[Dsh.W]::IsIconic($h)
      })
    }
    return $true }
  [void][Dsh.W]::EnumWindows($cb,[IntPtr]::Zero)
  return $list
}
`;

/** A PowerShell single-quoted literal (doubles embedded quotes). */
function psLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

/** Run PowerShell and return its stdout, or `null` when the desktop cannot be asked. */
function powershell(script, { log = () => {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          log(`desktop inquiry failed: ${error.message}`);
          resolve(null);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout.trim() : null);
      },
    );
  });
}

/** Run PowerShell that answers with JSON, returning the parsed value or `null`. */
async function powershellJson(script, options) {
  const stdout = await powershell(script, options);
  if (stdout === null || stdout === '') return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed ?? null;
  } catch {
    return null;
  }
}

/** Every Explorer folder window, with the state that decides whether it is on screen. */
async function explorerWindows(options) {
  const parsed = await powershellJson(`${PS_HEADER}
ConvertTo-Json -InputObject @(Get-DshExplorerWindows) -Compress`, options);
  if (parsed === null) return null;
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Lowercase and drop a trailing separator, so two spellings of one folder compare
 * equal. Windows paths are case-insensitive and a trailing separator is noise.
 * @param target - an absolute path.
 * @returns the comparison key.
 */
function normalizePathForCompare(target) {
  return target.replace(/[\\/]+$/u, '').toLowerCase();
}

/**
 * The rule that matters: a folder counts as "already open" only when a window showing
 * it is visible AND not minimized. A hidden or minimized window is not something the
 * user can see, and treating it as open is what made the repair never run.
 * @param window - one entry from {@link explorerWindows}.
 * @returns whether the user can actually see it.
 */
function isOnScreen(window) {
  return window.visible === true && window.minimized !== true;
}

/**
 * The handles of windows whose displayed folder is `key`.
 *
 * The folder of a window is only available from `Shell.Application` — a window title
 * carries the leaf name alone — so the collection is read here and joined with the
 * enumeration view by handle.
 * @param key - a normalized folder path.
 * @param options - `log` for failures.
 * @returns a Set of handles, or `null` when the shell collection cannot be read.
 */
function handlesShowingFolder(key, options = {}) {
  return powershellJson(`${PS_HEADER}
$target = ${psLiteral(key)}
$found = New-Object System.Collections.ArrayList
$sh = New-Object -ComObject Shell.Application
foreach ($w in @($sh.Windows())) {
  $url = [string]$w.LocationURL
  if (-not $url.StartsWith('file:///')) { continue }
  $decoded = [System.Uri]::UnescapeDataString($url.Substring(8)).Replace('/','\\').TrimEnd('\\').ToLower()
  if ($decoded -eq $target) { [void]$found.Add([int64]$w.HWND) }
}
ConvertTo-Json -InputObject @($found) -Compress`, options).then((parsed) => {
    if (parsed === null) return null;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return new Set(list.map((value) => Number(value)));
  });
}

/**
 * Whether the desktop currently shows one folder.
 * @param folder - the absolute folder path to look for.
 * @param options - `log`, for a diagnostic line when the desktop cannot be asked.
 * @returns `true` when a visible, non-minimized window shows it; `false` when the
 *   desktop answered and nothing does; `null` when the question could not be asked, so
 *   callers never mistake "unknown" for "not open".
 */
async function probeFolderOpen(folder, options = {}) {
  const windows = await explorerWindows(options);
  if (windows === null) return null;
  const handles = await handlesShowingFolder(normalizePathForCompare(folder), options);
  if (handles === null) return null;
  return windows.some((w) => handles.has(w.hwnd) && isOnScreen(w));
}

/**
 * Explorer windows that exist but are not on screen.
 *
 * These are what a `windowsHide: true` launch leaves behind: a real window the user
 * never sees. The title filter drops the many untitled helper windows the shell owns,
 * so a list of these is a list of things that were *meant* to be seen.
 * @param options - `log` for failures.
 * @returns `[{ hwnd, title }]`, or `null` when the desktop cannot be asked.
 */
async function hiddenExplorerWindows(options = {}) {
  const windows = await explorerWindows(options);
  if (windows === null) return null;
  return windows
    .filter((w) => w.visible !== true && typeof w.title === 'string' && w.title.length > 0)
    .map((w) => ({ hwnd: w.hwnd, title: w.title }));
}

/**
 * Show and focus a window that exists but is hidden or minimized.
 *
 * `SW_RESTORE` (9) is the only form measured to work: `SW_SHOW` (5) and
 * `SW_SHOWNORMAL` (1) both left a hidden window hidden, while `SW_RESTORE` flipped it
 * to `visible: true`. It also un-minimizes, which is the other case where a window
 * exists but the user cannot see it.
 *
 * @param hwnd - the window handle.
 * @param options - `log` for failures.
 * @returns `true` when the window reports visible and not minimized afterwards.
 */
async function restoreWindow(hwnd, options = {}) {
  const stdout = await powershell(`${PS_HEADER}
$h = [IntPtr]${String(Math.trunc(Number(hwnd)))}
[void][Dsh.W]::ShowWindow($h, 9)
[void][Dsh.W]::SetForegroundWindow($h)
if ([Dsh.W]::IsWindowVisible($h) -and -not [Dsh.W]::IsIconic($h)) { 'ok' } else { 'no' }`, options);
  return stdout === 'ok';
}

/**
 * Open one folder with Explorer directly, bypassing the shell's default verb.
 *
 * `explorer.exe <folder>` is a documented argument rather than a registry lookup, so it
 * works where `Invoke-Item` does nothing, and it is a GUI program, so it must not be
 * launched hidden.
 *
 * `explorer.exe` exits with a non-zero code even when it opens the window, so
 * `{ ok: true }` means only "the process started"; confirm with {@link probeFolderOpen}.
 *
 * @param folder - the absolute path to open.
 * @returns a promise for `{ ok, error }`.
 */
function openFolderInExplorer(folder) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      // `detached` + `unref` so the desktop app does not wait on, or hold open, a file
      // manager the user may keep for hours. No `windowsHide`: that would create the
      // window hidden, which is the bug this module exists to work around.
      const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' });
      child.on('error', (error) => done({ ok: false, error: error.message }));
      child.on('spawn', () => {
        child.unref();
        done({ ok: true, error: null });
      });
    } catch (error) {
      done({ ok: false, error: error.message });
    }
  });
}

module.exports = {
  explorerWindows,
  hiddenExplorerWindows,
  isOnScreen,
  normalizePathForCompare,
  openFolderInExplorer,
  probeFolderOpen,
  restoreWindow,
};
