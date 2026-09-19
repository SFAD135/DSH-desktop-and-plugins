#!/usr/bin/env node
/**
 * Live GUI probe over the Chrome DevTools Protocol.
 *
 * Start the app with remote debugging first:
 *   "dist\DeepSeek Harness\electron-core.exe" "<...>\resources\app" --remote-debugging-port=9222
 * then:
 *   node scripts/verify-gui.mjs [--port 9222] [--screenshot docs/screenshot.png] [--expect "文本"]
 *
 * `--mode harness` (default) checks the served Harness GUI; `--mode shell`
 * checks one of the shell's own local pages (loading.html / error.html) and
 * reports its shared-profile warning banner and data-location facts.
 * It reports the loaded page's title, URL, DOM size and visible text, checks
 * that the expected surface actually rendered, and optionally captures a PNG.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const PORT = Number(arg('port', '9222'));
const SHOT = arg('screenshot', null);
const EXPECT = arg('expect', null);
const EXPR = arg('eval', null);
const MODE = arg('mode', 'harness');
const EXPECT_WARN = flag('expect-warn');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((target) => target.type === 'page' && /^https?:/u.test(target.url)) ?? targets.find((target) => target.type === 'page');
if (!page) {
  process.stderr.write(`[gui] no page target on port ${PORT}; targets: ${JSON.stringify(targets.map((t) => t.type))}\n`);
  process.exit(1);
}
process.stdout.write(`[gui] target: ${page.url}\n`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
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

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const probe = `(() => {
  const text = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim();
  const panel = document.getElementById('warn');
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    nodes: document.querySelectorAll('*').length,
    boot: typeof window.__DSH_BOOT__,
    bridge: typeof window.dshShell,
    inputs: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    markers: {
      sessions: document.querySelectorAll('[class*="session" i]').length,
      sidebar: document.querySelectorAll('[class*="sidebar" i]').length,
      chat: document.querySelectorAll('[class*="chat" i], [class*="conversation" i]').length,
      fallbackError: /Something went wrong|无法加载|Application error/i.test(text),
    },
    shell: {
      statusText: document.getElementById('status-text')?.innerText ?? null,
      warnVisible: Boolean(panel) && !panel.classList.contains('hidden'),
      warnTitle: document.getElementById('warn-title')?.innerText ?? null,
      warnItems: [...document.querySelectorAll('#warn-list li')].map((li) => li.innerText),
      facts: [...document.querySelectorAll('.facts b, .facts span')].map((node) => node.innerText),
      actions: [...document.querySelectorAll('.actions button')].map((node) => node.innerText),
    },
    textHead: text.slice(0, 1200),
  };
})()`;

const evaluated = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true });
const value = evaluated.result?.value ?? {};process.stdout.write(`[gui] title       : ${value.title}\n`);
process.stdout.write(`[gui] url         : ${value.url}\n`);
process.stdout.write(`[gui] readyState  : ${value.readyState}\n`);
process.stdout.write(`[gui] DOM nodes   : ${value.nodes}\n`);
process.stdout.write(`[gui] __DSH_BOOT__: ${value.boot}\n`);
process.stdout.write(`[gui] editor seats: ${value.inputs}\n`);
process.stdout.write(`[gui] markers     : ${JSON.stringify(value.markers)}\n`);
if (MODE === 'shell') {
  process.stdout.write(`[gui] bridge      : ${value.bridge}\n`);
  process.stdout.write(`[gui] status      : ${value.shell?.statusText}\n`);
  process.stdout.write(`[gui] warn banner : visible=${value.shell?.warnVisible} title=${value.shell?.warnTitle}\n`);
  for (const item of value.shell?.warnItems ?? []) process.stdout.write(`[gui]   · ${item}\n`);
  process.stdout.write(`[gui] facts       : ${JSON.stringify(value.shell?.facts)}\n`);
  process.stdout.write(`[gui] actions     : ${JSON.stringify(value.shell?.actions)}\n`);
}
process.stdout.write(`[gui] visible text:\n${String(value.textHead ?? '').slice(0, 900)}\n`);

const checks = [];
if (MODE === 'shell') {
  checks.push(['page is a local shell page (file://)', /^file:\/\//u.test(value.url ?? '')]);
  checks.push(['shell IPC bridge exposed to the local page', value.bridge === 'object']);
  checks.push(['DOM rendered', (value.nodes ?? 0) > 20]);
  if (EXPECT_WARN) {
    checks.push(['shared-profile warning banner is visible', value.shell?.warnVisible === true]);
    checks.push(['warning banner carries evidence lines', (value.shell?.warnItems ?? []).length > 0]);
  }
  if (EXPECT) checks.push([`visible text contains ${JSON.stringify(EXPECT)}`, String(value.textHead ?? '').includes(EXPECT)]);
} else {
  checks.push(['page is the served Harness GUI (http on loopback)', /^http:\/\/127\.0\.0\.1:\d+/u.test(value.url ?? '')]);
  checks.push(['boot payload injected', value.boot !== 'undefined']);
  checks.push(['DOM rendered', (value.nodes ?? 0) > 50]);
  if (EXPECT) checks.push([`visible text contains ${JSON.stringify(EXPECT)}`, String(value.textHead ?? '').includes(EXPECT)]);
}

if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.resolve(ROOT, SHOT);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  process.stdout.write(`[gui] screenshot  : ${file}\n`);
}

if (EXPR) {
  const custom = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  process.stdout.write(`[gui] eval        : ${JSON.stringify(custom.result?.value ?? custom.result?.description ?? custom, null, 2)}\n`);
}

socket.close();
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) process.stdout.write(`${ok ? '  PASS' : '  FAIL'}  ${name}\n`);
process.stdout.write(`\n[gui] ${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
