'use strict';
/**
 * A log of the two "open on the desktop" actions.
 *
 * Both actions are implemented by the dsh host, not by this shell: the Web GUI
 * POSTs to a route on the local service, and the host launches Explorer, VS Code
 * or a default application on its own. This module watches those POSTs and writes
 * one line per attempt to the shell log — nothing else.
 *
 * ## Why it only logs
 *
 * An earlier revision tried to *verify* the result by asking the desktop whether a
 * window had appeared, and to repair it when none had. That was removed on purpose,
 * because a single look at the desktop cannot tell these two apart:
 *
 *   - the host never opened anything, and
 *   - the host opened it, and the user closed it before the look happened.
 *
 * Treating the second as the first made the shell open a **second** window right
 * after the user closed the first, and — if that one was closed quickly too — show
 * an "打开失败：宿主和桌面版都没能打开" dialog about a button that had in fact
 * worked twice. The fix is not a better-timed probe but no probe: the shell does not
 * second-guess the host, so it can neither duplicate a window nor cry wolf.
 *
 * The launches themselves are fixed where they belong, in the bundled runtime (see
 * `scripts/patch-runtime.mjs`: no `windowsHide` for GUI programs, `explorer.exe`
 * instead of `Invoke-Item`, a native path instead of a percent-encoded `file://`
 * URL). With that patch in place a click opens a visible window, and there is
 * nothing left for this shell to do but keep the record.
 *
 * ## What the log is for
 *
 * "I clicked and nothing happened" is otherwise unreportable, so every attempt is
 * recorded with the route, the button, the HTTP status (or the transport error) and
 * how long it took. The host explains refusals in a response body that a
 * `webRequest` observer cannot read without re-issuing the request — and re-issuing
 * a launch is not an option — so a refused status is mapped to the reason here
 * instead, keeping that evidence in the log.
 *
 * The line format is built by {@link describeOpenAttempt}, a pure function, so it
 * can be unit-tested without an Electron process
 * (`scripts/test-open-diagnostics.mjs`).
 *
 * @module dsh-desktop/open-diagnostics
 */

/**
 * Routes behind the "open on the desktop" buttons, in the Web GUI's own terms.
 */
const OPEN_ROUTES = [
  { prefix: '/open-in-app/apps', kind: 'apps', label: '读取可打开的应用列表' },
  { prefix: '/open-in-app/icon', kind: 'icon', label: '读取应用图标' },
  { prefix: '/open-in-app/open', kind: 'open-in-app', label: '「在本地打开」' },
  { prefix: '/api/present.host', kind: 'present-host', label: '查询桌面可用性' },
  { prefix: '/api/present.open', kind: 'present-open', label: '打开交付文件' },
];

/**
 * Why the host refused, per status code, for the route that was called.
 *
 * Only used to keep the reason in the log; nothing is shown to the user.
 */
const REFUSALS = {
  'present-open': {
    400: '请求参数不合法（会话或文件坐标缺失）',
    404: '宿主在该会话的记录里找不到这个文件（会话可能已归档，或它不是本轮的交付项）',
    409: '此主机没有可用的桌面',
    422: '该文件没有可验证的本机路径',
    500: '宿主内部错误',
  },
  // The host distinguishes these two: 400 is "unknown or unavailable app", 404 is
  // "directory does not exist". Getting them the wrong way round tells the user to
  // reinstall an application when the real problem is a folder that moved.
  'open-in-app': {
    400: '宿主不认识这个应用，或它当前不可用（可能已被卸载）',
    404: '要打开的目录不存在（可能已被移动或删除）',
    409: '此主机没有可用的桌面',
    500: '启动应用失败',
  },
};

/**
 * Match a request URL to one of the watched routes.
 * @param url - the full request URL.
 * @returns `{ kind, label, action, path }` or `null` when the URL is unrelated.
 */
function matchOpenRoute(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const route = OPEN_ROUTES.find((candidate) => parsed.pathname === candidate.prefix || parsed.pathname.startsWith(`${candidate.prefix}/`));
  if (route === undefined) return null;
  // `action` distinguishes "用默认应用打开" from "打开所在文件夹".
  const action = parsed.searchParams.get('action') ?? 'open';
  return { kind: route.kind, label: route.label, action, path: parsed.pathname };
}

/**
 * One line naming the concrete action, so a log entry says which button was
 * involved rather than which URL.
 * @param attempt - a watched attempt, which normally carries the route `label`.
 * @returns a human-readable action name, never empty.
 */
function actionName(attempt) {
  if (attempt.kind === 'present-open') {
    return attempt.action === 'reveal' ? '「打开所在文件夹」' : '「用默认应用打开」';
  }
  if (typeof attempt.label === 'string' && attempt.label.length > 0) return attempt.label;
  return '「在本地打开」';
}

/**
 * Read the JSON body of a watched request.
 *
 * Electron hands request bodies to a `webRequest` observer as `uploadData`. The
 * target path only ever appears there, so this is what makes a log line name the
 * folder that was asked for.
 * @param uploadData - `details.uploadData`, absent for bodyless requests.
 * @returns the parsed body, or `null` when there is none or it is not JSON.
 */
function readUploadBody(uploadData) {
  if (!Array.isArray(uploadData)) return null;
  for (const part of uploadData) {
    if (part === null || part === undefined || part.bytes === undefined) continue;
    try {
      return JSON.parse(Buffer.from(part.bytes).toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Turn one finished attempt into the single log line that records it.
 *
 * Kept pure and exported so the wording is asserted by a test rather than
 * discovered in a log file after a user reports "the button did nothing".
 * @param attempt - `{ kind, action, method, status, error, elapsedMs, app, targetPath }`.
 * @returns one line, without a trailing newline.
 */
function describeOpenAttempt(attempt) {
  const name = actionName(attempt);
  const transportError = attempt.error !== undefined && attempt.error !== null;
  const outcome = transportError
    ? `failed: ${attempt.error}`
    : attempt.status === undefined
      ? 'no response'
      : String(attempt.status);
  const took = attempt.elapsedMs === undefined ? '' : `; ${String(attempt.elapsedMs)}ms`;

  // Name the outcome in words as well: a bare status code is not evidence a human
  // can read six months later.
  let verdict;
  if (transportError) verdict = '请求没有送达宿主';
  else if (attempt.status === undefined) verdict = '宿主没有响应';
  else if (attempt.status >= 400) {
    verdict = `宿主拒绝了这个请求（${REFUSALS[attempt.kind]?.[attempt.status] ?? '宿主没有说明原因'}）`;
  } else verdict = '宿主接受了请求';

  const app = typeof attempt.app === 'string' && attempt.app.length > 0 ? `; app=${attempt.app}` : '';
  const target = typeof attempt.targetPath === 'string' && attempt.targetPath.length > 0
    ? `; path=${attempt.targetPath}`
    : '';
  return `open ${attempt.kind} (${attempt.method}) -> ${outcome}${took}; ${verdict}; ${name}${app}${target}`;
}

/**
 * Watch the open routes and record every attempt.
 *
 * There is deliberately nothing to configure and nothing to report: the watch
 * cannot change what happened, so it does not try.
 *
 * @param options - `log` writes the shell log.
 * @returns the three `webRequest` listeners, plus `whenSettled()` for tests.
 */
function createOpenWatch({ log = () => {} } = {}) {
  const pending = new Map();

  function onBeforeRequest(details) {
    if (details.method !== 'GET' && details.method !== 'POST') return;
    const match = matchOpenRoute(details.url);
    if (match === null) return;
    const body = readUploadBody(details.uploadData);
    pending.set(details.id, {
      ...match,
      id: details.id,
      method: details.method,
      startedAt: Date.now(),
      targetPath: typeof body?.path === 'string' ? body.path : undefined,
      app: typeof body?.app === 'string' ? body.app : undefined,
    });
  }

  function onCompleted(details) {
    const attempt = pending.get(details.id);
    if (attempt === undefined) return;
    pending.delete(details.id);
    attempt.status = details.statusCode;
    attempt.elapsedMs = Date.now() - attempt.startedAt;
    log(describeOpenAttempt(attempt));
  }

  function onErrorOccurred(details) {
    const attempt = pending.get(details.id);
    if (attempt === undefined) return;
    pending.delete(details.id);
    attempt.error = details.error;
    attempt.elapsedMs = Date.now() - attempt.startedAt;
    log(describeOpenAttempt(attempt));
  }

  /** Resolves once nothing is in flight; kept for the tests' call sites. */
  const whenSettled = () => Promise.resolve();

  return { onBeforeRequest, onCompleted, onErrorOccurred, pending, whenSettled };
}

module.exports = {
  OPEN_ROUTES,
  REFUSALS,
  actionName,
  createOpenWatch,
  describeOpenAttempt,
  matchOpenRoute,
  readUploadBody,
};
