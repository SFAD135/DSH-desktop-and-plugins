#!/usr/bin/env node
/**
 * Unit test for the dsh host command-line matcher.
 *
 * The matcher is the part of the concurrency warning that can be wrong in a
 * way users would notice, so every case below is a real command line observed
 * on this machine or a near neighbour of one. Run with:
 *   node scripts/test-host-detect.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { classifyDshHost, selectOtherHosts, tokenize } = require(path.join(ROOT, 'app', 'host-detect.js'));

// Derived from the project root rather than spelled out. A literal path here does not fail
// loudly when the project moves — the fixture is compared against itself, so the suite keeps
// passing while the string quietly stops naming the desktop shell's real entry file.
const DIST_RUNTIME = path.join(ROOT, 'dist', 'DeepSeek Harness', 'resources', 'runtime', 'dsh', 'node_modules', '@deepseek-ai');
const DESKTOP_BIN = `"${path.join(DIST_RUNTIME, 'dsh', 'lib', 'bin.js')}"`;
// This one is genuinely machine-specific: it stands for a command-line dsh installed in the
// npm cache, which is a location outside this project and cannot be derived from it.
const CLI_BIN = '"C:\\Users\\someone\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"';
const NODE = '"C:\\Program Files\\nodejs\\node.exe"';

/** Each case: [name, command line, expected isHost, expected profile]. */
const CASES = [
  ['desktop service (this shell)', `${NODE} ${DESKTOP_BIN} web --port 0 --no-open`, true, 'web'],
  ['cmd dsh web (npx cache tree)', `${NODE} ${CLI_BIN} web`, true, 'web'],
  ['cmd dsh web with fixed port', `${NODE} ${CLI_BIN} web --port 3080`, true, 'web'],
  ['explicit --profile web', `${NODE} ${CLI_BIN} --profile web --port 3080`, true, 'web'],
  ['explicit --profile=web', `${NODE} ${CLI_BIN} --profile=web`, true, 'web'],
  ['patch overlay before alias', `${NODE} ${CLI_BIN} --patch a.yml web`, true, 'web'],
  // A host on another profile is still a host; `detectProfileConflicts` files it under `otherProfile`.
  ['other profile (headless)', `${NODE} ${CLI_BIN} --profile headless --once`, true, 'headless'],
  ['tool subprocess runner', `${NODE} "${path.join(DIST_RUNTIME, 'dsh-subprocess-local', 'lib', 'runner.js')}" -- cmd /c echo hi`, false, null],
  ['plugin management', `${NODE} ${CLI_BIN} plugin --profile web add foo`, false, null],
  ['help', `${NODE} ${CLI_BIN} --help`, false, null],
  ['config dump', `${NODE} ${CLI_BIN} --profile web --dump-config`, false, null],
  ['unrelated node app', '"C:\\Program Files\\nodejs\\node.exe" "C:\\apps\\web\\server.js" --port 3000', false, null],
  ['agent command embedding bin.js text', `${NODE} "…\\dsh-subprocess-local\\lib\\runner.js" -- powershell -Command "node C:\\x\\dsh\\lib\\bin.js web"`, false, null],
  ['empty command line', '', false, null],
  ['undefined command line', undefined, false, null],
];

let failed = 0;
let ran = 0;
for (const [name, commandLine, expectedHost, expectedProfile] of CASES) {
  const actual = classifyDshHost(commandLine);
  const ok = actual.isHost === expectedHost && actual.profile === expectedProfile;
  ran += 1;
  if (!ok) failed += 1;
  const verdict = ok ? 'PASS' : 'FAIL';
  const shown = String(commandLine ?? '').length > 96 ? `${String(commandLine).slice(0, 93)}...` : String(commandLine ?? '');
  console.log(`[${verdict}] ${name.padEnd(34)} host=${String(actual.isHost).padEnd(5)} profile=${String(actual.profile)} reason=${actual.reason}`);
  if (!ok) console.log(`        expected host=${String(expectedHost)} profile=${String(expectedProfile)}\n        input: ${shown}`);
}

const tokenCheck = tokenize('a "b c" d') ;
const tokenOk = JSON.stringify(tokenCheck) === JSON.stringify(['a', 'b c', 'd']);
ran += 1;
console.log(`[${tokenOk ? 'PASS' : 'FAIL'}] ${'tokenizer keeps quoted args'.padEnd(34)} ${JSON.stringify(tokenCheck)}`);
if (!tokenOk) failed += 1;

// Self-exclusion: the shell must never report its own service as a competing
// host — but it must still report a *second* instance started from the same
// portable folder (same entry file, different parent).
const SELF_BIN = path.join(DIST_RUNTIME, 'dsh', 'lib', 'bin.js');
const OWN_PID = 5000;
const SELF_HOST = { pid: 9001, parentPid: OWN_PID, profile: 'web', commandLine: `${NODE} "${SELF_BIN}" web --port 0 --no-open` };
const TWIN_HOST = { pid: 9003, parentPid: 7777, profile: 'web', commandLine: `${NODE} "${SELF_BIN}" web --port 0 --no-open` };
const OTHER_HOST = { pid: 9002, parentPid: 8888, profile: 'web', commandLine: `${NODE} ${CLI_BIN} web` };
const dropped = selectOtherHosts([SELF_HOST, TWIN_HOST, OTHER_HOST], { ownPid: OWN_PID, ownBinPaths: [SELF_BIN] });
const selfChecks = [
  ['own service (own child + own entry) dropped', !dropped.some((host) => host.pid === 9001)],
  ['second instance from the same folder kept', dropped.some((host) => host.pid === 9003)],
  ['a CLI host is kept', dropped.some((host) => host.pid === 9002)],
  ['exclusion ignores case in the entry path', selectOtherHosts([{ ...SELF_HOST, commandLine: SELF_HOST.commandLine.toUpperCase() }], { ownPid: OWN_PID, ownBinPaths: [SELF_BIN] }).length === 0],
  ['own process pid is always excluded', selectOtherHosts([{ pid: OWN_PID, parentPid: 1, profile: 'web', commandLine: 'x' }], { ownPid: OWN_PID }).length === 0],
  ['own child on another entry file is kept', selectOtherHosts([{ pid: 9004, parentPid: OWN_PID, profile: 'web', commandLine: `${NODE} ${CLI_BIN} web` }], { ownPid: OWN_PID, ownBinPaths: [SELF_BIN] }).length === 1],
  ['explicit excludePids is honoured', !selectOtherHosts([OTHER_HOST], { excludePids: [9002], ownPid: OWN_PID }).some((host) => host.pid === 9002)],
];
for (const [name, ok] of selfChecks) {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(44)}`);
}

// A hardcoded total drifted from the real count elsewhere in this suite; here
// the total is derived from the case tables, and this asserts the tables were
// actually walked.
const EXPECTED_CHECKS = CASES.length + 1 + selfChecks.length;
if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(`[FAIL] ${'the suite still runs every check'.padEnd(44)} ran ${String(ran)}, expected ${String(EXPECTED_CHECKS)}`);
} else {
  console.log(`[PASS] ${'the suite still runs every check'.padEnd(44)}`);
}
ran += 1;

console.log(`\n${ran - failed}/${ran} checks passed`);
process.exit(failed === 0 ? 0 : 1);
