/**
 * Global prompt — browser half.
 *
 * A hand-written client bundle in the shape the host's client-modules node
 * half serves. Executing this file only registers a factory; the module body
 * runs at materialization, and `apply` registers one composer entry.
 *
 * The entry is a compact control at the left of the composer tool row
 * (`conversation.input.left`, a list slot). Pressing it opens a dialog with a
 * textarea bound to the `global-prompt` settings namespace over the settings
 * Remote. No session state is read: the value is global, so the two halves
 * need nothing from the conversation.
 *
 * Only platform-seeded modules are required (`react` and
 * `@deepseek-ai/dsh-client-ui-primitives`), so `dsh.client.external` stays
 * empty and this row adds no edge to the module graph.
 */
window.__ModuleLoader__.load({
	id: 'dsh-global-prompt',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const { Button, Modal, Switch, IconContextInjectionOutline16 } = primitives

		/** Settings namespace owned by the host half. */
		const NS = 'global-prompt'
		/** Slot id of this composer entry. */
		const ENTRY_ID = 'global-prompt'
		/** The composer tool row this control sits in. */
		const SLOT = 'conversation.input.left'

		const LABEL = '全局提示词'
		const PLACEHOLDER = '例如：始终使用简体中文回答；代码注释用英文；先给结论再解释。'

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
				minHeight: 200,
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
				marginTop: 10,
			},
			switchRow: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: 8,
				cursor: 'pointer',
			},
			switchLabel: {
				fontSize: 13,
				color: 'var(--dsw-alias-label-secondary)',
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

		/**
		 * Client plugin body: one composer entry that reads and writes the
		 * `global-prompt` settings namespace.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			let state = {
				/** Saved text as the host resolved it. */
				text: '',
				/** Whether the host injects the text at all. */
				enabled: true,
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

			let loadStarted = false
			/** Read the namespace once per page load; the dialog still re-reads on demand. */
			const ensureLoaded = () => {
				if (loadStarted) return
				loadStarted = true
				void refresh()
			}

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
				const value = entry.value || {}
				setState({
					text: typeof value.text === 'string' ? value.text : '',
					enabled: value.enabled !== false,
					revision: entry.revision,
					phase: 'idle',
					error: undefined,
					registered: true,
				})
			}

			/**
			 * Write a patch into the namespace's user layer, guarded by the
			 * revision observed at write time.
			 * @param patch - the plain-object patch to merge.
			 * @returns whether the write landed.
			 */
			const write = async (patch) => {
				setState({ phase: 'saving', error: undefined })
				let result
				try {
					result = await ctx.remote.settings.update(NS, patch, state.revision)
				} catch (error) {
					setState({ phase: 'error', error: messageOf(error) })
					return false
				}
				if (result === undefined || result === null || result.ok !== true) {
					setState({ phase: 'error', error: errorOf(result) })
					return false
				}
				const descriptor = result.value || {}
				const value = descriptor.value || {}
				setState({
					text: typeof value.text === 'string' ? value.text : state.text,
					enabled: value.enabled !== false,
					revision: descriptor.revision,
					phase: 'idle',
					error: undefined,
					registered: true,
				})
				return true
			}

			/** Shared snapshot hook: one store, two readers. */
			const useStore = () => React.useSyncExternalStore(subscribe, getState)

			/** The dialog: a textarea over the namespace plus save, clear, and enable. */
			function GlobalPromptDialog() {
				const snapshot = useStore()
				const [draft, setDraft] = React.useState(snapshot.text)
				const [notice, setNotice] = React.useState('')

				React.useEffect(() => {
					if (!snapshot.open) return
					setDraft(snapshot.text)
					setNotice('')
					void refresh()
				}, [snapshot.open])

				const saving = snapshot.phase === 'saving'

				const onSave = async () => {
					const ok = await write({ text: draft })
					setNotice(ok ? '已保存。下一轮对话立即生效。' : '')
				}
				const onClear = async () => {
					const ok = await write({ text: '' })
					if (ok) {
						setDraft('')
						setNotice('已清空，模型不再看到这段提示词。')
					}
				}

				const body = h('div', null,
					h('p', { style: css.hint },
						'保存后，每次模型请求都会把这段内容注入到系统提示词的最前面。内容为空时不占用任何 token；关闭“启用”可保留文本但停止注入。'),
					h('textarea', {
						style: css.textarea,
						value: draft,
						rows: 10,
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
								checked: snapshot.enabled,
								label: '启用',
								title: '关闭后保留文本，但不再注入',
								onChange: (next) => { void write({ enabled: next }) },
							}),
							h('span', { style: css.switchLabel }, '启用（关闭后保留文本但不注入）'),
						),
						h('span', { style: css.meta },
							'已保存 ' + String(snapshot.text.length) + ' 字'),
					),
					snapshot.error !== undefined ? h('p', { style: css.error }, snapshot.error) : null,
					notice.length > 0 ? h('p', { style: css.notice }, notice) : null,
				)

				const footer = h('div', { style: css.footer },
					h(Button, {
						variant: 'ghost',
						disabled: saving,
						onClick: () => { setState({ open: false }) },
					}, '关闭'),
					h(Button, {
						variant: 'outline',
						disabled: saving || snapshot.text.length === 0,
						onClick: () => { void onClear() },
					}, '清空'),
					h(Button, {
						variant: 'primary',
						disabled: saving || draft === snapshot.text,
						onClick: () => { void onSave() },
					}, saving ? '保存中…' : '保存'),
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

			/** The composer control: an icon button that opens the dialog. */
			function GlobalPromptControl() {
				const snapshot = useStore()
				React.useEffect(() => { ensureLoaded() }, [])

				const configured = snapshot.text.trim().length > 0
				const suffix = configured
					? (snapshot.enabled ? '（已设置）' : '（已设置，未启用）')
					: '（未设置）'

				return h(React.Fragment, null,
					h(Button, {
						variant: configured && snapshot.enabled ? 'outline' : 'ghost',
						size: 'sm',
						icon: h(IconContextInjectionOutline16, { size: 16 }),
						title: LABEL + suffix,
						'aria-label': LABEL,
						onClick: () => { setState({ open: true }) },
					}, LABEL),
					h(GlobalPromptDialog, { key: 'global-prompt-dialog' }),
				)
			}

			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				id: ENTRY_ID,
				order: 100,
				label: LABEL,
			}, GlobalPromptControl))
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
