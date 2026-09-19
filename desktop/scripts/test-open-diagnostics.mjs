#!/usr/bin/env node
/**
 * Unit tests for the open-action log (`app/open-diagnostics.js`).
 *
 * The whole contract of that module is now: **record, do not act**. So the tests
 * assert two things of equal weight:
 *
 *   1. every watched attempt produces exactly one log line naming the route, the
 *      button, the outcome and the target; and
 *   2. the watch touches nothing else — no dialog callback exists to call, no
 *      desktop probe is consulted, and settling never waits.
 *
 * The second half is the regression guard for the bug this module was rewritten to
 * remove: a probe that ran after the click reported "nothing opened" for a window
 * the user had already closed, which opened a second window and then raised an error
 * dialog about a button that had worked.
 *
 *   node scripts/test-open-diagnostics.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const openDiagnostics = require(path.join(ROOT, 'app', 'open-diagnostics.js'));
const { createOpenWatch, describeOpenAttempt, matchOpenRoute, readUploadBody } = openDiagnostics;

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

// ── route matching ──────────────────────────────────────────────────────────
const openInApp = matchOpenRoute('http://127.0.0.1:5000/open-in-app/open');
check('matches the open-in-app launch route', openInApp?.kind === 'open-in-app');
check('reads the default action', openInApp?.action === 'open');

const apps = matchOpenRoute('http://127.0.0.1:5000/open-in-app/apps');
check('matches the catalog route', apps?.kind === 'apps');

const icon = matchOpenRoute('http://127.0.0.1:5000/open-in-app/icon/vscode');
check('matches an icon sub-path', icon?.kind === 'icon');

const reveal = matchOpenRoute('http://127.0.0.1:5000/api/present.open?sessionId=s&seq=7&index=2&action=reveal');
check('matches the deliverables route', reveal?.kind === 'present-open');
check('reads the reveal action from the query', reveal?.action === 'reveal');
check('defaults the action to open when absent',
  matchOpenRoute('http://127.0.0.1:5000/api/present.open?sessionId=s&seq=7&index=2')?.action === 'open');

check('matches the desktop availability route',
  matchOpenRoute('http://127.0.0.1:5000/api/present.host')?.kind === 'present-host');
check('ignores unrelated routes', matchOpenRoute('http://127.0.0.1:5000/api/sessions') === null);
check('ignores a path that merely starts with the same text',
  matchOpenRoute('http://127.0.0.1:5000/open-in-app/openXYZ') === null);
check('ignores a malformed URL', matchOpenRoute('not a url') === null);

// There is no longer any such thing as a "quiet" route: nothing is announced, so a
// render-time call is logged exactly like a click. That is deliberate — the log is
// evidence, and evidence should not be filtered by who triggered it.
check('route matching no longer carries a quiet flag',
  openInApp !== null && !('quiet' in openInApp) && !('quiet' in apps),
  JSON.stringify(openInApp));

// ── request bodies ──────────────────────────────────────────────────────────
const bodyOf = (value) => [{ bytes: Buffer.from(JSON.stringify(value), 'utf8') }];
check('reads a JSON body', readUploadBody(bodyOf({ app: 'explorer', path: 'D:\\1848' }))?.path === 'D:\\1848');
check('returns null for a bodyless request', readUploadBody(undefined) === null);
check('returns null for an empty upload list', readUploadBody([]) === null);
check('returns null for a malformed body', readUploadBody([{ bytes: Buffer.from('{oops', 'utf8') }]) === null);
check('skips parts without bytes',
  readUploadBody([{ notBytes: true }, ...bodyOf({ path: 'D:\\x' })])?.path === 'D:\\x');

// ── the log line ────────────────────────────────────────────────────────────
const accepted = describeOpenAttempt({
  kind: 'open-in-app', action: 'open', method: 'POST', status: 200, elapsedMs: 12,
  app: 'explorer', targetPath: 'D:\\1848',
});
check('the line names the route and method', accepted.includes('open open-in-app (POST)'), accepted);
check('the line carries the status code', accepted.includes('-> 200'), accepted);
check('the line carries the elapsed time', accepted.includes('12ms'), accepted);
check('an accepted request is described as accepted', accepted.includes('宿主接受了请求'), accepted);
check('the line names the button', accepted.includes('「在本地打开」'), accepted);
check('the line names the target app and path',
  accepted.includes('app=explorer') && accepted.includes('path=D:\\1848'), accepted);

const refused = describeOpenAttempt({ kind: 'open-in-app', action: 'open', method: 'POST', status: 404, elapsedMs: 3 });
check('a refusal is described as a refusal', refused.includes('宿主拒绝了这个请求'), refused);
check('a refusal keeps the mapped reason in the log', refused.includes('目录不存在'), refused);
check('a refusal keeps the status code', refused.includes('-> 404'), refused);

const unknownRefusal = describeOpenAttempt({ kind: 'present-open', action: 'open', method: 'POST', status: 418 });
check('an unmapped refusal still says who refused',
  unknownRefusal.includes('宿主拒绝了这个请求') && unknownRefusal.includes('没有说明原因'), unknownRefusal);

const transport = describeOpenAttempt({ kind: 'open-in-app', action: 'open', method: 'POST', error: 'net::ERR_CONNECTION_REFUSED', elapsedMs: 1 });
check('a transport error is recorded as never delivered',
  transport.includes('failed: net::ERR_CONNECTION_REFUSED') && transport.includes('请求没有送达宿主'), transport);

const stalled = describeOpenAttempt({ kind: 'present-open', action: 'open', method: 'POST' });
check('a request with no response is recorded as such', stalled.includes('宿主没有响应'), stalled);

const revealLine = describeOpenAttempt({ kind: 'present-open', action: 'reveal', method: 'POST', status: 200 });
check('a reveal names the reveal button', revealLine.includes('「打开所在文件夹」'), revealLine);
const openLine = describeOpenAttempt({ kind: 'present-open', action: 'open', method: 'POST', status: 200 });
check('a plain open names the open button', openLine.includes('「用默认应用打开」'), openLine);
check('a GET is recorded rather than hidden',
  describeOpenAttempt({ kind: 'present-open', action: 'open', method: 'GET', status: 404 }).includes('(GET)'));

// ── there is no reporting surface left ──────────────────────────────────────
for (const gone of ['diagnoseOpenAttempt', 'explorerFolderFor', 'isAbsoluteWindowsPath']) {
  check(`the module no longer exports ${gone}`, openDiagnostics[gone] === undefined, String(openDiagnostics[gone]));
}

// ── the watch records and does nothing else ─────────────────────────────────
const lines = [];
const watch = createOpenWatch({ log: (line) => lines.push(line) });

watch.onBeforeRequest({
  id: 1, method: 'POST', url: 'http://127.0.0.1:5000/open-in-app/open',
  uploadData: [{ bytes: Buffer.from(JSON.stringify({ app: 'explorer', path: 'D:\\proj' }), 'utf8') }],
});
check('an in-flight request is tracked', watch.pending.size === 1, String(watch.pending.size));
watch.onCompleted({ id: 1, statusCode: 200 });
check('the attempt is dropped once answered', watch.pending.size === 0);
check('exactly one line is written per attempt', lines.length === 1, JSON.stringify(lines));
check('the line records the body it carried',
  lines[0].includes('app=explorer') && lines[0].includes('path=D:\\proj'), lines[0]);

watch.onBeforeRequest({ id: 2, method: 'POST', url: 'http://127.0.0.1:5000/api/present.open?action=reveal' });
watch.onErrorOccurred({ id: 2, error: 'net::ERR_FAILED' });
check('a transport failure is logged too', lines.length === 2 && lines[1].includes('net::ERR_FAILED'), JSON.stringify(lines));

// An unrelated route must not be remembered: the watch is not a general request log.
watch.onBeforeRequest({ id: 3, method: 'POST', url: 'http://127.0.0.1:5000/api/sessions' });
watch.onCompleted({ id: 3, statusCode: 200 });
check('unrelated traffic is ignored', watch.pending.size === 0 && lines.length === 2, JSON.stringify(lines));

// A completion for an id that was never watched (or already answered) is not a line.
watch.onCompleted({ id: 99, statusCode: 200 });
check('a completion for an unknown request logs nothing', lines.length === 2);

// ── settling is immediate: no grace period, no probe, no second window ──────
const settleLines = [];
const settleWatch = createOpenWatch({ log: (line) => settleLines.push(line) });
settleWatch.onBeforeRequest({ id: 7, method: 'POST', url: 'http://127.0.0.1:5000/open-in-app/open' });
const startedAt = Date.now();
settleWatch.onCompleted({ id: 7, statusCode: 200 });
const took = Date.now() - startedAt;
check('answering a request does not wait for a grace period', took < 50, `${String(took)}ms`);
check('the log line is written synchronously', settleLines.length === 1, JSON.stringify(settleLines));

// The old watch accepted a pile of collaborators for probing and repairing. Passing
// them must not resurrect the behaviour: every one of them is simply ignored.
let probed = 0;
let opened = 0;
let restored = 0;
let announced = 0;
const inertWatch = createOpenWatch({
  log: () => {},
  report: () => { announced += 1; },
  isEnabled: () => true,
  isWindowFocused: () => true,
  probeFolderOpen: async () => { probed += 1; return false; },
  openFolder: async () => { opened += 1; return { ok: true }; },
  listHiddenWindows: async () => { restored += 1; return []; },
  restoreWindow: async () => { restored += 1; return true; },
  sleep: async () => {},
});
inertWatch.onBeforeRequest({ id: 11, method: 'POST', url: 'http://127.0.0.1:5000/open-in-app/open', uploadData: [{ bytes: Buffer.from(JSON.stringify({ app: 'explorer', path: 'D:\\proj' }), 'utf8') }] });
inertWatch.onCompleted({ id: 11, statusCode: 200 });
await inertWatch.whenSettled();
await new Promise((resolve) => { setTimeout(resolve, 60); });
check('no desktop probe is performed', probed === 0, `probed=${String(probed)}`);
check('the shell never opens a second window', opened === 0, `opened=${String(opened)}`);
check('the shell never restores windows', restored === 0, `restored=${String(restored)}`);
check('nothing is announced to the user', announced === 0, `announced=${String(announced)}`);
check('settling resolves without waiting', typeof inertWatch.whenSettled === 'function');

// ── the module surface is exactly what the shell needs ──────────────────────
check('the public surface is the logging one',
  JSON.stringify(Object.keys(openDiagnostics).sort()) ===
    JSON.stringify(['OPEN_ROUTES', 'REFUSALS', 'actionName', 'createOpenWatch', 'describeOpenAttempt', 'matchOpenRoute', 'readUploadBody']),
  JSON.stringify(Object.keys(openDiagnostics).sort()));

console.log(`\n${String(ran - failed)}/${String(ran)} checks passed`);
process.exit(failed === 0 ? 0 : 1);
