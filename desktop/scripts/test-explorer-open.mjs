#!/usr/bin/env node
/**
 * End-to-end proof that opening something on the desktop actually shows a window.
 *
 * Unit tests cover the decision rules; this covers what only a real desktop can answer,
 * because every bug here was a property of the machine:
 *
 *   - `Invoke-Item` (what the host used to run) opens nothing where no default verb is
 *     registered for directories, while exiting 0;
 *   - `windowsHide: true` (which the host passed) creates the window HIDDEN, so the user
 *     sees nothing even though `Shell.Application` lists the folder as open.
 *
 * Four things are checked, in order of how much they prove:
 *
 *   1. the **patched host runtime** really produces a window the user can see — calling
 *      `openNativePath` / `revealNativePath` from the shipped module, for real;
 *   2. `explorer.exe <folder>` does too, including for a path with spaces and non-ASCII
 *      characters (`scripts/explorer-desktop.js` offers it as a repair helper; the shell
 *      no longer calls it — see `app/open-diagnostics.js`);
 *   3. the oracle does **not** count a hidden window as open — with the original
 *      `windowsHide: true` launch as a negative control, which must stay invisible;
 *   4. the oracle does **not** count a minimized window as open.
 *
 * Checks 3 and 4 are why this file still exists now that the shell no longer probes:
 * they pin down the measurement error that made 「在本地打开」 look like it worked when
 * it had not, and they are the only assertion that the runtime patch works on a real
 * desktop rather than merely being present in the file.
 *
 * It opens windows on purpose and closes them again; only windows whose title carries
 * this run's marker are ever touched, and the scratch directories are removed.
 *
 *   node scripts/test-explorer-open.mjs
 */
import { createRequire } from 'node:module';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { explorerWindows, hiddenExplorerWindows, openFolderInExplorer, probeFolderOpen } =
  require(path.join(ROOT, 'scripts', 'explorer-desktop.js'));

const PATCHED_MODULE = path.join(
  ROOT, 'build', 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-native-command', 'lib', 'index.js',
);

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

const MARKER = 'dsh-explorer-open';
const scratchPlain = path.join(os.tmpdir(), `${MARKER}-plain`);
const scratchHost = path.join(os.tmpdir(), `${MARKER}-host`);
const scratchReveal = path.join(os.tmpdir(), `${MARKER}-reveal 测试`);
const scratchControl = path.join(os.tmpdir(), `${MARKER}-control`);
const revealFile = path.join(scratchReveal, '123.txt');
const SIGNAL = new AbortController().signal;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Run one PowerShell snippet. */
function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  return (r.stdout || '').trim();
}

/**
 * Close every Explorer window whose title carries the marker, hidden ones included —
 * closing by handle is the only way to reach a window that is not on screen.
 */
function closeScratchWindows() {
  return Number(ps(`
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -Namespace C -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, System.IntPtr p);
public delegate bool EnumWindowsProc(System.IntPtr h, System.IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll")] public static extern bool PostMessageW(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
'@
$n = 0
$cb = [C.U+EnumWindowsProc]{ param($h,$p)
  $c = New-Object System.Text.StringBuilder 256
  [void][C.U]::GetClassNameW($h,$c,256)
  if($c.ToString() -eq 'CabinetWClass'){
    $t = New-Object System.Text.StringBuilder 512
    [void][C.U]::GetWindowTextW($h,$t,512)
    if($t.ToString() -like '*${MARKER}*'){ [void][C.U]::PostMessageW($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero); $n++ }
  }
  return $true }
[void][C.U]::EnumWindows($cb,[IntPtr]::Zero)
$n`)) || 0;
}

/** Poll until the desktop really shows `folder`, or give up. */
async function waitForShown(folder, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeFolderOpen(folder)) === true) return true;
    await sleep(700);
  }
  return false;
}

/** Minimize every window that is currently on screen. */
async function minimizeAllOnScreen() {
  const windows = await explorerWindows();
  if (windows === null) return 0;
  const keep = windows.filter((w) => w.visible === true && w.minimized !== true);
  let minimized = 0;
  for (const w of keep) {
    ps(`Add-Type -Namespace M -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
'@; [void][M.U]::ShowWindow([IntPtr]${String(w.hwnd)}, 6)`);
    minimized += 1;
  }
  return minimized;
}

// ── setup ───────────────────────────────────────────────────────────────────
for (const dir of [scratchPlain, scratchHost, scratchReveal]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(revealFile, '123\n');
closeScratchWindows();
await sleep(1500);

try {
  // ── 1. the patched host runtime ───────────────────────────────────────────
  if (!fs.existsSync(PATCHED_MODULE)) {
    check('the patched runtime module is present', false, `missing ${PATCHED_MODULE}; run npm run build`);
  } else {
    const host = await import(pathToFileURL(PATCHED_MODULE).href);

    await host.openNativePath(scratchHost, SIGNAL);
    check('the patched host opens a folder the user can see (no hidden window)',
      await waitForShown(scratchHost), 'no visible window appeared');

    closeScratchWindows();
    await sleep(1500);

    await host.revealNativePath(revealFile, SIGNAL);
    check('the patched host reveals a file in a visible window',
      await waitForShown(scratchReveal), 'reveal produced no visible window');
  }

  // ── 2. explorer.exe <folder>, the spare that the shell no longer uses ─────
  closeScratchWindows();
  await sleep(1500);
  check('the scratch folder starts closed', (await probeFolderOpen(scratchPlain)) === false,
    String(await probeFolderOpen(scratchPlain)));

  const started = await openFolderInExplorer(scratchPlain);
  check('explorer.exe starts for a path with spaces and non-ASCII characters',
    started.ok === true, JSON.stringify(started));
  check('explorer.exe <folder> produces a visible window', await waitForShown(scratchPlain), 'still not visible');

  // ── 3. a hidden window must never count as open ───────────────────────────
  // The negative control: exactly what the host did before the patch.
  closeScratchWindows();
  await sleep(1500);
  fs.mkdirSync(scratchControl, { recursive: true });
  await new Promise((resolve) => {
    execFile('explorer.exe', [scratchControl], { encoding: 'utf8', windowsHide: true, timeout: 10000 }, () => resolve());
  });
  await sleep(3000);
  const hidden = await hiddenExplorerWindows();
  check('a windowsHide launch really does create a hidden window',
    (hidden ?? []).some((w) => w.title.includes(`${MARKER}-control`)), JSON.stringify(hidden));
  check('a hidden window is NOT counted as open (the measurement error behind the bug)',
    (await probeFolderOpen(scratchControl)) === false, 'hidden window counted as open');

  // ── 4. a minimized window must not count either ───────────────────────────
  closeScratchWindows();
  await sleep(1500);
  await openFolderInExplorer(scratchPlain);
  await waitForShown(scratchPlain);
  const minimized = await minimizeAllOnScreen();
  await sleep(2500);
  check('a minimized window is NOT counted as open either',
    minimized > 0 && (await probeFolderOpen(scratchPlain)) === false,
    `minimized=${String(minimized)} probe=${String(await probeFolderOpen(scratchPlain))}`);
} finally {
  // ── cleanup: only our own windows and our own directories ────────────────
  closeScratchWindows();
  await sleep(1500);
  closeScratchWindows();
  await sleep(800);
  const left = (await hiddenExplorerWindows() ?? []).filter((w) => w.title.includes(MARKER));
  for (const dir of [scratchPlain, scratchHost, scratchReveal, scratchControl]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A window still holding the folder can block removal; the report below says so.
    }
  }
  check('cleanup left no hidden window of this run behind', left.length === 0, JSON.stringify(left));
  check('cleanup removed the scratch folders',
    !fs.existsSync(scratchPlain) && !fs.existsSync(scratchHost) && !fs.existsSync(scratchReveal),
    'a scratch directory survived');
}

console.log(`\n${ran - failed}/${ran} checks passed`);
process.exit(failed === 0 ? 0 : 1);
