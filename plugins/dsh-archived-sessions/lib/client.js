/**
 * Archived sessions — browser half.
 *
 * A hand-written client bundle in the shape the host's client-modules node half
 * serves. Executing this file only registers a factory; the module body runs at
 * materialization, and `apply` registers one Settings page.
 *
 * ## Why this page exists
 *
 * dsh's archive is one-way: archiving hides a session from every grouping
 * surface and, upstream, there is no viewing surface, no unarchive action, and
 * therefore no way to get a session back. The archived set is durable, so an
 * archived session is not lost — merely unreachable.
 *
 * This page is that missing surface. It lists every archived session, grouped by
 * the workspace it belonged to *before* archiving, and restores one at a time.
 *
 * ## Where the data comes from
 *
 * Nothing is fetched for the listing: the settings shell already hands a
 * `settings.section` entry the `useWorkspaces` and `useSessions` snapshot
 * selectors, so the page reads the same projections the sidebar does —
 * `workspaces.archivedSessionIds` for membership and `sessions.byId` for titles.
 * Because those snapshots are driven by the host's `workspace.follow`
 * projection, a restore performed here updates every other surface on its own,
 * with no extra plumbing on this side.
 *
 * ## How a restore travels
 *
 * The browser cannot reach a host service, and dsh's Remote bindings are
 * generated at build time — adding an RPC would mean patching generated files.
 * So the request goes through this plugin's own settings namespace, the same
 * channel `dsh-session-prompt` uses:
 *
 * 1. this page writes `requests[nonce] = sessionId`;
 * 2. the host half drains it and writes `results[nonce]`;
 * 3. this page polls `settings.describe` until the result lands, reports it,
 *    then drops both entries so the namespace never accumulates.
 *
 * The archive set change itself arrives through the workspace projection, so a
 * successful restore also makes the row disappear without a manual refresh.
 *
 * Only platform-seeded modules are required (`react` and
 * `@deepseek-ai/dsh-client-ui-primitives`), so `dsh.client.external` stays
 * empty and this row adds no edge to the module graph.
 */
window.__ModuleLoader__.load({
	id: 'dsh-archived-sessions',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement
		const { Button } = primitives

		/** Settings namespace owned by the host half. */
		const NS = 'archived-sessions'
		/** The settings slot this page occupies. */
		const SLOT = 'settings.section'
		/** Own id: a fresh key sits beside the shipped pages rather than replacing one. */
		const ENTRY_ID = 'archived-sessions'
		/** Group key for archived sessions no live workspace accounts for. */
		const UNGROUPED = '\u0000ungrouped'
		/** How often the page re-reads the namespace while a restore is in flight. */
		const POLL_MS = 400

		const css = {
			hint: {
				margin: '0 0 14px',
				fontSize: 13,
				lineHeight: 1.7,
				color: 'var(--dsw-alias-label-secondary)',
			},
			group: { marginBottom: 18 },
			groupHead: {
				display: 'flex',
				alignItems: 'baseline',
				gap: 8,
				margin: '0 0 6px',
				fontSize: 13,
				fontWeight: 600,
				color: 'var(--dsw-alias-label-primary)',
			},
			groupPath: {
				fontSize: 11,
				fontWeight: 400,
				color: 'var(--dsw-alias-label-tertiary)',
				wordBreak: 'break-all',
			},
			row: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 12,
				padding: '8px 12px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 8,
				background: 'var(--dsw-alias-bg-layer-1)',
				marginBottom: 6,
			},
			title: {
				fontSize: 13,
				color: 'var(--dsw-alias-label-primary)',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			ok: { margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
			error: { margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
			empty: { margin: '0', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
		}

		/** Turn any thrown value into displayable text. */
		function messageOf(error) {
			if (error === undefined || error === null) return '未知错误'
			if (typeof error === 'string') return error
			if (typeof error.message === 'string' && error.message.length > 0) return error.message
			return String(error)
		}

		/** Pull the failure text out of a `RemoteResult` error branch. */
		function errorOf(result) {
			const error = result === undefined || result === null ? undefined : result.error
			if (error === undefined || error === null) return '请求失败'
			return messageOf(error)
		}

		/**
		 * Bucket archived sessions by the workspace that accounted for them
		 * before archiving.
		 *
		 * Ownership is read from the live workspace rows first, because an
		 * archived session deliberately keeps its `sessionIds` slot so that
		 * restoring returns it to its old position. Only when no workspace
		 * accounts for the id — the workspace was removed, which drops the slot —
		 * does the session's recorded `cwd` decide the bucket, and a session whose
		 * directory matches no live workspace lands under 未分组.
		 *
		 * @param workspaces - the workspace snapshot.
		 * @param sessions - the session snapshot.
		 * @returns one group per workspace, in snapshot order.
		 */
		function groupArchived(workspaces, sessions) {
			const archived = workspaces === undefined || workspaces === null ? [] : workspaces.archivedSessionIds || []
			const items = workspaces === undefined || workspaces === null ? [] : workspaces.items || []
			const byId = sessions === undefined || sessions === null ? {} : sessions.byId || {}
			const groups = new Map()

			for (const id of archived) {
				const summary = byId[id]
				if (summary === undefined || summary === null) continue

				let owner
				for (const workspace of items) {
					if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)) {
						owner = workspace
						break
					}
				}
				if (owner === undefined && typeof summary.cwd === 'string') {
					for (const workspace of items) {
						if (workspace.path === summary.cwd) {
							owner = workspace
							break
						}
					}
				}

				const key = owner === undefined ? UNGROUPED : String(owner.workspaceId)
				if (!groups.has(key)) {
					groups.set(key, {
						key,
						label: owner === undefined ? '未分组' : owner.title || owner.path,
						path: owner === undefined ? undefined : owner.path,
						rows: [],
					})
				}
				groups.get(key).rows.push({
					id,
					title: summary.displayTitle || summary.title || id,
				})
			}
			return Array.from(groups.values())
		}

		/**
		 * Client plugin body: one Settings page listing archived sessions and
		 * restoring them through the host half.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			/**
			 * The page. The settings shell provides the snapshot selectors, so this
			 * component subscribes to nothing itself.
			 * @param props - owner props plus the shell's standard settings props.
			 */
			function ArchivedSessionsSection(props) {
				const useWorkspaces = props.useWorkspaces
				const useSessions = props.useSessions
				const workspaces = useWorkspaces((snapshot) => snapshot)
				const sessions = useSessions((snapshot) => snapshot)

				/** nonce -> sessionId, for restores currently in flight. */
				const [pending, setPending] = React.useState({})
				/** The last outcome, shown above the list. */
				const [notice, setNotice] = React.useState(undefined)
				/** Compare-and-set revision of the namespace, read at write time. */
				const [revision, setRevision] = React.useState(undefined)

				const groups = React.useMemo(
					() => groupArchived(workspaces, sessions),
					[workspaces, sessions],
				)
				const total = groups.reduce((count, group) => count + group.rows.length, 0)
				const inFlight = new Set(Object.values(pending))

				/**
				 * Poll the namespace while anything is in flight. The host half
				 * answers asynchronously (its watcher drains the request), so the
				 * result is observed rather than returned from the write.
				 */
				React.useEffect(() => {
					const nonces = Object.keys(pending)
					if (nonces.length === 0) return undefined
					let alive = true

					const tick = async () => {
						let result
						try {
							result = await ctx.remote.settings.describe()
						} catch (error) {
							return
						}
						if (!alive || result === undefined || result === null || result.ok !== true) return
						const namespaces = (result.value && result.value.namespaces) || []
						const entry = namespaces.find((item) => item !== null && typeof item === 'object' && item.ns === NS)
						if (entry === undefined) return
						const answered = (entry.value && entry.value.results) || {}
						const done = nonces.filter((nonce) => typeof answered[nonce] === 'string')
						if (done.length === 0) return

						const last = answered[done[done.length - 1]]
						setNotice(last === 'ok'
							? { kind: 'ok', text: '已恢复。' }
							: { kind: 'error', text: last.replace(/^error:\s*/, '') })

						setPending((previous) => {
							const next = Object.assign({}, previous)
							for (const nonce of done) delete next[nonce]
							return next
						})

						// Drop both entries so the namespace never accumulates. Both are
						// path-addressed, so an unrelated concurrent write is untouched.
						const ops = []
						for (const nonce of done) {
							ops.push({ op: 'unset', path: ['requests', nonce] })
							ops.push({ op: 'unset', path: ['results', nonce] })
						}
						try {
							const cleaned = await ctx.remote.settings.mutate(NS, ops, entry.revision)
							if (cleaned !== undefined && cleaned !== null && cleaned.ok === true) {
								setRevision(cleaned.value && cleaned.value.revision)
							}
						} catch (error) {
							// A failed cleanup is harmless: the host half ignores an
							// already-drained nonce, so a stale entry changes nothing.
						}
					}

					const timer = setInterval(() => { void tick() }, POLL_MS)
					void tick()
					return () => {
						alive = false
						clearInterval(timer)
					}
				}, [pending])

				/** Ask the host half to restore one session. */
				const restore = async (sessionId) => {
					const nonce = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
					setNotice(undefined)
					setPending((previous) => Object.assign({}, previous, { [nonce]: sessionId }))

					const ops = [{ op: 'set', path: ['requests', nonce], value: String(sessionId) }]
					const abandon = () => setPending((previous) => {
						const next = Object.assign({}, previous)
						delete next[nonce]
						return next
					})

					let result
					try {
						result = await ctx.remote.settings.mutate(NS, ops, revision)
					} catch (error) {
						abandon()
						setNotice({ kind: 'error', text: messageOf(error) })
						return
					}
					if (result === undefined || result === null || result.ok !== true) {
						abandon()
						setNotice({ kind: 'error', text: errorOf(result) })
						return
					}
					setRevision(result.value && result.value.revision)
				}

				const body = []
				body.push(h('p', { key: 'hint', style: css.hint },
					'已归档的会话不会出现在会话列表中。恢复后会回到归档前的工作区；'
					+ '若该工作区已不存在，则回到「未分组」。'))
				if (notice !== undefined) {
					body.push(h('p', { key: 'notice', style: notice.kind === 'ok' ? css.ok : css.error }, notice.text))
				}

				if (total === 0) {
					body.push(h('p', { key: 'empty', style: css.empty }, '没有已归档的会话。'))
					return h('div', null, body)
				}

				for (const group of groups) {
					const head = [h('span', { key: 'label' }, group.label)]
					if (typeof group.path === 'string') {
						head.push(h('span', { key: 'path', style: css.groupPath }, group.path))
					}
					const rows = group.rows.map((row) => {
						const busy = inFlight.has(row.id)
						return h('div', { key: row.id, style: css.row },
							h('span', { style: css.title, title: row.title }, row.title),
							h(Button, {
								variant: 'outline',
								size: 'sm',
								disabled: busy,
								'aria-label': '恢复会话「' + row.title + '」',
								onClick: () => { void restore(row.id) },
							}, busy ? '恢复中…' : '恢复'),
						)
					})
					body.push(h('div', { key: group.key, style: css.group },
						h('div', { style: css.groupHead }, head),
						rows,
					))
				}
				return h('div', null, body)
			}

			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				id: ENTRY_ID,
				order: 100,
				label: '已归档会话',
			}, ArchivedSessionsSection))
		}

		exports.apply = apply
		// `remote.settings` is required alongside `remote`: cordis resolves the
		// nested service by its own inject key, so a bare `remote` leaves
		// `ctx.remote.settings` throwing "cannot get property … without inject".
		exports.inject = ['slots', 'remote', 'remote.settings']
		return module.exports
	},
})
