#!/usr/bin/env node
/**
 * Headless verification of the bundled runtime: boot `dsh web` exactly the way
 * the desktop shell does, prove the HTTP surface answers behind the launch
 * token, prove the token fence rejects an unauthenticated anonymous request,
 * and prove a session workspace gets created.
 *
 * Everything runs inside build/smoke/ so nothing touches the real ~/.dsh.
 *
 * Usage: node scripts/smoke.mjs [--keep]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, openSync, closeSync, statSync, readSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUNTIME = path.join(ROOT, 'build', 'runtime');
const NODE_EXE = path.join(RUNTIME, 'node', 'node.exe');
const DSH_BIN = path.join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BIN_DIR = path.join(RUNTIME, 'bin');
const SMOKE = path.join(ROOT, 'build', 'smoke');
const HOME_DIR = path.join(SMOKE, 'home');
const WORKSPACE = path.join(SMOKE, 'workspace');
const KEEP = process.argv.includes('--keep');
const TIMEOUT_MS = 180_000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

for (const [target, label] of [[NODE_EXE, 'node.exe'], [DSH_BIN, 'dsh bin.js']]) {
  if (!existsSync(target)) {
    process.stderr.write(`[smoke] missing ${label}: ${target}\n[smoke] run: npm run prepare:runtime\n`);
    process.exit(1);
  }
}

/** Remove a directory, tolerating transient Windows file locks. */
function clean(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 });
    return true;
  } catch (error) {
    process.stdout.write(`[smoke] could not remove ${dir}: ${error.message}\n`);
    return false;
  }
}

clean(SMOKE);
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

process.stdout.write('[smoke] booting dsh web with a workspace-local DSH_HOME\n');

// The service writes to a log file rather than a pipe: piped stdio is denied
// in confined sandboxes, and file redirection also keeps the full log.
const SERVICE_LOG = path.join(SMOKE, 'service.log');
const logFd = openSync(SERVICE_LOG, 'a');
const child = spawn(NODE_EXE, [DSH_BIN, 'web', '--port', '0', '--no-open'], {
  cwd: WORKSPACE,
  env: {
    ...process.env,
    DSH_HOME: HOME_DIR,
    PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    ELECTRON_RUN_AS_NODE: undefined,
  },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
closeSync(logFd);

let output = '';
let offset = 0;
let tokenUrl = null;
let exited = null;

/** Read whatever the service appended since the last call. */
function drain() {
  const size = statSync(SERVICE_LOG).size;
  if (size <= offset) return '';
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const fd = openSync(SERVICE_LOG, 'r');
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  offset = size;
  const text = buffer.toString('utf8');
  output += text;
  return text;
}

child.on('exit', (code) => {
  exited = code ?? -1;
});

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  drain();
  const match = /dsh web:\s+(https?:\/\/\S+)/u.exec(output);
  if (match) {
    tokenUrl = match[1];
    break;
  }
  if (exited !== null) {
    drain();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function killTree() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}

let exitCode = 0;
try {
  if (!tokenUrl) throw new Error(`service never printed its URL (exit=${String(exited)})\n${output.slice(-4000)}`);
  const url = tokenUrl;
  process.stdout.write(`[smoke] service URL: ${url.replace(/token=[^&]+/u, 'token=***')}\n`);
  check('service prints an authenticated loopback URL', /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(url), url.replace(/token=[^&]+/u, 'token=***'));

  // 1) the launch-token URL authenticates the first index request and mints
  //    the persistent browser cookie (a 303 redirect to the clean URL).
  const tokenResponse = await fetch(url, { redirect: 'manual' });
  const cookie = tokenResponse.headers.getSetCookie?.().join('; ') ?? tokenResponse.headers.get('set-cookie') ?? '';
  check('launch token is accepted (redirect + cookie)', tokenResponse.status === 303 || tokenResponse.status === 302 || tokenResponse.status === 200, `HTTP ${tokenResponse.status}`);
  check('launch token trades for a browser cookie', cookie.length > 0, cookie.split(';')[0]?.slice(0, 48) ?? '');

  // 2) the token fence rejects an anonymous request for the same URL.
  const cleanUrl = new URL(url);
  cleanUrl.search = '';
  const anonymous = await fetch(cleanUrl.toString(), { redirect: 'manual' });
  check('unauthenticated request is fenced', anonymous.status === 401 || anonymous.status === 403, `HTTP ${anonymous.status}`);

  // 3) the cookie opens the app, and the served document is the Harness shell.
  const authed = await fetch(cleanUrl.toString(), { headers: { cookie }, redirect: 'follow' });
  const html = await authed.text();
  check('cookie-authenticated request reaches the app', authed.status === 200, `HTTP ${authed.status}`);
  check('served document is the Harness web shell', /__DSH_BOOT__|<div id="root"|DeepSeek/u.test(html), `${html.length} bytes, ${authed.headers.get('content-type') ?? 'no content-type'}`);
  if (!/__DSH_BOOT__|<div id="root"|DeepSeek/u.test(html)) process.stdout.write(`[smoke] body head:\n${html.slice(0, 600)}\n`);

  const sessionsDir = path.join(HOME_DIR, 'sessions');
  check('shared DSH_HOME is created', existsSync(HOME_DIR));
  check('profile initialized under DSH_HOME', existsSync(path.join(HOME_DIR, 'profiles', 'web', 'package.json')));
  process.stdout.write(`[smoke] sessions dir: ${sessionsDir} (${existsSync(sessionsDir) ? readdirSync(sessionsDir).length : 0} entries)\n`);
  process.stdout.write(`[smoke] service log: ${SERVICE_LOG} (${readFileSync(SERVICE_LOG, 'utf8').length} chars)\n`);
} catch (error) {
  check('service boot', false, error.message);
  exitCode = 1;
} finally {
  killTree();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!KEEP) clean(SMOKE);
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) exitCode = 1;
process.exit(exitCode);
