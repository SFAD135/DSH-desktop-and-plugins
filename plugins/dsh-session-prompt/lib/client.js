/**
 * Session prompt — browser half.
 *
 * A hand-written client bundle in the shape the host's client-modules node
 * half serves. Executing this file only registers a factory; the module body
 * runs at materialization, and `apply` registers one composer entry.
 *
 * The entry is a compact control at the left of the composer tool row
 * (`conversation.input.left`, a session-scoped list slot). Pressing it opens a
 * dialog bound to the *current* session's entry in the `session-prompt`
 * settings namespace: a textarea, an enable switch, and save/clear actions.
 *
 * The enable switch is per session and writes immediately, so it keeps the
 * text while stopping injection, and the composer button stops being blue the
 * moment it is switched off.
 *
 * The control turns the product's "send" blue while the current session has a
 * non-empty, enabled prompt — `--dsw-alias-button-info-fill`, the exact token
 * the composer's primary button uses — so the active state is visible without
 * opening the dialog.
 *
 * Only platform-seeded modules are required (`react` and
 * `@deepseek-ai/dsh-client-ui-primitives`), so `dsh.client.external` stays
 * empty and this row adds no edge to the module graph.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-prompt',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const { Button, Modal, Switch, IconContextInjectionOutline16 } = primitives

		/** Settings namespace owned by the host half. */
		const NS = 'session-prompt'
		/** Slot id of this composer entry. */
		const ENTRY_ID = 'session-prompt'
		/** The composer tool row this control sits in. */
		const SLOT = 'conversation.input.left'

		const LABEL = '会话提示词'
		const PLACEHOLDER = '例如：这个会话里始终用中文回答；先给结论再解释；代码注释用英文。'

		/**
		 * The composer's primary (send) button, verbatim: same background token,
		 * same foreground. Applied only while this session is active.
		 */
		const ACTIVE_STYLE = {
			background: 'var(--dsw-alias-button-info-fill)',
			color: '#fff',
		}

		/** Inline styles over the product's own theme tokens: no stylesheet to inject, nothing to clean up. */
		const css = {
			hint: {
				margin: '0 0 10px',
				fontSize: 13,
				lineHeight: 1.6,
				color: 'var(--dsw-alias-label-secondary)',
			},
			textarea: {
				display: 'block',
				width: '100%',
				minHeight: 170,
				boxSizing: 'border-box',
				resize: 'vertical',
				padding: '10px 12px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 8,
				background: 'var(--dsw-alias-bg-layer-1)',
				color: 'var(--dsw-alias-label-primary)',
				fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
				fontSize: 13,
				lineHeight: 1.7,
				outline: 'none',
			},
			row: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 12,
				marginTop: 12,
				flexWrap: 'wrap',
			},
			switchRow: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: 8,
				cursor: 'pointer',
			},
			switchLabel: {
				fontSize: 13,
				color: 'var(--dsw-alias-label-primary)',
			},
			meta: {
				fontSize: 12,
				color: 'var(--dsw-alias-label-tertiary)',
			},
			notice: {
				margin: '10px 0 0',
				fontSize: 12,
				color: 'var(--dsw-alias-state-success-primary)',
			},
			error: {
				margin: '10px 0 0',
				fontSize: 12,
				lineHeight: 1.6,
				color: 'var(--dsw-alias-state-error-primary)',
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
			},
			footer: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'flex-end',
				gap: 8,
			},
		}

		/** Required client services: the slot registry and the settings Remote namespace. */
		const inject = ['slots', 'remote', 'remote.settings']

		/** Turn any thrown value into displayable text. */
		function messageOf(error) {
			if (error === undefined || error === null) return '未知错误'
			if (typeof error === 'string') return error
			if (typeof error.message === 'string' && error.message.length > 0) return error.message
			return String(error)
		}

		/** Read the error text out of a Typert Remote result envelope. */
		function errorOf(result) {
			if (result === undefined || result === null) return '远程调用没有返回结果'
			if (result.ok === true) return ''
			const error = result.error
			if (error === undefined || error === null) return '未知错误'
			if (typeof error === 'string') return error
			return error.message || error.code || '未知错误'
		}

		/** The two session-keyed maps a redacted settings value carries, normalized. */
		function mapsOf(value) {
			const source = value !== undefined && value !== null && typeof value === 'object' ? value : {}
			const prompts = source.prompts
			const disabled = source.disabled
			return {
				texts: prompts !== undefined && prompts !== null && typeof prompts === 'object' ? prompts : {},
				disabled: disabled !== undefined && disabled !== null && typeof disabled === 'object' ? disabled : {},
			}
		}

		/**
		 * Client plugin body: one composer entry reading and writing the current
		 * session's prompt.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			let state = {
				/** sessionId -> prompt text, as the host resolved it. */
				texts: {},
				/** sessionId -> true while that session's text is kept but not injected. */
				disabled: {},
				/** Compare-and-set revision of the namespace, read at write time. */
				revision: undefined,
				/** Whether the dialog is open. */
				open: false,
				/** `loading` | `idle` | `saving` | `error`. */
				phase: 'loading',
				/** Last failure text, if any. */
				error: undefined,
				/** Whether the settings namespace is registered by the host half. */
				registered: undefined,
			}
			const listeners = new Set()
			/** Replace the snapshot and notify subscribers. */
			const setState = (patch) => {
				state = Object.assign({}, state, patch)
				for (const listener of Array.from(listeners)) listener()
			}
			/** Stable store subscription for `useSyncExternalStore`. */
			const subscribe = (listener) => {
				listeners.add(listener)
				return () => { listeners.delete(listener) }
			}
			const getState = () => state

			/** Sessions whose state this page has already asked for. */
			const seen = new Set()

			/** Re-read the namespace from the host and adopt it as the snapshot. */
			const refresh = async () => {
				setState({ phase: 'loading', error: undefined })
				let result
				try {
					result = await ctx.remote.settings.describe()
				} catch (error) {
					setState({ phase: 'error', error: messageOf(error) })
					return
				}
				if (result === undefined || result === null || result.ok !== true) {
					setState({ phase: 'error', error: errorOf(result) })
					return
				}
				const namespaces = (result.value && result.value.namespaces) || []
				const entry = namespaces.find((item) => item !== null && typeof item === 'object' && item.ns === NS)
				if (entry === undefined) {
					setState({
						phase: 'error',
						registered: false,
						error: '宿主半边未加载：settings 命名空间 "' + NS + '" 尚未注册。请重启 DSH 桌面端后重试。',
					})
					return
				}
				// Both maps arrive at once, so one read answers every session.
				const maps = mapsOf(entry.value)
				setState({
					texts: maps.texts,
					disabled: maps.disabled,
					revision: entry.revision,
					phase: 'idle',
					error: undefined,
					registered: true,
				})
			}

			/** Ask for the state once per session seen on this page. */
			const ensureLoaded = (sessionId) => {
				const key = sessionId === undefined ? '<none>' : String(sessionId)
				if (seen.has(key)) return
				seen.add(key)
				void refresh()
			}

			/**
			 * Apply path-addressed ops to this namespace, guarded by the revision
			 * observed at write time.
			 * @param ops - `settings.mutate` ops.
			 * @returns whether the write landed.
			 */
			const write = async (ops) => {
				setState({ phase: 'saving', error: undefined })
				let result
				try {
					result = await ctx.remote.settings.mutate(NS, ops, state.revision)
				} catch (error) {
					setState({ phase: 'error', error: messageOf(error) })
					return false
				}
				if (result === undefined || result === null || result.ok !== true) {
					setState({ phase: 'error', error: errorOf(result) })
					return false
				}
				const descriptor = result.value || {}
				const maps = mapsOf(descriptor.value)
				setState({
					texts: maps.texts,
					disabled: maps.disabled,
					revision: descriptor.revision,
					phase: 'idle',
					error: undefined,
					registered: true,
				})
				return true
			}

			/**
			 * Set (or, for empty text, drop) one session's text. Only ever touches
			 * `prompts`, so a session's switch state survives a text edit.
			 * @param sessionId - the session to write.
			 * @param text - the new text.
			 */
			const save = (sessionId, text) => {
				if (text.trim().length === 0) {
					return write([{ op: 'unset', path: ['prompts', String(sessionId)] }])
				}
				return write([{ op: 'set', path: ['prompts', String(sessionId)], value: text }])
			}

			/** Drop one session's text (and its switch state). */
			const clear = (sessionId) => write([
				{ op: 'unset', path: ['prompts', String(sessionId)] },
				{ op: 'unset', path: ['disabled', String(sessionId)] },
			])

			/**
			 * Turn one session's injection on or off, keeping its text. Applied
			 * immediately, so the composer button reflects the switch at once.
			 * @param sessionId - the session to toggle.
			 * @param enabled - the next state.
			 */
			const setEnabled = (sessionId, enabled) => {
				if (enabled) {
					return write([{ op: 'unset', path: ['disabled', String(sessionId)] }])
				}
				return write([{ op: 'set', path: ['disabled', String(sessionId)], value: true }])
			}

			/** Shared snapshot hook: one store, every session's control. */
			const useStore = () => React.useSyncExternalStore(subscribe, getState)

			/** The dialog: textarea plus a per-session enable switch. */
			function SessionPromptDialog({ sessionId }) {
				const snapshot = useStore()
				const key = sessionId === undefined ? undefined : String(sessionId)
				const saved = key === undefined ? '' : (snapshot.texts[key] || '')
				const savedEnabled = saved.trim().length > 0 && snapshot.disabled[key] !== true
				const [draft, setDraft] = React.useState(saved)
				const [notice, setNotice] = React.useState('')

				React.useEffect(() => {
					if (!snapshot.open) return
					setDraft(saved)
					setNotice('')
					void refresh()
				}, [snapshot.open, saved])

				const busy = snapshot.phase === 'saving'
				const dirty = draft !== saved

				const onSave = async () => {
					const ok = await save(key, draft)
					setNotice(ok ? '已保存。本会话的下一轮对话立即生效。' : '')
				}
				const onClear = async () => {
					const ok = await clear(key)
					if (ok) {
						setDraft('')
						setNotice('已清空，本会话不再注入这段提示词。')
					}
				}
				const onToggle = async (next) => {
					const ok = await setEnabled(key, next)
					if (ok) setNotice(next ? '已启用，本会话的下一轮对话开始注入。' : '已停用，文本保留但不再注入。')
				}

				const body = h('div', null,
					h('p', { style: css.hint },
						'只对当前会话生效：其他会话有自己的提示词，互不影响。保存后，本会话每次模型请求都会把这段内容注入到系统提示词的最前面；内容为空时不占用任何 token。'),
					h('textarea', {
						style: css.textarea,
						value: draft,
						rows: 9,
						spellCheck: false,
						placeholder: PLACEHOLDER,
						'aria-label': LABEL,
						onChange: (event) => {
							setDraft(event.target.value)
							if (notice.length > 0) setNotice('')
						},
					}),
					h('div', { style: css.row },
						h('label', { style: css.switchRow },
							h(Switch, {
								checked: savedEnabled,
								disabled: saved.trim().length === 0 || busy,
								label: '启用',
								title: '关闭后保留文本，但不再注入',
								onChange: (next) => { void onToggle(next) },
							}),
							h('span', { style: css.switchLabel }, '启用（关闭后保留文本但不注入）'),
						),
						h('span', { style: css.meta },
							'本会话已保存 ' + String(saved.length) + ' 字'
							+ (saved.trim().length === 0 ? '' : savedEnabled ? '，当前已启用' : '，当前已停用'),
						),
					),
					snapshot.error !== undefined ? h('p', { style: css.error }, snapshot.error) : null,
					notice.length > 0 ? h('p', { style: css.notice }, notice) : null,
				)

				const footer = h('div', { style: css.footer },
					h(Button, {
						variant: 'ghost',
						disabled: busy,
						onClick: () => { setState({ open: false }) },
					}, '关闭'),
					h(Button, {
						variant: 'outline',
						disabled: busy || saved.length === 0,
						onClick: () => { void onClear() },
					}, '清空'),
					h(Button, {
						variant: 'primary',
						disabled: busy || !dirty,
						onClick: () => { void onSave() },
					}, busy ? '保存中…' : '保存'),
				)

				return h(Modal, {
					open: snapshot.open,
					onClose: () => { setState({ open: false }) },
					title: LABEL,
					closeLabel: '关闭',
					children: body,
					footer,
				})
			}

			/** The composer control: a button that is blue while this session is active. */
			function SessionPromptControl(props) {
				const snapshot = useStore()
				// `sessionId` is a standard prop of this slot; the registration's own
				// `inject` supplies the same value as a fallback.
				const sessionId = props.sessionId !== undefined ? props.sessionId : props.slotSessionId
				React.useEffect(() => { ensureLoaded(sessionId) }, [sessionId])

				const key = sessionId === undefined ? undefined : String(sessionId)
				const text = key === undefined ? '' : (snapshot.texts[key] || '')
				const hasText = text.trim().length > 0
				const off = key !== undefined && snapshot.disabled[key] === true
				const active = hasText && !off
				const suffix = !hasText ? '（本会话未设置）' : off ? '（已设置，未启用）' : '（本会话已启用）'

				return h(React.Fragment, null,
					h(Button, {
						variant: 'ghost',
						size: 'sm',
						icon: h(IconContextInjectionOutline16, { size: 16 }),
						title: LABEL + suffix,
						'aria-label': LABEL,
						'data-session-prompt-active': active ? 'true' : 'false',
						style: active ? ACTIVE_STYLE : undefined,
						onClick: () => { setState({ open: true }) },
					}, LABEL),
					h(SessionPromptDialog, { sessionId }),
				)
			}

			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				id: ENTRY_ID,
				order: 100,
				label: LABEL,
				inject: (sessionId) => ({ slotSessionId: sessionId }),
			}, SessionPromptControl))
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
