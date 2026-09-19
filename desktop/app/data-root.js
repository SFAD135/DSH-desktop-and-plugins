'use strict';
/**
 * Decide where this shell keeps its data.
 *
 * Three inputs, in descending precedence:
 *
 *   1. `$DSH_DESKTOP_DATA` — an explicit override, used by tests and by anyone
 *      who wants to relocate the data without reinstalling.
 *   2. `<install dir>\data` — the layout the installer creates. Its presence is
 *      the "portable / one folder holds everything" switch, so the very same
 *      binary behaves as a normal app or as a self-contained one depending only
 *      on whether that directory exists next to the executable.
 *   3. neither — the historical behaviour: shell state under
 *      `%APPDATA%\DeepSeek Harness`, dsh data under `~/.dsh` (shared with the
 *      command line).
 *
 * The module is pure: the filesystem is injected, so the precedence rules are
 * unit-testable without an Electron process (`scripts/test-data-root.mjs`).
 *
 * @module dsh-desktop/data-root
 */
const path = require('node:path');

/** Environment variable that relocates the whole data root. */
const DATA_ROOT_ENV = 'DSH_DESKTOP_DATA';
/** Directory name created next to the executable by the installer. */
const DATA_DIR_NAME = 'data';
/** Subdirectory holding Electron's user data (settings, logs, Chromium profile). */
const SHELL_DIR_NAME = 'shell';
/** Subdirectory holding the dsh home (sessions, plugins, credentials). */
const DSH_HOME_DIR_NAME = 'dsh-home';
/** File written by the installer, so the shell can explain the layout. */
const MARKER_FILE_NAME = 'portable.json';

/**
 * Resolve the data root.
 * @param options - `env` for the override; `exeDir` is the directory holding the running executable; `isDirectory` probes the filesystem and defaults to `fs.statSync(...).isDirectory()`.
 * @returns `{ root, source }` — `root` is an absolute path, or `null` when the shell should use the historical defaults.
 */
function resolveDataRoot({ env = process.env, exeDir, isDirectory } = {}) {
  const probe = isDirectory ?? defaultIsDirectory;

  const override = typeof env[DATA_ROOT_ENV] === 'string' ? env[DATA_ROOT_ENV].trim() : '';
  if (override.length > 0) return { root: path.resolve(override), source: 'env' };

  if (typeof exeDir === 'string' && exeDir.length > 0) {
    const beside = path.join(exeDir, DATA_DIR_NAME);
    if (probe(beside)) return { root: beside, source: 'portable' };
  }

  return { root: null, source: 'default' };
}

function defaultIsDirectory(target) {
  try {
    // Required lazily so this module stays usable (and testable) anywhere.
    return require('node:fs').statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Electron user-data directory for a resolved data root (`null` = leave Electron's default). */
function shellDataDir(root) {
  return root === null || root === undefined ? null : path.join(root, SHELL_DIR_NAME);
}

/** The dsh home for a resolved data root (`null` = fall back to `~/.dsh`). */
function dshHomeDir(root) {
  return root === null || root === undefined ? null : path.join(root, DSH_HOME_DIR_NAME);
}

/**
 * Whether the shell data directory is already in use, which is how the shell
 * tells "this installed copy has run before" from "first run".
 * @param root - a resolved data root.
 * @param exists - filesystem probe.
 */
function isFirstRun(root, exists = (target) => require('node:fs').existsSync(target)) {
  const shell = shellDataDir(root);
  if (shell === null) return false;
  return !exists(path.join(shell, 'shell-settings.json'));
}

module.exports = {
  DATA_DIR_NAME,
  DATA_ROOT_ENV,
  DSH_HOME_DIR_NAME,
  MARKER_FILE_NAME,
  SHELL_DIR_NAME,
  dshHomeDir,
  isFirstRun,
  resolveDataRoot,
  shellDataDir,
};
