#!/usr/bin/env node
/**
 * Fetch the NSIS compiler used to build the installer.
 *
 * NSIS publishes a plain zip, so this needs no installer of its own and no
 * administrator rights: the archive is unpacked into `build/tools/nsis` and
 * `makensis.exe` runs from there. Nothing it produces ends up inside the shipped
 * installer, so it is a build-time dependency only.
 *
 * Usage:
 *   node scripts/prepare-nsis.mjs [--force]
 *
 * The download is verified against a pinned SHA-256. A mismatch is fatal rather
 * than a warning: the compiler produces the executable users run, so a swapped
 * artifact is not something to shrug off.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD = path.join(ROOT, 'build');
const TOOLS = path.join(BUILD, 'tools');
const DOWNLOADS = path.join(BUILD, 'downloads', 'nsis');
const NSIS_VERSION = '3.10';
/** The unpacked compiler lives in a versioned directory, as the zip is laid out. */
const NSIS_DIR = path.join(TOOLS, 'nsis', `nsis-${NSIS_VERSION}`);
const MAKENSIS = path.join(NSIS_DIR, 'makensis.exe');
const ZIP = path.join(DOWNLOADS, `nsis-${NSIS_VERSION}.zip`);
const FORCE = process.argv.includes('--force');

/**
 * SHA-256 of the published `nsis-3.10.zip`.
 *
 * Pinned from the artifact this project was built and tested against; update it
 * together with {@link NSIS_VERSION} after verifying a new release by hand.
 */
const EXPECTED_SHA256 = 'fcdce3229717a2a148e7cda0ab5bdb667f39d8fb33ede1da8dabc336bd5ad110';

const URLS = [
  `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`,
  `https://sourceforge.net/projects/nsis/files/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip/download`,
];

const log = (message) => process.stdout.write(`[nsis] ${message}\n`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The installed compiler's version string, or `null` when it cannot run. */
function installedVersion() {
  if (!existsSync(MAKENSIS)) return null;
  const result = spawnSync(MAKENSIS, ['/VERSION'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim().replace(/^v/u, '');
}

if (installedVersion() === NSIS_VERSION && !FORCE) {
  log(`NSIS ${NSIS_VERSION} already available (${path.relative(ROOT, MAKENSIS)})`);
  process.exit(0);
}

mkdirSync(DOWNLOADS, { recursive: true });

/** Whether the cached archive matches the pinned digest. */
function cachedArchiveIsValid() {
  if (!existsSync(ZIP) || statSync(ZIP).size === 0) return false;
  return sha256(ZIP) === EXPECTED_SHA256;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Stream one URL to `dest`, reporting progress. */
async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  let seen = 0;
  let mark = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    const percent = total === 0 ? 0 : Math.floor((seen / total) * 100);
    if (percent >= mark + 20) {
      mark = percent - (percent % 20);
      log(`  ${mb(seen)} / ${mb(total || seen)} (${percent}%)`);
    }
  });
  await pipeline(source, createWriteStream(dest));
}

if (!cachedArchiveIsValid()) {
  rmSync(ZIP, { force: true });
  const failures = [];
  let ok = false;
  for (const url of URLS) {
    try {
      log(`downloading ${url}`);
      await download(url, ZIP);
      const digest = sha256(ZIP);
      if (digest !== EXPECTED_SHA256) {
        throw new Error(`SHA-256 mismatch: got ${digest}, expected ${EXPECTED_SHA256}`);
      }
      ok = true;
      break;
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
      rmSync(ZIP, { force: true });
    }
  }
  if (!ok) {
    process.stderr.write(`[nsis] every download failed:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
  }
  log(`verified SHA-256 ${EXPECTED_SHA256}`);
} else {
  log(`cached ${path.basename(ZIP)} verified`);
}

// ── unpack ──────────────────────────────────────────────────────────────────
// `tar -xf` is the one extractor guaranteed present on Windows 10+; PowerShell's
// Expand-Archive is the fallback. The zip keeps everything under `nsis-3.10/`.
log('unpacking');
rmSync(NSIS_DIR, { recursive: true, force: true });
mkdirSync(path.join(TOOLS, 'nsis'), { recursive: true });
const tar = spawnSync('tar', ['-xf', ZIP, '-C', path.join(TOOLS, 'nsis')], { stdio: 'inherit' });
if (tar.status !== 0) {
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${path.join(TOOLS, 'nsis')}' -Force`],
    { stdio: 'inherit' },
  );
  if (ps.status !== 0) {
    process.stderr.write('[nsis] could not unpack the archive\n');
    process.exit(1);
  }
}

// ── verify ──────────────────────────────────────────────────────────────────
const version = installedVersion();
if (version !== NSIS_VERSION) {
  process.stderr.write(`[nsis] makensis did not run (got ${String(version)})\n`);
  process.exit(1);
}
for (const dir of ['Stubs', 'Include', 'Plugins', 'Contrib']) {
  if (!existsSync(path.join(NSIS_DIR, dir))) {
    process.stderr.write(`[nsis] the unpacked tree is missing ${dir}\n`);
    process.exit(1);
  }
}
log(`ready: ${MAKENSIS} (v${version})`);
