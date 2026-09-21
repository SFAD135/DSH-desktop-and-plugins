/**
 * Workspace health — host half.
 *
 * ## The condition this reports
 *
 * `WorkspaceRegistry.delete()` is documented as *"Delete one workspace
 * registration while retaining its directory and every session log"*. Removing
 * a workspace is deliberately registry-only, while a session's `cwd` is a
 * durable fact of its own log that is never rewritten. So deleting a workspace
 * leaves every session that lived there still pointing at that path — and if
 * the directory then disappears, nothing anywhere says so.
 *
 * The symptom a user actually meets is quiet and confusing: the session still
 * opens, but its tools fail against a directory that is gone, or a later write
 * silently recreates a directory no workspace owns.
 *
 * ## Why detection is cheap and certain
 *
 * The session store already knows every session's `cwd`, so nothing new needs
 * to be tracked: `sessionPersistence.list()` reports every stored session —
 * materialized artifacts plus this process's created-but-unmaterialized ones.
 *
 * This deliberately does *not* read `WorkspaceRegistry.headers`, even though
 * that map is public and looks like the obvious source. `headers` is populated
 * by a one-shot index built at startup (`replaceHeaderIndex`) plus whatever the
 * live session service reports, so a session created after that index — which
 * is what a delegated subagent session or a seeded session is — never appears
 * in it. Measured against this machine, exactly those two sessions were missing
 * from `headers` while present on disk, which would have made this page quietly
 * under-report precisely the sessions a user cannot easily find by hand.
 *
 * Note that `existsSync` would be the wrong probe: it is true for a plain file,
 * and a `cwd` that resolves to a file is exactly as broken as a missing one.
 * `statSync(...).isDirectory()` distinguishes the two, which is why the
 * classification below has three outcomes rather than two.
 *
 * ## Why the browser sees this through a settings namespace
 *
 * The page that renders this lives in the browser and cannot touch the
 * filesystem, so the verdict has to cross from host to client. dsh's Remote
 * bindings are generated at build time, and adding an RPC would mean patching
 * files the next upgrade overwrites. The plugin's own settings namespace is the
 * officially exposed channel `dsh-session-prompt` and `dsh-archived-sessions`
 * both use, so that is the one taken here.
 *
 * Publishing is change-driven: the scan runs on a timer, but `scope.replace()`
 * is only called when the verdict actually differs from what was last
 * published. A steady state therefore costs no writes at all, and the settings
 * file is not rewritten every few seconds.
 *
 * @module dsh-workspace-health
 */
import { statSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'workspace-health'

/** Settings supplies the channel to the browser; the session store supplies the headers. */
export const inject = ['settings', 'sessionPersistence']

/** Settings namespace owned by this plugin (lowercase-hyphenated grammar). */
export const NAMESPACE = 'workspace-health'

/** How often the host re-examines the session headers. */
export const SCAN_MS = 10000

/**
 * The classification codes published to the browser.
 *
 * Codes rather than sentences: the host has no business choosing display
 * language, and a stable code lets the page word each case itself.
 */
export const HEALTHY = 'live'
export const MISSING = 'missing'
export const NOT_A_DIRECTORY = 'not-a-directory'
export const NO_CWD = 'no-cwd'

/** Runtime schema for this namespace's resolved value. */
export const Config = z.object({
  /** sessionId -> classification code, for the sessions whose cwd is unusable. */
  orphans: z.dict(z.string()).default({}),
})

/**
 * Classify one session's recorded working directory.
 *
 * @param path - the header's `cwd`, of unknown validity.
 * @param stat - the stat probe, injectable so tests need no real filesystem.
 * @returns {@link HEALTHY}, {@link MISSING}, {@link NOT_A_DIRECTORY} or {@link NO_CWD}.
 */
export function classify(path, stat = statSync) {
  if (typeof path !== 'string' || path.trim().length === 0) return NO_CWD
  try {
    return stat(path).isDirectory() ? HEALTHY : NOT_A_DIRECTORY
  } catch {
    // Absent, or present but unreachable (permissions, a broken mount, a path
    // that no longer resolves). All of them mean the same thing to a user.
    return MISSING
  }
}

/**
 * Examine session headers and keep the unusable ones.
 *
 * A header without a usable id is skipped rather than reported: without an id
 * there is nothing to name on the page, and a malformed entry is not a finding
 * about the user's workspaces.
 *
 * @param headers - iterable of session headers.
 * @param stat - the stat probe, injectable for tests.
 * @returns sessionId -> classification code, in iteration order.
 */
export function scanHeaders(headers, stat = statSync) {
  const orphans = {}
  if (headers === undefined || headers === null) return orphans
  for (const header of headers) {
    if (header === undefined || header === null) continue
    const id = header.id
    if (typeof id !== 'string' || id.length === 0) continue
    const health = classify(header.cwd, stat)
    if (health !== HEALTHY) orphans[id] = health
  }
  return orphans
}

/**
 * Turn any thrown value into a loggable line.
 *
 * @param error - the thrown value.
 * @returns displayable text.
 */
function describe(error) {
  if (error === undefined || error === null) return String(error)
  if (typeof error === 'string') return error
  return error.message ?? String(error)
}

/**
 * Register the namespace and keep it published.
 *
 * A failed write clears the fingerprint so the next tick retries it, rather than
 * leaving the browser pinned to a stale verdict because one write was lost. A
 * failed *listing* publishes nothing at all — reporting every session as gone
 * because the store hiccuped would be far worse than reporting nothing.
 *
 * @param ctx - host context carrying `settings` and `sessionPersistence`.
 * @param config - the composition entry config, used as the namespace's `base` layer.
 */
export function apply(ctx, config) {
  const scope = ctx.settings.register(NAMESPACE, Config, { base: config })

  /** Serialized last-published verdict; the change detector. */
  let published

  const scan = async () => {
    let snapshots
    try {
      snapshots = await ctx.sessionPersistence.list()
    } catch (error) {
      ctx.logger?.warn?.(`workspace-health: listing stored sessions failed: ${describe(error)}`)
      return
    }

    const orphans = scanHeaders(snapshots.map((snapshot) => (snapshot === undefined || snapshot === null ? undefined : snapshot.header)))
    const fingerprint = JSON.stringify(orphans)
    if (fingerprint === published) return
    try {
      await scope.replace({ orphans })
      published = fingerprint
    } catch (error) {
      published = undefined
      ctx.logger?.warn?.(`workspace-health: publishing the scan failed: ${describe(error)}`)
    }
  }

  ctx.effect(() => {
    // Scan once at load: the page may be opened before the first tick.
    void scan()
    const timer = setInterval(() => { void scan() }, SCAN_MS)
    return () => clearInterval(timer)
  }, 'workspace-health.scan')
}
