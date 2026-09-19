'use strict';
/**
 * Build the text of the shell's "About" dialog.
 *
 * Kept pure (no Electron, no filesystem) so the exact wording users see — the
 * real dsh home, the profile name and directory, and **this application's own
 * private state directory** — is asserted by `scripts/test-about.mjs` instead of
 * being taken on trust from a native dialog that automation cannot read.
 *
 * Reporting both locations matters: "数据位置" is not one place. The dsh home is
 * shared with the command line, while the shell's own state (window geometry,
 * logs, login cookies) is private and lives elsewhere. Showing only the first
 * made the dialog misleading to anyone trying to find or reset the second.
 *
 * @module dsh-desktop/about-text
 */

/** What the shell keeps in its private state directory. */
const SHELL_STATE_CONTENTS = '窗口位置与端口、日志、登录 cookie';

/**
 * The About dialog's buttons, paired with what each one does.
 *
 * Kept here rather than inline in the main process so the invariant that matters
 * stays testable: every directory the text names has a button that opens it.
 * `action` is `null` for the dismiss button; the rest are handled by the caller.
 */
const ABOUT_BUTTONS = [
  { label: '确定', action: null },
  { label: '打开 dsh 数据文件夹', action: 'open-dsh-home' },
  { label: '打开桌面端状态文件夹', action: 'open-shell-state' },
  { label: '复制路径', action: 'copy-paths' },
];

/** Split an unknown-or-value field so a missing value reads as a plain word. */
const orUnknown = (value) => value ?? 'unknown';

/**
 * Render the About dialog content.
 * @param options - `snapshot` from the main process status snapshot; `profileName` and `homeShared` describe the data location; `portable` says the data lives beside the executable.
 * @returns `{ type, message, detail }` ready for `dialog.showMessageBox`, plus `conflict` for callers.
 */
function buildAbout({ snapshot, profileName, homeShared, portable = false }) {
  const concurrency = snapshot?.concurrency ?? null;
  const conflict = Boolean(concurrency?.conflict);
  const shellStateDir = orUnknown(snapshot?.shellDataDir);

  const sourceLine = portable
    ? '安装目录内的副本 — 命令行 dsh 只有在 DSH_HOME 指向同一目录时才共享（安装器默认已代为设置该用户变量）'
    : homeShared
      ? '%USERPROFILE%\\.dsh（默认位置）— 命令行 dsh 读写的正是这一份'
      : '自定义 DSH_HOME — 仅当命令行也设置同一个 DSH_HOME 时才共享';

  const lines = [
    `dsh 版本：${orUnknown(snapshot?.dshVersion)}`,
    `内置 Node：${orUnknown(snapshot?.nodeVersion)}`,
    `Electron：${orUnknown(snapshot?.electronVersion)}（Chromium ${orUnknown(snapshot?.chromeVersion)}）`,
    `本地服务：${snapshot?.url ?? '未运行'}`,
    '',
    portable ? '数据位置（两处，都在本安装目录内）' : '数据位置（两处，见下）',
    ...(portable && snapshot?.dataRoot ? [`  数据根目录：${snapshot.dataRoot}`] : []),
    '',
    `  ① dsh 数据（${portable ? '安装目录内' : homeShared ? '与命令行 dsh 共享' : '自定义位置'}）`,
    `     DSH_HOME：${orUnknown(snapshot?.dshHome)}`,
    `     profile：${profileName}`,
    `     profile 目录：${orUnknown(snapshot?.profileDir)}`,
    `     来源：${sourceLine}`,
    '',
    '  ② 桌面端自身状态（本应用私有，命令行 dsh 不读取）',
    `     目录：${shellStateDir}`,
    `     含：${SHELL_STATE_CONTENTS}`,
    '',
    '① 里的会话、设置、凭据与插件与命令行 dsh 完全共享。',
    '② 只属于本应用：删掉它不影响任何会话，只丢失窗口位置与登录状态。',
    '会话的工作目录由 dsh 自身登记，桌面端不干预。',
  ];

  if (conflict) {
    lines.push(
      '',
      '⚠ 检测到另一个 dsh 可能正在使用同一数据：',
      ...(concurrency.detail ?? []).map((item) => `  · ${item}`),
      '  建议同一时间只开一个，否则插件补丁可能被对方实时重载。',
      '  （说明：进程命令行看不到对方的 DSH_HOME，所以只能提示“可能”。）',
    );
  } else if (concurrency && !concurrency.scanAvailable) {
    lines.push(
      '',
      `并发检测不完整（进程扫描不可用：${String(concurrency.scanError ?? '').trim() || '未知原因'}），端口指纹结果仍然有效。`,
    );
  } else if (concurrency) {
    lines.push('', '未检测到其它 dsh 正在使用同一 profile。');
  }

  return {
    conflict,
    type: conflict ? 'warning' : 'info',
    message: conflict
      ? 'DeepSeek Harness Desktop — 检测到另一个 dsh 可能正在使用同一数据'
      : 'DeepSeek Harness Desktop',
    detail: lines.join('\n'),
  };
}

/**
 * The lines the About dialog's "复制路径" button puts on the clipboard.
 *
 * Both locations are included so the text can be pasted straight into a bug
 * report or a file manager without retyping either path.
 *
 * @param options - `snapshot` from the status snapshot; `profileName` names the profile.
 * @returns the clipboard text.
 */
function aboutClipboardText({ snapshot, profileName }) {
  return [
    `DSH_HOME=${orUnknown(snapshot?.dshHome)}`,
    `profile=${profileName}`,
    `profile 目录=${orUnknown(snapshot?.profileDir)}`,
    `桌面端状态=${orUnknown(snapshot?.shellDataDir)}`,
  ].join('\r\n');
}

module.exports = { ABOUT_BUTTONS, SHELL_STATE_CONTENTS, aboutClipboardText, buildAbout };
