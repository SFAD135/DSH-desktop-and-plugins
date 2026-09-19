/**
 * Measure where installer and uninstaller time actually goes.
 *
 * "The installer feels slow" is not actionable on its own: the cost could sit in
 * LZMA decompression, in creating ~26,000 files, or in deleting them again, and
 * each of those has a different fix. This script separates them by timing three
 * things on the same machine and disk:
 *
 *   1. `robocopy` of the payload tree — the same bytes and the same file count
 *      written by a fast, multi-threaded copier. This is the floor: no installer
 *      can beat it, so `install - copy` is what compression and NSIS overhead add.
 *   2. A real silent install of a setup built from that payload.
 *   3. A real silent uninstall, timed until the tree is actually gone.
 *   4. A recursive delete of the copied tree — the floor for the uninstall.
 *
 * It builds its own setup with a distinct APPID/APPNAME (`DSH Timing`) so the
 * user's genuine installation keeps its registry entries, shortcuts and DSH_HOME.
 * DSH_HOME is still backed up and restored, because the isolated install writes
 * and then withdraws that variable.
 *
 * Usage: node scripts/time-install.mjs [--skip-build]
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'DeepSeek Harness';
const APPID = 'DSH Timing';
const TIMING_APP_EXE = `${APP_NAME}.exe`;
const REG_KEY = `HKCU:\\Software\\${APPID}`;
const UNINST_KEY = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}`;
const LOG_FILE = path.join(os.tmpdir(), `${APPID}-install.log`);

// `--payload <dir>` measures a different tree, which is how a candidate
// optimisation is compared against the shipped payload without touching it.
const PAYLOAD = argValue('--payload') !== null
  ? path.resolve(ROOT, argValue('--payload'))
  : path.join(ROOT, 'build', 'installer', 'payload', APP_NAME);
const MAKENSIS = path.join(ROOT, 'build', 'tools', 'nsis', 'nsis-3.10', 'makensis.exe');
const NSI = path.join(ROOT, 'installer', 'installer.nsi');
// The installer needs a real .ico; build-installer.mjs generates this one.
const ICON = path.join(ROOT, 'build', 'icon.ico');
const WORK = path.join(ROOT, 'build', 'timing');
// Deliberately OUTSIDE WORK: the finally block wipes WORK, and a fresh makensis
// run on every invocation would make comparing before/after painful. The variant
// suffix keeps each compression experiment's setup cached separately.
const COMPRESSOR = argValue('--compressor') ?? 'lzma';
// `--tag` labels an experiment (e.g. a pruned payload) so its setup caches apart.
const TAG = argValue('--tag');
const VARIANT =
  (TAG === null ? '' : `${TAG}-`) +
  (process.argv.includes('--no-compress') ? 'stored' : `${COMPRESSOR}-dict${dictSize()}`);
const SETUP = path.join(ROOT, 'build', 'timing-setup', `${APPID.replace(/ /gu, '')}-${VARIANT}-Setup.exe`);

/** Value of `--flag <value>` on the command line, or null when absent. */
function argValue(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : null;
}

/** LZMA dictionary override in MB, or the shipped default of 64. */
function dictSize() {
  return Number(argValue('--dict') ?? 64);
}
const PARENT = path.join(WORK, 'parent');
const INSTALL = path.join(PARENT, APPID);
const COPY = path.join(WORK, 'copy');
// Where the installer lands when it does not honour /PARENT. Cleaned in the
// `finally` as well, so a mis-targeted install can never be left on the machine.
const OFFICIAL = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', APPID);

const DESKTOP_LNK = path.join(os.homedir(), 'Desktop', `${APPID}.lnk`);
const START_MENU = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', APPID,
);

const log = (message) => { process.stdout.write(`[time] ${message}\n`); };
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Quote a value as a PowerShell single-quoted literal. */
const psLiteral = (value) => `'${String(value).replace(/'/gu, "''")}'`;

function powershell(script) {
  const result = spawnSync(
    'powershell',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const sleep = (ms) => { spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', `Start-Sleep -Milliseconds ${ms}`], { windowsHide: true }); };

/** Recursively collect `relativePath -> size` for every file under `dir`. */
function fileMap(dir, prefix = '') {
  const map = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}\\${entry.name}`;
    if (entry.isDirectory()) for (const [k, v] of fileMap(full, rel)) map.set(k, v);
    else map.set(rel, statSync(full).size);
  }
  return map;
}

/** Delete a tree, retrying and killing anything holding it. */
function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); } catch { /* retried below */ }
    if (!existsSync(target)) return true;
    powershell(
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like ${psLiteral(path.join(target, '*'))} } ` +
        `| Stop-Process -Force -ErrorAction SilentlyContinue`,
    );
    sleep(400);
  }
  return !existsSync(target);
}

const nsisTempDirs = () => new Set(readdirSync(os.tmpdir()).filter((name) => name.startsWith('~nsu')));

function cleanNewNsisTempDirs(before) {
  let removed = 0;
  for (const name of readdirSync(os.tmpdir())) {
    if (!name.startsWith('~nsu') || before.has(name)) continue;
    if (removeTree(path.join(os.tmpdir(), name))) removed += 1;
  }
  return removed;
}

/**
 * Run one executable to completion with the given args; returns exit code.
 *
 * Launched through PowerShell's `Start-Process`, the same way
 * `accept-install.mjs` and `verify-real-install.mjs` drive the installer. That
 * matters: NSIS reads its raw command line, and how the arguments are assembled
 * decides whether a quoted `/PARENT="a b"` survives. A direct `spawnSync` builds
 * a different command line and the quoted parameter is silently lost, which makes
 * the installer fall back to the official location.
 */
function runExe(file, args, timeoutMs = 900_000) {
  const list = args.map(psLiteral).join(',');
  const script =
    `$p = Start-Process -FilePath ${psLiteral(file)} -ArgumentList ${list || '@()'} -PassThru; ` +
    `if ($p.WaitForExit(${timeoutMs})) { exit $p.ExitCode } else { $p.Kill(); exit 997 }`;
  const result = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs + 30_000,
  });
  const exit = result.status ?? -1;
  return { exit, timedOut: exit === 997 };
}

/**
 * NSIS reads its raw command line, so a parameter whose value contains a space
 * must carry its own quotes. Harmless for values without spaces.
 */
const nsisParam = (name, value) => `/${name}="${value}"`;

/** Wait until `predicate` holds, so an uninstaller that self-copies is timed fully. */
function waitUntil(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleep(intervalMs);
  }
  return false;
}

// ── preflight ───────────────────────────────────────────────────────────────
if (!existsSync(PAYLOAD)) {
  process.stderr.write(`[time] payload missing at ${PAYLOAD}; run: npm run build:installer\n`);
  process.exit(1);
}

const expected = fileMap(PAYLOAD);
const payloadBytes = [...expected.values()].reduce((a, b) => a + b, 0);
log(`payload ${mb(payloadBytes)} across ${expected.size} files`);

mkdirSync(WORK, { recursive: true });

// ── 0. build the isolated setup when needed ─────────────────────────────────
if (!existsSync(SETUP) || !process.argv.includes('--skip-build')) {
  mkdirSync(path.dirname(SETUP), { recursive: true });
  if (!existsSync(MAKENSIS)) {
    process.stderr.write(`[time] makensis missing at ${MAKENSIS}; run: npm run prepare:nsis\n`);
    process.exit(1);
  }
  if (!existsSync(ICON)) {
    log('generating the product icon');
    const icons = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });
    if (icons.status !== 0 || !existsSync(ICON)) {
      process.stderr.write(`[time] could not produce ${ICON}\n`);
      process.exit(1);
    }
  }
  const bundledNode = spawnSync(path.join(PAYLOAD, 'resources', 'runtime', 'node', 'node.exe'), ['-v'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const nodeVersion = (bundledNode.stdout ?? '').trim() || 'v24.21.0';
  const args = [
    '/INPUTCHARSET', 'UTF8',
    `/DPAYLOAD=${PAYLOAD}`,
    `/DOUTFILE=${SETUP}`,
    `/DAPPNAME=${APPID}`,
    `/DAPPID=${APPID}`,
    `/DAPPFOLDER=${APPID}`,
    '/DAPPVERSION=0.1.5-rc.2',
    '/DAPPVI_VERSION=0.1.5.2',
    `/DBUNDLED_NODE_VERSION=${nodeVersion}`,
    `/DPAYLOAD_BYTES=${payloadBytes}`,
    `/DICONFILE=${ICON}`,
    ...(process.argv.includes('--no-compress')
      ? ['/DNO_COMPRESS=1']
      : [`/DCOMPRESSOR=${COMPRESSOR}`, `/DDICTSIZE=${dictSize()}`]),
    NSI,
  ];
  log(`compiling the isolated setup (${APPID}, ${VARIANT}) — this is the slow part`);
  const started = Date.now();
  const built = spawnSync(MAKENSIS, args, { encoding: 'utf8', windowsHide: true, timeout: 900_000 });
  const buildMs = Date.now() - started;
  if (!existsSync(SETUP)) {
    process.stderr.write(`[time] compile failed (exit ${built.status}):\n${built.stdout ?? ''}\n${built.stderr ?? ''}\n`);
    process.exit(1);
  }
  log(`compiled in ${secs(buildMs)} -> ${mb(statSync(SETUP).size)}`);
} else {
  log(`reusing ${path.relative(ROOT, SETUP)} (${mb(statSync(SETUP).size)})`);
}

// ── hardware/inventory figures to normalise the numbers ─────────────────────
const cpu = os.cpus()[0]?.model ?? 'unknown';
const cores = os.cpus().length;
const ramGb = (os.totalmem() / 1024 ** 3).toFixed(1);
// `path.parse` yields `root` ("D:\"), not `drive`; Get-PSDrive wants the bare letter.
const volume = path.parse(ROOT).root.replace(/[\\/:]+$/u, '');
const freeBytes = powershell(`(Get-PSDrive -Name ${psLiteral(volume)}).Free`).trim();
log(`cpu ${cores}x ${cpu}; ram ${ramGb} GB; free on ${volume}: ${freeBytes} bytes`);

const priorDshHome = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
const priorNsisTempDirs = nsisTempDirs();
const results = {};
let installed = false;

try {
  // ── 1. copy baseline ──────────────────────────────────────────────────────
  removeTree(COPY);
  mkdirSync(COPY, { recursive: true });
  log('measuring the raw copy of the same tree (floor for install)');
  let copyStart = Date.now();
  const robocopy = spawnSync(
    'robocopy',
    [PAYLOAD, COPY, '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:0', '/W:0'],
    { encoding: 'utf8', windowsHide: true, timeout: 900_000 },
  );
  results.copyMs = Date.now() - copyStart;
  results.copyExit = robocopy.status ?? -1;
  log(`copy ${secs(results.copyMs)} (robocopy exit ${results.copyExit})`);

  // ── 2. real silent install ────────────────────────────────────────────────
  rmSync(LOG_FILE, { force: true });
  mkdirSync(PARENT, { recursive: true });
  log('installing silently (timed)');
  const installStart = Date.now();
  const install = runExe(SETUP, ['/S', nsisParam('PARENT', PARENT)]);
  results.installMs = Date.now() - installStart;
  results.installExit = install.exit;
  installed = existsSync(path.join(INSTALL, TIMING_APP_EXE));
  log(`install ${secs(results.installMs)} (exit ${install.exit}, produced=${installed})`);
  if (!installed) {
    const elsewhere = existsSync(path.join(OFFICIAL, TIMING_APP_EXE));
    throw new Error(
      `install did not produce ${path.join(INSTALL, TIMING_APP_EXE)}` +
        (elsewhere ? ` — it landed in the official location instead (${OFFICIAL}), so /PARENT was not honoured` : ''),
    );
  }

  const installedMap = fileMap(INSTALL);
  results.installedFiles = installedMap.size;

  // ── 3. recursive delete floor ─────────────────────────────────────────────
  log('measuring a recursive delete of the copy (floor for uninstall)');
  const deleteStart = Date.now();
  removeTree(COPY);
  results.deleteCopyMs = Date.now() - deleteStart;
  log(`delete ${secs(results.deleteCopyMs)}`);

  // ── 4. real silent uninstall ──────────────────────────────────────────────
  const uninstaller = path.join(INSTALL, 'uninstall.exe');
  log('uninstalling silently (timed until the tree is gone)');
  // A silent uninstaller copies itself into `%TEMP%` and relaunches, so launching
  // it returns almost immediately and the real deletion happens in that copy.
  // Timing the launcher alone would measure nothing; what the user waits for is
  // the install directory actually disappearing, so that is what is measured here
  // (`/DELETE_DATA` removes the data directory too, and then `$INSTDIR` itself).
  const uninstallStart = Date.now();
  const uninstall = runExe(uninstaller, ['/S', '/DELETE_DATA']);
  const gone = waitUntil(() => !existsSync(INSTALL), 300_000, 100);
  results.uninstallMs = Date.now() - uninstallStart;
  results.uninstallExit = uninstall.exit;
  results.treeGone = gone;
  log(`uninstall ${secs(results.uninstallMs)} (exit ${uninstall.exit}, tree gone=${gone})`);
  if (!gone) log(`  warning: ${INSTALL} still exists after the wait`);
  installed = false;
} finally {
  // ── report ────────────────────────────────────────────────────────────────
  const rows = [];
  const rate = (bytes, ms) => (ms > 0 ? `${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1)} MB/s` : 'n/a');
  const perFile = (ms, files) => (files > 0 && ms > 0 ? `${(ms / files).toFixed(2)} ms/file` : 'n/a');
  if (results.copyMs !== undefined) rows.push(['copy payload (robocopy /MT:16)', secs(results.copyMs), rate(payloadBytes, results.copyMs), perFile(results.copyMs, expected.size)]);
  if (results.installMs !== undefined) rows.push(['silent install', secs(results.installMs), rate(payloadBytes, results.installMs), perFile(results.installMs, expected.size)]);
  if (results.deleteCopyMs !== undefined) rows.push(['recursive delete (of copy)', secs(results.deleteCopyMs), '', perFile(results.deleteCopyMs, expected.size)]);
  if (results.uninstallMs !== undefined) rows.push(['silent uninstall (/DELETE_DATA)', secs(results.uninstallMs), '', perFile(results.uninstallMs, results.installedFiles ?? expected.size)]);
  process.stdout.write('\n结果\n');
  process.stdout.write(`  ${'阶段'.padEnd(34)} ${'耗时'.padStart(8)} ${'吞吐'.padStart(10)} ${'每文件'.padStart(11)}\n`);
  for (const [name, t, r, p] of rows) {
    process.stdout.write(`  ${name.padEnd(34)} ${t.padStart(8)} ${r.padStart(10)} ${p.padStart(11)}\n`);
  }
  if (results.installMs !== undefined && results.copyMs !== undefined) {
    const extra = results.installMs - results.copyMs;
    process.stdout.write(
      `\n  安装比纯拷贝多花 ${secs(extra)}（占安装 ${(results.installMs > 0 ? (extra / results.installMs) * 100 : 0).toFixed(0)}%）` +
        ` = LZMA 解压 + NSIS 开销\n`,
    );
  }
  if (results.uninstallMs !== undefined && results.deleteCopyMs !== undefined) {
    const extra = results.uninstallMs - results.deleteCopyMs;
    process.stdout.write(
      `  卸载比纯删除多花 ${secs(extra)}（占卸载 ${(results.uninstallMs > 0 ? (extra / results.uninstallMs) * 100 : 0).toFixed(0)}%）` +
        ` = 卸载器自复制 + NSIS 逐项遍历\n`,
    );
  }

  // ── restore ───────────────────────────────────────────────────────────────
  if (existsSync(path.join(INSTALL, 'uninstall.exe'))) {
    runExe(path.join(INSTALL, 'uninstall.exe'), ['/S', '/DELETE_DATA']);
    waitUntil(() => !existsSync(path.join(INSTALL, 'uninstall.exe')), 120_000);
  }
  // Only ever present if /PARENT was not honoured; never leave it behind.
  if (OFFICIAL !== '' && existsSync(path.join(OFFICIAL, TIMING_APP_EXE))) {
    log(`cleaning a mis-targeted install at ${OFFICIAL}`);
    if (existsSync(path.join(OFFICIAL, 'uninstall.exe'))) {
      runExe(path.join(OFFICIAL, 'uninstall.exe'), ['/S', '/DELETE_DATA']);
      waitUntil(() => !existsSync(path.join(OFFICIAL, 'uninstall.exe')), 180_000);
    }
  }
  removeTree(OFFICIAL);
  powershell(
    `Remove-Item -Path ${psLiteral(REG_KEY)},${psLiteral(UNINST_KEY)} -Recurse -Force -ErrorAction SilentlyContinue; ` +
      `Remove-Item -Path ${psLiteral(DESKTOP_LNK)} -Force -ErrorAction SilentlyContinue; ` +
      `Remove-Item -Path ${psLiteral(START_MENU)} -Recurse -Force -ErrorAction SilentlyContinue`,
  );

  // The isolated install wrote, then withdrew, DSH_HOME; put the real value back.
  const current = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
  if (current !== priorDshHome) {
    if (priorDshHome === '') {
      powershell(`[Environment]::SetEnvironmentVariable('DSH_HOME', $null, 'User')`);
    } else {
      powershell(`[Environment]::SetEnvironmentVariable('DSH_HOME', ${psLiteral(priorDshHome)}, 'User')`);
    }
    const restored = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
    log(`DSH_HOME: was ${priorDshHome || '(empty)'}, install left ${current || '(empty)'}, restored ${restored || '(empty)'}`);
  } else {
    log(`DSH_HOME unchanged (${current || '(empty)'})`);
  }

  removeTree(COPY);
  removeTree(WORK);
  const nsisRemoved = cleanNewNsisTempDirs(priorNsisTempDirs);
  log(`removed ${nsisRemoved} NSIS temp dir(s) created by this run`);

  const lingering = powershell(
    `@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like ${psLiteral(path.join(WORK, '*'))} } ` +
      `| Select-Object -ExpandProperty ProcessName) -join ','`,
  ).trim();
  log(lingering === '' ? 'no lingering processes' : `lingering: ${lingering}`);
}
