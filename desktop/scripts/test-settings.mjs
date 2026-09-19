#!/usr/bin/env node
/**
 * Unit tests for the shell settings rules (`app/settings.js`).
 *
 * These cover the three ways a settings file goes wrong over time: a retired
 * key lingering, an environment override leaking into the saved file, and the
 * effective settings being written back wholesale.
 *
 *   node scripts/test-settings.mjs
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { DEFAULT_DSH_HOME, DEFAULT_SETTINGS, PERSISTED_KEYS, persistedSettings, resolveSettings } = require(
  path.join(ROOT, 'app', 'settings.js'),
);

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

const HOME = os.homedir();

// ── defaults ────────────────────────────────────────────────────────────────
check('default home is ~/.dsh', DEFAULT_DSH_HOME === path.join(HOME, '.dsh'));
check('default port lets the OS choose', DEFAULT_SETTINGS.port === 0);
check('workspace is not a setting any more', !('workspace' in DEFAULT_SETTINGS) && !PERSISTED_KEYS.includes('workspace'));

// ── a normal settings file ──────────────────────────────────────────────────
const loaded = resolveSettings({ port: 3080, autoRestart: false, window: { width: 800 } }, {});
check('reads persisted values', loaded.settings.port === 3080 && loaded.settings.autoRestart === false);
check('merges window state over the defaults', loaded.settings.window.width === 800 && loaded.settings.window.height === 900);
check('keeps the default for an absent key', loaded.settings.closeToTray === false && loaded.settings.dshHome === DEFAULT_DSH_HOME);
check('reports nothing to clean', loaded.retired.length === 0 && loaded.unexpected.length === 0);

// ── the retired key ─────────────────────────────────────────────────────────
const legacy = resolveSettings({ workspace: 'C:\\Users\\someone', port: 0 }, {});
check('drops the retired workspace key', !('workspace' in legacy.settings));
check('reports the retired key so the file can be rewritten', legacy.retired.includes('workspace'));

// ── the bug this module exists for ──────────────────────────────────────────
const overridden = resolveSettings(
  { port: 3080, dshHome: 'C:\\Users\\someone\\.dsh' },
  { DSH_DESKTOP_HOME: 'D:\\shared-home', DSH_DESKTOP_PORT: '0' },
);
check('environment overrides the effective home', overridden.settings.dshHome === 'D:\\shared-home');
check('environment overrides the effective port', overridden.settings.port === 0);
const written = persistedSettings(overridden.stored);
check(
  'an override is NOT written back to disk',
  !JSON.stringify(written).includes('shared-home') && written.port === 3080 && written.dshHome === 'C:\\Users\\someone\\.dsh',
  JSON.stringify(written),
);
check('the stored copy keeps the file values', overridden.stored.port === 3080 && overridden.stored.dshHome === 'C:\\Users\\someone\\.dsh');
check(
  'effective and stored settings do not share the window object',
  overridden.settings.window !== overridden.stored.window,
);

// ── the persisted projection ────────────────────────────────────────────────
const projected = persistedSettings({ ...DEFAULT_SETTINGS, workspace: 'D:\\leftover', somethingElse: 1 });
check('projection keeps every persisted key', PERSISTED_KEYS.every((key) => key in projected));
check('projection drops unknown and retired keys', !('workspace' in projected) && !('somethingElse' in projected));
check('projection does not mutate its input', (() => {
  const input = { ...DEFAULT_SETTINGS, workspace: 'D:\\leftover' };
  persistedSettings(input);
  return input.workspace === 'D:\\leftover';
})());

// ── malformed input must not throw ──────────────────────────────────────────
const junk = resolveSettings(null, {});
check('tolerates a non-object file', junk.settings.port === 0 && junk.settings.dshHome === DEFAULT_DSH_HOME);
const stringy = resolveSettings({ port: 'not a number' }, {});
check('tolerates a junk port', stringy.settings.port === 'not a number', 'the shell coerces with Number(x) || 0 at spawn time');

// A hardcoded total drifted from the real count elsewhere in this suite; count
// what actually ran and fail if that number changes, so a silently deleted
// check cannot hide behind a stale summary line.
const EXPECTED_CHECKS = 19;
const ranBeforeAudit = ran;
check('the suite still runs every check', ranBeforeAudit === EXPECTED_CHECKS, `ran ${String(ranBeforeAudit)}, expected ${String(EXPECTED_CHECKS)}`);

const total = ran;
console.log(`\n${failed === 0 ? total : total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
