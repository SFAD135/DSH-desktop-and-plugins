#!/usr/bin/env node
/**
 * Assemble the bundled runtime for the desktop shell:
 *
 *   build/runtime/node/node.exe        official Node.js (win-x64)
 *   build/runtime/dsh/node_modules/**  the complete @deepseek-ai/dsh runtime tree
 *   build/runtime/pnpm/**              pnpm, so `dsh plugin` / the Plugins page works
 *   build/runtime/bin/pnpm.cmd         PATH shim that runs the bundled pnpm under the bundled node
 *   build/electron/**                  the Electron distribution (Chromium + windowing)
 *
 * Design notes:
 *   - Electron ships as a plain zip (no npm postinstall), so this script never
 *     depends on npm being able to spawn lifecycle scripts.
 *   - The dsh tree is copied from a matching local npm/npx install when one
 *     exists — that guarantees the desktop runtime is byte-identical to the
 *     CLI the user already runs. Otherwise it is installed from the registry
 *     with --ignore-scripts.
 *   - Every download tries a mirror first (npmmirror) and falls back to the
 *     canonical host. npm uses a project-local cache.
 *
 * Usage: node scripts/prepare-runtime.mjs [--force]
 * Env:   DSH_DESKTOP_DSH_TREE=<node_modules dir>  force a specific dsh tree source
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, cpSync, statSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { nodeVersion: NODE_VERSION, electronVersion: ELECTRON_VERSION, dshVersion: DSH_VERSION, pnpmVersion: PNPM_VERSION } = pkg.dsh;

const BUILD = path.join(ROOT, 'build');
const RUNTIME = path.join(BUILD, 'runtime');
const NPM_CACHE = path.join(ROOT, '.npm-cache');
const DOWNLOADS = path.join(BUILD, 'downloads');
const FORCE = process.argv.includes('--force');

for (const dir of [BUILD, RUNTIME, NPM_CACHE, DOWNLOADS]) mkdirSync(dir, { recursive: true });

const log = (message) => process.stdout.write(`[prepare] ${message}\n`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const readJsonSafe = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Stream one URL to a file, logging progress. */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let mark = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    const pct = total === 0 ? 0 : Math.floor((seen / total) * 100);
    if (pct >= mark + 10) {
      mark = pct - (pct % 10);
      log(`  ${path.basename(dest)} ${mb(seen)} / ${mb(total || seen)} (${pct}%)`);
    }
  });
  await pipeline(source, createWriteStream(dest));
  return seen;
}

/** Download the first URL that answers, into a cached file. */
async function downloadFirst(urls, dest) {
  if (existsSync(dest) && !FORCE && statSync(dest).size > 0) {
    log(`${path.basename(dest)} already cached (${mb(statSync(dest).size)})`);
    return dest;
  }
  const errors = [];
  for (const url of urls) {
    try {
      log(`downloading ${url}`);
      await download(url, dest);
      log(`  -> ${path.basename(dest)} ${mb(statSync(dest).size)}`);
      return dest;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      log(`  failed (${error.message}), trying next mirror`);
      rmSync(dest, { force: true });
    }
  }
  throw new Error(`every mirror failed:\n${errors.join('\n')}`);
}

/** Resolve the npm CLI entry shipped with the running Node, when present. */
function npmCli() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return path.resolve(candidate);
  return null;
}

function npmEnv(extra = {}) {
  return {
    ...process.env,
    npm_config_cache: NPM_CACHE,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
    ...extra,
  };
}

/**
 * Run npm inside `cwd`. `--ignore-scripts` is always passed: the runtime only
 * needs the published files, and a confined/sandboxed host cannot let npm
 * spawn lifecycle scripts at all.
 */
function runNpm(args, cwd, extraEnv = {}) {
  const full = ['--ignore-scripts', ...args];
  const cli = npmCli();
  const registries = [extraEnv.npm_config_registry, 'https://registry.npmjs.org/'].filter(Boolean);
  let lastStatus = 1;
  for (const registry of registries) {
    const env = npmEnv({ ...extraEnv, npm_config_registry: registry });
    log(`npm ${full.join(' ')}  (cwd=${path.relative(ROOT, cwd) || '.'}, registry=${registry})`);
    const result = cli
      ? spawnSync(process.execPath, [cli, ...full], { cwd, env, stdio: 'inherit' })
      : spawnSync('npm.cmd', full, { cwd, env, stdio: 'inherit', shell: true });
    if (result.error) throw result.error;
    lastStatus = result.status ?? 1;
    if (lastStatus === 0) return;
    log(`npm failed against ${registry}`);
  }
  throw new Error(`npm ${full.join(' ')} exited with code ${String(lastStatus)}`);
}

/** Extract a zip with the Windows bundled bsdtar, falling back to PowerShell. */
function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const tar = spawnSync('tar', ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  if (tar.status === 0) return;
  log('tar extraction failed; falling back to Expand-Archive');
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: 'inherit' });
  if (ps.status !== 0) throw new Error(`could not extract ${zip}`);
}

// ── 0. locate a matching local dsh tree ─────────────────────────────────────
/** Candidate node_modules directories that may already hold @deepseek-ai/dsh. */
function candidateDshRoots() {
  const dirs = [];
  if (process.env.DSH_DESKTOP_DSH_TREE) dirs.push(process.env.DSH_DESKTOP_DSH_TREE);
  if (process.env.LOCALAPPDATA) {
    const npx = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
    if (existsSync(npx)) {
      for (const entry of readdirSync(npx)) {
        const candidate = path.join(npx, entry, 'node_modules');
        if (existsSync(candidate)) dirs.push(candidate);
      }
    }
  }
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  dirs.push(NPM_CACHE);
  return dirs;
}

/** The first local tree that holds the exact dsh version we bundle. */
function findLocalDshTree() {
  for (const dir of candidateDshRoots()) {
    const manifest = path.join(dir, '@deepseek-ai', 'dsh', 'package.json');
    const bin = path.join(dir, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (!existsSync(manifest) || !existsSync(bin)) continue;
    const version = readJsonSafe(manifest)?.version;
    if (version !== DSH_VERSION) continue;
    return { nodeModules: dir, version };
  }
  return null;
}

// ── 1. Node.js runtime ──────────────────────────────────────────────────────
const nodeDir = path.join(RUNTIME, 'node');
const nodeExe = path.join(nodeDir, 'node.exe');
if (existsSync(nodeExe) && !FORCE) {
  log(`node runtime present: ${nodeExe}`);
} else {
  const zipName = `node-${NODE_VERSION}-win-x64.zip`;
  const zip = await downloadFirst([
    `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/${zipName}`,
    `https://nodejs.org/dist/${NODE_VERSION}/${zipName}`,
  ], path.join(DOWNLOADS, zipName));
  const staging = path.join(BUILD, 'node-extract');
  rmSync(staging, { recursive: true, force: true });
  extractZip(zip, staging);
  const inner = path.join(staging, `node-${NODE_VERSION}-win-x64`, 'node.exe');
  rmSync(nodeDir, { recursive: true, force: true });
  mkdirSync(nodeDir, { recursive: true });
  if (existsSync(inner)) copyFileSync(inner, nodeExe);
  else copyFileSync(await downloadFirst([`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`], path.join(DOWNLOADS, 'node.exe')), nodeExe);
  rmSync(staging, { recursive: true, force: true });
  log(`node runtime ready: ${nodeExe} (${mb(statSync(nodeExe).size)})`);
}

// ── 2. Complete dsh package tree ────────────────────────────────────────────
const dshRoot = path.join(RUNTIME, 'dsh');
const dshBin = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const skipDsh = (source) => /(?:^|[\\/])(?:\.package-lock\.json|_cacache|\.bin)(?:[\\/]|$)/u.test(source);
if (existsSync(dshBin) && !FORCE) {
  log(`dsh package present: ${dshBin}`);
} else {
  const local = findLocalDshTree();
  rmSync(dshRoot, { recursive: true, force: true });
  mkdirSync(dshRoot, { recursive: true });
  if (local) {
    log(`copying the dsh ${local.version} tree already installed at ${local.nodeModules}`);
    cpSync(local.nodeModules, path.join(dshRoot, 'node_modules'), { recursive: true, dereference: true, filter: (src) => !skipDsh(src) });
  } else {
    log(`no local dsh ${DSH_VERSION} tree found; installing from the registry`);
    const staging = path.join(BUILD, 'dsh-install');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify({ name: 'dsh-runtime', private: true, version: DSH_VERSION }, null, 2)}\n`);
    runNpm(['install', '--omit=dev', '--no-package-lock', `@deepseek-ai/dsh@${DSH_VERSION}`], staging, {
      npm_config_registry: 'https://registry.npmmirror.com/',
    });
    cpSync(path.join(staging, 'node_modules'), path.join(dshRoot, 'node_modules'), { recursive: true, dereference: true, filter: (src) => !skipDsh(src) });
    rmSync(staging, { recursive: true, force: true });
  }
  const installed = readJsonSafe(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))?.version;
  if (installed !== DSH_VERSION) throw new Error(`bundled dsh version mismatch: expected ${DSH_VERSION}, got ${String(installed)}`);
  writeFileSync(path.join(dshRoot, 'package.json'), `${JSON.stringify({ name: 'dsh-runtime', private: true, version: DSH_VERSION, dsh: { version: DSH_VERSION } }, null, 2)}\n`);
  log(`dsh package tree ready: ${dshBin} (v${installed})`);
}

// ── 3. pnpm (so profile plugin management works from the app) ───────────────
const pnpmRoot = path.join(RUNTIME, 'pnpm');
const pnpmCli = path.join(pnpmRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
if (existsSync(pnpmCli) && !FORCE) {
  log(`pnpm present: ${pnpmCli}`);
} else {
  const staging = path.join(BUILD, 'pnpm-install');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify({ name: 'pnpm-runtime', private: true }, null, 2)}\n`);
  runNpm(['install', '--omit=dev', '--no-package-lock', `pnpm@${PNPM_VERSION}`], staging, {
    npm_config_registry: 'https://registry.npmmirror.com/',
  });
  rmSync(pnpmRoot, { recursive: true, force: true });
  mkdirSync(pnpmRoot, { recursive: true });
  cpSync(path.join(staging, 'node_modules'), path.join(pnpmRoot, 'node_modules'), { recursive: true, dereference: true });
  rmSync(staging, { recursive: true, force: true });
  log(`pnpm ready: ${pnpmCli}`);
}

// ── 4. PATH shim directory ──────────────────────────────────────────────────
const binDir = path.join(RUNTIME, 'bin');
mkdirSync(binDir, { recursive: true });
writeFileSync(path.join(binDir, 'pnpm.cmd'), [
  '@echo off',
  'setlocal',
  'set "DSH_NODE=%~dp0..\\node\\node.exe"',
  'set "DSH_PNPM=%~dp0..\\pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs"',
  '"%DSH_NODE%" "%DSH_PNPM%" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n'));
log(`PATH shim ready: ${path.join(binDir, 'pnpm.cmd')}`);

// ── 5. Electron distribution ────────────────────────────────────────────────
const electronDir = path.join(BUILD, 'electron');
const electronExe = path.join(electronDir, 'electron.exe');
if (existsSync(electronExe) && !FORCE) {
  log(`electron present: ${electronExe}`);
} else {
  const zipName = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  const zip = await downloadFirst([
    `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${zipName}`,
    `https://registry.npmmirror.com/-/binary/electron/${ELECTRON_VERSION}/${zipName}`,
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${zipName}`,
  ], path.join(DOWNLOADS, zipName));
  rmSync(electronDir, { recursive: true, force: true });
  extractZip(zip, electronDir);
  if (!existsSync(electronExe)) throw new Error(`electron extraction produced no electron.exe in ${electronDir}`);
  log(`electron ready: ${electronExe}`);
}

log('runtime assembly complete');
log(`  node      ${nodeExe}`);
log(`  dsh       ${dshBin}`);
log(`  pnpm      ${pnpmCli}`);
log(`  electron  ${electronExe}`);
