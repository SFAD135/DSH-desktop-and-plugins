'use strict';
/**
 * DeepSeek Harness Desktop — Electron shell.
 *
 * Responsibilities:
 *   1. own the process lifecycle of a bundled `dsh web` service (bundled
 *      Node.js runtime + bundled complete `@deepseek-ai/dsh` package tree);
 *   2. host that service in a native WebView window;
 *   3. share `%USERPROFILE%\.dsh` with the command line `dsh`, so sessions,
 *      settings, credentials and plugins are the same data;
 *   4. fail loudly and recoverably: a startup/crash problem renders an error
 *      page with the real stderr tail instead of a blank window.
 *
 * The local pages (loading.html / error.html) talk to this process through the
 * guarded preload bridge; the served Web GUI never gets the bridge.
 */
const { app, BrowserWindow, ClipboardItem, Menu, Tray, shell, dialog, clipboard, nativeImage, ipcMain, session } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_WEB_PORT, detectProfileConflicts } = require('./host-detect');
const { ABOUT_BUTTONS, aboutClipboardText, buildAbout } = require('./about-text');
const { DEFAULT_DSH_HOME, DEFAULT_SETTINGS, persistedSettings, resolveSettings } = require('./settings');
const { dshHomeDir, resolveDataRoot, shellDataDir } = require('./data-root');
const { copyHome, declineImport, migrationPrompt, planMigration } = require('./migrate');
const { buildContextMenu, isBrowsable } = require('./context-menu');
const { hostPathForImageUrl, imageFileName, imageMarkdown, isDurableImageUrl, isFileBackedImageUrl, isShareableImageUrl } = require('./image-actions');
const { createOpenWatch } = require('./open-diagnostics');

// ── paths ───────────────────────────────────────────────────────────────────
const APP_DIR = __dirname;
const APP_ROOT = path.join(APP_DIR, '..');

/**
 * Resolve the bundled runtime. The packaged layout puts it under
 * `resources/runtime`; a source checkout keeps it under `build/runtime`.
 * Existence decides, so the shell behaves the same whether Electron was
 * started with an explicit app path or through the packaged entry point.
 */
function resolveRuntimeRoot() {
  const packaged = path.join(process.resourcesPath, 'runtime');
  if (fs.existsSync(path.join(packaged, 'node', 'node.exe'))) return packaged;
  const development = path.join(APP_ROOT, 'build', 'runtime');
  if (fs.existsSync(path.join(development, 'node', 'node.exe'))) return development;
  return packaged;
}

const RUNTIME_ROOT = resolveRuntimeRoot();
const NODE_EXE = path.join(RUNTIME_ROOT, 'node', 'node.exe');
const NODE_DIR = path.join(RUNTIME_ROOT, 'node');
const DSH_BIN = path.join(RUNTIME_ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BIN_DIR = path.join(RUNTIME_ROOT, 'bin');
const ICON_PNG = path.join(APP_DIR, 'assets', 'icon.png');
/** The user's home: also the service cwd, used only as a last-resort sandbox root. */
const HOME = os.homedir();

// ── data root ───────────────────────────────────────────────────────────────
// An installed copy can keep everything beside its executable (`<install>\data`);
// see `data-root.js` for the precedence. This must run before anything reads
// `app.getPath('userData')`, because Electron resolves its own paths once and
// the Chromium profile (settings, cookies, caches) moves with them.
const EXE_DIR = path.dirname(app.getPath('exe'));
const DATA_ROOT = resolveDataRoot({ env: process.env, exeDir: EXE_DIR });
/** Set when `--user-data-dir` was passed: an explicit runtime override wins. */
const EXPLICIT_USER_DATA = process.argv.some((arg) => arg.startsWith('--user-data-dir'));
const PORTABLE_SHELL_DIR = shellDataDir(DATA_ROOT.root);
if (PORTABLE_SHELL_DIR !== null && !EXPLICIT_USER_DATA) app.setPath('userData', PORTABLE_SHELL_DIR);

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'shell-settings.json');
/** The dsh home this shell defaults to: beside the executable, or the shared `~/.dsh`. */
const DEFAULT_HOME_FOR_SETTINGS = dshHomeDir(DATA_ROOT.root) ?? DEFAULT_DSH_HOME;

/**
 * The dsh profile this shell boots. It is deliberately NOT `desktop`: upstream
 * reserves that name for its own Electron application and the CLI refuses to
 * boot it, and sharing `web` is what makes plugins/sessions common with a
 * command-line `dsh web`.
 */
const PROFILE_NAME = 'web';

function profileDir() {
  return path.join(settings.dshHome, 'profiles', PROFILE_NAME);
}

/** Whether this shell uses the shared default home (and therefore a bare `dsh` reads the same data). */
function isDefaultHome() {
  return path.resolve(settings.dshHome).toLowerCase() === path.resolve(DEFAULT_DSH_HOME).toLowerCase();
}

/** Whether the shell keeps its own data beside the executable. */
function isPortable() {
  return DATA_ROOT.root !== null && !EXPLICIT_USER_DATA;
}

const URL_LINE = /dsh web:\s+(https?:\/\/\S+)/u;
const LOG_TAIL_LIMIT = 64 * 1024;

// ── settings ────────────────────────────────────────────────────────────────
/**
 * The settings the shell runs with (this launch's environment overrides
 * included). `storedSettings` is the subset that belongs in the file; runtime
 * changes are applied to both through {@link updateSettings}.
 */
let settings = { ...DEFAULT_SETTINGS };
let storedSettings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  let raw = {};
  let read = false;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    read = true;
  } catch {
    /* first run: defaults */
  }
  const { settings: resolved, stored, retired, unexpected } = resolveSettings(raw, process.env, {
    defaultDshHome: DEFAULT_HOME_FOR_SETTINGS,
  });
  settings = resolved;
  storedSettings = stored;
  if (retired.length > 0) logShell(`settings: dropped retired key(s) ${retired.join(', ')}`);
  if (unexpected.length > 0) logShell(`settings: dropped unrecognized key(s) ${unexpected.join(', ')}`);
  // Rewrite once so a file written by an older version stops carrying keys that
  // no longer mean anything. Without this the cleanup would wait for the user's
  // next window move or port change.
  if (read && (retired.length > 0 || unexpected.length > 0)) saveSettings();
}

/** Apply a persistable change to both the effective and the stored settings. */
function updateSettings(patch, { persist = true } = {}) {
  Object.assign(settings, patch);
  Object.assign(storedSettings, patch);
  if (persist) saveSettings();
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(persistedSettings(storedSettings), null, 2)}\n`);
  } catch (error) {
    logShell(`could not persist settings: ${error.message}`);
  }
}

// ── logging ─────────────────────────────────────────────────────────────────
let logStream = null;
function openLogs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  logStream = fs.createWriteStream(path.join(LOG_DIR, `desktop-${stamp}.log`), { flags: 'a' });
}
function logShell(message) {
  const line = `[shell] ${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  logStream?.write(line);
}

/** Bounded tail of the service output, shown verbatim on the error page. */
class Tail {
  constructor(limit) {
    this.limit = limit;
    this.value = '';
  }
  push(text) {
    this.value += text;
    if (this.value.length > this.limit) this.value = this.value.slice(this.value.length - this.limit);
  }
  clear() {
    this.value = '';
  }
  get text() {
    return this.value;
  }
}

// ── first-run import of an existing home ────────────────────────────────────
/**
 * Offer to copy an existing `~/.dsh` into this installation's own home.
 *
 * Only relevant when the shell keeps its data beside the executable; the copy
 * never removes the source, so the command line keeps working either way.
 */
async function importExistingHome() {
  const targetHome = path.resolve(settings.dshHome);
  const sourceHome = path.resolve(DEFAULT_DSH_HOME);
  const plan = planMigration({ sourceHome, targetHome, sourceHomeIsTarget: sourceHome === targetHome });
  if (!plan.offer) {
    logShell(`import: not offered (${plan.reason})`);
    return;
  }

  logShell(`import: offering to copy ${sourceHome} -> ${targetHome}`);
  const prompt = migrationPrompt(plan);
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '导入已有数据',
    message: prompt.message,
    detail: prompt.detail,
    buttons: ['导入', '不导入'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) {
    declineImport(plan);
    logShell('import: declined; recorded so the offer is not repeated');
    return;
  }

  try {
    const result = copyHome(plan, {
      onProgress: ({ copied }) => {
        if (copied % 200 === 0) logShell(`import: ${String(copied)} files copied…`);
      },
    });
    logShell(`import: done, ${String(result.copied)} files copied into ${targetHome}`);
    showShellPage('loading.html');
  } catch (error) {
    logShell(`import: failed: ${error.message}`);
    await dialog.showMessageBox({
      type: 'warning',
      title: '导入失败',
      message: '导入已有数据时出错',
      detail: `${error.message}\n\n本安装将以空数据启动。原数据未被修改，仍保留在：\n${sourceHome}`,
      buttons: ['确定'],
      noLink: true,
    });
  }
}

// ── shell/service state ─────────────────────────────────────────────────────
const state = {
  phase: 'idle', // idle | starting | ready | failed | stopping
  url: null,
  port: null,
  message: '准备启动',
  error: null,
  attempts: 0,
  child: null,
  serviceLog: null,
  shellPage: null,
  quitRequested: false,
  startedAt: 0,
  concurrency: null,
};
const serviceTail = new Tail(LOG_TAIL_LIMIT);
const shellTail = new Tail(LOG_TAIL_LIMIT);

let mainWindow = null;
let tray = null;
let statusTimer = null;

// ── shared-profile concurrency detection ────────────────────────────────────
// This shell exists to share `$DSH_HOME` (and the `web` profile) with the
// command-line `dsh`. Nothing in dsh takes a profile-wide lock — its only
// cross-process lock is a per-session kernel lease held while a session is
// being written — so a second host on the same profile is possible and merely
// hazardous (live patch reload, shared storage writes). It is therefore
// reported as a gentle warning, never a block.
const CONCURRENCY_SETTLE_MS = 1500;
const CONCURRENCY_INTERVAL_MS = 60_000;
let concurrencyBusy = false;
let concurrencyInterval = null;
let concurrencySettleTimer = null;

/** The window title, carrying the warning when another host shares this profile. */
function windowTitle() {
  const base = 'DeepSeek Harness';
  return state.concurrency?.conflict
    ? `${base} — 注意：另一个 dsh 可能正在使用同一数据（profile「${PROFILE_NAME}」）`
    : base;
}

function applyWindowTitle() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(windowTitle());
}

function applyTrayTooltip() {
  if (!tray) return;
  tray.setToolTip(state.concurrency?.conflict
    ? `DeepSeek Harness — 另一个 dsh 可能正在使用 profile「${PROFILE_NAME}」`
    : 'DeepSeek Harness');
}

/**
 * Look for other dsh hosts that share this profile, and surface the result in
 * the window title, the tray tooltip and the shell pages.
 *
 * Fail-open by design: `host-detect` reports each signal's availability
 * separately, so an environment where the process list cannot be read still
 * yields the port-fingerprint verdict (and vice versa) instead of a silent
 * "all clear".
 * @param options - `force` re-checks even during the settle window.
 */
async function refreshConcurrency({ force = false } = {}) {
  if (concurrencyBusy) return state.concurrency;
  if (state.phase !== 'ready' && state.phase !== 'starting') return state.concurrency;
  if (!force && state.concurrency?.checkedAt && Date.now() - state.concurrency.checkedAt < 10_000) return state.concurrency;
  concurrencyBusy = true;
  try {
    // Never fingerprint our own port: otherwise pinning the shell to 3080 would
    // report the shell itself as a competing host.
    const probePorts = [DEFAULT_WEB_PORT].filter((port) => String(port) !== String(state.port));
    const result = await detectProfileConflicts({
      profile: PROFILE_NAME,
      excludePids: [state.child?.pid].filter((pid) => typeof pid === 'number'),
      ownBinPaths: [DSH_BIN],
      probePorts,
    });
    const wasConflicting = Boolean(state.concurrency?.conflict);
    state.concurrency = {
      conflict: result.conflict,
      detail: result.detail,
      others: result.matching.map((host) => ({ pid: host.pid, profile: host.profile })),
      probes: result.probes.map((probe) => ({ port: probe.port, isDshHost: probe.isDshHost, status: probe.status, detail: probe.detail })),
      scanAvailable: result.scanAvailable,
      scanError: result.scanError,
      checkedAt: Date.now(),
    };
    const evidence = result.detail.length > 0 ? result.detail.join('；') : '未发现其它 host';
    logShell(`profile check: profile=${PROFILE_NAME} conflict=${String(result.conflict)} — ${evidence}${result.scanError ? `（进程扫描不可用：${result.scanError.trim()}）` : ''}`);
    if (wasConflicting !== result.conflict) {
      applyWindowTitle();
      applyTrayTooltip();
    }
    pushStatus();
    return state.concurrency;
  } catch (error) {
    logShell(`profile check failed: ${error.message}`);
    return state.concurrency;
  } finally {
    concurrencyBusy = false;
  }
}

/** Re-check shortly after the service becomes ready (the own-port filter changed). */
function scheduleConcurrencyCheck() {
  if (concurrencySettleTimer) clearTimeout(concurrencySettleTimer);
  concurrencySettleTimer = setTimeout(() => {
    concurrencySettleTimer = null;
    void refreshConcurrency({ force: true });
  }, CONCURRENCY_SETTLE_MS);
}

function statusSnapshot() {
  return {
    phase: state.phase,
    message: state.message,
    error: state.error,
    url: state.url,
    port: state.port,
    dshHome: settings.dshHome,
    profileName: PROFILE_NAME,
    profileDir: profileDir(),
    homeShared: isDefaultHome(),
    // Where this copy keeps things, so the UI can say "everything lives here".
    dataRoot: DATA_ROOT.root,
    dataRootSource: DATA_ROOT.source,
    shellDataDir: app.getPath('userData'),
    concurrency: state.concurrency,
    dshVersion: dshVersion(),
    nodeVersion: nodeVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    logs: serviceTail.text + shellTail.text,
    logDir: LOG_DIR,
    serviceLog: state.serviceLog,
    attempts: state.attempts,
  };
}

function pushStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (state.phase === 'ready') return; // the real GUI owns the window now
  mainWindow.webContents.send('dsh:status', statusSnapshot());
}

function setPhase(phase, message, error = null) {
  state.phase = phase;
  state.message = message;
  state.error = error;
  logShell(`phase=${phase} ${message}${error ? ` (${error})` : ''}`);
  pushStatus();
}

let cachedVersions = null;
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function dshVersion() {
  cachedVersions ??= {};
  cachedVersions.dsh ??= readJsonSafe(path.join(RUNTIME_ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))?.version ?? 'unknown';
  return cachedVersions.dsh;
}
function nodeVersion() {
  cachedVersions ??= {};
  if (cachedVersions.node === undefined) {
    const result = spawnSync(NODE_EXE, ['-v'], { encoding: 'utf8', windowsHide: true });
    cachedVersions.node = result.status === 0 ? result.stdout.trim() : 'unknown';
  }
  return cachedVersions.node;
}

function childEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_FORCE_IS_PACKAGED;
  env.DSH_HOME = settings.dshHome;
  env.DSH_DESKTOP_SHELL = 'electron';
  const parts = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  // The bundled directory carries only a `pnpm` shim (`dsh plugin` forwards to
  // pnpm); the system `node` on PATH is deliberately left alone.
  env.PATH = [BIN_DIR, ...parts].join(path.delimiter);
  env.Path = env.PATH;
  return env;
}

function stopService() {
  const child = state.child;
  state.child = null;
  if (!child) return;
  if (child.pollTimer) clearInterval(child.pollTimer);
  child.pollTimer = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  logShell(`stopping service pid=${child.pid}`);
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch (error) {
    logShell(`could not stop service: ${error.message}`);
  }
}

/** Pick a concrete port for the next start (0 = let the OS choose). */
function startService({ freshAttempt = true } = {}) {
  if (freshAttempt) state.attempts = 0;
  state.quitRequested = false;

  if (!fs.existsSync(NODE_EXE)) return failFast('捆绑的 Node 运行时缺失', `找不到 ${NODE_EXE}\n请先运行：npm run prepare:runtime`);
  if (!fs.existsSync(DSH_BIN)) return failFast('捆绑的 dsh 包缺失', `找不到 ${DSH_BIN}\n请先运行：npm run prepare:runtime`);

  stopService();
  serviceTail.clear();
  state.url = null;
  state.port = null;
  setPhase('starting', '正在启动本地 dsh 服务…');
  showShellPage('loading.html');

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  state.serviceLog = path.join(LOG_DIR, `dsh-service-${stamp}.log`);
  const port = Number(settings.port) || 0;
  const args = [DSH_BIN, 'web', '--port', String(port), '--no-open'];
  logShell(`spawn ${NODE_EXE} ${args.join(' ')}`);
  logShell(`cwd=${HOME} DSH_HOME=${settings.dshHome}`);
  logShell(`service log: ${state.serviceLog}`);

  // The service writes into a log file rather than a pipe: that keeps the full
  // transcript on disk and does not depend on the host allowing piped stdio.
  const logFd = fs.openSync(state.serviceLog, 'a');
  let child;
  try {
    child = spawn(NODE_EXE, args, {
      // The service cwd only ever serves as a last-resort sandbox root for a
      // session that carries no cwd of its own; it does not choose where work
      // happens, so the user's home is the neutral choice.
      cwd: HOME,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  state.child = child;
  state.startedAt = Date.now();
  // Check now (not before the spawn) so the shell's own service is already
  // visible to the scan — and excluded by launcher path, never by pid alone.
  void refreshConcurrency({ force: true });

  let offset = 0;
  let buffered = '';
  const drain = () => {
    try {
      const size = fs.statSync(state.serviceLog).size;
      if (size <= offset) return;
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(state.serviceLog, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
      const text = buffer.toString('utf8');
      serviceTail.push(text);
      buffered = (buffered + text).slice(-16384);
      const match = URL_LINE.exec(buffered);
      if (match && state.phase === 'starting') {
        buffered = '';
        onServiceReady(match[1]);
      }
      scheduleStatus();
    } catch (error) {
      logShell(`could not read the service log: ${error.message}`);
    }
  };
  const poll = setInterval(drain, 200);
  child.pollTimer = poll;

  child.on('error', (error) => {
    clearInterval(poll);
    setPhase('failed', `无法启动本地服务：${error.message}`, error.message);
    showShellPage('error.html');
  });
  child.on('exit', (code, signal) => {
    clearInterval(poll);
    // Give the service's last output a moment to land on disk before judging.
    setTimeout(() => {
      drain();
      if (state.child !== child) return; // superseded by a newer start
      state.child = null;
      if (state.quitRequested) return;
      const detail = `dsh 服务进程退出（code=${String(code)} signal=${String(signal)}）`;
      logShell(detail);
      if (/EADDRINUSE/u.test(serviceTail.text)) return scheduleRestart('端口被占用，正在换用空闲端口重试…', { resetPort: true });
      if (state.phase === 'ready') return scheduleRestart(detail);
      setPhase('failed', '本地服务启动失败', `${detail}\n\n${serviceTail.text.slice(-4000)}`);
      showShellPage('error.html');
    }, 200);
  });
}

function failFast(title, detail) {
  setPhase('failed', title, detail);
  showShellPage('error.html');
}

function scheduleRestart(reason, { resetPort = false } = {}) {
  if (state.quitRequested) return;
  if (!settings.autoRestart) return failFast('本地服务已停止', `${reason}\n\n${serviceTail.text.slice(-4000)}`);
  if (state.attempts >= 5) return failFast('本地服务反复启动失败', `${reason}\n\n${serviceTail.text.slice(-4000)}`);
  state.attempts += 1;
  const delay = Math.min(1000 * 2 ** (state.attempts - 1), 15000);
  if (resetPort && settings.port !== 0) updateSettings({ port: 0 });
  setPhase('starting', `${reason}（第 ${state.attempts}/5 次重试，${Math.round(delay / 1000)} 秒后）`);
  showShellPage('loading.html');
  setTimeout(() => {
    if (state.quitRequested) return;
    startService({ freshAttempt: false });
  }, delay);
}

function onServiceReady(url) {
  state.url = url;
  try {
    state.port = Number(new URL(url).port) || null;
  } catch {
    state.port = null;
  }
  setPhase('ready', `服务已就绪：${url}`);
  state.shellPage = null; // the served GUI takes over the window
  scheduleConcurrencyCheck();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(url).catch((error) => {
    setPhase('failed', '无法加载 Web 界面', error.message);
    showShellPage('error.html');
  });
}

function scheduleStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    pushStatus();
  }, 250);
}

// ── window ──────────────────────────────────────────────────────────────────
function shellPageUrl(file) {
  return pathToFileURL(path.join(APP_DIR, file)).toString();
}

function showShellPage(file) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Track the intended page explicitly: asking for the page that is already
  // loading would abort the in-flight navigation.
  if (state.shellPage === file) {
    pushStatus();
    return;
  }
  state.shellPage = file;
  mainWindow.loadFile(path.join(APP_DIR, file)).catch((error) => {
    if (error.code === 'ERR_ABORTED') return;
    logShell(`could not load ${file}: ${error.message}`);
  });
}

function windowIcon() {
  if (!fs.existsSync(ICON_PNG)) return undefined;
  const image = nativeImage.createFromPath(ICON_PNG);
  return image.isEmpty() ? undefined : image;
}

// ── context menu ────────────────────────────────────────────────────────────
/** The inspector entry is offered only when explicitly asked for. */
const DEVTOOLS_ENABLED = process.env.DSH_DESKTOP_DEVTOOLS === '1';

/** Turn a descriptor from `context-menu.js` into a real Menu item template. */
function toMenuTemplateItem(item) {
  if (item.type === 'separator') return { type: 'separator' };
  // A `role` item is handled by Electron itself: native undo/clipboard behaviour.
  if (item.role) {
    const template = { role: item.role, label: item.label };
    if (item.accelerator) template.accelerator = item.accelerator;
    if (item.enabled === false) template.enabled = false;
    return template;
  }
  return {
    label: item.label,
    ...(item.enabled === false ? { enabled: false } : {}),
    click: () => void runContextCommand(item.command, item.payload ?? {}),
  };
}

/** Perform a menu command that has no Electron role. */
async function runContextCommand(command, payload) {
  const openExternal = (url) => {
    shell.openExternal(url).catch((error) => logShell(`openExternal failed: ${error.message}`));
  };
  switch (command) {
    case 'copyLink':
    case 'copyImageUrl':
    case 'copyPageUrl':
      await writeClipboardText(payload.text ?? '');
      return;
    case 'openLink':
    case 'openPageExternally':
      if (isBrowsable(payload.url)) openExternal(payload.url);
      return;
    case 'reload':
      mainWindow?.webContents.reload();
      return;
    case 'inspect':
      mainWindow?.webContents.inspectElement(payload.x ?? 0, payload.y ?? 0);
      return;
    case 'copyImage':
      await copyImageToClipboard(payload.url);
      return;
    case 'saveImage':
      await saveImageToDisk(payload.url);
      return;
    case 'copyImagePath': {
      const hostPath = hostPathForImageUrl(payload.url);
      if (hostPath === null) {
        await reportImageFailure('复制本地路径', payload.url, new Error('这张图片没有对应的本地文件（页面内生成的图片）'));
        return;
      }
      await writeClipboardText(hostPath);
      return;
    }
    case 'copyImageMarkdown':
      await writeClipboardText(imageMarkdown({ url: payload.url }));
      return;
    default:
      logShell(`unhandled context menu command: ${command}`);
  }
}

/**
 * Put plain text on the clipboard.
 *
 * Electron 40 replaced the clipboard with the W3C-shaped **asynchronous** API, so
 * every write returns a Promise. Ignoring it would let a failure vanish, which is
 * the silent-no-op this whole area was reported for.
 *
 * @param text - the text to copy.
 * @returns `true` when it was written.
 */
async function writeClipboardText(text) {
  try {
    await clipboard.writeText(String(text ?? ''));
    return true;
  } catch (error) {
    logShell(`clipboard write failed: ${error.message}`);
    return false;
  }
}

/** Raster types the system clipboard accepts as image data. */
const CLIPBOARD_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']);

/** Normalize a response content type to a bare, lowercase MIME type. */
function bareMimeType(contentType) {
  const value = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return value.length > 0 ? value : null;
}

/**
 * Read an image's bytes, whichever way it is addressed.
 *
 * The bytes are read **in the page**, not in the main process, because that is
 * the only context where both shapes actually resolve:
 *
 *   - `/api/file?path=…` needs the `dsh-auth-*` cookie the page holds; a
 *     cookie-less main-process `fetch` is answered with HTTP 401 (verified), and
 *     that 401 is exactly why the first version of this menu did nothing;
 *   - `blob:` URLs exist only inside the renderer and cannot be fetched from the
 *     main process at all.
 *
 * `file:` URLs are the exception: the page cannot read them, but the main process
 * can open them directly from disk.
 *
 * @param url - the image URL as the page reported it.
 * @returns `{ buffer, contentType }`, or throws with a human-readable reason.
 */
async function readImageBytes(url) {
  const hostPath = hostPathForImageUrl(url);
  const isFileUrl = /^file:/iu.test(String(url ?? ''));
  if (hostPath !== null && isFileUrl) {
    const image = nativeImage.createFromPath(hostPath);
    if (image.isEmpty()) throw new Error(`无法读取本地图片：${hostPath}`);
    return { buffer: image.toPNG(), contentType: 'image/png' };
  }

  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('窗口已关闭');
  const script = `(async () => {
    try {
      const response = await fetch(${JSON.stringify(String(url))}, { credentials: 'include' });
      if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Chunked so a large image cannot blow the argument limit of fromCharCode.
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return { ok: true, base64: btoa(binary), contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  })()`;

  const result = await mainWindow.webContents.executeJavaScript(script, true);
  if (!result || result.ok !== true) {
    throw new Error(result?.error ? `${result.error}（${shortUrl(url)}）` : '页面未能返回图片数据');
  }
  return { buffer: Buffer.from(result.base64, 'base64'), contentType: result.contentType || '' };
}

/** Shorten a URL for an error message, keeping the part that identifies it. */
function shortUrl(url) {
  const text = String(url ?? '');
  return text.length <= 60 ? text : `${text.slice(0, 57)}…`;
}

/** Tell the user an image action failed, instead of only writing to the log. */
async function reportImageFailure(action, url, error) {
  logShell(`${action} failed: ${error.message}`);
  await dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'warning',
    title: '图片操作失败',
    message: `${action}失败`,
    detail: `${error.message}\n\n图片地址：${shortUrl(url)}`,
    buttons: ['确定'],
    noLink: true,
  });
}

/** Copy an image to the clipboard as image data. */
async function copyImageToClipboard(url) {
  try {
    const { buffer, contentType } = await readImageBytes(url);
    const mime = bareMimeType(contentType);

    // Prefer the bytes exactly as served, so a JPEG stays a JPEG. Anything the
    // clipboard does not accept as an image (SVG, or a server that sent no type)
    // is normalized through the decoder into PNG.
    let bytes = buffer;
    let type = mime !== null && CLIPBOARD_IMAGE_TYPES.has(mime) ? mime : null;
    if (type === null) {
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error(`无法解码图片（类型 ${mime ?? 'unknown'}）`);
      bytes = image.toPNG();
      type = 'image/png';
    }

    await clipboard.write([new ClipboardItem({ [type]: new Blob([bytes], { type }) })]);
    const image = nativeImage.createFromBuffer(bytes);
    const size = image.isEmpty() ? null : image.getSize();
    logShell(`copyImage ok: ${String(bytes.length)} bytes, ${type}${size ? `, ${String(size.width)}x${String(size.height)}` : ''}`);
    return bytes.length;
  } catch (error) {
    await reportImageFailure('复制图片', url, error);
    return 0;
  }
}

/**
 * The save dialog's arguments for one image.
 *
 * Kept separate from the dialog itself so the part that was wrong before — a
 * suggested name with no extension, and no defined starting folder — can be
 * asserted without opening a modal that automation cannot dismiss.
 *
 * @param url - the image URL.
 * @param contentType - the response content type, when known.
 * @returns the options for `dialog.showSaveDialog`.
 */
function saveImageOptions(url, contentType) {
  return {
    title: '图片另存为',
    defaultPath: path.join(app.getPath('downloads'), imageFileName(url, contentType)),
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
}

/**
 * Save an image to disk.
 *
 * The suggested name carries a real extension (taken from the response when the
 * URL has none) and the dialog starts in the downloads folder, so the result is
 * a file the system can actually open.
 */
async function saveImageToDisk(url) {
  try {
    const { buffer, contentType } = await readImageBytes(url);
    const target = await dialog.showSaveDialog(mainWindow ?? undefined, saveImageOptions(url, contentType));
    if (target.canceled || !target.filePath) return;
    fs.writeFileSync(target.filePath, buffer);
    logShell(`saveImage ok: ${String(buffer.length)} bytes -> ${target.filePath}`);
  } catch (error) {
    await reportImageFailure('图片另存为', url, error);
  }
}

function createWindow() {
  const bounds = settings.window ?? {};
  mainWindow = new BrowserWindow({
    width: bounds.width ?? 1360,
    height: bounds.height ?? 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1117',
    title: 'DeepSeek Harness',
    icon: windowIcon(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (bounds.maximized) mainWindow.maximize();

  const remember = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const rect = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    updateSettings({ window: { ...rect, maximized } });
  };
  mainWindow.on('resized', remember);
  mainWindow.on('moved', remember);
  mainWindow.on('maximize', remember);
  mainWindow.on('unmaximize', remember);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (settings.window?.maximized) mainWindow.maximize();
  });

  mainWindow.webContents.on('did-finish-load', () => pushStatus());

  // Electron has no default context menu, so without this the right button does
  // nothing at all — including "copy" on a text selection.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { items } = buildContextMenu({
      ...params,
      devTools: DEVTOOLS_ENABLED,
      imageDurable: isDurableImageUrl(params.srcURL),
      imageShareable: isShareableImageUrl(params.srcURL),
      imageFileBacked: isFileBackedImageUrl(params.srcURL),
    });
    if (items.length === 0) return;
    const hasSelection = typeof params.selectionText === 'string' && params.selectionText.trim().length > 0;
    logShell(
      `context menu: ${String(items.length)} item(s), selection=${String(hasSelection)}, editable=${String(params.isEditable)}, image=${String(params.mediaType === 'image')}`,
    );
    Menu.buildFromTemplate(items.map(toMenuTemplateItem)).popup({ window: mainWindow });
  });

  // The served GUI sets its own document title; while a shared-profile warning
  // is active the title bar keeps carrying it.
  mainWindow.on('page-title-updated', (event) => {
    if (!state.concurrency?.conflict) return;
    event.preventDefault();
    mainWindow.setTitle(windowTitle());
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // aborted navigation
    logShell(`did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
    if (state.phase === 'ready') {
      setPhase('failed', '无法加载 Web 界面', `${errorDescription} (${errorCode})\n${validatedURL}`);
      showShellPage('error.html');
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logShell(`renderer gone: ${details.reason}`);
    setPhase('failed', '界面进程异常退出', `reason=${details.reason} exitCode=${String(details.exitCode)}`);
    showShellPage('error.html');
  });

  // Only the local shell pages may open new windows (they do not); everything
  // else goes to the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url) && !isLocalServiceUrl(url)) {
      shell.openExternal(url).catch((error) => logShell(`openExternal failed: ${error.message}`));
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^https?:/u.test(url)) return; // file:// shell pages
    if (isLocalServiceUrl(url) || url.startsWith('file://')) return;
    event.preventDefault();
    shell.openExternal(url).catch((error) => logShell(`openExternal failed: ${error.message}`));
  });

  mainWindow.on('close', (event) => {
    remember();
    if (!state.quitRequested && settings.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  return mainWindow;
}

function isLocalServiceUrl(url) {
  try {
    const target = new URL(url);
    if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') return false;
    return state.port === null || target.port === String(state.port);
  } catch {
    return false;
  }
}

// ── menus / tray ────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: '应用',
      submenu: [
        { label: '打开日志文件夹', click: () => void shell.openPath(LOG_DIR) },
        { label: '重启本地服务', accelerator: 'CmdOrCtrl+Shift+R', click: () => startService() },
        { label: '停止本地服务', click: () => { stopService(); setPhase('idle', '服务已停止'); showShellPage('loading.html'); } },
        { type: 'separator' },
        { label: '端口设置…', click: configurePort },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => { state.quitRequested = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新界面' },
        { role: 'forceReload', label: '强制刷新' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '复制诊断日志', click: () => void writeClipboardText(serviceTail.text + shellTail.text) },
        { label: '打开日志文件夹', click: () => void shell.openPath(LOG_DIR) },
        { type: 'separator' },
        // Every 「在本地打开」 / 「打开交付文件」 attempt is written to the shell log,
        // but never announced: see `app/open-diagnostics.js` for why the shell does
        // not try to verify or second-guess those launches.
        { label: '关于 DeepSeek Harness Desktop', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayIcon() {
  const image = windowIcon();
  if (!image) return undefined;
  return image.resize({ width: 16, height: 16 });
}

function buildTray() {
  const image = trayIcon();
  if (!image) return;
  try {
    tray = new Tray(image);
  } catch (error) {
    logShell(`tray unavailable: ${error.message}`);
    return;
  }
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '重启本地服务', click: () => startService() },
    { label: '打开日志文件夹', click: () => void shell.openPath(LOG_DIR) },
    { type: 'separator' },
    { label: '退出', click: () => { state.quitRequested = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus());
  });
}

async function configurePort() {
  const result = await dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'question',
    title: '本地服务端口',
    message: '选择本地服务的监听端口',
    detail: '“自动”让操作系统挑选空闲端口（推荐，永不与其它程序冲突）。固定的端口在重启服务后生效。',
    buttons: ['自动（推荐）', '固定为 3080', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (result.response === 2) return;
  updateSettings({ port: result.response === 1 ? 3080 : 0 });
  startService();
}

async function showAbout() {
  const snapshot = statusSnapshot();
  const about = buildAbout({
    snapshot,
    profileName: PROFILE_NAME,
    homeShared: isDefaultHome(),
    portable: isPortable(),
  });
  // Buttons come from the same module as the text, so the dialog cannot name a
  // directory without also offering a way to open it.
  const result = await dialog.showMessageBox(mainWindow ?? undefined, {
    type: about.type,
    title: '关于 DeepSeek Harness Desktop',
    message: about.message,
    detail: about.detail,
    buttons: ABOUT_BUTTONS.map((button) => button.label),
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  await runAboutAction(ABOUT_BUTTONS[result.response]?.action ?? null, snapshot);
}

/**
 * Carry out the About dialog's chosen action.
 * @param action - one of the actions declared in `ABOUT_BUTTONS`, or `null`.
 * @param snapshot - the status snapshot the dialog was built from.
 */
async function runAboutAction(action, snapshot) {
  switch (action) {
    case 'open-dsh-home': {
      const home = settings.dshHome;
      const target = fs.existsSync(profileDir()) ? profileDir() : fs.existsSync(home) ? home : DATA_ROOT.root;
      await openPathOrLog(target, 'about: dsh data');
      return;
    }
    case 'open-shell-state': {
      // Never hand openPath a directory that does not exist yet: it fails, and
      // the button would look broken. Create the shell's own state dir first.
      const target = app.getPath('userData');
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (error) {
        logShell(`about: could not create ${target} — ${error.message}`);
      }
      await openPathOrLog(target, 'about: shell state');
      return;
    }
    case 'copy-paths':
      await writeClipboardText(aboutClipboardText({ snapshot, profileName: PROFILE_NAME }));
      return;
    default:
      return;
  }
}

/**
 * Open a path in the system file manager, reporting failure in the shell log.
 *
 * `shell.openPath` resolves to an error *string* rather than rejecting, so an
 * ignored return value makes a broken button indistinguishable from a working
 * one — the silent-no-op failure the context menu was reported for.
 *
 * @param target - the directory to reveal.
 * @param label - what to call it in the log.
 */
async function openPathOrLog(target, label) {
  if (!target) {
    logShell(`${label}: nothing to open`);
    return;
  }
  const problem = await shell.openPath(target);
  if (problem) logShell(`${label}: openPath(${target}) failed — ${problem}`);
}

// ── logging "open on the desktop" ───────────────────────────────────────────
// The dsh host performs these launches itself; this shell only observes the HTTP
// call and writes it to the log. It deliberately does not try to verify or repair
// the result — a single look at the desktop cannot tell "the host opened nothing"
// apart from "the user already closed it", and acting on that guess opened a
// second window and raised false alarms. See `app/open-diagnostics.js`.

// ── IPC (local shell pages only) ────────────────────────────────────────────
function fromShellPage(event) {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith('file://');
}

ipcMain.handle('dsh:status', (event) => (fromShellPage(event) ? statusSnapshot() : null));ipcMain.handle('dsh:action', async (event, action) => {
  if (!fromShellPage(event)) return { ok: false, error: 'forbidden' };
  switch (action) {
    case 'restart':
      startService();
      return { ok: true };
    case 'quit':
      state.quitRequested = true;
      app.quit();
      return { ok: true };
    case 'open-logs':
      await shell.openPath(LOG_DIR);
      return { ok: true };
    case 'configure-port':
      await configurePort();
      return { ok: true };
    case 'copy-logs':
      await writeClipboardText(serviceTail.text + shellTail.text);
      return { ok: true };
    case 'about':
      await showAbout();
      return { ok: true };
    case 'check-hosts': {
      const result = await refreshConcurrency({ force: true });
      return { ok: true, concurrency: result ?? null };
    }
    default:
      return { ok: false, error: `unknown action ${String(action)}` };
  }
});

// ── dragging an image out of the window ─────────────────────────────────────
// Chromium will not export a dragged image to Explorer by itself: the renderer
// asks here and the main process starts a real file drag. Only URLs that resolve
// to a file on disk can be dragged, so `blob:` images keep their default
// behaviour rather than starting a drag that would silently do nothing.
ipcMain.on('dsh:drag-image', (event, payload) => {
  const url = payload?.url;
  const sender = event.senderFrame?.url ?? '';
  if (!/^(file|https?):/u.test(sender)) return;
  const hostPath = hostPathForImageUrl(url);
  if (hostPath === null || !fs.existsSync(hostPath)) {
    logShell(`drag-image skipped: no file behind ${shortUrl(url)}`);
    return;
  }
  // Logged before the drag starts: a native OLE drag cannot be driven by a test,
  // so the verifiable part is that the URL was accepted and resolved to a real
  // file. `startDrag` itself is the operating system's business.
  logShell(`drag-image resolved: ${hostPath}`);
  try {
    const icon = nativeImage.createFromPath(hostPath);
    event.sender.startDrag({
      file: hostPath,
      icon: icon.isEmpty() ? windowIcon() : icon.resize({ width: 128 }),
    });
  } catch (error) {
    logShell(`drag-image failed: ${error.message}`);
  }
});

/**
 * Describe what is on the clipboard right now.
 *
 * Read back through the same asynchronous API the write used, so a caller can
 * assert what actually landed instead of what was intended. Used by the test hook
 * and by the acceptance test to tell "the copy worked" apart from "an earlier copy
 * is still sitting there".
 *
 * @returns `{ types, bytes, size, clipboardHasImage }`.
 */
async function clipboardState() {
  // The Windows clipboard is not synchronously readable right after a write, so
  // the state is polled briefly instead of sampled once.
  let items = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    items = await clipboard.read();
    if (items.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const types = items.flatMap((item) => item.types ?? []);
  const png = items.find((item) => (item.types ?? []).includes('image/png'));
  let bytes = 0;
  let size = null;
  if (png) {
    const blob = await png.getType('image/png');
    const buffer = Buffer.from(await blob.arrayBuffer());
    bytes = buffer.length;
    const image = nativeImage.createFromBuffer(buffer);
    if (!image.isEmpty()) size = image.getSize();
  }
  return { types, bytes, size, clipboardHasImage: types.some((type) => type.startsWith('image/')) };
}

// Test-only IPC, registered only when the flag is set, so the image pipeline can
// be verified end-to-end: a native context menu cannot be clicked by a test.
if (process.env.DSH_DESKTOP_TEST_HOOK === '1') {
  ipcMain.handle('dsh:test-image', async (_event, { command, payload }) => {
    if (command === 'clearClipboard') {
      clipboard.clear();
      // What matters is that no image is left behind; Windows may still report
      // other formats, so the assertion is about the image rather than the count.
      const state = await clipboardState();
      return { ok: true, emptyAfterClear: state.types.length === 0, hasImageAfterClear: state.clipboardHasImage };
    }
    if (command === 'clipboardState') {
      return { ok: true, ...(await clipboardState()) };
    }
    if (command === 'copyImage') {
      const copiedBytes = await copyImageToClipboard(payload.url);
      // Read the clipboard back through the same async API the write used, so the
      // assertion covers what actually landed rather than what was intended.
      // `copiedBytes` and `bytes` (the clipboard's own size) are kept apart on
      // purpose: spreading the state over `bytes` silently overwrote it before.
      return { ok: copiedBytes > 0, copiedBytes, ...(await clipboardState()) };
    }
    if (command === 'readBytes') {
      const { buffer, contentType } = await readImageBytes(payload.url);
      return { ok: true, bytes: buffer.length, contentType, head: buffer.subarray(0, 8).toString('hex') };
    }
    if (command === 'saveTarget') {
      // The dialog cannot be dismissed by a test, so its arguments are asserted
      // instead — that is where the extension-less "file" name came from.
      const { contentType } = await readImageBytes(payload.url);
      const options = saveImageOptions(payload.url, contentType);
      return {
        ok: true,
        contentType,
        defaultPath: options.defaultPath,
        suggestedName: path.basename(options.defaultPath),
        directory: path.dirname(options.defaultPath),
        extensions: options.filters?.[0]?.extensions ?? [],
      };
    }
    if (command === 'decodeProbe') {
      // Reports which decoding routes accept these bytes, so a decode failure can
      // be attributed to the image or to the code path.
      const { buffer, contentType } = await readImageBytes(payload.url);
      const routes = {};
      const record = (label, image) => {
        routes[label] = image.isEmpty() ? 'empty' : `${String(image.getSize().width)}x${String(image.getSize().height)}`;
      };
      try {
        record('createFromBuffer', nativeImage.createFromBuffer(buffer));
      } catch (error) {
        routes.createFromBuffer = `threw ${error.message}`;
      }
      return { ok: true, bytes: buffer.length, contentType, routes };
    }
    return { ok: false, error: `unknown test command ${String(command)}` };
  });
}

// ── app lifecycle ───────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.setAppUserModelId('com.deepseek.harness.desktop');

  app.whenReady().then(async () => {
    openLogs();
    loadSettings();
    logShell(`dsh-desktop starting; electron=${process.versions.electron} node=${process.versions.node}`);
    logShell(`runtime=${RUNTIME_ROOT}`);
    logShell(
      DATA_ROOT.root === null
        ? 'data layout: default (shell=%APPDATA%, dsh home=%USERPROFILE%\\.dsh)'
        : `data layout: ${DATA_ROOT.source} (shell=${app.getPath('userData')}, dsh home=${settings.dshHome}` +
            `${EXPLICIT_USER_DATA ? '; shell dir pinned by --user-data-dir' : ''})`,
    );

    // Ask about an existing home before the service starts, so the answer can
    // still decide whether this run begins with imported data.
    if (DATA_ROOT.root !== null) await importExistingHome();

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const url = webContents.getURL();
      const allowed = isLocalServiceUrl(url) && ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications'].includes(permission);
      callback(Boolean(allowed));
    });

    // Make the Web GUI's two "open on the desktop" actions observable. Both are
    // carried out by the dsh host, so without this the shell has no way to tell a
    // successful launch from a request that never arrived — the two look
    // identical on screen. No URL filter is used on purpose: match patterns do not
    // take the ephemeral port reliably, and a filter that silently matched nothing
    // would hide the very requests this exists to reveal.
    //
    // Record every attempt in the shell log. Nothing is verified and nothing is
    // announced: the launches are fixed in the bundled runtime, and a probe here
    // could only add a second window or a false alarm. See
    // `app/open-diagnostics.js`.
    const openWatch = createOpenWatch({ log: (message) => logShell(message) });
    try {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        openWatch.onBeforeRequest(details);
        callback({});
      });
      session.defaultSession.webRequest.onCompleted((details) => openWatch.onCompleted(details));
      session.defaultSession.webRequest.onErrorOccurred((details) => openWatch.onErrorOccurred(details));
    } catch (error) {
      logShell(`could not watch the open routes: ${error.message}`);
    }

    createWindow();
    buildMenu();
    buildTray();
    showShellPage('loading.html');
    startService();

    // Periodic re-check: another `dsh web` may start (or stop) at any time.
    concurrencyInterval = setInterval(() => {
      if (state.phase === 'ready') void refreshConcurrency();
    }, CONCURRENCY_INTERVAL_MS);
    if (typeof concurrencyInterval.unref === 'function') concurrencyInterval.unref();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });

  app.on('window-all-closed', () => {
    state.quitRequested = true;
    app.quit();
  });

  app.on('before-quit', () => {
    state.quitRequested = true;
    stopService();
  });

  app.on('will-quit', () => {
    if (concurrencyInterval) clearInterval(concurrencyInterval);
    if (concurrencySettleTimer) clearTimeout(concurrencySettleTimer);
    stopService();
    tray?.destroy();
    logStream?.end();
  });
}
