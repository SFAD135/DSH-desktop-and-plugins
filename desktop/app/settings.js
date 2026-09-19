'use strict';
/**
 * Shell settings: which keys are persisted, which may be overridden by the
 * environment, and which retired keys are dropped on load.
 *
 * Kept free of Electron and of the filesystem so the rules that are easy to get
 * wrong — an environment override leaking into the saved file, a removed key
 * lingering forever, an unknown key surviving a rewrite — are unit-testable
 * (`scripts/test-settings.mjs`).
 *
 * NOTE: there is deliberately no `workspace` setting. A session's working
 * directory is decided by dsh itself — it is recorded in each session's header
 * and registered in `$DSH_HOME/storages/workspace.json` — and `dsh web` exposes
 * no workspace option at all, so a shell-side setting could not influence which
 * directory work happens in.
 *
 * @module dsh-desktop/settings
 */
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
/** The default harness home, and therefore the one shared with a bare `dsh`. */
const DEFAULT_DSH_HOME = path.join(HOME, '.dsh');

const DEFAULT_SETTINGS = {
  port: 0,
  dshHome: DEFAULT_DSH_HOME,
  autoRestart: true,
  closeToTray: false,
  window: { width: 1360, height: 900, x: undefined, y: undefined, maximized: false },
};

/**
 * The keys written back to `shell-settings.json`.
 *
 * This is an allowlist on purpose: the effective settings also hold values
 * injected by the environment (`DSH_DESKTOP_HOME` / `DSH_DESKTOP_PORT`), and
 * those are meant to be per-launch — persisting them would turn a one-off
 * override into a permanent change.
 */
const PERSISTED_KEYS = ['port', 'dshHome', 'autoRestart', 'closeToTray', 'window'];

/** Environment variables applied to the effective settings only. */
const ENV_HOME_VAR = 'DSH_DESKTOP_HOME';
const ENV_PORT_VAR = 'DSH_DESKTOP_PORT';

/** Keys that earlier versions wrote and that are now retired. */
const RETIRED_KEYS = ['workspace', 'openDiagnostics'];

/**
 * Merge a settings file with the defaults and the environment.
 *
 * Two objects come back on purpose. `settings` is what the shell runs with,
 * including this launch's environment overrides; `stored` is what belongs in
 * the file. Keeping them apart is the whole point: `DSH_DESKTOP_HOME` and
 * `DSH_DESKTOP_PORT` are meant to be per-launch, and saving `settings` would
 * promote a one-off override into a permanent change.
 *
 * @param raw - the parsed settings file (any object; `{}` when the file is absent).
 * @param env - environment mapping used for the per-launch overrides.
 * @param options - `defaultDshHome` replaces the built-in `~/.dsh`, which is how an
 *   installed copy whose data lives beside the executable gets its own home.
 * @returns `{ settings, stored, retired, unexpected }`.
 */
function resolveSettings(raw = {}, env = process.env, { defaultDshHome = DEFAULT_DSH_HOME } = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const stored = {
    ...DEFAULT_SETTINGS,
    dshHome: defaultDshHome,
    ...source,
    window: { ...DEFAULT_SETTINGS.window, ...(source.window ?? {}) },
  };
  const keys = Object.keys(source);
  const retired = RETIRED_KEYS.filter((key) => keys.includes(key));
  const unexpected = keys.filter((key) => !PERSISTED_KEYS.includes(key) && !RETIRED_KEYS.includes(key));
  for (const key of retired) delete stored[key];

  const settings = { ...stored, window: { ...stored.window } };
  if (env[ENV_HOME_VAR]) settings.dshHome = env[ENV_HOME_VAR];
  if (env[ENV_PORT_VAR] !== undefined) settings.port = Number(env[ENV_PORT_VAR]) || 0;
  return { settings, stored, retired, unexpected };
}

/**
 * Project an object onto what may be written to disk.
 * @param source - a settings object (normally the `stored` one).
 * @returns a plain object holding only the persisted keys.
 */
function persistedSettings(source) {
  const persisted = {};
  for (const key of PERSISTED_KEYS) {
    if (source[key] !== undefined) persisted[key] = source[key];
  }
  return persisted;
}

module.exports = { DEFAULT_DSH_HOME, DEFAULT_SETTINGS, PERSISTED_KEYS, RETIRED_KEYS, persistedSettings, resolveSettings };
