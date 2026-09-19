#!/usr/bin/env node
/**
 * Unit tests for the right-click menu (`app/context-menu.js`).
 *
 * The regression this exists for: Electron shows no context menu by default, so
 * an unimplemented handler makes the right button do nothing at all — including
 * "copy" on a selected passage. The tests therefore pin down that a selection
 * always yields an enabled copy, and that a right-click on blank space still
 * offers something.
 *
 *   node scripts/test-context-menu.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { COMMANDS, buildContextMenu, isBrowsable } = require(path.join(ROOT, 'app', 'context-menu.js'));
const { isDurableImageUrl, isFileBackedImageUrl, isShareableImageUrl } = require(path.join(ROOT, 'app', 'image-actions.js'));

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

/** Find the item whose label or role matches. */
const find = (items, key) => items.find((item) => item.role === key || item.command === key);
const roles = (items) => items.filter((item) => item.role).map((item) => item.role);
const commands = (items) => items.filter((item) => item.command).map((item) => item.command);
/** Separators must never lead, trail or repeat — the menu would render oddly. */
const separatorsAreSane = (items) =>
  items.every((item, index) => {
    if (item.type !== 'separator') return true;
    if (index === 0 || index === items.length - 1) return false;
    return items[index - 1].type !== 'separator';
  });

const GUI = 'http://127.0.0.1:54437/';
const SHELL = 'file:///D:/app/loading.html';

// ── the reported bug: copy on a selection ───────────────────────────────────
const selection = buildContextMenu({ selectionText: '这是我想复制的一段话', pageURL: GUI });
const copy = find(selection.items, 'copy');
check('a text selection offers copy', Boolean(copy));
check('copy is enabled for a selection', copy?.enabled !== false);
check('copy shows its shortcut', copy?.accelerator === 'CmdOrCtrl+C');
check('a selection also offers select-all', roles(selection.items).includes('selectAll'));
check('a read-only selection is not offered editing roles', !roles(selection.items).includes('paste'));

const blank = buildContextMenu({ pageURL: GUI });
check('right-clicking blank space still offers the reload entry', commands(blank.items).includes('reload'));
check('blank space offers no copy', !roles(blank.items).includes('copy'));
check('the menu is never empty', blank.items.length > 0);

// ── editable fields ─────────────────────────────────────────────────────────
const editable = buildContextMenu({
  isEditable: true,
  selectionText: '',
  editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true },
  pageURL: GUI,
});
check('editable fields get the editing roles', ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'].every((role) => roles(editable.items).includes(role)));
check('every editing item is labelled', editable.items.filter((i) => i.role).every((i) => typeof i.label === 'string' && i.label.length > 0));
check('a disabled edit flag disables its item', find(editable.items, 'redo')?.enabled === false);
check('an enabled edit flag leaves the item enabled', find(editable.items, 'undo')?.enabled !== false);
check('missing edit flags default to enabled', find(buildContextMenu({ isEditable: true }).items, 'paste')?.enabled !== false);

// ── links ───────────────────────────────────────────────────────────────────
const link = buildContextMenu({ linkURL: 'https://example.com/docs', selectionText: '', pageURL: GUI });
check('a link offers open in browser', commands(link.items).includes('openLink'));
check('a link offers copy-address', commands(link.items).includes('copyLink'));
check('the link address travels with the command', find(link.items, 'copyLink')?.payload?.text === 'https://example.com/docs');
check('a non-http link is not treated as a link', !isBrowsable('javascript:alert(1)') && !isBrowsable('') && isBrowsable('http://x/'));

// ── images ──────────────────────────────────────────────────────────────────
const image = buildContextMenu({ mediaType: 'image', srcURL: 'http://127.0.0.1:1/a.png', pageURL: GUI });
check('an image offers copy and save', ['copyImage', 'saveImage', 'copyImageUrl'].every((c) => commands(image.items).includes(c)));
check('image commands carry the source url', find(image.items, 'copyImageUrl')?.payload?.text === 'http://127.0.0.1:1/a.png');
check('a non-image media type offers no image actions', commands(buildContextMenu({ mediaType: 'video', srcURL: 'x' }).items).every((c) => !c.startsWith('copyImage') && c !== 'saveImage'));

// Referencing an image is only honest when the URL still means something later.
// A `blob:` image has no durable address, so those two entries must be disabled
// rather than offered and then producing a dead link.
check('a durable image offers the path and markdown entries', ['copyImagePath', 'copyImageMarkdown'].every((c) => commands(image.items).includes(c)));
check('the path/markdown entries are enabled for a durable image', find(image.items, 'copyImagePath')?.enabled !== false && find(image.items, 'copyImageMarkdown')?.enabled !== false);
// The flags come from the real predicates, exactly as the context-menu listener
// derives them, so this cannot drift from what the app actually passes.
const imageMenu = (url) =>
  buildContextMenu({
    mediaType: 'image',
    srcURL: url,
    pageURL: GUI,
    imageDurable: isDurableImageUrl(url),
    imageShareable: isShareableImageUrl(url),
    imageFileBacked: isFileBackedImageUrl(url),
  });
const transient = imageMenu('blob:http://127.0.0.1:1/abc');
check('a blob image still offers copy and save', ['copyImage', 'saveImage'].every((c) => commands(transient.items).includes(c)));
check('a blob image disables the path entry', find(transient.items, 'copyImagePath')?.enabled === false);
check('a blob image disables the markdown entry', find(transient.items, 'copyImageMarkdown')?.enabled === false);
// A blob URL is scoped to the document that made it, so copying it as an
// "address" would put something useless on the clipboard.
check('a blob image disables the address entry', find(transient.items, 'copyImageUrl')?.enabled === false);
const remote = imageMenu('https://example.com/photo.png');
check('a remote image keeps the address entry enabled', find(remote.items, 'copyImageUrl')?.enabled !== false);
// A remote image is durable but has no file here: naming its "local path" would
// offer an entry that always fails when clicked.
check('a remote image disables the local path entry', find(remote.items, 'copyImagePath')?.enabled === false);
check('a remote image can still be referenced by markdown', find(remote.items, 'copyImageMarkdown')?.enabled !== false);
const dataUrl = imageMenu('data:image/png;base64,iVBORw0KGgo=');
check('a data url disables the address entry', find(dataUrl.items, 'copyImageUrl')?.enabled === false);
check('a data url disables the local path entry', find(dataUrl.items, 'copyImagePath')?.enabled === false);
const hostImage = imageMenu('http://127.0.0.1:1/api/file?path=D%3A%5Ca.png');
check('a file-backed image enables all three', ['copyImageUrl', 'copyImagePath', 'copyImageMarkdown'].every((c) => find(hostImage.items, c)?.enabled !== false));
check('the path entry carries the url rather than a pre-resolved path', typeof find(image.items, 'copyImagePath')?.payload?.url === 'string');

// ── page-level entries ──────────────────────────────────────────────────────
check('a served page can be opened in a real browser', commands(blank.items).includes('openPageExternally'));
check('a served page offers its address', commands(blank.items).includes('copyPageUrl'));
check('a local shell page is not offered for the browser', !commands(buildContextMenu({ pageURL: SHELL }).items).includes('openPageExternally'));
check('the inspector is hidden unless enabled', !commands(buildContextMenu({ pageURL: GUI }).items).includes('inspect'));
check('the inspector appears when enabled', commands(buildContextMenu({ pageURL: GUI, devTools: true }).items).includes('inspect'));
check('the inspector carries the click position', find(buildContextMenu({ pageURL: GUI, devTools: true, x: 12, y: 34 }).items, 'inspect')?.payload?.x === 12);

// ── structure ───────────────────────────────────────────────────────────────
for (const [name, menu] of [['blank', blank], ['selection', selection], ['editable', editable], ['link', link], ['image', image]]) {
  check(`${name}: separators are well formed`, separatorsAreSane(menu.items));
}
check('every command has a label', Object.values(COMMANDS).every((label) => label.length > 0));
check('every offered command is implemented by name', (() => {
  const known = new Set(['copyLink', 'openLink', 'copyImage', 'saveImage', 'copyImageUrl', 'copyImagePath', 'copyImageMarkdown', 'reload', 'copyPageUrl', 'openPageExternally', 'inspect']);
  return [...commands(selection.items), ...commands(image.items), ...commands(blank.items)].every((c) => known.has(c));
})());
// The reverse direction: a declared command that no menu ever offers is dead
// weight — it makes the feature list look bigger than what actually exists
// (a stray `forceReload` entry was doing exactly that).
const reachable = new Set(
  [
    buildContextMenu({ isEditable: true, pageURL: GUI }),
    buildContextMenu({ selectionText: 'x', pageURL: GUI }),
    buildContextMenu({ linkURL: 'https://example.com/', pageURL: GUI }),
    buildContextMenu({ mediaType: 'image', srcURL: 'http://127.0.0.1:1/a.png', pageURL: GUI }),
    buildContextMenu({ pageURL: GUI }),
    buildContextMenu({ pageURL: GUI, devTools: true }),
  ].flatMap((menu) => commands(menu.items)),
);
check(
  'no declared command is unreachable',
  Object.keys(COMMANDS).every((name) => reachable.has(name)),
  `unreachable: ${Object.keys(COMMANDS).filter((name) => !reachable.has(name)).join(',') || 'none'}`,
);
check('reload is always offered, so blank space is never a dead end', commands(buildContextMenu({}).items).includes('reload'));

// A hardcoded total once drifted from the real count elsewhere in this suite;
// count what actually ran and fail if that number changes, so a silently
// deleted check cannot hide behind a stale summary line.
const EXPECTED_CHECKS = 48;
const ranBeforeAudit = ran;
check('the suite still runs every check', ranBeforeAudit === EXPECTED_CHECKS, `ran ${String(ranBeforeAudit)}, expected ${String(EXPECTED_CHECKS)}`);

const total = ran;
console.log(`\n${failed === 0 ? total : total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
