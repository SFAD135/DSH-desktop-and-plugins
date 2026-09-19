'use strict';
/**
 * The right-click menu.
 *
 * Electron deliberately ships **no** default context menu — a browser shows one,
 * an Electron window shows nothing unless the app builds it. This module decides
 * what that menu contains, as a pure function over the `context-menu` event
 * parameters, so the rules (what is enabled, what is offered for a link or an
 * image, what a blank area still provides) are unit-testable without a window.
 *
 * Items carrying a `role` are handled by Electron itself, which keeps native
 * behaviour (IME, clipboard, undo stack) intact; items carrying a `command` are
 * dispatched by the caller.
 *
 * @module dsh-desktop/context-menu
 */

/** Commands the caller must implement, each with the payload it receives. */
const COMMANDS = {
  copyLink: '复制链接地址',
  openLink: '在浏览器中打开链接',
  copyImage: '复制图片',
  saveImage: '图片另存为…',
  copyImageUrl: '复制图片地址',
  copyImagePath: '复制本地路径',
  copyImageMarkdown: '复制为 Markdown',
  reload: '刷新界面',
  copyPageUrl: '复制页面地址',
  openPageExternally: '在浏览器中打开本页',
  inspect: '检查元素',
};

const sep = () => ({ type: 'separator' });

/** Whether the URL can be handed to a system browser. */
function isBrowsable(url) {
  return typeof url === 'string' && /^https?:\/\//iu.test(url);
}

/**
 * Build the menu.
 *
 * @param params - the Electron `context-menu` event parameters, plus `devTools` to allow the inspector entry.
 * @returns `{ items }` — a flat list of `{ type }`, `{ role, ... }` or `{ command, payload, ... }` descriptors.
 */
function buildContextMenu(params = {}) {
  const {
    isEditable = false,
    editFlags = {},
    selectionText = '',
    linkURL = '',
    mediaType = 'none',
    srcURL = '',
    pageURL = '',
    x = 0,
    y = 0,
    devTools = false,
    imageDurable = true,
    imageShareable = true,
    imageFileBacked = true,
  } = params;

  const items = [];
  const push = (item) => items.push(item);
  const hasSelection = typeof selectionText === 'string' && selectionText.trim().length > 0;

  // ── editing ───────────────────────────────────────────────────────────────
  if (isEditable) {
    push({ role: 'undo', label: '撤销', accelerator: 'CmdOrCtrl+Z', enabled: editFlags.canUndo !== false });
    push({ role: 'redo', label: '重做', accelerator: 'CmdOrCtrl+Y', enabled: editFlags.canRedo !== false });
    push(sep());
    push({ role: 'cut', label: '剪切', accelerator: 'CmdOrCtrl+X', enabled: editFlags.canCut !== false });
    push({ role: 'copy', label: '复制', accelerator: 'CmdOrCtrl+C', enabled: editFlags.canCopy !== false });
    push({ role: 'paste', label: '粘贴', accelerator: 'CmdOrCtrl+V', enabled: editFlags.canPaste !== false });
    push({ role: 'delete', label: '删除', enabled: editFlags.canDelete !== false });
    push(sep());
    push({ role: 'selectAll', label: '全选', accelerator: 'CmdOrCtrl+A', enabled: editFlags.canSelectAll !== false });
  } else if (hasSelection) {
    push({ role: 'copy', label: '复制', accelerator: 'CmdOrCtrl+C' });
    push(sep());
    push({ role: 'selectAll', label: '全选', accelerator: 'CmdOrCtrl+A' });
  }

  // ── links ─────────────────────────────────────────────────────────────────
  if (isBrowsable(linkURL)) {
    if (items.length > 0) push(sep());
    push({ command: 'openLink', label: COMMANDS.openLink, payload: { url: linkURL } });
    push({ command: 'copyLink', label: COMMANDS.copyLink, payload: { text: linkURL } });
  }

  // ── images ────────────────────────────────────────────────────────────────
  // Three separate questions, because they have genuinely different answers:
  //   `imageShareable`  — is the URL an address worth putting on the clipboard?
  //                       (false for `blob:`/`data:`, true for a remote image)
  //   `imageFileBacked` — is there a file on this machine to name or drag out?
  //                       (false for a remote image, even though it is durable)
  //   `imageDurable`    — can it be referenced again later, e.g. in markdown?
  // Entries are disabled rather than offered and then failing silently.
  if (mediaType === 'image' && srcURL) {
    if (items.length > 0) push(sep());
    push({ command: 'copyImage', label: COMMANDS.copyImage, payload: { url: srcURL } });
    push({ command: 'saveImage', label: COMMANDS.saveImage, payload: { url: srcURL } });
    push(sep());
    push({
      command: 'copyImageUrl',
      label: COMMANDS.copyImageUrl,
      payload: { text: srcURL },
      enabled: imageShareable,
    });
    push({
      command: 'copyImagePath',
      label: COMMANDS.copyImagePath,
      payload: { url: srcURL },
      enabled: imageFileBacked,
    });
    push({
      command: 'copyImageMarkdown',
      label: COMMANDS.copyImageMarkdown,
      payload: { url: srcURL },
      enabled: imageDurable,
    });
  }

  // ── always available ──────────────────────────────────────────────────────
  // A right-click on empty space must still do something, otherwise the window
  // feels broken — which is exactly what an absent handler felt like.
  if (items.length > 0) push(sep());
  push({ command: 'reload', label: COMMANDS.reload, accelerator: 'F5' });
  if (isBrowsable(pageURL)) {
    push({ command: 'copyPageUrl', label: COMMANDS.copyPageUrl, payload: { text: pageURL } });
    push({ command: 'openPageExternally', label: COMMANDS.openPageExternally, payload: { url: pageURL } });
  }
  if (devTools) {
    push(sep());
    push({ command: 'inspect', label: COMMANDS.inspect, payload: { x, y } });
  }

  return { items: normalize(items) };
}

/**
 * Drop separators that lead, trail or sit next to another separator.
 *
 * Composition above adds separators optimistically between groups; this makes
 * the result correct regardless of which groups ended up empty, which is easier
 * to reason about than guarding every call site.
 */
function normalize(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue;
      out.push(item);
      continue;
    }
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

module.exports = { COMMANDS, buildContextMenu, isBrowsable };
