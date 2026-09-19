#!/usr/bin/env node
/**
 * Acceptance test for the right-click menu.
 *
 * Regression under test: Electron provides no context menu of its own, so an
 * early build had a right button that did nothing at all — no way to copy a
 * selected passage. This drives the real window over the DevTools protocol:
 *
 *   1. the served Harness GUI loads;
 *   2. text in it is selectable at all;
 *   3. a real right-click reaches the shell's handler with the selection attached;
 *   4. the resulting menu actually offers copy.
 *
 * The shell runs against a throwaway data root (a copy of the real home, so the
 * user's own data is never touched) and its own Electron profile, which keeps it
 * clear of any installed instance.
 *
 * Launching the Electron window needs a desktop session; under a confined
 * sandbox run this with `danger-full-access`.
 *
 *   node scripts/accept-context-menu.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'dist', 'DeepSeek Harness');
const EXE = path.join(DIST, 'DeepSeek Harness.exe');
const UITEST = path.join(ROOT, 'build', 'uitest', 'context-menu');
const DATA_ROOT = path.join(UITEST, 'data');
// Electron's own profile for this run. It is passed explicitly so the path shows
// up in the command line of every child process: the launcher exits immediately
// after spawning Electron, so the renderer tree has to be found by its profile
// rather than by the pid that was spawned.
const USER_DATA = path.join(UITEST, 'shell');
const LOG_DIR = path.join(USER_DATA, 'logs');
const CDP_PORT = 9334;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, Boolean(ok)]);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};
const log = (message) => process.stdout.write(`[ctx] ${message}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json`, { signal: AbortSignal.timeout(900) });
    return await response.json();
  } catch {
    return [];
  }
}

/**
 * Kill the Electron tree belonging to this run.
 *
 * Matched on the debugging port, not the profile path: only the *main* process
 * carries the switch, and killing it with `/T` is what also reaps the bundled
 * `node.exe` running the dsh service. Matching the profile path alone would miss
 * the main process (its command line holds just the app directory) and leave an
 * orphan holding the profile.
 */
function killTestApp() {
  const marker = `--remote-debugging-port=${String(CDP_PORT)}`;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='electron-core.exe'\"",
    `$mine = $procs | Where-Object { $_.CommandLine -like '*${marker}*' }`,
    '$mine | ForEach-Object { taskkill /pid $_.ProcessId /T /F 2>&1 | Out-Null }',
  ].join('; ');
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
}

/** Remove a directory a just-killed process may still hold open. */
function removeWithRetries(target, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      if (!existsSync(target)) return true;
    } catch {
      /* the killed Electron tree releases its profile a moment later */
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { stdio: 'ignore', windowsHide: true });
  }
  return !existsSync(target);
}

/** The newest shell log, which is where the context-menu handler reports. */
function readShellLog() {
  if (!existsSync(LOG_DIR)) return '';
  const files = readdirSync(LOG_DIR).filter((name) => name.startsWith('desktop-') && name.endsWith('.log')).sort();
  if (files.length === 0) return '';
  return readFileSync(path.join(LOG_DIR, files[files.length - 1]), 'utf8');
}

/** Connect to the served page and return `{ send, close }`. */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not open the DevTools websocket')), { once: true });
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { socket, send };
}

/** Whether the GUI has finished its own boot, or is still swapping placeholders. */
const SETTLE_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : '';
  return {
    nodes: document.querySelectorAll('*').length,
    loading: /Loading plugins|正在加载|Loading…/i.test(text),
  };
})()`;

/**
 * Select the first substantial run of text that the page actually allows to be
 * selected, and report where it is on screen.
 *
 * `user-select: none` matters here: the Harness GUI marks its chrome with it, and
 * a range added over such an element yields an empty selection — which would look
 * like "text cannot be copied" when it is really "that text is not content".
 */
const SELECT_SCRIPT = `(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const element = node.parentElement;
    if (!element || !node.nodeValue || node.nodeValue.trim().length < 8) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.userSelect === 'none' || style.webkitUserSelect === 'none') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    if (text.trim().length === 0) continue;
    return {
      text,
      x: Math.round(rect.left + Math.min(rect.width / 2, 40)),
      y: Math.round(rect.top + rect.height / 2),
      node: element.tagName,
    };
  }
  return null;
})()`;

let app = null;

try {
  if (!existsSync(EXE)) {
    log(`missing ${EXE}; run "npm run build" first`);
    process.exit(2);
  }

  rmSync(UITEST, { recursive: true, force: true });
  mkdirSync(path.join(DATA_ROOT, 'dsh-home'), { recursive: true });
  mkdirSync(USER_DATA, { recursive: true });

  // A ready-to-boot home, so the GUI comes up without initializing a profile.
  log('preparing the test data root…');
  const prepared = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-shared-home.mjs'), path.join(DATA_ROOT, 'dsh-home')], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  check('test home prepared', prepared.status === 0 && existsSync(path.join(DATA_ROOT, 'dsh-home', 'profiles', 'web', 'cordis.yml')));
  // Mark the import as already offered, otherwise first run opens a modal dialog.
  writeFileSync(
    path.join(DATA_ROOT, 'dsh-home', 'imported-from.json'),
    `${JSON.stringify({ importedFrom: null, declinedAt: 'test' }, null, 2)}\n`,
  );

  log('starting the desktop shell…');
  const fd = openSync(path.join(UITEST, 'app.log'), 'a');
  app = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${String(CDP_PORT)}`], {
    cwd: DIST,
    env: { ...process.env, DSH_DESKTOP_DATA: DATA_ROOT, DSH_DESKTOP_PORT: '0' },
    stdio: ['ignore', fd, fd],
    windowsHide: false,
  });
  closeSync(fd);

  // 1 ── wait for the served GUI.
  let target = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !target) {
    const targets = await cdpTargets();
    target = targets.find((entry) => entry.type === 'page' && /^http:\/\/127\.0\.0\.1/u.test(entry.url ?? ''));
    if (!target) await delay(700);
  }
  check('the served Harness GUI loaded', target !== null, target?.url ?? 'no http page target appeared');
  if (!target) throw new Error('cannot continue without the GUI');

  const { socket, send } = await connect(target);

  // 2 ── let the GUI settle first: selecting a placeholder such as "Loading
  // plugins…" would race with its removal, and the selection would vanish
  // before the click.
  let settled = false;
  const settleDeadline = Date.now() + 60_000;
  let lastState = null;
  while (Date.now() < settleDeadline && !settled) {
    lastState = (await send('Runtime.evaluate', { expression: SETTLE_SCRIPT, returnByValue: true })).result.value;
    settled = Boolean(lastState) && lastState.nodes > 40 && !lastState.loading;
    if (!settled) await delay(500);
  }
  check('the GUI finished booting', settled, lastState ? `nodes=${String(lastState.nodes)} loading=${String(lastState.loading)}` : 'no DOM');

  // 3 ── text in the GUI must be selectable (the user's actual goal).
  const selection = (await send('Runtime.evaluate', { expression: SELECT_SCRIPT, returnByValue: true })).result.value;
  check('text in the GUI can be selected', Boolean(selection) && selection.text.trim().length > 0, selection ? `${String(selection.text.length)} chars in <${selection.node}>` : 'no selectable text found');
  if (!selection) throw new Error('cannot continue without a selection');
  log(`selected: ${JSON.stringify(selection.text.slice(0, 60))}`);

  // 4 ── a real right-click over that selection.
  const point = { x: selection.x, y: selection.y };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1 });

  // 5 ── the handler must have run, with the selection attached.
  let line = null;
  for (let attempt = 0; attempt < 30 && !line; attempt += 1) {
    await delay(400);
    line = (readShellLog().match(/^.*context menu: (.*)$/mu) ?? [])[1] ?? null;
  }
  check('the right-click reached the shell', line !== null, line ?? 'no "context menu:" line in the shell log');
  check('the handler saw the selection', /selection=true/u.test(line ?? ''), line ?? '');
  const itemCount = Number((/^(\d+) item/u.exec(line ?? '') ?? [])[1] ?? '0');
  // copy + select-all + reload + address entries is the floor for a selection.
  check('the menu offers several entries', itemCount >= 4, `${String(itemCount)} item(s)`);
  check('the menu is built for a non-editable page', /editable=false/u.test(line ?? ''), line ?? '');

  socket.close();
} finally {
  log('cleaning up…');
  // The launcher has usually exited by now, so its child tree must be found by
  // the profile path rather than by the pid that was spawned.
  killTestApp();
  if (app && app.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  if (!removeWithRetries(UITEST)) log(`note: could not remove ${UITEST}`);
}

const failed = checks.filter(([, ok]) => !ok);
process.stdout.write(`\n[ctx] ${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
