'use strict';
/**
 * Preload for the shell window.
 *
 * Two responsibilities, deliberately separated:
 *
 * 1. The shell bridge is exposed ONLY to `file://` documents (loading.html /
 *    error.html). The Web GUI served by the local dsh service never receives it,
 *    and the main process independently rejects IPC that does not originate from
 *    a file:// frame — so a served page cannot drive the shell.
 *
 * 2. Dragging an image out of the window. Chromium does not export a dragged
 *    image to the operating system on its own; the renderer must prevent the
 *    default drag and ask the main process to start a file drag. This needs a
 *    listener on the served page, so it is kept strictly one-way: the page can
 *    only report "an image at this URL is being dragged", never run a command.
 */
const { contextBridge, ipcRenderer } = require('electron');
const { hostPathForImageUrl } = require('./image-actions');

try {
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('dshShell', {
      status: () => ipcRenderer.invoke('dsh:status'),
      action: (name) => ipcRenderer.invoke('dsh:action', name),
      onStatus: (callback) => {
        const listener = (_event, snapshot) => callback(snapshot);
        ipcRenderer.on('dsh:status', listener);
        return () => ipcRenderer.removeListener('dsh:status', listener);
      },
    });
  }

  // Test-only hook: never exposed in a normal run, because the main process only
  // registers the matching handler when DSH_DESKTOP_TEST_HOOK=1. It exists so the
  // image byte pipeline can be exercised end-to-end (the native context menu
  // cannot be clicked from an automated test).
  if (process.env.DSH_DESKTOP_TEST_HOOK === '1') {
    contextBridge.exposeInMainWorld('dshTest', {
      imageCommand: (command, payload) => ipcRenderer.invoke('dsh:test-image', { command, payload }),
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener(
      'dragstart',
      (event) => {
        const target = event.target;
        const element = target && target.closest ? target.closest('img') : null;
        if (!element) return;
        // Only URLs that resolve to a file on disk can be dragged out. `blob:` and
        // `data:` images have no file behind them, so they are left to Chromium's
        // own behaviour rather than starting a drag that would do nothing. The
        // same rule the main process applies is reused here instead of restated.
        const source = element.currentSrc || element.src;
        if (hostPathForImageUrl(source) === null) return;
        event.preventDefault();
        ipcRenderer.send('dsh:drag-image', { url: source });
      },
      true,
    );
  }
} catch {
  /* never break the hosted page */
}
