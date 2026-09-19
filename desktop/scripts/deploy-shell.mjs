#!/usr/bin/env node
/**
 * Copy the shell sources in `app/` into an installed desktop app.
 *
 * The shell is plain CommonJS loaded by Electron from
 * `<install>\resources\app\app\`, so changing it is a file copy — no rebuild and
 * no reinstall. That is convenient and also dangerous: this writes into a live
 * installation, and a bad copy leaves an app that will not start. So every run
 * takes a backup first, reports exactly which files it will touch before touching
 * them, and can be undone with `--rollback`.
 *
 * Usage:
 *   node scripts/deploy-shell.mjs --dry-run          # show the plan only
 *   node scripts/deploy-shell.mjs                    # apply, with a backup
 *   node scripts/deploy-shell.mjs --target <dir>     # a specific installation
 *   node scripts/deploy-shell.mjs --rollback <dir>   # restore a backup
 *   node scripts/deploy-shell.mjs --restart          # restart the app afterwards
 *
 * The target defaults to the `InstallDir` recorded by the installer, so the
 * common case needs no arguments.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_APP = path.join(ROOT, 'app');
const BACKUP_ROOT = path.join(ROOT, 'build', 'shell-backup');
const REG_KEY = 'HKCU:\\Software\\DeepSeek Harness';

const log = (m) => { process.stdout.write(`[deploy] ${m}\n`); };
const psLiteral = (v) => `'${String(v).replace(/'/gu, "''")}'`;

function powershell(script) {
  const r = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

function argValue(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : null;
}

const sha256 = (file) => {
  const r = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', `(Get-FileHash -LiteralPath ${psLiteral(file)} -Algorithm SHA256).Hash`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return (r.stdout ?? '').trim();
};

/** Where the app is installed: `/PARENT=`-style override first, then the registry. */
function resolveTarget() {
  const explicit = argValue('--target');
  if (explicit !== null) return path.resolve(explicit);
  const recorded = powershell(`(Get-ItemProperty -Path ${psLiteral(REG_KEY)} -ErrorAction SilentlyContinue).InstallDir`);
  return recorded === '' ? null : recorded;
}

/** Fail loudly rather than writing into a directory that is not this app. */
function assertIsInstall(target) {
  const marker = path.join(target, 'resources', 'app', 'app', 'main.js');
  if (!existsSync(marker)) {
    throw new Error(`${target} does not look like a DeepSeek Harness installation (no ${marker})`);
  }
  return marker;
}

/** Every shell file the source tree provides, relative to `app/`. */
function sourceFiles() {
  const out = [];
  (function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  })(SOURCE_APP, '');
  return out;
}

/** Is the desktop app currently running from `target`? */
function runningProcesses(target) {
  const raw = powershell(
    `Get-CimInstance Win32_Process -Filter "Name='electron-core.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.ExecutablePath -like ${psLiteral(path.join(target, '*'))} } | ` +
      `ForEach-Object { "$($_.ProcessId)" }`,
  );
  return raw.split(/\r?\n/u).map((s) => s.trim()).filter((s) => /^\d+$/u.test(s));
}

// ── rollback ────────────────────────────────────────────────────────────────
function rollback(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${dir} has no manifest.json; not a backup made by this script`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  log(`rolling back to ${manifest.target} (backed up ${manifest.createdAt})`);
  let restored = 0;
  let removed = 0;
  for (const entry of manifest.files) {
    const dest = path.join(manifest.target, 'resources', 'app', 'app', entry.path);
    const backup = path.join(dir, 'app', entry.path);
    if (entry.existed) {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(backup, dest);
      restored += 1;
    } else if (existsSync(dest)) {
      // The file did not exist before the deploy, so undoing means removing it.
      rmSync(dest, { force: true });
      removed += 1;
    }
  }
  const pkgBackup = path.join(dir, 'package.json');
  if (existsSync(pkgBackup)) {
    copyFileSync(pkgBackup, path.join(manifest.target, 'resources', 'app', 'package.json'));
  }
  log(`restored ${restored} file(s), removed ${removed} added file(s)`);
  log('restart the app for the rollback to take effect');
}

// ── main ────────────────────────────────────────────────────────────────────
const rollbackDir = argValue('--rollback');
if (rollbackDir !== null) {
  rollback(path.resolve(rollbackDir));
  process.exit(0);
}

const dryRun = process.argv.includes('--dry-run');
const target = resolveTarget();
if (target === null) {
  process.stderr.write('[deploy] no installation found; pass --target <dir>\n');
  process.exit(1);
}
assertIsInstall(target);
log(`target ${target}`);

const live = runningProcesses(target);
if (live.length > 0) {
  log(`the app is running (pid ${live.join(', ')}); a restart is needed for the change to take effect`);
}

const files = sourceFiles();
const plan = [];
for (const rel of files) {
  const src = path.join(SOURCE_APP, rel);
  const dest = path.join(target, 'resources', 'app', 'app', rel);
  const existed = existsSync(dest);
  if (!existed) {
    plan.push({ path: rel, action: 'add', existed: false, src, dest });
  } else if (sha256(src) !== sha256(dest)) {
    plan.push({ path: rel, action: 'replace', existed: true, src, dest });
  }
}
const packageSrc = path.join(ROOT, 'package.json');
const packageDest = path.join(target, 'resources', 'app', 'package.json');
const packageChanged = !existsSync(packageDest) || sha256(packageSrc) !== sha256(packageDest);

process.stdout.write('\n');
if (plan.length === 0 && !packageChanged) {
  log('the installed shell already matches the source; nothing to do');
  process.exit(0);
}
for (const item of plan) {
  const size = statSync(item.src).size;
  log(`  ${item.action === 'add' ? 'add    ' : 'replace'}  ${item.path}  (${size} B)`);
}
if (packageChanged) log('  replace  package.json');

if (dryRun) {
  log('dry run: nothing was written');
  process.exit(0);
}

// The backup lives under the project's build directory, not inside the install,
// so it cannot be mistaken for application content or shipped in a payload.
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const backupDir = path.join(BACKUP_ROOT, stamp);
mkdirSync(path.join(backupDir, 'app'), { recursive: true });
for (const item of plan) {
  if (item.existed) {
    const to = path.join(backupDir, 'app', item.path);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(item.dest, to);
  }
}
if (packageChanged && existsSync(packageDest)) copyFileSync(packageDest, path.join(backupDir, 'package.json'));
writeFileSync(
  path.join(backupDir, 'manifest.json'),
  `${JSON.stringify({ target, createdAt: new Date().toISOString(), files: plan.map((i) => ({ path: i.path, existed: i.existed })) }, null, 2)}\n`,
);

process.stdout.write('\n');
let written = 0;
for (const item of plan) {
  mkdirSync(path.dirname(item.dest), { recursive: true });
  copyFileSync(item.src, item.dest);
  if (sha256(item.src) !== sha256(item.dest)) throw new Error(`copy verification failed for ${item.path}`);
  written += 1;
}
if (packageChanged) copyFileSync(packageSrc, packageDest);

log(`wrote ${written + (packageChanged ? 1 : 0)} file(s), each verified by hash`);
log(`backup ${path.relative(ROOT, backupDir)}`);
log(`roll back with: node scripts/deploy-shell.mjs --rollback "${path.relative(ROOT, backupDir)}"`);

if (process.argv.includes('--restart')) {
  const exe = path.join(target, 'DeepSeek Harness.exe');
  if (!existsSync(exe)) {
    log(`cannot restart: ${exe} is missing`);
  } else {
    log('restarting the app');
    for (const pid of runningProcesses(target)) {
      spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true });
    }
    const child = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', `Start-Process -FilePath ${psLiteral(exe)}`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    log(child.status === 0 ? 'restart requested' : 'restart failed');
  }
} else {
  log('restart the app for the change to take effect');
}
