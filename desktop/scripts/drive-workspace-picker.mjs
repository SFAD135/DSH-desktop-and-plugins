#!/usr/bin/env node
/**
 * Drive the Web GUI's workspace flow over the DevTools protocol (acceptance
 * helper): open the workspace menu and either report its entries or click
 * "添加工作区…" so the native folder dialog appears for
 * scripts/select-workspace-dialog.ps1 to fill in.
 *
 * Usage:
 *   node scripts/drive-workspace-picker.mjs --port 9222 [--click]
 *   node scripts/drive-workspace-picker.mjs --select "dsh-desktop"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback;
};
const PORT = Number(arg('port', '9222'));
const CLICK = process.argv.includes('--click');
const SELECT = typeof arg('select', null) === 'string' ? arg('select', null) : null;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((target) => target.type === 'page' && /^https?:/u.test(target.url));
if (!page) {
  process.stderr.write('[picker] no page target\n');
  process.exit(1);
}

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
  socket.addEventListener('error', () => reject(new Error('devtools websocket failed')), { once: true });
});
const send = (method, params = {}) => {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return result.result?.value;
};

const script = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const workspaceButton = [...document.querySelectorAll('button')].find((element) => /工作区|workspace/i.test(element.innerText));
  if (!workspaceButton) return { error: 'no workspace button' };
  workspaceButton.click();
  await wait(900);
  const entries = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button, div')]
    .filter((element) => {
      const text = (element.textContent ?? '').trim();
      return text.length > 0 && text.length < 40 && element.children.length <= 2;
    })
    .map((element) => ({ tag: element.tagName, text: (element.textContent ?? '').trim(), kids: element.children.length }));
  const unique = [...new Map(entries.map((entry) => [entry.text, entry])).values()];
  const target = ${SELECT === null ? 'null' : JSON.stringify(SELECT)};
  const addLabel = '添加工作区';
  let clicked = null;
  if (target === null) {
    if (${CLICK ? 'true' : 'false'}) {
      const add = [...document.querySelectorAll('*')].filter((element) => (element.textContent ?? '').trim().startsWith(addLabel)).pop();
      if (add) { add.click(); clicked = 'add'; }
    }
  } else {
    const item = [...document.querySelectorAll('*')].filter((element) => (element.textContent ?? '').trim() === target).pop();
    if (item) { item.click(); clicked = target; }
  }
  await wait(900);
  return { clicked, entries: unique, bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) };
})()`;

const result = await evaluate(script);
process.stdout.write(`[picker] ${JSON.stringify(result, null, 2)}\n`);
socket.close();
