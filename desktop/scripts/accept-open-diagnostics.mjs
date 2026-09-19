#!/usr/bin/env node
/**
 * Acceptance test for the shell's record of the Web GUI's "open on the desktop"
 * actions (`app/open-diagnostics.js`).
 *
 * The contract under test is deliberately small, and both halves matter:
 *
 *   1. every attempt is written to the shell log with its route, button, HTTP status
 *      and reason — the record that makes "I clicked and nothing happened"
 *      reportable at all; and
 *   2. the shell **never reacts** to a launch: no dialog, no notification, no probe,
 *      no second window. An earlier revision verified the result after the click and
 *      repaired it when no window was found; a window the user closed quickly was
 *      then read as "nothing opened", so the shell opened a duplicate and, if that
 *      one was closed too, raised an error dialog about a button that had worked.
 *      Case 1 closes its window immediately to reproduce exactly that sequence.
 *
 * The cases are chosen so their outcomes do not depend on timing:
 *   - a real directory succeeds (200) and must end up on screen;
 *   - a missing directory makes the host answer 404 (deterministic refusal);
 *   - an unknown application makes it answer 400 (deterministic refusal);
 *   - the deliverable route carries no path at all, and must still be recorded.
 *
 * Isolation: the shell runs against a scratch data root via `DSH_DESKTOP_DATA`,
 * so the user's own installation, sessions and DSH_HOME are never touched. The
 * Electron window is created off-screen; the Explorer windows the successful case
 * opens are closed again at the end.
 *
 * Usage: node scripts/accept-open-diagnostics.mjs
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'DeepSeek Harness');
const ELECTRON = path.join(DIST, 'electron-core.exe');
const APP_DIR = path.join(DIST, 'resources', 'app');
const WORK = path.join(ROOT, 'build', 'open-diag');
const DATA = path.join(WORK, 'data');
const CDP_PORT = 9337;

const log = (message) => { process.stdout.write(`[open-diag] ${message}\n`); };
let checks = 0;
let failures = 0;
function check(ok, label, detail = '') {
  checks += 1;
  if (ok) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === '' ? '' : `\n         ${detail}`}\n`);
  }
  return ok;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const psLiteral = (value) => `'${String(value).replace(/'/gu, "''")}'`;

/**
 * Run PowerShell with UTF-8 on both ends. Without this its console output is
 * encoded with the OEM codepage, so the Chinese text of a dialog comes back as
 * mojibake and every `includes` assertion against it fails for the wrong reason.
 */
function powershell(script, timeoutMs = 120_000) {
  const preamble = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';
  const result = spawnSync(
    'powershell',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', preamble + script],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
  );
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** The console banner PowerShell adds when it is told to write JSON would break parsing. */
function powershellJson(script) {
  const raw = powershell(`$ProgressPreference='SilentlyContinue'; ${script}`).trim();
  const at = raw.indexOf('[');
  const atObject = raw.indexOf('{');
  const start = at === -1 ? atObject : (atObject === -1 ? at : Math.min(at, atObject));
  if (start === -1) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

/** Poll until `predicate` returns something truthy. Awaiting the result is what
 * makes an async predicate work — a bare Promise is always truthy. */
async function waitFor(predicate, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * Kill only the Electron instance this run started.
 *
 * The marker is the debug port passed on this run's own command line, never the
 * executable path. An earlier version matched `$_.Path -like "<DIST>\*"`, which is
 * *every* process whose binary lives under `dist\` — including the developer's own
 * running desktop app, whose binary is exactly that file. Running this test
 * therefore closed the app the user was working in. The three sibling `accept-*`
 * scripts already scope their kill to their own port marker; this one now does too.
 */
function killLeftoverProcesses() {
  const marker = `--remote-debugging-port=${String(CDP_PORT)}`;
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='electron-core.exe'\"; " +
    `$mine = $procs | Where-Object { $_.CommandLine -like ${psLiteral(`*${marker}*`)} }; ` +
    '$mine | ForEach-Object { taskkill /pid $_.ProcessId /T /F 2>&1 | Out-Null }';
  powershell(script);
}

/** Delete a tree, retrying and killing anything holding it. */
function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); } catch { /* retried */ }
    if (!existsSync(target)) return true;
    powershell(
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like ${psLiteral(path.join(target, '*'))} } ` +
        `| Stop-Process -Force -ErrorAction SilentlyContinue`,
    );
    powershell('Start-Sleep -Milliseconds 400');
  }
  return !existsSync(target);
}

/**
 * The title this shell used to give every dialog it raised about an open. Nothing
 * shows one any more, so this is now the pattern the assertions require to be
 * **absent** — the shell must never react to a launch, whichever way it went.
 */
const DIALOG_TITLE = '在本地打开';

// ── window helpers ──────────────────────────────────────────────────────────
// One PowerShell program serves both the dialog and the Explorer queries; the
// P/Invoke declarations are the only way to see a window the shell owns.
const WIN_HELPERS = `
Add-Type -Namespace OD -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, System.IntPtr p);
public delegate bool EnumWindowsProc(System.IntPtr h, System.IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(System.IntPtr h, EnumWindowsProc cb, System.IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@`;

/**
 * Text of every top-level dialog whose title *or* body matches `textPattern`.
 *
 * Matching has to consider both: the window title carries the action name
 * (「在本地打开」) while the reason ("宿主拒绝了这个请求") is body text, and a
 * pattern aimed at one of them must still find the dialog.
 */
function dialogsMatching(textPattern) {
  const script = `${WIN_HELPERS}
$found = New-Object System.Collections.ArrayList
$cb = [OD.N+EnumWindowsProc]{ param($h,$p)
  $c = New-Object System.Text.StringBuilder 256
  [void][OD.N]::GetClassNameW($h,$c,256)
  if($c.ToString() -eq '#32770'){
    $t = New-Object System.Text.StringBuilder 512
    [void][OD.N]::GetWindowTextW($h,$t,512)
    $texts = New-Object System.Collections.ArrayList
    $child = [OD.N+EnumWindowsProc]{ param($ch,$cp)
      $cc = New-Object System.Text.StringBuilder 256
      [void][OD.N]::GetClassNameW($ch,$cc,256)
      if($cc.ToString() -in @('Static','Button')){
        $ct = New-Object System.Text.StringBuilder 2048
        [void][OD.N]::GetWindowTextW($ch,$ct,2048)
        if($ct.ToString().Trim().Length -gt 0){ [void]$texts.Add($ct.ToString()) }
      }
      return $true }
    [void][OD.N]::EnumChildWindows($h,$child,[IntPtr]::Zero)
    $combined = $t.ToString() + ' ' + ($texts -join ' ')
    if($combined -match ${psLiteral(textPattern)}){
      [void]$found.Add([pscustomobject]@{ title=$t.ToString(); texts=@($texts); combined=$combined; handle=$h.ToInt64() })
    }
  }
  return $true }
[void][OD.N]::EnumWindows($cb,[IntPtr]::Zero)
ConvertTo-Json -InputObject @($found) -Depth 4 -Compress`;
  const parsed = powershellJson(script);
  if (parsed === null) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Close every dialog whose title or body matches, returning how many were closed. */
function closeDialogs(textPattern) {
  const script = `${WIN_HELPERS}
$n = 0
$cb = [OD.N+EnumWindowsProc]{ param($h,$p)
  $c = New-Object System.Text.StringBuilder 256
  [void][OD.N]::GetClassNameW($h,$c,256)
  if($c.ToString() -eq '#32770'){
    $t = New-Object System.Text.StringBuilder 512
    [void][OD.N]::GetWindowTextW($h,$t,512)
    $texts = New-Object System.Collections.ArrayList
    $child = [OD.N+EnumWindowsProc]{ param($ch,$cp)
      $cc = New-Object System.Text.StringBuilder 256
      [void][OD.N]::GetClassNameW($ch,$cc,256)
      if($cc.ToString() -in @('Static','Button')){
        $ct = New-Object System.Text.StringBuilder 2048
        [void][OD.N]::GetWindowTextW($ch,$ct,2048)
        if($ct.ToString().Trim().Length -gt 0){ [void]$texts.Add($ct.ToString()) }
      }
      return $true }
    [void][OD.N]::EnumChildWindows($h,$child,[IntPtr]::Zero)
    $combined = $t.ToString() + ' ' + ($texts -join ' ')
    if($combined -match ${psLiteral(textPattern)}){ [void][OD.N]::SendMessageW($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero); $script:n++ }
  }
  return $true }
[void][OD.N]::EnumWindows($cb,[IntPtr]::Zero)
$n`;
  return Number(powershell(script).trim()) || 0;
}

/** Titles of the visible Explorer folder windows. */
function folderWindowTitles() {
  const script = `${WIN_HELPERS}
$found = New-Object System.Collections.ArrayList
$cb = [OD.N+EnumWindowsProc]{ param($h,$p)
  $c = New-Object System.Text.StringBuilder 256
  [void][OD.N]::GetClassNameW($h,$c,256)
  if($c.ToString() -eq 'CabinetWClass'){
    $t = New-Object System.Text.StringBuilder 512
    [void][OD.N]::GetWindowTextW($h,$t,512)
    [void]$found.Add($t.ToString())
  }
  return $true }
[void][OD.N]::EnumWindows($cb,[IntPtr]::Zero)
ConvertTo-Json -InputObject @($found) -Compress`;
  const parsed = powershellJson(script);
  if (parsed === null) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Close Explorer windows whose title mentions `needle`. */
function closeFoldersMentioning(needle) {
  const script = `${WIN_HELPERS}
$n = 0
$cb = [OD.N+EnumWindowsProc]{ param($h,$p)
  $c = New-Object System.Text.StringBuilder 256
  [void][OD.N]::GetClassNameW($h,$c,256)
  if($c.ToString() -eq 'CabinetWClass'){
    $t = New-Object System.Text.StringBuilder 512
    [void][OD.N]::GetWindowTextW($h,$t,512)
    if($t.ToString() -like ${psLiteral(`*${needle}*`)}){ [void][OD.N]::SendMessageW($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero); $n++ }
  }
  return $true }
[void][OD.N]::EnumWindows($cb,[IntPtr]::Zero)
$n`;
  // Window enumeration misses Explorer windows that are hosted elsewhere (measured:
  // six open folders it reported as zero), so the desktop is also asked directly.
  // Leaving a window behind would put something unexplained on the user's screen.
  const viaShell = `${WIN_HELPERS}
$sh = New-Object -ComObject Shell.Application
$n = 0
foreach ($w in $sh.Windows()) {
  if ($w.LocationURL -like ${psLiteral(`*${needle}*`)}) { $w.Quit(); $n++ }
}
$n`;
  return (Number(powershell(script).trim()) || 0) + (Number(powershell(viaShell).trim()) || 0);
}

/**
 * Whether the desktop really shows `needle` in an open folder.
 *
 * Uses `Shell.Application` rather than window enumeration: it is the oracle that
 * agrees with what the user actually sees, and it is what the shell's own probe
 * trusts.
 */
function folderIsOpen(needle) {
  const script = `${WIN_HELPERS}
$sh = New-Object -ComObject Shell.Application
$n = 0
foreach ($w in $sh.Windows()) {
  if ($w.LocationURL -like ${psLiteral(`*${needle}*`)}) { $n++ }
}
$n`;
  return (Number(powershell(script).trim()) || 0) > 0;
}

/**
 * The shell's own window must not be treated as one of ours. Nothing here needs to
 * force focus any more: the verdicts that depended on the foreground window are gone
 * along with the verification they fed.
 */

// ── CDP ─────────────────────────────────────────────────────────────────────
/** Issue a fetch inside the page, so the request carries the page's own cookies. */
async function pageFetch(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text };
  }
  return { value: res.result?.result?.value };
}

/** The Web GUI page, once the shell has a window on the local service. */
/** Current page title, for diagnostics in a failure message. */
async function pageTitle(cdp) {
  const probe = await pageFetch(cdp, 'document.title');
  return probe.value ?? probe.error ?? '(unknown)';
}

async function connectCdp(port, timeoutMs = 120_000) {
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      // Any page served over loopback is the GUI; matching on the token query
      // would break if the shell ever changes how it hands the token to the page.
      return list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1/u.test(t.url ?? '')) ?? null;
    } catch { return null; }
  }, timeoutMs, 700);
  if (!target) return null;

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry(message);
  });
  const send = (method, params = {}) => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

// ── preflight ───────────────────────────────────────────────────────────────
/**
 * Last lines of the newest shell log. Available even when the GUI never came up,
 * because "no page appeared" is otherwise indistinguishable from a first-run
 * dialog, a crashed runtime or a missing payload.
 */
function shellLogTail(lines = 12) {
  const dir = path.join(DATA, 'shell', 'logs');
  if (!existsSync(dir)) return `(no shell logs under ${dir})`;
  const files = readdirSync(dir)
    .filter((n) => n.startsWith('desktop-'))
    .map((n) => path.join(dir, n))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  const newest = files.at(-1);
  if (newest === undefined) return `(no desktop-*.log under ${dir})`;
  return readFileSync(newest, 'utf8').trim().split(/\r?\n/u).slice(-lines).join('\n');
}
for (const required of [ELECTRON, APP_DIR]) {
  if (!existsSync(required)) {
    process.stderr.write(`[open-diag] missing ${required}; run: npm run build\n`);
    process.exit(1);
  }
}

// Refuse to run while the developer's own desktop app is open.
//
// This test drives a real GUI and opens real Explorer windows. More importantly, a
// bug here once killed the running app: cleanup that matched processes by executable
// path under `dist\` cannot tell this run's instance from a live one, because they
// are the same binary. That specific line is fixed, but the guard stays: the safe
// assumption is that a running app belongs to someone who is using it.
const userApp = (() => {
  const marker = `--remote-debugging-port=${String(CDP_PORT)}`;
  // `--type=` marks Electron's helper processes (GPU, network, renderer, utility);
  // they carry no `--type=`, so only main processes are counted. Reporting four
  // "instances" for one open app would be a lie in a message about safety.
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='electron-core.exe'\"; " +
    `@($procs | Where-Object { $_.CommandLine -notlike ${psLiteral(`*${marker}*`)} ` +
    `-and $_.CommandLine -notlike '*--type=*' }).Count`;
  return Number(powershell(script).trim()) || 0;
})();
if (userApp > 0 && process.env.DSH_ACCEPT_ALLOW_RUNNING_APP !== '1') {
  process.stderr.write(
    `[open-diag] DeepSeek Harness is already running (${String(userApp)} window/instance).\n` +
      '  This test drives a GUI and opens Explorer windows, so it refuses to run\n' +
      '  alongside a session you are using. Close the app first, or set\n' +
      '  DSH_ACCEPT_ALLOW_RUNNING_APP=1 to run anyway (it will not touch them).\n',
  );
  process.exit(1);
}

log('syncing the current shell sources into the portable build under test');
cpSync(path.join(ROOT, 'app'), path.join(APP_DIR, 'app'), { recursive: true, dereference: true });
cpSync(path.join(ROOT, 'package.json'), path.join(APP_DIR, 'package.json'));

process.stdout.write('\n');
const priorFolders = new Set(folderWindowTitles());
const scratchName = `opendiag-${Date.now().toString(36)}`;
const target = path.join(WORK, scratchName);
const missing = path.join(WORK, `${scratchName}-does-not-exist`);
let app = null;
let cdp = null;

try {
  removeTree(WORK);
  mkdirSync(target, { recursive: true });
  // Make this look like an installation that has already run, so no first-run
  // dialog blocks startup before a page exists to drive. Two independent pieces
  // of state are involved and both are needed:
  //   shell-settings.json  - `isFirstRun` treats its presence as "this copy has run"
  //   imported-from.json   - the marker `planMigration` writes once the "import
  //                          your old ~/.dsh" question has been answered. Without
  //                          it the shell shows that modal on startup and the
  //                          window never loads, which looks exactly like a
  //                          debugging-port failure.
  mkdirSync(path.join(DATA, 'shell'), { recursive: true });
  // `openDiagnostics` was written by earlier versions and is now retired. Seeding it
  // proves an existing settings file still starts cleanly after the switch was removed.
  writeFileSync(path.join(DATA, 'shell', 'shell-settings.json'), '{"port":0,"openDiagnostics":false}\n');
  mkdirSync(path.join(DATA, 'dsh-home'), { recursive: true });
  writeFileSync(
    path.join(DATA, 'dsh-home', 'imported-from.json'),
    `${JSON.stringify({ importedFrom: null, declinedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  log(`scratch data root ${path.relative(ROOT, DATA)}`);
  app = spawn(
    ELECTRON,
    [APP_DIR, `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: DIST,
      // The scratch data root is what keeps the user's own install out of this run.
      env: { ...process.env, DSH_DESKTOP_DATA: DATA },
      stdio: 'ignore',
      windowsHide: true,
    },
  );

  cdp = await connectCdp(CDP_PORT);
  check(cdp !== null, '带调试端口的桌面版启动成功');
  if (cdp === null) {
    // Without this the only symptom is "no page", which is also what a first-run
    // dialog, a crashed runtime or a missing payload look like.
    throw new Error(`no Web GUI page appeared on port ${CDP_PORT}; shell log tail:\n${shellLogTail()}`);
  }

  const logDir = path.join(DATA, 'shell', 'logs');
  await waitFor(() => (existsSync(logDir) ? readdirSync(logDir).some((n) => n.startsWith('desktop-')) : false), 60_000);
  /**
   * The newest desktop log. Reading only that one keeps "what was appended by
   * this step" well defined — `readdirSync` order is not guaranteed, so
   * concatenating every log would put a restart's file in an arbitrary position.
   */
  const shellLog = () => {
    if (!existsSync(logDir)) return '';
    const files = readdirSync(logDir)
      .filter((n) => n.startsWith('desktop-'))
      .map((n) => path.join(logDir, n))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    const newest = files.at(-1);
    return newest === undefined ? '' : readFileSync(newest, 'utf8');
  };

  // Wait for the real GUI rather than the `loading.html` the shell shows first.
  // The window navigates from `file://.../loading.html` to the local service, so
  // a check that only looks for "a button" matches the loading page too — and the
  // loading page's title literally ends in 「启动中」. `#root` exists only in the GUI.
  const readyExpression =
    `(document.querySelector('#root') && document.title && !document.title.includes('启动中')) ? 'ready' : ''`;
  const readiness = await waitFor(async () => {
    const probe = await pageFetch(cdp, readyExpression);
    // Returning the string (not a boolean) keeps the assertion below meaningful.
    return probe.value === 'ready' ? 'ready' : null;
  }, 90_000, 800);
  check(readiness === 'ready', 'Web GUI 已加载（不是启动页）', `title=${JSON.stringify(await pageTitle(cdp))}`);

  const call = async (appId, dir) => {
    const body = JSON.stringify({ app: appId, path: dir });
    const expression =
      `fetch('/open-in-app/open',{method:'POST',headers:{'content-type':'application/json'},` +
      `body:${JSON.stringify(body)}}).then(async r => r.status)`;
    const result = await pageFetch(cdp, expression);
    return result.error ?? result.value;
  };

  /** POST the deliverable route, which carries session/seq/index and no path at all. */
  const callDeliverable = async () => {
    const expression =
      `fetch('/api/present.open?sessionId=no-such-session&seq=1&index=0&action=reveal',` +
      `{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r => r.status)`;
    const result = await pageFetch(cdp, expression);
    return result.error ?? result.value;
  };

  // ── case 1: a real directory launches, and closing it changes nothing ──────
  process.stdout.write('\n');
  log('case 1: opening a real directory (host answers 200)');
  const statusOk = await call('explorer', target);
  check(statusOk === 200, '宿主对真实目录返回 200', `实际 ${statusOk}`);

  const logged200 = await waitFor(
    () => (/open open-in-app \(POST\) -> 200/u.test(shellLog()) ? shellLog() : null), 20_000, 500);
  check(logged200 !== null, '外壳把这次「在本地打开」记进了日志',
    shellLog().split('\n').filter((l) => l.includes('open-in-app')).slice(-3).join(' | '));
  if (logged200 !== null) {
    const line = logged200.split('\n').filter((l) => l.includes('open open-in-app (POST) -> 200')).at(-1) ?? '';
    check(line.includes('宿主接受了请求'), '日志写明了宿主接受了请求', line);
    check(line.includes('「在本地打开」'), '日志写明了是哪个按钮', line);
    check(line.includes('app=explorer'), '日志记下了目标应用', line);
    check(line.includes(scratchName), '日志记下了目标目录', line);
  }
  // The host answers 200 even when it opened nothing (its 1 s launch watch expires
  // first, and on Windows it used to open folders through `Invoke-Item`, which does
  // nothing where no default verb for directories is registered). What matters is
  // that the folder ends up on screen — that is what proves the bundled runtime is
  // patched, so assert against the desktop rather than the status code.
  await waitFor(() => (folderIsOpen(scratchName) ? 'yes' : null), 15_000, 500);
  check(folderIsOpen(scratchName), '目录确实出现在了桌面上（运行时补丁生效）',
    shellLog().split('\n').filter((l) => l.includes('open ')).slice(-2).join(' | '));

  // The heart of the rewrite. Close the window *immediately* — the sequence that used
  // to produce a duplicate window and then an error dialog — and assert the shell did
  // nothing at all in response.
  const closedImmediately = closeFoldersMentioning(scratchName);
  log(`  立刻关掉了这次打开的 ${String(closedImmediately)} 个窗口`);
  await sleep(6000);
  check(!folderIsOpen(scratchName), '关掉之后目录没有被重新打开（外壳不会「修复」）');
  check(dialogsMatching(DIALOG_TITLE).length === 0, '快速关掉窗口不会弹出任何错误对话框');
  check(!/open diagnosis/u.test(shellLog()), '外壳不再产出「诊断结论」，只写日志');
  check(!/已由桌面版代为打开|都没能打开|没有来到前台/u.test(shellLog()), '日志里也没有任何「代为打开 / 打开失败」的说法');

  // ── case 2: a missing directory is refused, and only the log says so ───────
  process.stdout.write('\n');
  log('case 2: a directory that does not exist (host answers 404)');
  const status404 = await call('explorer', missing);
  check(status404 === 404, '宿主对不存在的目录返回 404', `实际 ${status404}`);
  const logged404 = await waitFor(
    () => (/open open-in-app \(POST\) -> 404/u.test(shellLog()) ? shellLog() : null), 20_000, 500);
  check(logged404 !== null, '外壳日志记录了 HTTP 404');
  check((logged404 ?? '').includes('宿主拒绝了这个请求'), '日志把这笔记为「宿主拒绝」');
  check((logged404 ?? '').includes('要打开的目录不存在'), '日志给出了 404 的正确原因（目录不存在）');
  check(dialogsMatching(DIALOG_TITLE).length === 0, '被拒绝时同样不弹窗（只记日志）');

  // ── case 3: an unknown application is refused too ─────────────────────────
  process.stdout.write('\n');
  log('case 3: an application the host does not know (host answers 400)');
  const status400 = await call('definitely-not-a-real-app', target);
  check(status400 === 400, '宿主对未知应用返回 400', `实际 ${status400}`);
  const logged400 = await waitFor(
    () => (/open open-in-app \(POST\) -> 400/u.test(shellLog()) ? shellLog() : null), 20_000, 500);
  check(logged400 !== null, '外壳日志记录了 HTTP 400');
  check((logged400 ?? '').includes('不认识这个应用'), '日志给出了 400 的正确原因（应用不可用）');
  check(dialogsMatching(DIALOG_TITLE).length === 0, '未知应用同样不弹窗');

  // ── case 4: the deliverable button's route is recorded too ────────────────
  process.stdout.write('\n');
  log('case 4: 交付文件按钮（/api/present.open，请求体里没有路径）');
  const deliverableStatus = await callDeliverable();
  check(typeof deliverableStatus === 'number', '交付文件路由有响应', `实际 ${String(deliverableStatus)}`);
  const loggedDeliverable = await waitFor(
    () => (/open present-open \(POST\) -> \d+/u.test(shellLog()) ? shellLog() : null), 20_000, 500);
  check(loggedDeliverable !== null, '交付文件路由也被记进了日志',
    shellLog().split('\n').filter((l) => l.includes('present-open')).slice(-2).join(' | '));
  if (loggedDeliverable !== null) {
    const line = loggedDeliverable.split('\n').filter((l) => l.includes('open present-open (POST) ->')).at(-1) ?? '';
    check(line.includes('「打开所在文件夹」') || line.includes('「用默认应用打开」'), '日志写明了是哪个按钮', line);
  }
  check(dialogsMatching(DIALOG_TITLE).length === 0, '交付文件路由同样不弹窗');

  // Nothing in this whole run may have produced a dialog, whichever case it came from.
  check(dialogsMatching(DIALOG_TITLE).length === 0, '整轮验收没有出现过任何弹窗');
  log(`  closed ${closeDialogs(DIALOG_TITLE)} dialog(s)`);
} catch (error) {
  check(false, '验收过程未抛异常', String(error && error.stack ? error.stack : error));
} finally {
  // ── cleanup ───────────────────────────────────────────────────────────────
  closeDialogs(DIALOG_TITLE);
  if (cdp) { try { cdp.close(); } catch { /* already closed */ } }
  if (app && app.exitCode === null) {
    app.kill();
    await sleep(2000);
    if (app.exitCode === null) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { windowsHide: true });
  }
  // Electron's own child processes (renderers, and the dsh host it spawned) can
  // outlive a kill of the main process; all of this run's live under DIST.
  killLeftoverProcesses();
  await sleep(1500);

  // Only the Explorer windows this run created are closed.
  const created = folderWindowTitles().filter((title) => title.includes(scratchName) && !priorFolders.has(title));
  const closedFolders = closeFoldersMentioning(scratchName);
  log(`closed ${closedFolders} Explorer window(s) this run opened (${created.length} identified)`);

  check(removeTree(WORK), '清理了临时数据目录');
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
