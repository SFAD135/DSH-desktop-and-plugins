/**
 * Archived sessions — host half.
 *
 * ## What this adds
 *
 * dsh's session archive is one-way: `archiveSession()` exists on the workspace
 * registry and is exposed as `ctx.remote.workspace.archiveSession`, but there is
 * no inverse — no unarchive method, no RPC, no UI. Upstream states this as a
 * known limitation ("no unarchive action exists yet").
 *
 * The durable shape, however, was designed for it. The registry's own comment
 * says archiving "never touches workspace accounting — an archived session
 * keeps its `sessionIds` slot so unarchiving restores its position". So the
 * archived set is a pure display filter, and restoring is a matter of removing
 * one id from it.
 *
 * ## Why no dsh patch is needed
 *
 * `WorkspaceRegistry` declares no JS-private members, so the three methods
 * `archiveSession()` itself uses — `enqueueOperation`, `requireState`,
 * `setState` — are reachable from a plugin. Writing the inverse through the very
 * same serialized operation chain means the pending-mutation marker, the
 * workspace invariant, and the durable change feed all behave exactly as they
 * do for a first-party mutation. Nothing is written behind the registry's back.
 *
 * ## Why the client meets us in a settings namespace
 *
 * The client half runs in the browser and cannot reach a host service directly.
 * dsh's Remote bindings are generated at build time (`typert.host.js` /
 * `typert.remote-client.js`, each carrying schemas and source locations), so
 * adding a new RPC would mean patching generated files that the next dsh
 * upgrade overwrites.
 *
 * Instead the two halves meet in this plugin's `archived-sessions` settings
 * namespace — reached through the officially exposed `settings.describe` /
 * `settings.mutate` remotes, the same channel `dsh-session-prompt` uses:
 *
 * - `requests`: nonce -> session id. The client writes one entry to ask for a
 *   restore. A nonce rather than a bare id keeps two rapid restores distinct.
 * - `results`: nonce -> `ok` or `error: …`. This half writes the outcome back,
 *   so the client can report a failure instead of waiting forever.
 *
 * The archived-set change itself needs no extra plumbing: the registry's write
 * feeds the existing `workspace.follow` projection, so every surface that
 * already renders archive state updates on its own.
 *
 * @module dsh-archived-sessions
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'archived-sessions'

/** Hard dependencies: settings for the request channel, the registry for the inverse. */
export const inject = ['settings', 'workspaceRegistry']

/** Settings namespace owned by this plugin (lowercase-hyphenated grammar). */
export const NAMESPACE = 'archived-sessions'

/** Runtime schema for this namespace's resolved value. */
export const Config = z.object({
  requests: z.dict(z.string()).default({}),
  results: z.dict(z.string()).default({}),
})

/** Turn any thrown value into displayable text. */
export function messageOf(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/**
 * Remove one session id from the registry's archive set — the exact inverse of
 * `WorkspaceRegistry.archiveSession()`, sharing its serialized write chain.
 *
 * Idempotent: a session that is not archived resolves `false` without writing,
 * so a replayed request (or a stale one surviving a restart) is harmless.
 *
 * @param registry - the live `ctx.workspaceRegistry` service.
 * @param sessionId - the session to restore.
 * @returns whether the archive set actually changed.
 */
export async function unarchiveVia(registry, sessionId) {
  return registry.enqueueOperation(async () => {
    const state = registry.requireState()
    const archived = state.archivedSessionIds
    if (!archived.includes(sessionId)) return false
    await registry.setState({
      ...state,
      archivedSessionIds: archived.filter((id) => id !== sessionId),
    })
    return true
  })
}

/**
 * Register the request namespace and pump it: every nonce the client writes is
 * drained once, its outcome recorded under `results`.
 *
 * Re-entrancy is guarded twice and both are load-bearing:
 *
 * - `handled` remembers drained nonces for this process, so writing `results`
 *   (which itself trips the watcher) cannot loop;
 * - the `draining` / `again` pair makes a burst of writes drain serially without
 *   dropping the last one, which a plain "already running" flag would.
 *
 * A requested restore never rejects the pump: a failure is recorded as the
 * nonce's result so the browser shows the reason instead of hanging.
 *
 * @param ctx - host context carrying `settings` and `workspaceRegistry`.
 * @param config - the composition entry config, used as the namespace's `base` layer.
 */
export function apply(ctx, config) {
  const scope = ctx.settings.register(NAMESPACE, Config, { base: config })

  /** Nonces already drained in this process; the write-back re-entry guard. */
  const handled = new Set()
  let draining = false
  let again = false

  const drainOnce = async () => {
    const value = scope.get()
    const requests = value?.requests ?? {}
    const pending = Object.entries(requests).filter(([nonce]) => !handled.has(nonce))
    if (pending.length === 0) return

    const results = { ...(value?.results ?? {}) }
    for (const [nonce, sessionId] of pending) {
      // Claim before awaiting: a concurrent drain must not pick the same nonce.
      handled.add(nonce)
      try {
        await unarchiveVia(ctx.workspaceRegistry, sessionId)
        results[nonce] = 'ok'
      } catch (error) {
        results[nonce] = 'error: ' + messageOf(error)
        ctx.logger?.warn?.(`archived-sessions: restore failed for ${sessionId}: ${messageOf(error)}`)
      }
    }

    // Re-read before writing. The client may have queued another request — or
    // cleaned up a finished one — while this drain was awaiting, and copying
    // the map read at entry would silently drop that write.
    //
    // `replace` rather than `update`: a merge cannot drop a key, and `results`
    // must be the complete next map rather than an accumulation across drains.
    const current = scope.get()
    await scope.replace({ requests: current?.requests ?? {}, results })
  }

  const drain = async () => {
    if (draining) {
      again = true
      return
    }
    draining = true
    try {
      do {
        again = false
        await drainOnce()
      } while (again)
    } finally {
      draining = false
    }
  }

  scope.watch(() => { void drain() })
  // Requests written before this plugin loaded still deserve draining.
  void drain()
}
