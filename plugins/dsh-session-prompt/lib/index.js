/**
 * Session prompt — host half.
 *
 * One user-authored block of text per session, at the head of that session's
 * system prompt and nowhere else.
 *
 * ## Why the section is registered per agent
 *
 * A section registered through the root context lands in the global prompt
 * layer and would apply to every session. Registering it through `agent.ctx`
 * puts it in that agent's own scope layer instead: `SystemPrompt.assemble()`
 * merges the global layer with the scope chain for the assembling agent, so
 * the section exists for exactly one session and unwinds when the agent is
 * disposed. This is the same mechanism `dsh-file-reference-local` and agent
 * presets use to give one agent a prompt its neighbours do not see.
 *
 * The section's `text` is a function, evaluated on every assembly — that is,
 * on every model request — so an edit (or flipping a session's enable switch)
 * applies to the next request with no restart, no reload, and no
 * re-registration. While the text is unchanged the rendered prefix is
 * byte-stable, so KV cache reuse is preserved; empty text renders the section
 * to nothing and `renderPrompt` drops empty sections, so an unset session
 * costs zero tokens.
 *
 * Order 10 places it after the persona prefix (order 0) and before every
 * first-party guidance section (plan policy starts at 500).
 *
 * ## Storage
 *
 * The `session-prompt` settings namespace holds two maps, both keyed by
 * session id:
 *
 * - `prompts` — the text, as a plain string, so a hand-edited `settings.yaml`
 *   stays readable: `prompts: { <session-id>: 始终用中文 }`.
 * - `disabled` — present and `true` only for sessions whose text is kept but
 *   deliberately not injected, so the enable switch is off without losing what
 *   you typed. A session with no entry here is enabled.
 *
 * Keeping `disabled` as a separate map rather than folding it into a
 * `{text, enabled}` object keeps `prompts` a simple string map — which is what
 * makes the YAML readable — and means enabling/disabling a session never
 * rewrites its text.
 *
 * Writes go through path-addressed `settings.mutate` ops (`set` / `unset` at
 * `['prompts', sessionId]` or `['disabled', sessionId]`), so editing one
 * session never rewrites — and therefore never clobbers — another session's
 * entry.
 *
 * @module dsh-session-prompt
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'session-prompt'

/** Hard dependencies: settings for storage, the prompt registry, the live-agent registry. */
export const inject = ['settings', 'systemPrompt', 'agents']

/** Settings namespace owned by this plugin (lowercase-hyphenated grammar). */
export const NAMESPACE = 'session-prompt'

/** Prompt-section name; scoped per agent, so it never shadows a first-party section. */
export const SECTION_NAME = 'user:session-prompt'

/** Prompt-section order: after the persona prefix (0), before plan policy (500). */
export const SECTION_ORDER = 10

/** Runtime schema for this namespace's resolved value. */
export const Config = z.object({
  prompts: z.dict(z.string()).default({}),
  disabled: z.dict(z.boolean()).default({}),
})

/**
 * Read one session's stored entry out of a resolved namespace value.
 *
 * Tolerant by design: a malformed or missing namespace value yields an empty,
 * enabled entry rather than throwing, because this runs inside prompt assembly
 * on every model request.
 *
 * @param value - the namespace's resolved (deep-frozen) snapshot.
 * @param sessionId - the session to read.
 * @returns `{ text, enabled }` for that session.
 */
export function entryOf(value, sessionId) {
  const empty = { text: '', enabled: true }
  if (value === undefined || value === null || sessionId === undefined) return empty
  const prompts = value.prompts
  const disabled = value.disabled
  const stored = prompts === undefined || prompts === null ? undefined : prompts[sessionId]
  if (typeof stored !== 'string') return empty
  const off = disabled === undefined || disabled === null ? false : disabled[sessionId] === true
  return { text: stored, enabled: off !== true }
}

/**
 * The text a session should actually contribute to its system prompt:
 * its stored text while enabled, and nothing while disabled (or while the text
 * is empty or whitespace-only, which would otherwise inject dead space).
 * @param value - the namespace's resolved snapshot.
 * @param sessionId - the session to read.
 * @returns the injectable text, or `''`.
 */
export function promptOf(value, sessionId) {
  const entry = entryOf(value, sessionId)
  if (entry.enabled !== true) return ''
  return entry.text.trim().length === 0 ? '' : entry.text
}

/**
 * Register the settings namespace and give every live agent a scoped prompt
 * section reading its own session's text.
 * @param ctx - host context carrying `settings`, `systemPrompt`, and `agents`.
 * @param config - the composition entry config, used as the namespace's `base` layer.
 */
export function apply(ctx, config) {
  const scope = ctx.settings.register(NAMESPACE, Config, { base: config })

  /** One injected fiber per agent, so disposal is exact and idempotent. */
  const fibers = new Map()

  /**
   * Install the scoped section on one agent.
   * @param agent - a live agent.
   */
  const install = (agent) => {
    if (fibers.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt'], (agentScope) => {
      agentScope.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => promptOf(scope.get(), agent.session.id),
      })
    })
    fibers.set(agent, fiber)
  }

  /**
   * Remove the scoped section from one agent, tolerating a disposal failure.
   * @param agent - an agent being disposed, or one already gone.
   */
  const uninstall = (agent) => {
    const fiber = fibers.get(agent)
    if (fiber === undefined) return
    fibers.delete(agent)
    Promise.resolve(fiber.dispose()).catch((error) => {
      ctx.logger?.warn?.(`session-prompt: scoped section cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Agents already live when this plugin loaded, then every later one.
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => uninstall(agent))

  ctx.effect(() => () => {
    const pending = [...fibers.values()]
    fibers.clear()
    return Promise.all(pending.map((fiber) => Promise.resolve(fiber.dispose()).catch(() => {})))
  }, 'session-prompt: scoped sections')
}
