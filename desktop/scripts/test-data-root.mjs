#!/usr/bin/env node
/**
 * Unit tests for the data-root rules (`app/data-root.js`).
 *
 * The interesting part is the precedence, and the guarantee that a plain app
 * directory (no `data/` beside the executable) keeps the historical layout —
 * that is what lets one binary serve both the portable build and an installed
 * copy without a second code path.
 *
 *   node scripts/test-data-root.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { DATA_ROOT_ENV, dshHomeDir, isFirstRun, resolveDataRoot, shellDataDir } = require(
  path.join(ROOT, 'app', 'data-root.js'),
);

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

const EXE = 'D:\\Apps\\DeepSeek Harness';
const dirs = new Set([path.join(EXE, 'data')]);
const isDirectory = (target) => dirs.has(path.resolve(target));

// ── precedence ──────────────────────────────────────────────────────────────
const portable = resolveDataRoot({ env: {}, exeDir: EXE, isDirectory });
check('a data directory beside the executable means portable', portable.source === 'portable');
check('the portable root is <exe>\\data', portable.root === path.join(EXE, 'data'));

const overridden = resolveDataRoot({
  env: { [DATA_ROOT_ENV]: 'E:\\elsewhere' },
  exeDir: EXE,
  isDirectory,
});
check('the environment override wins over the portable directory', overridden.source === 'env' && overridden.root === 'E:\\elsewhere');

const blank = resolveDataRoot({ env: { [DATA_ROOT_ENV]: '   ' }, exeDir: EXE, isDirectory });
check('a blank override is ignored', blank.source === 'portable');

const plain = resolveDataRoot({ env: {}, exeDir: 'D:\\Apps\\Plain', isDirectory });
check('no data directory falls back to the default layout', plain.source === 'default' && plain.root === null);

const noExe = resolveDataRoot({ env: {}, exeDir: undefined, isDirectory });
check('a missing exe directory falls back to the default layout', noExe.root === null);

// ── derived directories ─────────────────────────────────────────────────────
check('the shell data directory is <root>\\shell', shellDataDir(portable.root) === path.join(EXE, 'data', 'shell'));
check('the dsh home is <root>\\dsh-home', dshHomeDir(portable.root) === path.join(EXE, 'data', 'dsh-home'));
check('a default layout derives no directories', shellDataDir(null) === null && dshHomeDir(null) === null);
check('the default layout leaves dsh on ~/.dsh', dshHomeDir(plain.root) === null);

// ── first run detection ─────────────────────────────────────────────────────
const empty = () => false;
const hasSettings = (target) => target.endsWith('shell-settings.json');
check('a home without settings counts as a first run', isFirstRun(portable.root, empty) === true);
check('a home with settings does not', isFirstRun(portable.root, hasSettings) === false);
check('the default layout is never a "first run"', isFirstRun(null, empty) === false);

// A hardcoded total drifted from the real count elsewhere in this suite; count
// what actually ran and fail if that number changes.
const EXPECTED_CHECKS = 13;
const ranBeforeAudit = ran;
check('the suite still runs every check', ranBeforeAudit === EXPECTED_CHECKS, `ran ${String(ranBeforeAudit)}, expected ${String(EXPECTED_CHECKS)}`);

const total = ran;
console.log(`\n${failed === 0 ? total : total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
