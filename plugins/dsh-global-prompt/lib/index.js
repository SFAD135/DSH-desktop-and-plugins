/**
 * Global prompt — host half.
 *
 * A host-plane row that gives every agent one user-authored block of text at
 * the head of its system prompt. The text lives in the `global-prompt`
 * settings namespace (user layer of `$DSH_HOME/settings.yaml`), so it is
 * durable, hot-reloaded, and editable from either the composer dialog or the
 * document itself.
 *
 * Why a system-prompt section and not an injected user message:
 *   - it is resident context, so it never enters (or replays through) the
 *     session log, and compaction cannot drop it;
 *   - the variable provider is re-evaluated on every assembly — that is, on
 *     every model request — so an edit applies to the next request with no
 *     restart and no re-registration;
 *   - while the text is unchanged the rendered prefix is byte-stable, so KV
 *     cache reuse across requests is preserved;
 *   - an empty text renders the section to nothing, and `renderPrompt` drops
 *     empty sections, so the feature costs zero tokens when unused.
 *
 * Order 10 places it after the persona prefix (order 0) and before every
 * first-party guidance section (plan policy starts at 500), which is what
 * "at the start of the input" means for this surface.
 *
 * @module dsh-global-prompt
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'global-prompt'

/** Hard dependencies: without either service this row would silently do nothing. */
export const inject = ['settings', 'systemPrompt']

/** Settings namespace owned by this plugin (lowercase-hyphenated grammar). */
export const NAMESPACE = 'global-prompt'

/** Prompt-variable reference name; must match `/^[a-z][a-z0-9_]*$/`. */
export const VARIABLE_NAME = 'global_prompt'

/** Prompt-section name; unique so it never shadows a first-party section. */
export const SECTION_NAME = 'user:global-prompt'

/** Prompt-section order: after the persona prefix (0), before plan policy (500). */
export const SECTION_ORDER = 10

/** Runtime schema for this namespace's resolved value. */
export const Config = z.object({
  text: z.string().default(''),
  enabled: z.boolean().default(true),
})

/**
 * Register the settings namespace, the prompt variable that reads it, and the
 * section that renders it.
 * @param ctx - host context carrying `settings` and `systemPrompt`.
 * @param config - the composition entry config, used as the namespace's `base` layer.
 */
export function apply(ctx, config) {
  const scope = ctx.settings.register(NAMESPACE, Config, { base: config })

  ctx.effect(() => ctx.systemPrompt.variable(VARIABLE_NAME, () => {
    const value = scope.get()
    if (value === undefined || value.enabled === false) return ''
    return typeof value.text === 'string' ? value.text : ''
  }), 'global-prompt.variable()')

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: `{{${VARIABLE_NAME}}}`,
  }), 'global-prompt.section()')
}
