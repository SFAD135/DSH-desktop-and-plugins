#!/usr/bin/env node
/**
 * Unit tests for the first-run import (`app/migrate.js`).
 *
 * The rules that matter are the *refusals*: an import must never be offered
 * twice, never offered onto a home that already has data, and never offered
 * when the source is the target. The copy itself is exercised against a real
 * temporary tree, because "copy, never move" is the safety property here.
 *
 *   node scripts/test-migrate.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { MARKER_FILE_NAME, copyHome, declineImport, migrationPrompt, planMigration } = require(
  path.join(ROOT, 'app', 'migrate.js'),
);

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

const SOURCE = 'C:\\Users\\someone\\.dsh';
const TARGET = 'D:\\Apps\\DeepSeek Harness\\data\\dsh-home';

/** A probe pair with no filesystem involved. */
const fake = ({ source = ['sessions', 'profiles', 'settings.yaml'], target = [], marker = false } = {}) => ({
  exists: (p) => (p === SOURCE ? source.length > 0 : marker && p.endsWith(MARKER_FILE_NAME)),
  list: (p) => {
    if (p.startsWith(SOURCE)) return p === SOURCE ? source : ['a', 'b'];
    if (p.startsWith(TARGET) && p.endsWith('sessions')) return target;
    return [];
  },
});

// ── the offer ───────────────────────────────────────────────────────────────
const offer = planMigration({ sourceHome: SOURCE, targetHome: TARGET, ...fake() });
check('an existing home with data is offered', offer.offer === true);
check('the offer lists what was found', offer.highlights.map((h) => h.entry).join(',') === 'sessions,profiles,settings.yaml');
check('the labels are human readable', offer.highlights.every((h) => /[一-龥]/u.test(h.label)));

// ── the refusals ────────────────────────────────────────────────────────────
check('not offered twice', planMigration({ sourceHome: SOURCE, targetHome: TARGET, ...fake({ marker: true }) }).offer === false);
check(
  'not offered onto a home that already has sessions',
  planMigration({ sourceHome: SOURCE, targetHome: TARGET, ...fake({ target: ['session-x'] }) }).offer === false,
);
check(
  'not offered when the source is the target',
  planMigration({ sourceHome: TARGET, targetHome: TARGET, sourceHomeIsTarget: true, ...fake() }).offer === false,
);
check(
  'not offered when the source does not exist',
  planMigration({ sourceHome: SOURCE, targetHome: TARGET, exists: () => false, list: () => [] }).offer === false,
);
check(
  'not offered when the source holds nothing interesting',
  planMigration({ sourceHome: SOURCE, targetHome: TARGET, ...fake({ source: ['Cache', 'GPUCache'] }) }).offer === false,
);
check('not offered without both homes', planMigration({ sourceHome: null, targetHome: TARGET, ...fake() }).offer === false);

// ── the prompt ──────────────────────────────────────────────────────────────
const prompt = migrationPrompt(offer);
check('the prompt names both directories', prompt.detail.includes(SOURCE) && prompt.detail.includes(TARGET));
check('the prompt promises a copy, not a move', prompt.detail.includes('复制') && prompt.detail.includes('原位置保持不变'));

// ── a real copy ─────────────────────────────────────────────────────────────
const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'));
try {
  const src = path.join(scratch, 'legacy-home');
  const dst = path.join(scratch, 'data', 'dsh-home');
  mkdirSync(path.join(src, 'sessions', 'ws', 'session-1'), { recursive: true });
  mkdirSync(path.join(src, 'profiles', 'web'), { recursive: true });
  writeFileSync(path.join(src, 'settings.yaml'), 'port: 0\n');
  writeFileSync(path.join(src, 'sessions', 'ws', 'session-1', 'session.v3.jsonl.zstd'), 'binary-ish');
  writeFileSync(path.join(src, 'profiles', 'web', 'cordis.yml'), 'plugins: []\n');

  const realPlan = planMigration({ sourceHome: src, targetHome: dst });
  check('a real tree is planned as offerable', realPlan.offer === true, realPlan.reason);

  const result = copyHome(realPlan, { now: () => '2026-01-01T00:00:00.000Z' });
  check('the copy walked the nested tree', result.copied === 3, String(result.copied));
  check('nested session files arrived', existsSync(path.join(dst, 'sessions', 'ws', 'session-1', 'session.v3.jsonl.zstd')));
  check('the source was left intact', existsSync(path.join(src, 'settings.yaml')) && existsSync(path.join(src, 'sessions')));
  check('a marker records where the data came from', JSON.parse(readFileSync(path.join(dst, MARKER_FILE_NAME), 'utf8')).importedFrom === src);
  check('the import is not offered again after copying', planMigration({ sourceHome: src, targetHome: dst }).offer === false);

  // Declining must also settle the question permanently.
  const dst2 = path.join(scratch, 'data2', 'dsh-home');
  const plan2 = planMigration({ sourceHome: src, targetHome: dst2 });
  declineImport(plan2, { now: () => '2026-01-01T00:00:00.000Z' });
  const declined = JSON.parse(readFileSync(path.join(dst2, MARKER_FILE_NAME), 'utf8'));
  check('declining is recorded', declined.importedFrom === null && typeof declined.declinedAt === 'string');
  check('copied nothing while declining', readdirSync(dst2).join(',') === MARKER_FILE_NAME);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// A hardcoded total drifted from the real count elsewhere in this suite; count
// what actually ran and fail if that number changes, so a silently deleted
// check cannot hide behind a stale summary line.
const EXPECTED_CHECKS = 19;
const ranBeforeAudit = ran;
check('the suite still runs every check', ranBeforeAudit === EXPECTED_CHECKS, `ran ${String(ranBeforeAudit)}, expected ${String(EXPECTED_CHECKS)}`);

const total = ran;
console.log(`\n${failed === 0 ? total : total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
