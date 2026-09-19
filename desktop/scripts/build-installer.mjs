#!/usr/bin/env node
/**
 * Build the Windows installer.
 *
 * Pipeline: assemble a clean portable application (`build.mjs --layout installed`),
 * then hand it to NSIS, which embeds it into one setup executable that lets the
 * user choose where to install and whether to install for one user or all users.
 *
 * Usage:
 *   node scripts/build-installer.mjs                     # full build
 *   node scripts/build-installer.mjs --skip-build        # reuse the existing payload
 *   node scripts/build-installer.mjs --payload <dir>     # install a different tree
 *   node scripts/build-installer.mjs --compressor zlib   # smaller setup vs faster install
 *   node scripts/build-installer.mjs --dict 32           # LZMA dictionary, in MB
 *
 * The payload is built with `--out` into `build/installer/payload`, never into
 * `dist/`, because a running instance keeps its own executables locked.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const APP_NAME = 'DeepSeek Harness';
const APP_EXE = 'DeepSeek Harness.exe';
/**
 * The folder created under a parent directory the user picks. Picking `..\tools`
 * therefore installs to `..\tools\DSH Desktop`, which is what the installer tells
 * the user it will do.
 */
const APP_FOLDER = pkg.dsh?.appFolder ?? 'DSH Desktop';
const INSTALLER_DIR = path.join(ROOT, 'build', 'installer');
const PAYLOAD_ROOT = path.join(INSTALLER_DIR, 'payload');
const PAYLOAD = path.join(PAYLOAD_ROOT, APP_NAME);
const OUT_DIR = path.join(ROOT, 'dist-installer');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const NSIS_DIR = path.join(ROOT, 'build', 'tools', 'nsis', 'nsis-3.10');
const MAKENSIS = path.join(NSIS_DIR, 'makensis.exe');

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const SKIP_BUILD = process.argv.includes('--skip-build');
const PAYLOAD_OVERRIDE = argValue('--payload');

const log = (message) => process.stdout.write(`[installer] ${message}\n`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `0.1.5-rc.2` -> `0.1.5.0`: the four numeric parts VIProductVersion requires. */
function numericVersion(version) {
  const parts = (version.match(/\d+/gu) ?? []).slice(0, 3);
  while (parts.length < 3) parts.push('0');
  return [...parts, '0'].join('.');
}

const APP_VERSION = pkg.version;
const VI_VERSION = numericVersion(APP_VERSION);
const OUT_FILE = path.join(OUT_DIR, `${APP_NAME.replace(/ /gu, '')}-Setup-${APP_VERSION}.exe`);

// ── 1. compiler ─────────────────────────────────────────────────────────────
if (!existsSync(MAKENSIS)) {
  log('NSIS is missing; fetching it');
  const prepared = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-nsis.mjs')], { stdio: 'inherit' });
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}

// ── 2. payload ──────────────────────────────────────────────────────────────
const payloadDir = PAYLOAD_OVERRIDE ? path.resolve(ROOT, PAYLOAD_OVERRIDE) : PAYLOAD;
if (PAYLOAD_OVERRIDE) {
  log(`using the payload at ${payloadDir}`);
} else if (SKIP_BUILD) {
  log(`reusing the payload at ${payloadDir}`);
} else {
  log('assembling the application payload');
  rmSync(PAYLOAD_ROOT, { recursive: true, force: true });
  mkdirSync(PAYLOAD_ROOT, { recursive: true });
  const built = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'build.mjs'), '--out', path.join('build', 'installer', 'payload', APP_NAME), '--layout', 'installed'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
}

for (const required of [path.join(payloadDir, APP_EXE), path.join(payloadDir, 'resources', 'app', 'app', 'main.js')]) {
  if (!existsSync(required)) {
    process.stderr.write(`[installer] the payload is incomplete: ${required} is missing\n`);
    process.exit(1);
  }
}
if (existsSync(path.join(payloadDir, 'data'))) {
  // A payload with data would ship someone's sessions, and the installer treats
  // `data` as a marker it owns.
  process.stderr.write(`[installer] refusing to package a payload that already contains data\\: ${payloadDir}\n`);
  process.exit(1);
}

if (!existsSync(ICON)) {
  log('generating icons');
  const icons = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });
  if (icons.status !== 0) process.exit(icons.status ?? 1);
}

// ── 3. compile ──────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
rmSync(OUT_FILE, { force: true });

/**
 * Uncompressed payload size, for the installer's disk-space estimate.
 *
 * Reported to the user before a ~700 MB copy starts, so it is measured from the
 * real tree rather than guessed from the version metadata.
 */
function treeSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? treeSize(full) : statSync(full).size;
  }
  return total;
}

/**
 * The Node.js version actually shipped inside the payload.
 *
 * Asked of the bundled `node.exe` itself, because that is what the installer
 * shows the user; the version in package.json is only a fallback for the case
 * where the runtime cannot be executed (e.g. a cross-architecture build).
 */
function bundledNodeVersion(dir) {
  const node = path.join(dir, 'resources', 'runtime', 'node', 'node.exe');
  if (existsSync(node)) {
    const probed = spawnSync(node, ['-v'], { encoding: 'utf8', windowsHide: true });
    const version = (probed.stdout ?? '').trim();
    if (probed.status === 0 && /^v\d/u.test(version)) return version;
    log(`could not run ${path.relative(ROOT, node)}; falling back to package.json`);
  }
  return pkg.dsh?.nodeVersion ?? '';
}

const payloadBytes = treeSize(payloadDir);
const nodeVersion = bundledNodeVersion(payloadDir);
log(`payload is ${mb(payloadBytes)}, bundled Node.js ${nodeVersion || '(none)'}`);

// The compressor is a real trade-off, not an implementation detail, so it is a
// knob rather than a constant. Measured on this payload (silent install, same
// machine): LZMA gives a 156.7 MB setup in 25.0 s, zlib a 233.3 MB setup in
// 17.0 s. LZMA stays the default because download size matters more than an
// eight-second install for most users; see `installer/installer.nsi`.
const COMPRESSORS = ['lzma', 'zlib', 'bzip2'];
const compressor = argValue('--compressor') ?? 'lzma';
if (!COMPRESSORS.includes(compressor)) {
  process.stderr.write(`[installer] unknown --compressor ${compressor}; expected one of ${COMPRESSORS.join(', ')}\n`);
  process.exit(1);
}
const dictSize = argValue('--dict') ?? '64';

log(
  `compiling ${path.relative(ROOT, OUT_FILE)} ` +
    `(this takes a while: ${compressor} solid on the whole payload)`,
);
const started = Date.now();
const compiled = spawnSync(MAKENSIS, [
  // The .nsi is UTF-8 without a BOM (so ordinary tooling can edit it), which
  // makensis will not assume on its own.
  '/INPUTCHARSET', 'UTF8',
  `/DPAYLOAD=${payloadDir}`,
  `/DOUTFILE=${OUT_FILE}`,
  `/DAPPNAME=${APP_NAME}`,
  `/DAPPEXE=${APP_EXE}`,
  `/DAPPVERSION=${APP_VERSION}`,
  `/DAPPVI_VERSION=${VI_VERSION}`,
  `/DICONFILE=${ICON}`,
  `/DAPPFOLDER=${APP_FOLDER}`,
  `/DBUNDLED_NODE_VERSION=${nodeVersion}`,
  `/DPAYLOAD_BYTES=${payloadBytes}`,
  `/DCOMPRESSOR=${compressor}`,
  `/DDICTSIZE=${dictSize}`,
  path.join(ROOT, 'installer', 'installer.nsi'),
], { cwd: ROOT, stdio: 'inherit' });
if (compiled.status !== 0 || !existsSync(OUT_FILE)) {
  process.stderr.write('[installer] NSIS failed\n');
  process.exit(compiled.status === 0 ? 1 : compiled.status ?? 1);
}

// ── 4. report ───────────────────────────────────────────────────────────────
const size = statSync(OUT_FILE).size;
const digest = createHash('sha256').update(readFileSync(OUT_FILE)).digest('hex');

log(`done in ${String(Math.round((Date.now() - started) / 1000))}s`);
log(`  setup    ${OUT_FILE}`);
log(`  size     ${mb(size)} (from ${mb(payloadBytes)} of payload)`);
log(`  sha256   ${digest}`);
log(`  installs per-user to %LOCALAPPDATA%\\Programs\\${APP_NAME}`);
log(`  custom parent P produces P\\${APP_FOLDER}`);
