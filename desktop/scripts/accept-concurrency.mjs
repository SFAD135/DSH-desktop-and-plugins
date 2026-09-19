#!/usr/bin/env node
/**
 * Acceptance test for the shared-profile concurrency warning.
 *
 * Reproduces the situation the warning exists for: a command-line `dsh web`
 * host is already using profile `web` in the same DSH_HOME, and the desktop
 * shell is then started against that same home. It asserts that the shell
 *
 *   1. shows the warning banner on its own loading page, with the *other
 *      host's* pid and the default web port as evidence;
 *   2. keeps the warning in the native window title;
 *   3. still reaches the served Harness GUI afterwards;
 *   4. offers no workspace picker — a session's working directory belongs to
 *      dsh, not to this shell.
 *
 * The shell under test runs with its own `--user-data-dir` (so Electron's
 * single-instance lock does not stop it next to another instance) and with a
 * copied home, so the real `~/.dsh` is never touched.
 *
 * Launching the Electron window needs a desktop session; under a confined
 * sandbox run this with `danger-full-access`.
 *
 *   node scripts/accept-concurrency.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { probeWebHost } = require(path.join(ROOT, 'app', 'host-detect.js'));

/** The directory the competing host is started from (any directory will do). */
const HOST_CWD = path.dirname(ROOT);
const DIST = path.join(ROOT, 'dist', 'DeepSeek Harness');
const EXE = path.join(DIST, 'DeepSeek Harness.exe');
const UITEST = path.join(ROOT, 'build', 'uitest');
const SCRATCH = path.join(UITEST, 'scratch');
const SHARED_HOME = path.join(UITEST, 'shared-home');
const OTHER_LOG = path.join(UITEST, 'other-host.log');
// Unique per run: a previous run's directory can still be held open by a
// just-killed Electron process, and that must never block the next run.
const USER_DATA = path.join(os.tmpdir(), `dsh-accept-userdata-${String(process.pid)}`);
const OTHER_PORT = 3080;
const CDP_PORT = 9333;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, Boolean(ok)]);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};
const log = (message) => process.stdout.write(`[accept] ${message}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a command with file-redirected stdio (no pipes: they are not always allowed). */
function runCapture(command, args, { cwd = ROOT, env = process.env, timeoutMs = 120_000 } = {}) {
  mkdirSync(SCRATCH, { recursive: true });
  const stamp = `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  const outFile = path.join(SCRATCH, `out-${stamp}.txt`);
  const errFile = path.join(SCRATCH, `err-${stamp}.txt`);
  const outFd = openSync(outFile, 'a');
  const errFd = openSync(errFile, 'a');
  let status = null;
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', outFd, errFd], windowsHide: true, timeout: timeoutMs });
    status = result.status;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  rmSync(outFile, { force: true });
  rmSync(errFile, { force: true });
  return { stdout, stderr, status };
}

/** Locate an installed CLI dsh (the npx cache tree), i.e. a non-bundled host. */
function findCliDsh() {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    const candidate = path.join(cache, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Ask the shell's own CDP endpoint for its page targets. */
async function cdpTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json`, { signal: AbortSignal.timeout(900) });
    return await response.json();
  } catch {
    return [];
  }
}

function probeShellPage(extraArgs = []) {
  return runCapture(process.execPath, [path.join(ROOT, 'scripts', 'verify-gui.mjs'), '--port', String(CDP_PORT), ...extraArgs]);
}

/** Window titles of the Electron processes belonging to the shell under test. */
function readWindowTitles() {
  // NOTE: keep the pipeline inside one statement — joining these lines with ';'
  // would start a statement with '|' and quietly produce nothing.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='electron-core.exe'\"",
    `$mine = $procs | Where-Object { $_.CommandLine -like '*${USER_DATA}*' }`,
    '$mine | ForEach-Object { $p = Get-Process -Id $_.ProcessId; if ($p.MainWindowTitle) { $p.MainWindowTitle } }',
  ].join('; ');
  const { stdout, stderr } = runCapture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  const titles = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (titles.length === 0 && stderr.trim()) log(`window title probe stderr: ${stderr.trim().split('\n')[0]}`);
  return titles;
}

/** Kill every electron-core process belonging to the shell under test. */
function killTestApp() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='electron-core.exe'\"",
    `$mine = $procs | Where-Object { $_.CommandLine -like '*${USER_DATA}*' }`,
    '$mine | ForEach-Object { taskkill /pid $_.ProcessId /T /F 2>&1 | Out-Null }',
  ].join('; ');
  runCapture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
}

/** Remove a directory that a just-killed process may still hold open. */
function removeWithRetries(target, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      if (!existsSync(target)) return true;
    } catch {
      /* a killed Electron process can hold its user-data dir for a moment */
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { stdio: 'ignore', windowsHide: true });
  }
  return !existsSync(target);
}

let otherHost = null;
let shellApp = null;

try {
  if (!existsSync(EXE)) {
    log(`missing ${EXE}; run "npm run build" first`);
    process.exit(2);
  }
  const cliDsh = findCliDsh();
  if (!cliDsh) {
    log('could not find an installed CLI dsh tree (npm cache) to act as the second host');
    process.exit(2);
  }
  log(`other host entry: ${cliDsh}`);

  mkdirSync(UITEST, { recursive: true });
  removeWithRetries(USER_DATA);

  // 0 ── seed a settings file in the shape an older version wrote it, so the
  // migration path (retired `workspace` key, unknown keys) is exercised for real
  // instead of only in the unit tests.
  mkdirSync(USER_DATA, { recursive: true });
  writeFileSync(
    path.join(USER_DATA, 'shell-settings.json'),
    `${JSON.stringify({ port: 0, workspace: 'C:\\Users\\someone', fromTheFuture: true }, null, 2)}\n`,
  );

  // 1 ── a copy of the real product data, shared by both hosts.
  log('preparing a shared home copy…');
  const prepared = runCapture(process.execPath, [path.join(ROOT, 'scripts', 'prepare-shared-home.mjs'), SHARED_HOME]);
  check('shared home copy prepared', existsSync(path.join(SHARED_HOME, 'profiles', 'web', 'cordis.yml')), prepared.stderr.trim().slice(0, 120));

  // 2 ── the competing host: a real command-line `dsh web` on the default port.
  rmSync(OTHER_LOG, { force: true });
  const otherFd = openSync(OTHER_LOG, 'a');
  otherHost = spawn(process.execPath, [cliDsh, 'web', '--port', String(OTHER_PORT), '--no-open'], {
    cwd: HOST_CWD,
    env: { ...process.env, DSH_HOME: SHARED_HOME },
    stdio: ['ignore', otherFd, otherFd],
    windowsHide: true,
  });
  closeSync(otherFd);
  log(`started the competing host pid=${String(otherHost.pid)} on port ${String(OTHER_PORT)}`);

  let otherReady = false;
  for (let attempt = 0; attempt < 60 && !otherReady; attempt += 1) {
    await delay(500);
    otherReady = (await probeWebHost(OTHER_PORT)).isDshHost;
  }
  check('competing CLI host answers on the default port', otherReady, `port ${String(OTHER_PORT)}`);

  // 3 ── the shell under test, pointed at the same home and profile.
  log('starting the desktop shell against the same home…');
  shellApp = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${String(CDP_PORT)}`], {
    cwd: DIST,
    env: {
      ...process.env,
      DSH_DESKTOP_HOME: SHARED_HOME,
      DSH_DESKTOP_PORT: '0',
    },
    stdio: 'ignore',
    windowsHide: false,
  });

  // 4 ── catch the shell's loading page, and wait for the warning to appear:
  // the detection runs asynchronously after the service spawns, so an early
  // sample legitimately shows no banner yet.
  let shellProbe = null;
  let sawServedGui = false;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const targets = await cdpTargets();
    if (targets.some((target) => /^http:\/\/127\.0\.0\.1/u.test(target.url ?? ''))) sawServedGui = true;
    const onLoadingPage = targets.some((target) => /loading\.html/u.test(target.url ?? ''));
    if (onLoadingPage) {
      const probe = probeShellPage(['--mode', 'shell', '--expect-warn', '--expect', SHARED_HOME, '--screenshot', 'docs/concurrency-warning.png']);
      if (/^\[gui\] url\s+: file:/mu.test(probe.stdout)) {
        shellProbe = probe.stdout;
        if (/warn banner : visible=true/u.test(probe.stdout)) break; // the warning landed
      }
    } else if (sawServedGui) {
      break; // the served GUI took the window; the loading page is gone
    }
    await delay(400);
  }
  if (shellProbe) process.stdout.write(shellProbe);

  check('shell loading page was observed', shellProbe !== null, shellProbe ? '' : 'the loading window was missed (the app started too fast)');
  if (shellProbe) {
    const warnTitle = /warn banner : visible=(\w+) title=(.*)/u.exec(shellProbe);
    const items = [...shellProbe.matchAll(/^\[gui\]\s+· (.*)$/gmu)].map((match) => match[1]);
    check('warning banner is visible on the loading page', warnTitle?.[1] === 'true', warnTitle?.[2] ?? '');
    check('banner names the competing host by pid', items.some((item) => item.includes(`pid=${String(otherHost.pid)}`)), items.join(' / ').slice(0, 200));
    check('banner reports the default web port', items.some((item) => item.includes(`端口 ${String(OTHER_PORT)}`)), '');
    check('banner explains the shared-data caveat', items.some((item) => item.includes('DSH_HOME 相同')), '');
    check('loading page shows the profile directory', shellProbe.includes(path.join(SHARED_HOME, 'profiles', 'web')));
    // This run uses a copied home, so the honest label is the custom one.
    check('loading page labels the data location honestly', shellProbe.includes('（自定义 DSH_HOME）'), '');
    // The retired workspace setting must be gone from the UI, not merely unused.
    check('loading page offers no workspace picker', !shellProbe.includes('工作区'), '');
    check('重新检测 action is offered', shellProbe.includes('重新检测'));
  }

  // 4b ── and the seeded settings file must have been migrated on load.
  try {
    const migrated = JSON.parse(readFileSync(path.join(USER_DATA, 'shell-settings.json'), 'utf8'));
    check('the retired workspace key was removed from the settings file', !('workspace' in migrated), JSON.stringify(migrated));
    check('the unknown key was removed from the settings file', !('fromTheFuture' in migrated));
    check('the migration kept the real settings', migrated.port === 0 && migrated.autoRestart === true && typeof migrated.window === 'object');
  } catch (error) {
    check('the retired workspace key was removed from the settings file', false, error.message);
  }

  // 5 ── the warning must survive into the native window title.
  let titles = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(500);
    titles = readWindowTitles();
    if (titles.some((title) => title.includes('可能正在使用同一数据'))) break;
  }
  check('window title carries the warning', titles.some((title) => title.includes('可能正在使用同一数据')), titles.join(' | ').slice(0, 160));
  check('window title keeps the product name', titles.some((title) => title.includes('DeepSeek Harness')));

  // 6 ── and the shell must still work: the served GUI has to come up fully.
  // `verify-gui.mjs` exits non-zero unless every one of its checks passes, so
  // the exit status — not a regex over its output — is the verdict. It is
  // retried because the SPA needs a moment to render after the URL changes.
  let harnessProbe = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = probeShellPage(['--mode', 'harness', '--expect', 'DeepSeek']);
    if (/^\[gui\] url\s+: http:/mu.test(probe.stdout)) {
      harnessProbe = probe;
      if (probe.status === 0) break;
    }
    await delay(700);
  }
  check('served Harness GUI still loads with the warning active', harnessProbe !== null);
  if (harnessProbe) {
    process.stdout.write(harnessProbe.stdout.split('\n').filter((line) => /^  (PASS|FAIL)|checks passed|^\[gui\] (url|DOM|__DSH)/u.test(line)).join('\n') + '\n');
    check('served GUI passed all of its own checks', harnessProbe.status === 0,
      (harnessProbe.stdout.match(/^  FAIL.*$/gmu) ?? []).join(' / ').slice(0, 160));
  }
  check('loading-page screenshot written', existsSync(path.join(ROOT, 'docs', 'concurrency-warning.png')));
} finally {
  log('cleaning up…');
  try {
    killTestApp();
  } catch {
    /* best effort */
  }
  for (const child of [otherHost, shellApp]) {
    if (!child || child.exitCode !== null) continue;
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* best effort */
    }
  }
  if (!removeWithRetries(USER_DATA)) log(`note: could not remove ${USER_DATA} (still locked by a killed process)`);
  if (!removeWithRetries(UITEST)) log(`note: could not remove ${UITEST} (still locked)`);
}

const failed = checks.filter(([, ok]) => !ok);
process.stdout.write(`\n[accept] ${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
