'use strict';
/**
 * First-run import of an existing dsh home.
 *
 * When the shell keeps its data beside the executable (see `data-root.js`), the
 * dsh home it uses is *not* the one a command-line `dsh` uses, so an existing
 * installation would appear to have lost all of its sessions. This module
 * decides whether to offer an import and performs it as a **copy**, never a
 * move: the original stays usable by the command line, and a failed copy cannot
 * destroy anything.
 *
 * The decision is a pure function so it can be tested without a filesystem
 * (`scripts/test-migrate.mjs`); only {@link copyHome} touches disk.
 *
 * @module dsh-desktop/migrate
 */
const fs = require('node:fs');
const path = require('node:path');

/** Written into the target home once the import has been offered, so it is asked at most once. */
const MARKER_FILE_NAME = 'imported-from.json';

/** Entries worth reporting in the prompt, with the label shown to the user. */
const HIGHLIGHTS = [
  ['sessions', '会话'],
  ['profiles', 'profile 与插件'],
  ['settings.yaml', '设置'],
  ['.credentials.yaml', '凭据'],
  ['storages', '工作区登记'],
  ['attachments', '附件'],
];

/**
 * Decide whether to offer an import.
 *
 * The offer is made only when all of these hold: portable data is in use, the
 * target home has no marker (never asked before), the target home does not
 * already hold sessions, and a different source home exists with something in
 * it. Any of these failing means "stay quiet", which keeps the prompt from
 * appearing on every launch or on a machine where there is nothing to import.
 *
 * @param options - `sourceHome` is the existing home to import from; `targetHome` is the home this shell will use; `sourceHomeIsTarget` guards against offering to import a directory into itself; `exists`/`list` are filesystem probes.
 * @returns `{ offer, reason, highlights, sourceHome, targetHome }`; `highlights` lists the found entries as `{ entry, label }`.
 */
function planMigration({
  sourceHome,
  targetHome,
  sourceHomeIsTarget = false,
  exists = (target) => fs.existsSync(target),
  list = (target) => (fs.existsSync(target) ? fs.readdirSync(target) : []),
} = {}) {
  const nothing = (reason) => ({ offer: false, reason, highlights: [], sourceHome, targetHome });

  if (!sourceHome || !targetHome) return nothing('no home to compare');
  if (sourceHomeIsTarget) return nothing('source and target are the same directory');
  if (exists(path.join(targetHome, MARKER_FILE_NAME))) return nothing('already offered on an earlier launch');
  if (list(path.join(targetHome, 'sessions')).length > 0) return nothing('the target home already has sessions');
  if (!exists(sourceHome)) return nothing('no existing home was found');

  const present = new Set(list(sourceHome));
  const highlights = HIGHLIGHTS.filter(([entry]) => present.has(entry)).map(([entry, label]) => ({ entry, label }));
  if (highlights.length === 0) return nothing('the existing home has nothing worth importing');

  return { offer: true, reason: 'an existing home with data was found', highlights, sourceHome, targetHome };
}

/**
 * The message shown before an import.
 * @param plan - a plan from {@link planMigration}.
 * @returns `{ message, detail }` for `dialog.showMessageBox`.
 */
function migrationPrompt(plan) {
  const found = plan.highlights.map((item) => item.label).join('、');
  return {
    message: '检测到已有 dsh 数据，是否导入？',
    detail: [
      `来源：${plan.sourceHome}`,
      `目标：${plan.targetHome}`,
      '',
      `其中包含：${found}`,
      '',
      '选择“导入”会把这些数据复制一份到本安装目录，原位置保持不变，',
      '命令行 dsh 仍然可以继续使用它。复制完成后本次启动会使用导入的数据。',
      '',
      '选择“不导入”则本次安装从空数据开始（之后不再询问）。',
    ].join('\n'),
  };
}

/**
 * Copy an existing home into the target, then record that the offer was made.
 *
 * `fs.cpSync` is used with `force: false` for files so an existing target entry
 * is never silently replaced; the walk is recursive because a home contains
 * nested profile and plugin trees.
 *
 * @param plan - a plan from {@link planMigration}.
 * @param options - `onProgress` receives `{ copied }`; `now` stamps the marker.
 * @returns `{ copied, skipped, marker }`.
 */
function copyHome(plan, { onProgress, now = () => new Date().toISOString() } = {}) {
  const { sourceHome, targetHome } = plan;
  let copied = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        walk(src, dst);
        continue;
      }
      if (entry.isFile()) {
        if (fs.existsSync(dst)) continue;
        fs.copyFileSync(src, dst);
        copied += 1;
        if (onProgress) onProgress({ copied });
      }
      // Symlinks and other special entries are deliberately not reproduced.
    }
  };
  walk(sourceHome, targetHome);

  fs.mkdirSync(targetHome, { recursive: true });
  const marker = path.join(targetHome, MARKER_FILE_NAME);
  fs.writeFileSync(
    marker,
    `${JSON.stringify({ importedFrom: sourceHome, importedAt: now(), copied }, null, 2)}\n`,
  );
  return { copied, marker };
}

/** Record that the user declined, so the offer is not repeated. */
function declineImport(plan, { now = () => new Date().toISOString() } = {}) {
  fs.mkdirSync(plan.targetHome, { recursive: true });
  const marker = path.join(plan.targetHome, MARKER_FILE_NAME);
  fs.writeFileSync(marker, `${JSON.stringify({ importedFrom: null, declinedAt: now() }, null, 2)}\n`);
  return marker;
}

module.exports = { HIGHLIGHTS, MARKER_FILE_NAME, copyHome, declineImport, migrationPrompt, planMigration };
