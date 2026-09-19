#!/usr/bin/env node
/**
 * Assert the content of the shell's "About" dialog.
 *
 * The dialog is native, so it cannot be read by the GUI probe. Building its
 * text through a pure module (app/about-text.js) keeps the promise "About shows
 * the real home and the profile path, labelled as shared with the CLI"
 * verifiable. Run with:
 *   node scripts/test-about.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { ABOUT_BUTTONS, aboutClipboardText, buildAbout } = require(path.join(ROOT, 'app', 'about-text.js'));

const SNAPSHOT = {
  dshVersion: '0.1.5-rc.2',
  nodeVersion: 'v24.21.0',
  electronVersion: '44.4.2',
  chromeVersion: '140.0.0.0',
  url: 'http://127.0.0.1:54437/',
  dshHome: 'C:\\Users\\someone\\.dsh',
  profileDir: 'C:\\Users\\someone\\.dsh\\profiles\\web',
  shellDataDir: 'C:\\Users\\someone\\AppData\\Roaming\\DeepSeek Harness',
  concurrency: null,
};

const shared = buildAbout({ snapshot: SNAPSHOT, profileName: 'web', homeShared: true });
const custom = buildAbout({
  snapshot: { ...SNAPSHOT, dshHome: 'D:\\other-home', profileDir: 'D:\\other-home\\profiles\\web' },
  profileName: 'web',
  homeShared: false,
});
const installed = buildAbout({
  snapshot: {
    ...SNAPSHOT,
    dshHome: 'D:\\Apps\\DeepSeek Harness\\data\\dsh-home',
    profileDir: 'D:\\Apps\\DeepSeek Harness\\data\\dsh-home\\profiles\\web',
    dataRoot: 'D:\\Apps\\DeepSeek Harness\\data',
    shellDataDir: 'D:\\Apps\\DeepSeek Harness\\data\\shell',
  },
  profileName: 'web',
  homeShared: false,
  portable: true,
});
const conflicting = buildAbout({
  snapshot: {
    ...SNAPSHOT,
    concurrency: {
      conflict: true,
      detail: ['进程 pid=4242 正在运行 profile「web」', '端口 3080 上有一个 dsh host（auth challenge）'],
      scanAvailable: true,
      scanError: null,
    },
  },
  profileName: 'web',
  homeShared: true,
});
const degraded = buildAbout({
  snapshot: { ...SNAPSHOT, concurrency: { conflict: false, detail: [], scanAvailable: false, scanError: '拒绝访问' } },
  profileName: 'web',
  homeShared: true,
});
const clear = buildAbout({
  snapshot: { ...SNAPSHOT, concurrency: { conflict: false, detail: [], scanAvailable: true, scanError: null } },
  profileName: 'web',
  homeShared: true,
});

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};
const has = (haystack, needle) => haystack.includes(needle);

// The three things About must show, plus the provenance labels.
check('shows the real DSH_HOME path', has(shared.detail, 'C:\\Users\\someone\\.dsh'));
check('shows the profile name', has(shared.detail, 'profile：web'));
check('shows the profile directory', has(shared.detail, 'C:\\Users\\someone\\.dsh\\profiles\\web'));
check('labels the dsh data as shared with the CLI', has(shared.detail, '① dsh 数据（与命令行 dsh 共享）'));
check('states the data provenance', has(shared.detail, '%USERPROFILE%\\.dsh'));
check('keeps version/service facts', has(shared.detail, 'dsh 版本：0.1.5-rc.2') && has(shared.detail, 'Electron：44.4.2'));
check('is an info box when nothing conflicts', shared.type === 'info' && !shared.conflict);
// The retired `workspace` knob must not creep back into the dialog.
check('does not advertise a shell workspace setting', !has(shared.detail, '工作区：') && has(shared.detail, '工作目录由 dsh 自身登记'));

// The shell's own state is a second, private location — not the shared home.
check('shows the shell state directory', has(shared.detail, 'C:\\Users\\someone\\AppData\\Roaming\\DeepSeek Harness'));
check('separates the shell state from the dsh data', has(shared.detail, '① dsh 数据') && has(shared.detail, '② 桌面端自身状态'));
check('says the shell state is private to this app', has(shared.detail, '本应用私有，命令行 dsh 不读取'));
check('lists what the shell state holds', has(shared.detail, '窗口位置与端口、日志、登录 cookie'));
check('says the shell state is safe to delete', has(shared.detail, '删掉它不影响任何会话'));
// A private location must never be described as shared.
check('does not call the shell state shared', !/②[^\n]*共享/u.test(shared.detail));

// A custom home must NOT claim to be the shared default.
check('custom home is labelled custom', has(custom.detail, '自定义') && !has(custom.detail, '默认位置'));
check('custom home warns it is only shared on demand', has(custom.detail, '仅当命令行也设置同一个 DSH_HOME 时才共享'));
check('custom home still reports the private shell state', has(custom.detail, 'C:\\Users\\someone\\AppData\\Roaming\\DeepSeek Harness'));

// An installed copy keeps both locations beside the executable.
check('installed layout says both locations are inside the install directory', has(installed.detail, '数据位置（两处，都在本安装目录内）'));
check('installed layout shows the data root and shell state', has(installed.detail, 'D:\\Apps\\DeepSeek Harness\\data') && has(installed.detail, 'data\\shell'));
check('installed layout labels the dsh data as inside the install directory', has(installed.detail, '① dsh 数据（安装目录内）'));
check('installed layout explains how the CLI still shares it', has(installed.detail, 'DSH_HOME 指向同一目录'));
check('installed layout does not claim to be the shared default', !has(installed.detail, '默认位置'));

// Conflict reporting.
check('conflict flips the box to a warning', conflicting.type === 'warning' && conflicting.conflict);
check('conflict message names the other host', has(conflicting.message, '检测到另一个 dsh'));
check('conflict lists the evidence', has(conflicting.detail, 'pid=4242') && has(conflicting.detail, '端口 3080'));

// Honest degradation when only one signal works.
check('degraded scan is disclosed', has(degraded.detail, '进程扫描不可用：拒绝访问') && degraded.type === 'info');
check('clear verdict is stated', has(clear.detail, '未检测到其它 dsh'));

// Clipboard payload.
const clip = aboutClipboardText({ snapshot: SNAPSHOT, profileName: 'web' });
check('clipboard carries home, profile and dir', has(clip, 'DSH_HOME=C:\\Users\\someone\\.dsh') && has(clip, 'profile=web') && has(clip, 'profiles\\web'));
check('clipboard carries the shell state directory', has(clip, '桌面端状态=C:\\Users\\someone\\AppData\\Roaming\\DeepSeek Harness'));
check('clipboard omits the retired workspace line', !clip.includes('工作区='));

// Buttons must cover every location the text names — "here is a path you can
// never reach" is a half-answer, and magic response indices are easy to break.
const actions = ABOUT_BUTTONS.map((button) => button.action).filter(Boolean);
check('every button has a label', ABOUT_BUTTONS.every((button) => typeof button.label === 'string' && button.label.length > 0));
check('the first button is the default dismiss', ABOUT_BUTTONS[0].action === null);
check('a button opens the dsh data', actions.includes('open-dsh-home'));
check('a button opens the shell state', actions.includes('open-shell-state'));
check('a button copies the paths', actions.includes('copy-paths'));
check('the two directories get one button each', actions.filter((action) => action.startsWith('open-')).length === 2);
check('button actions are unique', new Set(actions).size === actions.length);
// The two "open" buttons must name the directory they open, not just say "open".
check('the open buttons name their directory', has(ABOUT_BUTTONS[1].label, 'dsh') && has(ABOUT_BUTTONS[2].label, '桌面端'));
check('no About button mentions the retired workspace knob', !ABOUT_BUTTONS.some((button) => has(button.label, '工作区')));

// The dialog is native, so its buttons cannot be clicked from a test. What can
// be checked is the wiring that makes a button do something: a button whose
// action the main process never handles is the same silent no-op the right-click
// menu was reported for. Asserted against the source, deliberately.
const mainSource = readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
const handled = new Set([...mainSource.matchAll(/case '([a-z-]+)':/gu)].map((match) => match[1]));
check('the dialog is built with the declared buttons', mainSource.includes('ABOUT_BUTTONS.map'));
check('every non-dismiss button is handled by the main process', actions.every((action) => handled.has(action)), `handled: ${[...handled].join(',')}`);
check('no button action is left dangling', actions.length > 0 && actions.every((action) => mainSource.includes(`'${action}'`)));
// The paths on the clipboard must match what the dialog showed.
check('the copy button writes the clipboard text', handled.has('copy-paths') && mainSource.includes('aboutClipboardText'));

// A hardcoded total once drifted from the real count and printed "26/26" while
// thirty checks ran. Count what actually ran, and fail loudly if the number
// changes — that is how a silently deleted check gets noticed. This audit must
// stay last, or it counts a partial run.
const EXPECTED_CHECKS = 43;
const ranBeforeAudit = ran;
check('the suite still runs every check', ranBeforeAudit === EXPECTED_CHECKS, `ran ${String(ranBeforeAudit)}, expected ${String(EXPECTED_CHECKS)}`);

const total = ran;
console.log(`\n${failed === 0 ? total : total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
