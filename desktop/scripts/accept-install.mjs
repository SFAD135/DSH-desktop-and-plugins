#!/usr/bin/env node
/**
 * Acceptance test for the Windows installer.
 *
 * Builds throwaway installers from a tiny fake payload and drives their real GUI
 * with SendKeys, reading each page back through scripts/installer-ui.ps1. That is
 * the point: the requirements are about what the pages *say and allow* — which
 * text the Node.js check shows, whether 下一步 is genuinely disabled, what a
 * chosen directory becomes — and none of that is observable from a silent
 * install.
 *
 * Usage:
 *   node scripts/accept-install.mjs          # build, drive the GUI, install/uninstall
 *   node scripts/accept-install.mjs --keep   # leave the scratch tree behind
 *
 * Everything happens under build/installer/accept and a throwaway product id
 * (DSHAccept), so no real install is touched: the id is compiled in, which is why
 * this cannot uninstall the user's own copy.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD = path.join(ROOT, 'build', 'installer', 'accept');
const PAYLOAD = path.join(BUILD, 'payload', 'DSHAccept');
const PARENT = path.join(BUILD, 'install-parent');
const MAKENSIS = path.join(ROOT, 'build', 'tools', 'nsis', 'nsis-3.10', 'makensis.exe');
const UI_DRIVER = path.join(ROOT, 'scripts', 'installer-ui.ps1');
const NSI = path.join(ROOT, 'installer', 'installer.nsi');

/** A product id nothing else uses, so install/uninstall cannot hit a real copy. */
const APP_ID = 'DSHAccept';
/**
 * Every product id this suite can register, and the "Add or remove programs" key
 * each one writes. An install that is uninstalled normally removes its own entry,
 * but the migration branch re-registers the product under a new directory, so the
 * key can survive the run. Left behind, it becomes a phantom entry in 应用和功能
 * pointing at a scratch directory that no longer exists.
 */
const UNINSTALL_ROOT = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
/**
 * Build an "Add or remove programs" key path.
 *
 * Deliberately NOT `path.join`: Node treats the `HKCU:` prefix as a drive-relative
 * path and returns `.\HKCU:\Software\...`, a *filesystem* path that `Test-Path`
 * silently resolves against the working directory. Every check written against such
 * a path passes no matter what the registry contains — which is how a phantom entry
 * survived a cleanup that reported success. Registry paths are plain strings; keep
 * them that way.
 */
const uninstallKeyFor = (id) => `${UNINSTALL_ROOT}\\${id}`;
/** The install-location key the detector reads and the installer writes. */
const REG_KEY = `HKCU:\\Software\\${APP_ID}`;
const APP_EXE = 'DSHAccept.exe';
const APP_FOLDER = 'DSH Desktop';
const BUNDLED_NODE = 'v24.21.0';
const MAIN_EXE = `${APP_ID}.exe`;
/**
 * The no-Node build gets its own product name as well as its own file name.
 * Without that its window and log are indistinguishable from the real build's,
 * and a mix-up silently makes the gate assertions meaningless — which is exactly
 * what happened before this was separate.
 */
const NONODE_ID = 'DSHAcceptNoNode';
const NONODE_EXE = `${NONODE_ID}.exe`;
const INSTALL_DIR = path.join(PARENT, APP_FOLDER);
const LOG_FILE = path.join(process.env.TEMP ?? '', `${APP_ID}-install.log`);
const NONODE_LOG = path.join(process.env.TEMP ?? '', `${NONODE_ID}-install.log`);

const KEEP = process.argv.includes('--keep');

let checks = 0;
let failures = 0;

function check(ok, label, detail = '') {
  checks += 1;
  if (ok) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}\n`);
  }
}

const log = (message) => process.stdout.write(`[accept-install] ${message}\n`);
const psLiteral = (value) => `'${String(value).replace(/'/gu, "''")}'`;

/**
 * Run PowerShell and return stdout+stderr.
 *
 * -NoLogo matters: without it PowerShell prints its copyright banner, which lands
 * in the captured stdout and makes the JSON page dump unparseable. stderr is
 * merged rather than dropped so a failing script reports why instead of looking
 * like it produced nothing.
 */
function runPowerShell(argv) {
  const result = spawnSync(
    'powershell',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...argv],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? '', all: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status };
}

function powershell(command) {
  return runPowerShell(['-Command', command]).all;
}

/** Run a .ps1 file with arguments, returning stdout+stderr. */
function powershellScript(scriptPath, args) {
  return runPowerShell(['-File', scriptPath, ...args]);
}

/**
 * Run a program to completion and return its exit code plus whether it had to be
 * killed.
 *
 * The timeout matters: an installer that shows a modal dialog under /S blocks
 * forever (NSIS does not suppress MessageBox in silent mode), and without this
 * the whole acceptance run would hang instead of failing the one check.
 */
function runToExit(file, args = [], timeoutMs = 120_000) {
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

/**
 * Wait until `predicate` holds, up to a timeout; returns the final verdict.
 *
 * Needed for work the installer finishes asynchronously: an NSIS *uninstaller*
 * copies itself to %TEMP% and exits immediately, so the deletion carries on after
 * the process this test launched is gone — asserting straight away would race it.
 */
/**
 * Remove registry keys and keep them away, until they have stayed gone.
 *
 * A single `Remove-Item` is not enough, for two measured reasons. A late-finishing
 * installer writes its "Add or remove programs" entry a few seconds after the
 * deletion, so checking immediately reports success while a phantom entry for a
 * deleted directory survives — which is exactly what happened before this existed.
 * And the writer is often a process this suite already forgot about, so anything
 * still alive is killed first rather than raced.
 *
 * Absence must therefore be *sustained*: stopping at the first empty observation is
 * what let the late write through, so a result only counts after `STABLE_LOOKS`
 * consecutive clean looks.
 */
async function removeRegistryKeysForGood(keys) {
  const STABLE_LOOKS = 3;
  const remaining = () => keys.filter((key) => powershell(`Test-Path ${psLiteral(key)}`).trim().toLowerCase() === 'true');
  const remove = () => powershell(
    keys.map((key) => `Remove-Item -Path ${psLiteral(key)} -Recurse -Force -ErrorAction SilentlyContinue;`).join(' '),
  );
  let cleanLooks = 0;
  let attempts = 0;
  for (; attempts < 15 && cleanLooks < STABLE_LOOKS; attempts += 1) {
    // Kill-then-remove, not remove-then-hope: an installer mid-write would
    // otherwise re-create the key between the delete and the check.
    stopInstallers();
    if (remaining().length > 0) remove();
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    cleanLooks = remaining().length === 0 ? cleanLooks + 1 : 0;
  }
  const left = remaining();
  return { gone: left.length === 0, attempts, left };
}

/**
 * Like `waitFor`, but returns how many milliseconds it took.
 *
 * The duration is the useful part when waiting for installers to wind down: a long
 * wait is the explanation for a registry entry that came back after an earlier
 * sweep, so it is worth reporting rather than hiding behind a boolean.
 */
async function waitForUntil(predicate, timeoutMs = 30_000, intervalMs = 250) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return Date.now() - start;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  return Date.now() - start;
}

async function waitFor(predicate, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  return predicate();
}

/**
 * Kill anything this test could still have on screen.
 *
 * An NSIS *uninstaller* does not run as `uninstall.exe`: it copies itself to
 * %TEMP%\~nsu<n>.tmp and runs there as **Un.exe**. Matching on process name alone
 * therefore missed exactly the window most likely to be left hanging in front of
 * the user — a modal uninstall wizard or error dialog nobody can click. So the
 * match is on the executable's *path* being inside this run's scratch tree or an
 * NSIS uninstaller temp directory, which is precise and cannot hit unrelated `Un.exe`.
 */
const INSTALLER_PROCESSES = `${psLiteral(APP_ID)},${psLiteral(NONODE_ID)},'uninstall'`;
const stopInstallers = () => powershell(
  `Get-Process -Name ${INSTALLER_PROCESSES} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; ` +
    // Path-based sweep for the temp copy of an uninstaller and anything else
    // launched out of the scratch tree.
    `Get-Process -ErrorAction SilentlyContinue | Where-Object { ` +
    `$_.Path -and ($_.Path -like ${psLiteral(path.join(BUILD, '*'))} -or $_.Path -like ${psLiteral(path.join(process.env.TEMP ?? 'C:\\Windows\\Temp', '~nsu*'))}) ` +
    `} | Stop-Process -Force -ErrorAction SilentlyContinue`,
);

/** Paths of any installer/uninstaller process still alive; empty when clean. */
const lingeringInstallers = () => powershell(
  `@(Get-Process -Name ${INSTALLER_PROCESSES} -ErrorAction SilentlyContinue ` +
    `| Select-Object -ExpandProperty ProcessName) -join ','`,
).trim();

const TEMP_DIR = process.env.TEMP ?? 'C:\\Windows\\Temp';

/**
 * Names of NSIS uninstaller temp directories (`~nsu1.tmp`, …) present right now.
 *
 * An NSIS uninstaller runs from such a directory and normally removes it, but it
 * cannot always delete its own running copy and leaves the folder behind. Only
 * directories that appear *during* this run are cleaned up, so one belonging to
 * some other program's installer is never touched.
 */
const nsisTempDirs = () => new Set(readdirSync(TEMP_DIR).filter((name) => name.startsWith('~nsu')));

function cleanNewNsisTempDirs(before) {
  let removed = 0;
  for (const name of readdirSync(TEMP_DIR)) {
    if (!name.startsWith('~nsu') || before.has(name)) continue;
    if (removeTree(path.join(TEMP_DIR, name))) removed += 1;
  }
  return removed;
}

/**
 * Remove a tree, retrying briefly.
 *
 * A just-launched installer still holds its own .exe open for a moment after
 * being killed, and Windows refuses to delete a directory containing an open
 * file — so a single unlucky rmSync would fail the whole run.
 */
function removeTree(target) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      stopInstallers();
      spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], { windowsHide: true });
    }
  }
}

/** Start an installer, replacing any instance still on screen. */
function launch(exeName, extraArgs = []) {
  const file = path.join(BUILD, exeName);
  const argLiteral = extraArgs.length > 0 ? `-ArgumentList ${extraArgs.map(psLiteral).join(',')}` : '';
  stopInstallers();
  powershell(`Start-Process -FilePath ${psLiteral(file)} ${argLiteral} | Out-Null`);
}

/** Drive the installer UI: optionally click/send keys, then read the page back. */
function ui({ name = APP_ID, clickId, keys, dump = true } = {}) {
  const args = ['-ProcessName', name];
  if (clickId !== undefined) args.push('-ClickId', String(clickId));
  if (keys !== undefined) args.push('-SendKeys', keys);
  if (!dump) args.push('-NoDump');
  const raw = powershellScript(UI_DRIVER, args).all.trim();
  if (!dump) return null;
  const start = raw.indexOf('{');
  if (start < 0) throw new Error(`installer-ui.ps1 produced no JSON:\n${raw.slice(0, 600)}`);
  return JSON.parse(raw.slice(start));
}

const textOf = (page) => (page?.controls ?? []).map((c) => c.text).join('\n');
const controlById = (page, id) => (page?.controls ?? []).find((c) => c.id === id);
const controlByText = (page, needle) => (page?.controls ?? []).find((c) => c.text.includes(needle));
/** The wizard's own 下一步 button lives in the outer window, control id 1. */
const NEXT_BUTTON_ID = 1;
const nextButton = (page) => controlById(page, NEXT_BUTTON_ID);
const pathField = (page) => (page?.controls ?? []).find((c) => c.class === 'Edit');

/**
 * Press 下一步 until the page carrying `marker` is showing.
 *
 * The button is *clicked* (posted BM_CLICK) rather than typed with SendKeys.
 * SendKeys depends on which window happens to have focus, and losing that race
 * left the walk stuck on page 1 — which then showed up as bogus assertions about
 * missing labels on later pages.
 *
 * Markers must be words that appear ONLY on the intended page: the welcome text
 * mentions both 「选择安装位置」 and 「运行环境」 while describing the steps, so
 * those would match page 1 and silently stop the walk.
 */
function advanceTo(marker, { maxPresses = 8, name = APP_ID } = {}) {
  let page = ui({ name });
  for (let i = 0; i < maxPresses; i += 1) {
    if (textOf(page).includes(marker)) return page;
    ui({ name, clickId: NEXT_BUTTON_ID, dump: false });
    page = ui({ name });
  }
  return page;
}

/**
 * Reach a page or fail loudly, quoting what was actually on screen.
 *
 * Every page assertion goes through this so that "the marker was never reached"
 * is reported as itself, instead of surfacing as a confusing complaint about a
 * missing label on some other page.
 *
 * Markers must be words that appear ONLY on the intended page: the welcome text
 * mentions both 「选择安装位置」 and 「运行环境」 while describing the steps, so
 * those would match page 1 and silently stop the walk.
 */
function requirePage(marker, options) {
  const page = advanceTo(marker, options);
  if (!textOf(page).includes(marker)) {
    check(false, `到达「${marker}」页`, `实际页面：${textOf(page).slice(0, 320).replace(/\n/gu, ' | ')}`);
    return null;
  }
  return page;
}

/** Markers unique to each installer page. */
const PAGE = {
  node: '安装包内置',
  scope: '选择安装范围',
  target: '更改安装位置',
};

const logLines = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf16le').split('\n').length : 0);

function compile(outName, defines) {
  const args = [
    '/INPUTCHARSET', 'UTF8',
    `/DPAYLOAD=${PAYLOAD}`,
    `/DOUTFILE=${path.join(BUILD, outName)}`,
    `/DAPPID=${defines.appId ?? APP_ID}`,
    `/DAPPNAME=${defines.appName ?? APP_ID}`,
    `/DAPPEXE=${APP_EXE}`,
    `/DAPPFOLDER=${APP_FOLDER}`,
    '/DAPPVERSION=9.9.9-test',
    '/DAPPVI_VERSION=9.9.9.0',
    `/DBUNDLED_NODE_VERSION=${defines.bundledNode ?? BUNDLED_NODE}`,
    `/DPAYLOAD_BYTES=${defines.payloadBytes ?? 2_000_000}`,
  ];
  if (defines.allowBundledNode === false) args.push('/DALLOW_BUNDLED_NODE=0');
  if (defines.forceNoNode) args.push('/DFORCE_NO_NODE=1');
  // The script path must come LAST: makensis treats everything after it as
  // arguments for the script, not as options. Appending these two defines after
  // the path silently discarded them, which is why the no-Node build kept
  // detecting the real Node.js.
  args.push(NSI);
  const result = spawnSync(MAKENSIS, args, { cwd: ROOT, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) throw new Error(`makensis failed for ${outName}:\n${output}`);
  const warnings = output.match(/warning.*/giu);
  if (warnings) log(`note: makensis warnings for ${outName}: ${warnings.join('; ')}`);
}

// ── scratch payload ─────────────────────────────────────────────────────────
log('assembling a fake payload');
// Snapshot before any uninstaller runs, so the cleanup below can tell this run's
// temp directories from ones that were already there.
const priorNsisTempDirs = nsisTempDirs();
// The installs below export DSH_HOME at user scope and the uninstalls withdraw it,
// so whatever the user had is destroyed by the run itself. Snapshot it now; the
// cleanup restores it. Without this, running this suite on a machine that already
// has a genuine installation silently unpoints that user's command-line dsh.
const priorDshHome = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
if (priorDshHome !== '') log(`noting the existing DSH_HOME to restore later: ${priorDshHome}`);
// Kill first: a left-over installer from an earlier run locks its own .exe, and
// the tree below cannot be removed while that handle is open.
stopInstallers();
// Sweep at the START as well as at the end. A previous run's installer can write
// its registry entry after that run's cleanup gave up, and a phantom "DSHAccept"
// in 应用和功能 pointing at a deleted directory is exactly the thing this suite
// exists to prove it does not leave behind — so clear the slate before measuring.
{
  // Report on what was actually there, not on how many attempts the loop took:
  // proving the keys *stay* gone always takes several observations, so an attempt
  // count would announce a stale entry on every single run.
  const before = [REG_KEY, uninstallKeyFor(APP_ID), uninstallKeyFor(NONODE_ID)]
    .filter((key) => powershell(`Test-Path ${psLiteral(key)}`).trim().toLowerCase() === 'true');
  const stale = await removeRegistryKeysForGood([
    REG_KEY,
    uninstallKeyFor(APP_ID),
    uninstallKeyFor(NONODE_ID),
  ]);
  if (before.length > 0) log(`cleared ${String(before.length)} registry entr(ies) left by an earlier run`);
  if (!stale.gone) log(`warning: could not clear stale registry entries: ${stale.left.join(', ')}`);
}
removeTree(BUILD);
mkdirSync(path.join(PAYLOAD, 'resources', 'app', 'app'), { recursive: true });
writeFileSync(path.join(PAYLOAD, APP_EXE), 'fake executable');
writeFileSync(path.join(PAYLOAD, '使用说明.txt'), '使用说明');
writeFileSync(path.join(PAYLOAD, 'resources', 'app', 'app', 'main.js'), '// fake');
writeFileSync(path.join(PAYLOAD, 'resources', 'blob.bin'), Buffer.alloc(64 * 1024, 7));

removeTree(PARENT);
rmSync(LOG_FILE, { force: true });

// ── build ───────────────────────────────────────────────────────────────────
log('compiling the acceptance installers');
compile(MAIN_EXE, {});
compile(NONODE_EXE, {
  appId: NONODE_ID,
  appName: NONODE_ID,
  bundledNode: '',
  forceNoNode: true,
  allowBundledNode: false,
});

// ── 1. 安装包说明 ───────────────────────────────────────────────────────────
log('checking the welcome page (requirement 1)');
launch(MAIN_EXE);
const welcome = ui();
const welcomeText = textOf(welcome);
check(welcome.title.includes(APP_ID), '窗口标题包含产品名', welcome.title);
check(welcomeText.includes('欢迎安装'), '有安装包说明页');
check(welcomeText.includes('data'), '说明页讲清了数据存放位置');
check(welcomeText.includes('卸载') && welcomeText.includes('保留'), '说明页讲清了卸载保留数据');

// ── 2. Node.js 检测 ─────────────────────────────────────────────────────────
log('checking the Node.js page with a runtime present (requirement 2)');
const nodePage = requirePage(PAGE.node);
const nodeText = textOf(nodePage);
check(nodeText.includes('系统 Node.js'), '分别显示「系统 Node.js」一行');
check(nodeText.includes('安装包内置'), '分别显示「安装包内置」一行');
check(/已检测到 Node\.js/u.test(nodeText), '检测到系统 Node.js', nodeText.match(/已检测到[^\n]*/u)?.[0] ?? '');
check(nodeText.includes(BUNDLED_NODE), '显示内置运行时版本');
check(controlByText(nodePage, '重新检测') !== undefined, '提供「重新检测」按钮');
check(nextButton(nodePage)?.enabled === true, '检测到后「下一步」可用');

const refresh = controlByText(nodePage, '重新检测');
if (refresh === undefined) {
  check(false, '「重新检测」真的重新执行了检测', '按钮未找到');
  check(false, '重新检测后仍停留在本页', '按钮未找到');
} else {
  const before = logLines();
  ui({ clickId: refresh.id, dump: false });
  check(logLines() > before, '「重新检测」真的重新执行了检测', `${before} -> ${logLines()} 行`);
  check(textOf(ui()).includes('安装包内置'), '重新检测后仍停留在本页');
}
stopInstallers();

log('checking that the gate blocks when no Node.js exists (requirement 2)');
rmSync(NONODE_LOG, { force: true });
launch(NONODE_EXE);
const noNodePage = requirePage(PAGE.node, { name: NONODE_ID });
const noNodeText = textOf(noNodePage);
// Proves the dump came from the no-Node build and not from the other installer
// still on screen, which would make every assertion below meaningless.
check(noNodePage?.title?.includes(NONODE_ID) === true, '读到的是无 Node.js 构建的窗口', `标题「${noNodePage?.title ?? ''}」`);
const nodeVerdict = (noNodePage?.controls ?? []).find((c) => c.id === 1204)?.text ?? '';
check(noNodeText.includes('需要先安装 Node.js'), '提示「需要先安装 Node.js」', `结论行「${nodeVerdict.replace(/\n/gu, ' / ')}」`);
check(nextButton(noNodePage)?.enabled === false, '未检测到 Node.js 时「下一步」被禁用', `enabled=${String(nextButton(noNodePage)?.enabled)}`);
check(controlByText(noNodePage, '重新检测') !== undefined, '未检测到时仍提供「重新检测」');
check(controlByText(noNodePage, 'nodejs.org') !== undefined, '未检测到时提供下载入口');
// The gate is not merely a disabled button: the leave handler must refuse too.
// Ask for the next page both ways — clicking 下一步 and a real ENTER keystroke —
// and require that neither gets through.
advanceTo(PAGE.scope, { name: NONODE_ID, maxPresses: 3 });
ui({ name: NONODE_ID, keys: '{ENTER}', dump: false });
ui({ name: NONODE_ID, clickId: NEXT_BUTTON_ID, dump: false });
check(textOf(ui({ name: NONODE_ID })).includes('安装包内置'), '点击与回车都无法越过检测页（离开函数同样拦截）');
stopInstallers();

// ── 3. 安装位置规则 ─────────────────────────────────────────────────────────
log('checking the install-directory rule (requirement 3)');
const dirCases = [
  ['D:\\tools', 'D:\\tools'],
  ['D:\\tools\\', 'D:\\tools'],
  [`D:\\tools\\${APP_FOLDER}`, 'D:\\tools'],
  ['D:\\AI projects\\temp\\工具', 'D:\\AI projects\\temp\\工具'],
  ['C:\\', 'C:'],
];
for (const [parent, expectedParent] of dirCases) {
  launch(MAIN_EXE, [`/PARENT=${parent}`]);
  const page = requirePage(PAGE.target);
  const shown = pathField(page)?.text ?? '';
  const want = `${expectedParent}\\${APP_FOLDER}`;
  check(shown === want, `选择「${parent}」显示「${want}」`, `实际「${shown || '<无>'}」`);
  check(textOf(page).includes(APP_FOLDER), '页面上说明了会创建 DSH Desktop 文件夹');
}
stopInstallers();

// ── 4. successfully / unsuccessfully installing ─────────────────────────────
log('installing (requirement 4: success)');
rmSync(PARENT, { recursive: true, force: true });
rmSync(LOG_FILE, { force: true });
const ok = runToExit(path.join(BUILD, MAIN_EXE), ['/S', `/PARENT="${PARENT}"`]);
check(ok.exit === 0 && !ok.timedOut, '静默安装退出码为 0', `exit=${ok.exit} timedOut=${ok.timedOut}`);
check(existsSync(path.join(INSTALL_DIR, APP_EXE)), '安装后存在主程序', INSTALL_DIR);
check(existsSync(path.join(INSTALL_DIR, '使用说明.txt')), '安装后存在说明文件');
check(existsSync(path.join(INSTALL_DIR, 'data', 'dsh-home')), '创建了 data\\dsh-home');
check(existsSync(path.join(INSTALL_DIR, 'data', 'shell')), '创建了 data\\shell');
// The install exports DSH_HOME so the command-line dsh and the desktop app share
// one home — the whole point of keeping data inside the install directory.
const dshHome = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
check(
  dshHome === path.join(INSTALL_DIR, 'data', 'dsh-home'),
  '安装了 DSH_HOME（命令行 dsh 与桌面版共用数据）',
  `实际「${dshHome}」`,
);
check(existsSync(path.join(INSTALL_DIR, 'uninstall.exe')), '写入了卸载程序');
const marker = path.join(INSTALL_DIR, 'data', 'portable.json');
check(existsSync(marker), '创建了 portable.json 标记');
if (existsSync(marker)) {
  const raw = readFileSync(marker);
  check(raw.every((byte) => byte < 0x80), 'portable.json 是纯 ASCII（任何区域设置下都是合法 UTF-8）');
  try {
    JSON.parse(raw.toString('utf8'));
    check(true, 'portable.json 可被 JSON 解析');
  } catch (error) {
    check(false, 'portable.json 可被 JSON 解析', String(error));
  }
}
check(existsSync(LOG_FILE), '写了安装日志');
const logBytes = existsSync(LOG_FILE) ? readFileSync(LOG_FILE) : Buffer.alloc(0);
check(logBytes[0] === 0xff && logBytes[1] === 0xfe, '日志是 UTF-16LE（非中文区域设置下也不会乱码）');
check(readFileSync(LOG_FILE, 'utf16le').includes('安装完成'), '日志记录了安装完成');

log('installing into an impossible location (requirement 4: failure)');
// A *directory* where the executable must go: the file copy cannot succeed, which
// is the realistic "something went wrong mid-copy" case.
const blocked = path.join(BUILD, 'blocked');
mkdirSync(path.join(blocked, APP_EXE), { recursive: true });
rmSync(LOG_FILE, { force: true });
const bad = runToExit(path.join(BUILD, MAIN_EXE), ['/S', `/DIR="${blocked}"`]);
check(!bad.timedOut, '安装失败时没有卡在对话框上（静默模式不弹窗）', `timedOut=${bad.timedOut}`);
check(bad.exit !== 0, '安装失败时退出码非 0', `exit=${bad.exit}`);
const failLog = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf16le') : '';
check(failLog.includes('安装失败'), '日志记录了失败');
check(/原因|失败/.test(failLog), '日志包含可读的失败原因');
// The payload copy may leave partial files behind — NSIS does not roll back, and
// claiming otherwise would be a lie. What must NOT exist is a half-registered
// install: no uninstaller is written once the copy has failed.
check(!existsSync(path.join(blocked, 'uninstall.exe')), '失败后没有注册出可用的安装（无 uninstall.exe）');

// ── 5. uninstall ────────────────────────────────────────────────────────────
log('uninstalling (data must survive by default)');
// Always drive the real uninstall.exe sitting in the install directory. An NSIS
// uninstaller defaults $INSTDIR to the folder it is *run from*, so running a copy
// from elsewhere makes it delete that folder instead — which wiped this entire
// scratch tree before the installer learned to prefer its recorded InstallDir.
// Not copying it at all is the honest test of how a user actually uninstalls.
const uninstaller = path.join(INSTALL_DIR, 'uninstall.exe');
const un = runToExit(uninstaller, ['/S']);
check(
  await waitFor(() => !existsSync(path.join(INSTALL_DIR, APP_EXE))),
  '卸载后主程序被删除',
  `仍在：${path.join(INSTALL_DIR, APP_EXE)}`,
);
check(existsSync(path.join(INSTALL_DIR, 'data', 'dsh-home')), '默认卸载保留 data（不丢会话）');
// The override is withdrawn on uninstall — but only when it still points at this
// install, so a DSH_HOME the user set for another copy survives.
check(
  await waitFor(
    () => powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim() === '',
    15_000,
    500,
  ),
  '卸载时撤回了 DSH_HOME（命令行 dsh 回到默认数据目录）',
);
check(un.exit === 0 && !un.timedOut, '静默卸载退出码为 0', `exit=${un.exit}`);

log('reinstalling, then uninstalling with /DELETE_DATA');
// A fresh install is needed because the /DELETE_DATA case must start from an
// installed state, and the run above deliberately left the data behind.
const reinstalled = runToExit(path.join(BUILD, MAIN_EXE), ['/S', `/PARENT="${PARENT}"`]);
check(
  reinstalled.exit === 0 && existsSync(path.join(INSTALL_DIR, APP_EXE)),
  '可以覆盖安装到保留了数据的旧目录',
  `exit=${reinstalled.exit}`,
);
const del = runToExit(path.join(INSTALL_DIR, 'uninstall.exe'), ['/S', '/DELETE_DATA']);
check(
  await waitFor(() => !existsSync(path.join(INSTALL_DIR, 'data'))),
  '带 /DELETE_DATA 时数据被删除',
  `exit=${del.exit}`,
);
check(del.exit === 0 && !del.timedOut, '带 /DELETE_DATA 时退出码为 0', `exit=${del.exit}`);
// The whole point of the InstallDir fix: the scratch tree the test lives in must
// still be intact, because the uninstaller removed the install, not its own cwd.
check(existsSync(path.join(BUILD, MAIN_EXE)), '卸载只删安装目录，没有波及安装程序自己所在的目录');

// ── 6. migrating an existing install (requirement 3) ────────────────────────
log('checking the "desktop already installed" branch and migration');
// The migration case launches the installer again, so the compiled installers must
// still be on disk. Assert it here: otherwise a failed launch reads as "no window"
// and every assertion below fails for the wrong reason.
log(`  scratch tree before migration: ${readdirSync(BUILD).join(', ')}`);
check(existsSync(path.join(BUILD, MAIN_EXE)), '迁移测试前安装程序仍然存在', `${MAIN_EXE} 不在 ${BUILD}`);
const OLD_DIR = path.join(BUILD, 'old-install');
const NEW_PARENT = path.join(BUILD, 'migrate-parent');
const NEW_DIR = path.join(NEW_PARENT, APP_FOLDER);
const MARKER_CONTENT = 'MIGRATED-SESSION-DATA';

// A stand-in for an existing per-user install: the executable the detector looks
// for, plus data that must survive the move.
mkdirSync(path.join(OLD_DIR, 'data', 'dsh-home'), { recursive: true });
writeFileSync(path.join(OLD_DIR, 'data', 'dsh-home', 'session.txt'), MARKER_CONTENT);
writeFileSync(path.join(OLD_DIR, APP_EXE), 'previous version');
writeFileSync(path.join(OLD_DIR, 'stale-file.txt'), 'belongs to the old install');
// The registration the detector reads, in the same shape the installer writes.
// `REG_KEY` is declared near the top, because the start-of-run sweep needs it.
powershell(
  `New-Item -Path ${psLiteral(REG_KEY)} -Force | Out-Null; ` +
    `Set-ItemProperty -Path ${psLiteral(REG_KEY)} -Name InstallDir -Value ${psLiteral(OLD_DIR)}; ` +
    `Set-ItemProperty -Path ${psLiteral(REG_KEY)} -Name InstallMode -Value 'user'`,
);
check(
  powershell(`(Get-ItemProperty -Path ${psLiteral(REG_KEY)}).InstallDir`).trim() === OLD_DIR,
  '测试用的旧安装已登记到注册表',
);

launch(MAIN_EXE, [`/PARENT=${NEW_PARENT}`]);
const migratePage = requirePage(PAGE.target);
const migrateText = textOf(migratePage);
check(migrateText.includes('已检测到'), '已装过时页面报告检测结果');
check(migrateText.includes(OLD_DIR), '显示了旧安装目录', migrateText.split('\n').find((l) => l.includes('old-install')) ?? '');
const migrateRadio = (migratePage.controls ?? []).find((c) => c.class === 'Button' && c.text.includes('迁移到新的'));
const keepRadio = (migratePage.controls ?? []).find((c) => c.class === 'Button' && c.text.includes('保持当前目录'));
check(migrateRadio !== undefined, '提供了「迁移安装目录」选项', (migratePage.controls ?? []).filter((c) => c.class === 'Button').map((c) => c.text).join(' | '));
check(keepRadio !== undefined, '提供了「保持当前目录」选项');
// The command-line dsh line must be reported separately, as asked for.
check(migrateText.includes('命令行 dsh'), '单独一行报告命令行 dsh 的状态');

if (migrateRadio === undefined) {
  check(false, '迁移确实搬走了程序与数据', '迁移选项未找到');
} else {
  // Pick 迁移, then walk the remaining pages so the install actually runs.
  ui({ clickId: migrateRadio.id, dump: false });
  for (let i = 0; i < 6; i += 1) {
    ui({ clickId: NEXT_BUTTON_ID, dump: false });
    // eslint-disable-next-line no-await-in-loop -- polling the same outcome
    if (await waitFor(() => existsSync(path.join(NEW_DIR, 'data', 'dsh-home', 'session.txt')), 2_000, 200)) break;
  }
  const moved = existsSync(path.join(NEW_DIR, 'data', 'dsh-home', 'session.txt'));
  check(moved, '迁移把 data 搬到了新目录', NEW_DIR);
  if (moved) {
    check(
      readFileSync(path.join(NEW_DIR, 'data', 'dsh-home', 'session.txt'), 'utf8') === MARKER_CONTENT,
      '迁移后会话数据内容完好',
    );
  }
  check(existsSync(path.join(NEW_DIR, APP_EXE)), '迁移把程序装到了新目录');
  check(!existsSync(path.join(OLD_DIR, 'data')), '旧目录里的 data 已不再存在（是搬走而非复制）');
  check(!existsSync(path.join(OLD_DIR, APP_EXE)), '旧目录里的程序文件已清理');
  const registered = powershell(`(Get-ItemProperty -Path ${psLiteral(REG_KEY)} -ErrorAction SilentlyContinue).InstallDir`).trim();
  check(registered === NEW_DIR, '注册表指向了新的安装目录', `实际「${registered}」`);
}
stopInstallers();

// ── cleanup ─────────────────────────────────────────────────────────────────
stopInstallers();
// Every install in this run exported DSH_HOME at user scope, and every uninstall
// withdrew it again. So a value that existed BEFORE this run is gone by now, and
// simply withdrawing the leftover is not enough — that is what silently destroyed a
// genuine `DSH_HOME` the first time this ran. The original is snapshotted at the
// start (see `priorDshHome`) and put back here.
const leftoverHome = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
if (leftoverHome.toLowerCase().startsWith(BUILD.toLowerCase())) {
  powershell(`[Environment]::SetEnvironmentVariable('DSH_HOME', $null, 'User')`);
  log(`withdrew the scratch DSH_HOME (${leftoverHome})`);
}
if (priorDshHome === '') {
  log('no DSH_HOME left behind');
} else {
  powershell(`[Environment]::SetEnvironmentVariable('DSH_HOME', ${psLiteral(priorDshHome)}, 'User')`);
  log(`restored the pre-existing DSH_HOME (${priorDshHome})`);
}
const homeNow = powershell(`[Environment]::GetEnvironmentVariable('DSH_HOME','User')`).trim();
check(
  homeNow === priorDshHome,
  '测试结束时用户原有的 DSH_HOME 与开跑前一致',
  `开跑前「${priorDshHome || '(空)'}」，现在「${homeNow || '(空)'}」`,
);
powershell(
  `Remove-Item -Recurse -Force ${psLiteral(PARENT)} -ErrorAction SilentlyContinue`,
);
// The migration branch re-registers the product under its new directory, and an
// installer can still be finishing here, so this settles and retries rather than
// deleting once and declaring victory.
const registryCleanup = await removeRegistryKeysForGood([
  REG_KEY,
  uninstallKeyFor(APP_ID),
  uninstallKeyFor(NONODE_ID),
]);
if (KEEP) log(`kept ${path.relative(ROOT, BUILD)}`);
else removeTree(BUILD);
const nsisRemoved = cleanNewNsisTempDirs(priorNsisTempDirs);
log(`removed ${nsisRemoved} NSIS uninstaller temp dir(s) created by this run`);

// A last line of defence: an installer or uninstaller left on screen would sit in
// front of the user waiting for a click nobody knows to make. Report it instead of
// finishing quietly.
const lingering = lingeringInstallers();
check(lingering === '', '结束时没有残留的安装/卸载窗口', `仍在运行：${lingering}`);

// The registry check goes LAST, after every other cleanup and after the processes
// above are confirmed gone.
//
// Measured with a registry watcher: the entry is re-created by the setup binary
// itself (`DSHAccept.exe`) while it finishes its migration work, several seconds
// after an early sweep has already seen the key absent. So the sweep must not start
// until no installer is left to write, and "clean" has to hold across consecutive
// observations rather than for a single instant.
const settleMs = await waitForUntil(() => lingeringInstallers() === '', 60_000);
if (settleMs > 1_000) log(`waited ${String(Math.round(settleMs / 1000))}s for installers to finish before the final registry check`);
// `DSH_ACCEPT_DEBUG=1` dumps what the sweep actually observes. It exists because a
// phantom entry survived a sweep that truthfully saw nothing, and guessing at the
// cause from the outside wasted far more time than one line of evidence.
if (process.env.DSH_ACCEPT_DEBUG === '1') {
  const watched = [REG_KEY, uninstallKeyFor(APP_ID), uninstallKeyFor(NONODE_ID)];
  for (const key of watched) {
    const seen = powershell(
      `if (Test-Path ${psLiteral(key)}) { "PRESENT|" + (Get-ItemProperty ${psLiteral(key)} -ErrorAction SilentlyContinue).InstallLocation } else { "ABSENT" }`,
    ).trim();
    log(`debug before sweep: ${key} -> ${seen}`);
  }
  const alive = powershell(
    `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'DSHAccept|uninstall|Un\\.exe' } | ForEach-Object { "$($_.ProcessId):$($_.Name)" }) -join ','`,
  ).trim();
  log(`debug before sweep: installer processes = ${alive === '' ? '(none)' : alive}`);
}
const finalSweep = await removeRegistryKeysForGood([
  REG_KEY,
  uninstallKeyFor(APP_ID),
  uninstallKeyFor(NONODE_ID),
]);
for (const id of [APP_ID, NONODE_ID]) {
  check(
    !finalSweep.left.includes(uninstallKeyFor(id)),
    `收尾复查：「应用和功能」里没有残留 ${id}`,
    `仍然存在 ${uninstallKeyFor(id)}`,
  );
}
check(
  finalSweep.gone && registryCleanup.gone,
  '测试结束时自己的注册表条目都清干净了（含迟到写入的复查）',
  `残留：${finalSweep.left.join(', ') || registryCleanup.left.join(', ')}`,
);

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
