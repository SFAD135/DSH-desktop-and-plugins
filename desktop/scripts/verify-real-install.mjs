/**
 * End-to-end check of the REAL built installer.
 *
 * `accept-install.mjs` drives a fake 2 MB payload to test the wizard's pages and
 * every failure path quickly. This script is the complementary, slower check: it
 * takes the actual `dist-installer\DeepSeekHarness-Setup-*.exe`, installs it, and
 * proves the installed copy is complete and functional.
 *
 * Deliberate properties:
 *   - It never launches the GUI. Launching Electron would put a window in front of
 *     whoever is using the machine, so the installed app is exercised through its
 *     bundled runtime instead (node.exe and the dsh CLI), which is where a broken
 *     payload would actually show up.
 *   - It installs into a scratch directory via /PARENT, so the official location
 *     (%LOCALAPPDATA%\Programs\DeepSeek Harness) is left untouched.
 *   - It refuses to run when a real install is already registered, because the
 *     uninstall at the end would remove that registration.
 *   - It restores the machine in a `finally`: uninstall, withdraw DSH_HOME if it
 *     still points into the scratch tree, and delete the scratch tree. A failure
 *     part-way through therefore cannot leave a stray install, shortcut or env var.
 *
 * Usage: node scripts/verify-real-install.mjs [path-to-setup.exe]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'DeepSeek Harness';
const APP_EXE = 'DeepSeek Harness.exe';
const APP_FOLDER = 'DSH Desktop';
const REG_KEY = `HKCU:\\Software\\${APP_NAME}`;
const UNINST_KEY = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`;
const LOG_FILE = path.join(os.tmpdir(), `${APP_NAME}-install.log`);

const PAYLOAD = path.join(ROOT, 'build', 'installer', 'payload', APP_NAME);
const WORK = path.join(ROOT, 'build', 'verify-real');
const PARENT = path.join(WORK, 'parent');
const INSTALL = path.join(PARENT, APP_FOLDER);

const DESKTOP_LNK = path.join(os.homedir(), 'Desktop', `${APP_NAME}.lnk`);
const START_MENU = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME,
);

const log = (message) => { process.stdout.write(`[verify-real] ${message}\n`); };
let checks = 0;
let failures = 0;
function check(ok, label, detail = '') {
  checks += 1;
  if (ok) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === '' ? '' : `\n         ${detail}`}\n`);
  }
  return ok;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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

/** Run a program to completion; reports whether it had to be killed. */
function runToExit(file, args = [], timeoutMs = 600_000) {
  const list = args.map(psLiteral).join(',');
  const script =
    `$p = Start-Process -FilePath ${psLiteral(file)} -ArgumentList ${list || '@()'} -PassThru; ` +
    `if ($p.WaitForExit(${timeoutMs})) { exit $p.ExitCode } else { $p.Kill(); exit 997 }`;
  const result = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const exit = result.status ?? -1;
  return { exit, timedOut: exit === 997 };
}

/** Recursively collect `relativePath -> size` for every file under `dir`. */
function fileMap(dir, prefix = '') {
  const map = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}\\${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of fileMap(full, rel)) map.set(k, v);
    } else {
      map.set(rel, statSync(full).size);
    }
  }
  return map;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Delete a tree, retrying and killing anything holding it.
 *
 * A just-finished uninstaller runs as `Un.exe` from an NSIS temp copy and keeps
 * handles open for a moment after the process this script started is gone, so a
 * plain rmSync fails with EPERM. Killing by *path inside the tree* is precise and
 * cannot hit an unrelated program that happens to share a name.
 */
function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    } catch { /* handled by the retry below */ }
    if (!existsSync(target)) return true;
    powershell(
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { ` +
        `$_.Path -and $_.Path -like ${psLiteral(path.join(target, '*'))} } ` +
        `| Stop-Process -Force -ErrorAction SilentlyContinue`,
    );
    spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], { windowsHide: true });
  }
  return !existsSync(target);
}

/** Withdraw DSH_HOME only when it points inside this run's scratch tree. */
function clearScratchDshHome(label) {
  const current = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
  if (current === '') return { cleared: false, current };
  if (!current.toLowerCase().startsWith(WORK.toLowerCase())) {
    return { cleared: false, current, foreign: true };
  }
  powershell(`[Environment]::SetEnvironmentVariable('DSH_HOME', $null, 'User')`);
  if (label !== undefined) log(`${label}: withdrew DSH_HOME (${current})`);
  return { cleared: true, current };
}

/**
 * Names of NSIS uninstaller temp directories (`~nsu1.tmp`, …) present right now.
 *
 * An NSIS uninstaller runs from such a directory and normally removes it, but it
 * cannot always delete its own running copy and leaves the folder behind. Only
 * directories that appear *during* this run are cleaned up, so a directory
 * belonging to some other program's installer is never touched.
 */
const nsisTempDirs = () => new Set(readdirSync(os.tmpdir()).filter((name) => name.startsWith('~nsu')));

function cleanNewNsisTempDirs(before) {
  const pending = () =>
    readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('~nsu') && !before.has(name))
      .map((name) => path.join(os.tmpdir(), name));

  // One pass is not enough. An uninstaller can still be starting up when the script
  // reaches this point, and `Un.exe` re-creates its own `~nsuN.tmp` copy as it runs —
  // so a single sweep both missed a late arrival and raced a directory back into
  // existence. Repeat until a sweep finds nothing left, which is also what makes the
  // reported count mean "gone", not "we tried".
  const removed = new Set();
  for (let pass = 0; pass < 12; pass += 1) {
    const targets = pending();
    if (targets.length === 0) break;
    for (const target of targets) {
      if (removeTree(target)) removed.add(target);
    }
    spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { windowsHide: true });
  }
  return removed.size;
}

// ── preflight ───────────────────────────────────────────────────────────────
const setupArg = process.argv[2];
const SETUP = setupArg !== undefined
  ? path.resolve(setupArg)
  : (() => {
    const dir = path.join(ROOT, 'dist-installer');
    if (!existsSync(dir)) return '';
    const candidates = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.exe'))
      .map((name) => path.join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates[0] ?? '';
  })();

if (SETUP === '' || !existsSync(SETUP)) {
  process.stderr.write(`[verify-real] no setup executable found; build one with: npm run build:installer\n`);
  process.exit(1);
}
if (!existsSync(PAYLOAD)) {
  process.stderr.write(
    `[verify-real] payload missing at ${PAYLOAD}\n` +
      `              the installer rebuilds it, so run: npm run build:installer\n`,
  );
  process.exit(1);
}

log(`setup   ${path.relative(ROOT, SETUP)} (${mb(statSync(SETUP).size)})`);
log(`payload ${mb(fileMap(PAYLOAD).values().reduce((a, b) => a + b, 0))}`);
log(`sha256  ${sha256(SETUP)}`);

// Guard: uninstalling at the end removes the registration, so a genuine install of
// the same product on this machine must not be disturbed.
const existing = powershell(
  `if (Test-Path ${psLiteral(REG_KEY)}) { (Get-ItemProperty ${psLiteral(REG_KEY)}).InstallDir } else { '' }`,
).trim();
if (existing !== '') {
  process.stderr.write(
    `[verify-real] refusing to run: "${APP_NAME}" is already installed at ${existing}\n` +
      `              and this test would uninstall it. Remove it first, or pass an explicit setup path.\n`,
  );
  process.exit(1);
}

removeTree(WORK);
mkdirSync(PARENT, { recursive: true });
const priorDshHome = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
const priorNsisTempDirs = nsisTempDirs();

let installed = false;
try {
  // ── 1. silent install ─────────────────────────────────────────────────────
  log('installing silently into a scratch directory');
  rmSync(LOG_FILE, { force: true });
  const install = runToExit(SETUP, ['/S', `/PARENT=${PARENT}`]);
  installed = existsSync(path.join(INSTALL, APP_EXE));
  check(install.exit === 0 && !install.timedOut, '静默安装退出码为 0', `exit=${install.exit} timedOut=${install.timedOut}`);
  if (!installed) throw new Error(`install did not produce ${path.join(INSTALL, APP_EXE)}`);
  check(true, '安装到了自定义父目录下的 DSH Desktop', INSTALL);

  // ── 2. payload integrity ──────────────────────────────────────────────────
  log('comparing the installed tree against the payload');
  const expected = fileMap(PAYLOAD);
  const actual = fileMap(INSTALL);
  // The installer adds these on top of the payload.
  for (const extra of ['uninstall.exe', 'portable.json']) actual.delete(extra);
  for (const key of [...actual.keys()]) if (key.startsWith('data\\')) actual.delete(key);

  const missing = [...expected.keys()].filter((k) => !actual.has(k));
  const extra = [...actual.keys()].filter((k) => !expected.has(k));
  const sizeMismatch = [...expected.entries()].filter(([k, v]) => actual.has(k) && actual.get(k) !== v);
  check(missing.length === 0, `安装出了 payload 的全部 ${expected.size} 个文件`, `缺少 ${missing.slice(0, 5).join(', ')}`);
  check(extra.length === 0, '安装目录没有 payload 之外的多余文件', `多出 ${extra.slice(0, 5).join(', ')}`);
  check(sizeMismatch.length === 0, '所有文件大小与 payload 一致', `不一致 ${sizeMismatch.slice(0, 5).map(([k]) => k).join(', ')}`);

  // Size equality could still hide a corrupted binary, so the two files that
  // actually run are compared byte for byte.
  const launcher = APP_EXE;
  const nodeExe = 'resources\\runtime\\node\\node.exe';
  check(
    sha256(path.join(INSTALL, launcher)) === sha256(path.join(PAYLOAD, launcher)),
    '主程序与 payload 逐字节一致',
  );
  check(
    sha256(path.join(INSTALL, nodeExe)) === sha256(path.join(PAYLOAD, nodeExe)),
    '内置 Node.js 运行时与 payload 逐字节一致',
  );

  // ── 3. the installed runtime actually works ───────────────────────────────
  log('running the installed runtime headlessly');
  const nodePath = path.join(INSTALL, 'resources', 'runtime', 'node', 'node.exe');
  const dshBin = path.join(INSTALL, 'resources', 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const nodeVersion = spawnSync(nodePath, ['-v'], { encoding: 'utf8', windowsHide: true });
  check(
    nodeVersion.status === 0 && (nodeVersion.stdout ?? '').trim() === 'v24.21.0',
    '安装后的内置 Node.js 可以运行且版本正确',
    `输出「${(nodeVersion.stdout ?? '').trim()}」`,
  );
  // DSH_HOME points into this scratch install, so the CLI writes there and not
  // into the user's real ~/.dsh.
  const dshVersion = spawnSync(nodePath, [dshBin, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DSH_HOME: path.join(INSTALL, 'data', 'dsh-home') },
  });
  check(
    dshVersion.status === 0 && (dshVersion.stdout ?? '').trim() === '0.1.5-rc.2',
    '安装后的 dsh CLI 可以运行且版本正确',
    `输出「${(dshVersion.stdout ?? '').trim()}」 错误「${(dshVersion.stderr ?? '').trim().slice(0, 120)}」`,
  );

  // ── 4. data layout, registration, env var ─────────────────────────────────
  log('checking the data layout and registration');
  check(existsSync(path.join(INSTALL, 'data', 'dsh-home')), '创建了 data\\dsh-home（会话与设置所在）');
  check(existsSync(path.join(INSTALL, 'data', 'shell')), '创建了 data\\shell');
  check(existsSync(path.join(INSTALL, '使用说明.txt')), '安装了使用说明');

  const portable = path.join(INSTALL, 'data', 'portable.json');
  check(existsSync(portable), '写了 data\\portable.json 标记');
  if (existsSync(portable)) {
    const raw = readFileSync(portable);
    check(
      raw.every((byte) => byte < 0x80),
      'portable.json 是纯 ASCII（任何区域设置下都是合法 UTF-8）',
    );
    let parsed = null;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { /* reported below */ }
    check(parsed !== null, 'portable.json 可被 JSON 解析');
  }

  const logRaw = existsSync(LOG_FILE) ? readFileSync(LOG_FILE) : Buffer.alloc(0);
  check(logRaw.length > 0, '写了安装日志', LOG_FILE);
  check(
    logRaw.length >= 2 && logRaw[0] === 0xff && logRaw[1] === 0xfe,
    '日志是 UTF-16LE（非中文区域设置下也不会乱码）',
  );
  const logText = logRaw.toString('utf16le');
  check(logText.includes('安装完成'), '日志记录了安装完成');

  const registered = powershell(
    `$k = Get-ItemProperty ${psLiteral(REG_KEY)} -ErrorAction SilentlyContinue; ` +
      `if ($k) { "$($k.InstallDir)|$($k.InstallMode)" } else { '' }`,
  ).trim();
  check(registered === `${INSTALL}|user`, '注册表记录了安装目录与范围', `实际「${registered}」`);
  const uninstString = powershell(
    `(Get-ItemProperty ${psLiteral(UNINST_KEY)} -ErrorAction SilentlyContinue).UninstallString`,
  ).trim();
  check(
    uninstString.toLowerCase().includes('uninstall.exe'),
    '在「应用和功能」里注册了卸载项',
    `实际「${uninstString}」`,
  );

  const dshHome = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
  check(
    dshHome === path.join(INSTALL, 'data', 'dsh-home'),
    '安装了 DSH_HOME（命令行 dsh 与桌面版共用数据）',
    `实际「${dshHome}」`,
  );

  check(existsSync(DESKTOP_LNK), '创建了桌面快捷方式');
  check(existsSync(START_MENU), '创建了开始菜单项');

  // ── 5. uninstall ──────────────────────────────────────────────────────────
  log('uninstalling (data must survive by default)');
  const un = runToExit(path.join(INSTALL, 'uninstall.exe'), ['/S']);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && existsSync(path.join(INSTALL, APP_EXE))) {
    spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { windowsHide: true });
  }
  check(!existsSync(path.join(INSTALL, APP_EXE)), '卸载后主程序被删除');
  check(existsSync(path.join(INSTALL, 'data', 'dsh-home')), '默认卸载保留 data（不丢会话）');
  check(un.exit === 0 && !un.timedOut, '静默卸载退出码为 0', `exit=${un.exit}`);
  check(!existsSync(DESKTOP_LNK), '卸载后桌面快捷方式被删除');
  check(!existsSync(START_MENU), '卸载后开始菜单项被删除');
  check(
    powershell(`if (Test-Path ${psLiteral(REG_KEY)}) { 'yes' } else { '' }`).trim() === '',
    '卸载后注册表项被清理',
  );
  check(
    powershell(`if (Test-Path ${psLiteral(UNINST_KEY)}) { 'yes' } else { '' }`).trim() === '',
    '卸载后「应用和功能」里的卸载项被清理',
  );
  const homeAfter = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
  check(
    homeAfter === '',
    '卸载时撤回了 DSH_HOME（命令行 dsh 回到默认数据目录）',
    `实际「${homeAfter}」`,
  );

  // The uninstaller's $INSTDIR defaults to the folder it runs from, so prove it
  // removed the install and not this script's own working directory.
  check(existsSync(SETUP), '卸载只删安装目录，没有波及安装程序自己所在的目录');
} finally {
  // ── restore ───────────────────────────────────────────────────────────────
  // Everything below must hold even if an assertion above threw, otherwise the
  // machine is left with a stray install, shortcut or redirected dsh home.
  if (existsSync(path.join(INSTALL, 'uninstall.exe'))) {
    runToExit(path.join(INSTALL, 'uninstall.exe'), ['/S', '/DELETE_DATA']);
  }
  powershell(
    `Remove-Item -Path ${psLiteral(REG_KEY)},${psLiteral(UNINST_KEY)} -Recurse -Force -ErrorAction SilentlyContinue; ` +
      `Remove-Item -Path ${psLiteral(DESKTOP_LNK)} -Force -ErrorAction SilentlyContinue; ` +
      `Remove-Item -Path ${psLiteral(START_MENU)} -Recurse -Force -ErrorAction SilentlyContinue`,
  );
  const homeState = clearScratchDshHome('cleanup');
  if (homeState.cleared) {
    check(true, '收尾时没有留下指向临时目录的 DSH_HOME');
  } else if (homeState.current === '') {
    check(true, '收尾时没有留下指向临时目录的 DSH_HOME');
  } else if (homeState.foreign === true) {
    // A DSH_HOME the user set for a genuine install must be left alone.
    log(`left an unrelated DSH_HOME alone: ${homeState.current}`);
    check(true, '收尾时没有留下指向临时目录的 DSH_HOME');
  }
  // This run's install exported DSH_HOME at user scope and this run's uninstall
  // withdrew it again, so a value that existed beforehand is already gone by now.
  // Merely asserting that would report the damage after the fact; put it back.
  if (priorDshHome !== '') {
    powershell(`[Environment]::SetEnvironmentVariable('DSH_HOME', ${psLiteral(priorDshHome)}, 'User')`);
    log(`restored the pre-existing DSH_HOME (${priorDshHome})`);
  }
  check(
    priorDshHome === powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim(),
    '测试没有改变用户原有的 DSH_HOME',
    `原本「${priorDshHome}」`,
  );
  check(removeTree(WORK), '收尾时清理了临时目录');
  const nsisRemoved = cleanNewNsisTempDirs(priorNsisTempDirs);
  log(`removed ${nsisRemoved} NSIS uninstaller temp dir(s) created by this run`);

  const lingering = powershell(
    `@(Get-Process -Name ${psLiteral(APP_NAME)},'uninstall' -ErrorAction SilentlyContinue ` +
      `| Select-Object -ExpandProperty ProcessName) -join ','`,
  ).trim();
  check(lingering === '', '结束时没有残留的安装/卸载进程', `仍在运行：${lingering}`);
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
