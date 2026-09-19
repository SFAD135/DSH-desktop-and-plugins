#!/usr/bin/env node
/**
 * Acceptance test for the image actions.
 *
 * This is the test that was missing when the image menu shipped broken. The unit
 * tests only asserted how the menu was *composed*; they passed while every entry
 * was dead, because a cookie-less `fetch` of `/api/file?…` is answered with 401
 * and `blob:` URLs cannot be fetched from the main process at all.
 *
 * So this drives the real pipeline in a real window:
 *
 *   1. an image served by the local dsh service (`/api/file?path=…`, the shape
 *      the GUI uses for local files) is placed in the page;
 *   2. an image that only exists as a `blob:` in the page is placed next to it;
 *   3. the shell's own byte reader is invoked for both and must return real PNG
 *      bytes — that is the cookie and the renderer-scope requirement;
 *   4. copying to the clipboard must leave an actual image on the clipboard.
 *
 * The native context menu cannot be clicked from a test, so the shell exposes the
 * same code path over an IPC channel that is registered **only** when
 * `DSH_DESKTOP_TEST_HOOK=1`. Production never sets it.
 *
 *   node scripts/accept-image-actions.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'dist', 'DeepSeek Harness');
const EXE = path.join(DIST, 'DeepSeek Harness.exe');
const UITEST = path.join(ROOT, 'build', 'uitest', 'image-actions');
const DATA_ROOT = path.join(UITEST, 'data');
const USER_DATA = path.join(UITEST, 'shell');
const DSH_HOME = path.join(DATA_ROOT, 'dsh-home');
const LOG_DIR = path.join(USER_DATA, 'logs');
const CDP_PORT = 9335;
/** Where the shell will offer to save images; asserted against its own answer. */
const downloads = path.join(process.env.USERPROFILE ?? '', 'Downloads');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, Boolean(ok)]);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};
const log = (message) => process.stdout.write(`[img] ${message}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json`, { signal: AbortSignal.timeout(900) });
    return await response.json();
  } catch {
    return [];
  }
}

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

/** Kill this run's Electron tree, found by the debugging port it was given. */
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

/** A tiny valid PNG, so the served image is genuinely decodable. */
function pngBytes() {
  // 1x1 opaque red PNG.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
}

/**
 * A real PNG from the user's own attachment store, when one is available.
 *
 * Used so the test copies an image of the kind and size a person actually copies
 * (hundreds of KB, thousands of pixels) rather than a synthetic pixel.
 */
function pickRealSample() {
  const objects = path.join(process.env.USERPROFILE ?? '', '.dsh', 'attachments', 'v1', 'objects');
  if (!existsSync(objects)) return null;
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        try {
          const head = readFileSync(full).subarray(0, 8);
          if (head.toString('hex').startsWith('89504e47')) candidates.push(full);
        } catch {
          /* unreadable: skip */
        }
      }
    }
  };
  try {
    walk(objects, 0);
  } catch {
    return null;
  }
  return candidates.length > 0 ? readFileSync(candidates[0]) : null;
}

let app = null;

try {
  if (!existsSync(EXE)) {
    log(`missing ${EXE}; run "npm run build" first`);
    process.exit(2);
  }

  rmSync(UITEST, { recursive: true, force: true });
  mkdirSync(DSH_HOME, { recursive: true });
  mkdirSync(USER_DATA, { recursive: true });

  log('preparing the test data root…');
  const prepared = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-shared-home.mjs'), DSH_HOME], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  check('test home prepared', prepared.status === 0 && existsSync(path.join(DSH_HOME, 'profiles', 'web', 'cordis.yml')));
  writeFileSync(
    path.join(DSH_HOME, 'imported-from.json'),
    `${JSON.stringify({ importedFrom: null, declinedAt: 'test' }, null, 2)}\n`,
  );

  // The image the service will serve: a real PNG inside the test data root. A
  // realistic one is used on purpose — a 1x1 synthetic PNG is not what a user
  // ever copies, and it turns out not to exercise the decoder the same way.
  const sample = path.join(UITEST, '样本 图片.png');
  const realSample = pickRealSample();
  writeFileSync(sample, realSample ?? pngBytes());
  const sampleBytes = readFileSync(sample).length;
  check('sample image written', existsSync(sample) && sampleBytes > 100, `${String(sampleBytes)} bytes${realSample ? ' (real attachment)' : ' (synthetic fallback)'}`);

  log('starting the desktop shell…');
  const fd = openSync(path.join(UITEST, 'app.log'), 'a');
  app = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${String(CDP_PORT)}`], {
    cwd: DIST,
    env: { ...process.env, DSH_DESKTOP_DATA: DATA_ROOT, DSH_DESKTOP_PORT: '0', DSH_DESKTOP_TEST_HOOK: '1' },
    stdio: ['ignore', fd, fd],
    windowsHide: false,
  });
  closeSync(fd);

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

  // Let the GUI settle so the page's own scripts are not fighting the test.
  let settled = false;
  const settleDeadline = Date.now() + 60_000;
  while (Date.now() < settleDeadline && !settled) {
    const state = (await send('Runtime.evaluate', {
      expression: '({ n: document.querySelectorAll("*").length, t: document.body ? document.body.innerText : "" })',
      returnByValue: true,
    })).result.value;
    settled = state.n > 40 && !/Loading plugins|正在加载|Loading…/i.test(state.t);
    if (!settled) await delay(500);
  }
  check('the GUI finished booting', settled);

  // The test hook must be reachable on the served page.
  const hook = (await send('Runtime.evaluate', { expression: 'typeof window.dshTest?.imageCommand', returnByValue: true })).result.value;
  check('the test hook is available', hook === 'function', String(hook));

  // ── the shape the GUI actually uses for local files ───────────────────────
  const servedUrl = `${new URL(target.url).origin}/api/file?path=${encodeURIComponent(sample)}`;
  log(`served image: ${servedUrl}`);

  const placed = (await send('Runtime.evaluate', {
    expression: `(async () => {
      const img = document.createElement('img');
      img.id = 'dsh-img-served';
      img.style.cssText = 'position:fixed;left:8px;top:8px;width:48px;height:48px;z-index:2147483647';
      img.src = ${JSON.stringify(servedUrl)};
      document.body.appendChild(img);
      try { await img.decode(); } catch {}
      return { complete: img.complete, natural: img.naturalWidth, src: img.currentSrc || img.src };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('the served image rendered in the page', placed?.complete === true && placed?.natural > 0, JSON.stringify(placed));
  // If the page itself could not load it, the byte pipeline cannot be blamed.
  check('the page loaded the served image through the service', placed?.natural > 0, `naturalWidth=${String(placed?.natural)}`);

  // ── read bytes: this is the 401 regression, and it must now succeed ───────
  const servedRead = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('readBytes', { url: ${JSON.stringify(servedUrl)} })`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('reading a service image returns bytes', servedRead?.ok === true && servedRead?.bytes > 40, JSON.stringify(servedRead));
  check('the bytes are the PNG that was served', String(servedRead?.head ?? '').startsWith('89504e47'), String(servedRead?.head ?? ''));
  check('the response content type is reported', /image\/png/u.test(String(servedRead?.contentType ?? '')), String(servedRead?.contentType ?? ''));

  // Which decoding routes accept these bytes — so a later failure can be blamed
  // on the image or on the code rather than guessed at.
  const probe = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('decodeProbe', { url: ${JSON.stringify(servedUrl)} })`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  log(`decode routes: ${JSON.stringify(probe?.routes ?? null)}`);
  check('nativeImage accepts the served bytes', /^\d+x\d+$/u.test(String(probe?.routes?.createFromBuffer ?? '')), JSON.stringify(probe?.routes ?? null));

  // ── a blob: image, which the main process cannot fetch at all ─────────────
  // Drawn on a canvas at a size nothing else in this test uses, so a later
  // assertion can prove *this* image landed rather than a leftover.
  const blobUrl = (await send('Runtime.evaluate', {
    expression: `(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2f6f4f';
      ctx.fillRect(0, 0, 64, 48);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(8, 8, 24, 16);
      const url = await new Promise((resolve) => canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/png'));
      const img = document.createElement('img');
      img.id = 'dsh-img-blob';
      img.style.cssText = 'position:fixed;left:64px;top:8px;width:48px;height:48px;z-index:2147483647';
      img.src = url;
      document.body.appendChild(img);
      try { await img.decode(); } catch {}
      return url;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('a page-local blob image was created', typeof blobUrl === 'string' && blobUrl.startsWith('blob:'), String(blobUrl));

  const blobRead = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('readBytes', { url: ${JSON.stringify(blobUrl)} })`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('reading a blob image returns bytes', blobRead?.ok === true && blobRead?.bytes > 40, JSON.stringify(blobRead));
  check('the blob bytes are a PNG', String(blobRead?.head ?? '').startsWith('89504e47'), String(blobRead?.head ?? ''));

  // ── copy to the clipboard must leave real image data ─────────────────────
  // The clipboard is cleared first and the landed image is compared by its
  // dimensions: byte-for-byte identity is NOT guaranteed (the platform re-encodes
  // PNG on the way in), and without clearing, an assertion passes merely because
  // an earlier step left an image behind. Both were real false positives here.
  const cleared = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('clearClipboard', {})`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('the clipboard can be emptied of images before the copy', cleared?.emptyAfterClear !== false && cleared?.hasImageAfterClear === false, JSON.stringify(cleared));

  const servedSize = String(probe?.routes?.createFromBuffer ?? '');
  const copied = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('copyImage', { url: ${JSON.stringify(servedUrl)} })`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('copying a service image reports success', copied?.ok === true && copied?.copiedBytes > 40, JSON.stringify(copied));
  check('the clipboard holds an image afterwards', copied?.clipboardHasImage === true, JSON.stringify(copied));
  check('the clipboard image has real dimensions', (copied?.size?.width ?? 0) > 0 && (copied?.size?.height ?? 0) > 0, JSON.stringify(copied?.size ?? null));
  check('the clipboard image is the image that was copied', `${String(copied?.size?.width)}x${String(copied?.size?.height)}` === servedSize, `clipboard=${String(copied?.size?.width)}x${String(copied?.size?.height)} decoded=${servedSize}`);

  // A blob: image is the case the main process cannot fetch at all, and it is
  // copied from a cleared clipboard so it cannot inherit the previous image.
  await send('Runtime.evaluate', { expression: `window.dshTest.imageCommand('clearClipboard', {})`, returnByValue: true, awaitPromise: true });
  const copiedBlob = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('copyImage', { url: ${JSON.stringify(blobUrl)} })`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('copying a blob image reports success', copiedBlob?.ok === true && copiedBlob?.copiedBytes > 40, JSON.stringify(copiedBlob));
  check('the blob image reached the clipboard', copiedBlob?.clipboardHasImage === true, JSON.stringify(copiedBlob));
  check('the clipboard now holds the 64x48 blob, not the previous image', copiedBlob?.size?.width === 64 && copiedBlob?.size?.height === 48, JSON.stringify(copiedBlob?.size ?? null));

  // ── the save dialog's arguments ───────────────────────────────────────────
  // The dialog itself is modal and cannot be dismissed by a test, but the two
  // things that were wrong before are in its arguments: the suggested name had no
  // extension (the service URL's basename is the literal string "file") and there
  // was no starting folder.
  const saveTarget = (await send('Runtime.evaluate', {
    expression: `window.dshTest.imageCommand('saveTarget', { url: ${JSON.stringify(servedUrl)} })`,
    returnByValue: true,
    awaitPromise: true,
  })).result.value;
  check('the save dialog suggests the real file name', saveTarget?.suggestedName === path.basename(sample), `${String(saveTarget?.suggestedName)} vs ${path.basename(sample)}`);
  check('the suggested name keeps an extension', /\.[A-Za-z0-9]{2,5}$/u.test(String(saveTarget?.suggestedName ?? '')), String(saveTarget?.suggestedName ?? ''));
  check('the suggested name is not the bare word "file"', saveTarget?.suggestedName !== 'file');
  check('the save dialog starts in the downloads folder', saveTarget?.directory === downloads, `${String(saveTarget?.directory)} vs ${downloads}`);
  check('the save dialog offers image extensions', Array.isArray(saveTarget?.extensions) && saveTarget.extensions.includes('png'));

  // ── dragging an image out of the window ───────────────────────────────────
  // The OS drag itself cannot be driven by a test, so what is asserted is the
  // verifiable half: the preload intercepts the drag, accepts only URLs that map
  // to a file on disk, and the main process resolves that URL to the real file.
  const dragDispatched = (await send('Runtime.evaluate', {
    expression: `(() => {
      const img = document.getElementById('dsh-img-served');
      if (!img) return 'no image';
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      img.dispatchEvent(event);
      return event.defaultPrevented ? 'handled' : 'not handled';
    })()`,
    returnByValue: true,
  })).result.value;
  check('the shell claims the drag of a file-backed image', dragDispatched === 'handled', String(dragDispatched));

  const blobDrag = (await send('Runtime.evaluate', {
    expression: `(() => {
      const img = document.getElementById('dsh-img-blob');
      if (!img) return 'no image';
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      img.dispatchEvent(event);
      return event.defaultPrevented ? 'handled' : 'not handled';
    })()`,
    returnByValue: true,
  })).result.value;
  check('a blob image is left to the default drag behaviour', blobDrag === 'not handled', String(blobDrag));

  await delay(1200);
  const dragLogs = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('desktop-') && name.endsWith('.log'))
    .sort()
    .map((name) => readFileSync(path.join(LOG_DIR, name), 'utf8'))
    .join('\n');
  check('the drag was resolved to the real file', dragLogs.includes(`drag-image resolved: ${sample}`), (dragLogs.match(/^.*drag-image.*$/gmu) ?? []).slice(-2).join(' | '));
  check('no drag was attempted for the blob image', !/drag-image resolved: blob/iu.test(dragLogs));

  // ── the shell must not have logged a failure for these ───────────────────
  const logs = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('desktop-') && name.endsWith('.log'))
    .sort()
    .map((name) => readFileSync(path.join(LOG_DIR, name), 'utf8'))
    .join('\n');
  check('no image failure was logged', !/copyImage failed|readImageBytes|图片操作失败/u.test(logs), (logs.match(/^.*(?:failed|401).*$/gmu) ?? []).slice(-3).join(' | '));
  check('the successful copies were logged with a byte count', /copyImage ok: \d+ bytes/u.test(logs), (logs.match(/^.*copyImage.*$/gmu) ?? []).slice(-2).join(' | '));

  socket.close();
} finally {
  log('cleaning up…');
  killTestApp();
  if (app && app.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  if (!removeWithRetries(UITEST)) log(`note: could not remove ${UITEST}`);
}

const failed = checks.filter(([, ok]) => !ok);
process.stdout.write(`\n[img] ${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
