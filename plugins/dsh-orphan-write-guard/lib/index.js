/**
 * Orphan write guard — host half only.
 *
 * ## The behaviour this stops
 *
 * `WorkspaceRegistry.delete()` is documented as *"Delete one workspace
 * registration while retaining its directory and every session log"* — removing
 * a workspace is deliberately a registry-only operation. But a session's `cwd`
 * is a durable fact of its own log and is never rewritten, so deleting a
 * workspace leaves every session that lived there pointing at that path.
 *
 * If the directory then disappears (the user cleaned it up), nothing notices.
 * Writing a file inside it runs `dsh-fs-local`'s `writeFileAtomic`, whose first
 * act is `await mkdir(dirname(path), { recursive: true })`. The directory comes
 * back — but the workspace registration does not, so the tree is now in a state
 * the user never asked for: a directory that exists with no workspace owning it.
 *
 * ## What this does
 *
 * `dsh-workspace` already tracks exactly the fact we need. Its `headers` map
 * holds every session header (including `cwd`), and its own indexer records
 * `cwd '…' is not a directory` for the broken ones. Neither is `#`-private, and
 * `WorkspaceRegistry` declares no private members at all, so a plugin can read
 * the same map the registry uses.
 *
 * So the rule is narrow and needs no bookkeeping of our own: **deny a `write`
 * whose target lies inside a session's `cwd` when that `cwd` no longer exists.**
 *
 * It is deliberately not "deny any write to a missing directory" — that would
 * break the ordinary and legitimate case of writing a new file into a new
 * subdirectory. Only a path that some session still calls home, and that is
 * gone, is refused.
 *
 * ## Relative paths
 *
 * The tool's own parameter description invites a relative `file_path`, and
 * `dsh-tool-fs` resolves it against the calling session's cwd before writing.
 * A guard comparing the raw argument would therefore see `"test.txt"`, find no
 * absolute ancestor, and allow a write that still recreates the directory.
 *
 * So the target is resolved through `absoluteTarget()` using the very same
 * base the tool uses (`exec.agent.session.header.cwd`). Both sides then agree
 * on which absolute path a relative request denotes.
 *
 * ## Scope and honest limits
 *
 * Only `write` is guarded. `edit` cannot create a directory — `editText()`
 * throws `FS_STALE_VERSION` when the file is absent, and a file can only exist
 * if its directory does — so guarding it would add nothing. Shell tools
 * (`bash -c "… > file"`) are out of reach: their redirection is not a
 * structured argument, and no guard can read it. This narrows the surprise; it
 * does not make the shell safe.
 *
 * The guard denies, it never allows: cordis guards are monotonic, so this can
 * only ever add a refusal, never excuse one another guard already made.
 *
 * @module dsh-orphan-write-guard
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/** Cordis plugin name. */
export const name = 'orphan-write-guard'

/** `tools` supplies the guard chain; `workspaceRegistry` the session headers. */
export const inject = ['tools', 'workspaceRegistry']

/** The one tool that can create a directory as a side effect of writing. */
export const WRITE_TOOL = 'write'

/** The path field every file tool in `dsh-tool-fs` takes. */
export const PATH_FIELD = 'file_path'

/**
 * Canonicalize for comparison: absolute, no trailing separator, case-folded.
 *
 * Case folding is unconditional because Windows paths are case-insensitive and
 * the cost of a false positive here (refusing a write the user meant) is far
 * worse than a missed match, which merely leaves today's behaviour in place.
 *
 * @param value - the path to normalize.
 * @returns the comparison key.
 */
export function normalize(value) {
  let out = resolve(value)
  while (out.length > 1 && (out.endsWith(sep) || out.endsWith('/'))) out = out.slice(0, -1)
  return out.toLowerCase()
}

/**
 * Whether `target` is `directory` itself or lies beneath it.
 *
 * Compares on the separator boundary so that `/a/bc` is not treated as living
 * inside `/a/b`.
 *
 * @param target - the path being written.
 * @param directory - the candidate ancestor.
 * @returns whether the target is contained.
 */
export function isWithin(target, directory) {
  if (!isAbsolute(target) || !isAbsolute(directory)) return false
  const inner = normalize(target)
  const outer = normalize(directory)
  return inner === outer || inner.startsWith(outer + sep)
}

/**
 * Resolve a write target to an absolute path the way the filesystem backend
 * will, so that a relative `file_path` cannot slip past the containment test.
 *
 * `dsh-tool-fs` resolves a relative request against the calling agent's session
 * cwd — `sessionResolveOptions()` falls back to `exec.agent.session.header.cwd`
 * when no sandbox workspace root applies. A guard that inspected only absolute
 * targets would therefore let `{"file_path":"test.txt"}` recreate an orphaned
 * session directory, which is precisely the hole this function closes.
 *
 * The session cwd is read from the same place the tool reads it, so both sides
 * always agree on what a relative path means.
 *
 * @param exec - the execution context carrying the agent.
 * @param target - the raw `file_path` argument.
 * @returns the absolute path, or `undefined` when no base is available.
 */
export function absoluteTarget(exec, target) {
  if (isAbsolute(target)) return target
  const cwd = exec === undefined || exec === null || exec.agent === undefined || exec.agent === null
    ? undefined
    : exec.agent.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  return resolve(cwd, target)
}

/**
 * Find the orphaned session home that accounts for a write target, if any.
 *
 * `isWithin` is a pure string test and runs first, so `exists` — a real
 * filesystem probe on the hot path of every write — is only consulted for the
 * handful of headers that could actually be ancestors.
 *
 * @param registry - the live `ctx.workspaceRegistry`.
 * @param target - the path being written, already absolute.
 * @param exists - existence probe, injectable for tests.
 * @returns the orphaned directory, or `undefined` when the write is ordinary.
 */
export function orphanFor(registry, target, exists = existsSync) {
  const headers = registry === undefined || registry === null ? undefined : registry.headers
  if (!(headers instanceof Map)) return undefined
  for (const header of headers.values()) {
    const cwd = header === undefined || header === null ? undefined : header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) continue
    if (!isWithin(target, cwd)) continue
    if (exists(cwd)) continue
    return cwd
  }
  return undefined
}

/**
 * The refusal text the model receives.
 *
 * It names the directory and, more importantly, says why the write is odd and
 * what to do instead — a bare "denied" teaches nothing and invites a retry.
 *
 * @param directory - the missing session home.
 * @returns the denial reason.
 */
export function denialFor(directory) {
  return `refusing to write: '${directory}' no longer exists, but it is the working directory of a session.`
    + ' Writing here would silently recreate that directory, which no workspace would then own.'
    + ' If the directory is genuinely wanted again, create it deliberately (or re-add the workspace in DSH) first.'
}

/**
 * Register the guard for the lifetime of this plugin.
 *
 * `guard()` attaches to the tool service's own context rather than ours, so the
 * disposer it returns is what keeps the registration from outliving an unload
 * or an HMR replacement.
 *
 * @param ctx - host context carrying `tools` and `workspaceRegistry`.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.tools.guard((exec) => {
      if (exec === undefined || exec === null || exec.name !== WRITE_TOOL) return undefined
      const args = exec.arguments
      if (typeof args !== 'object' || args === null) return undefined
      const raw = args[PATH_FIELD]
      if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
      // Resolve exactly as the tool will. Reading `raw` directly would let a
      // relative path — which is what the tool's own schema encourages — walk
      // straight past the containment test.
      const target = absoluteTarget(exec, raw)
      if (target === undefined) return undefined
      const orphan = orphanFor(ctx.workspaceRegistry, target)
      return orphan === undefined ? undefined : denialFor(orphan)
    })
    return () => dispose()
  }, 'orphan-write-guard.guard')
}
