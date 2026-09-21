/**
 * Workspace health — browser half.
 *
 * A hand-written client bundle in the shape the host's client-modules node half
 * serves. Executing this file only registers a factory; the module body runs at
 * materialization, and `apply` starts two consumers of one scan.
 *
 * ## What this does
 *
 * Deleting a workspace in dsh removes the registration and nothing else, while
 * each session's `cwd` stays frozen in its own log. When that directory is later
 * removed, the affected sessions keep working right up until a tool touches a
 * path that is no longer there — and the failure they produce points at the
 * file, never at the real cause.
 *
 * This half makes the cause visible in the two places it matters:
 *
 * 1. **The sidebar.** Every session row whose working directory is gone is drawn
 *    in the error colour, and hovering it says 当前会话工作区不存在. This is the
 *    surface a user actually browses, so it answers "why did that session
 *    suddenly break?" without opening anything.
 * 2. **A Settings page.** The same fact, grouped by directory, with counts and a
 *    per-group reason — the repair view, since one deleted directory typically
 *    strands several sessions and they are fixed together.
 *
 * ## Where the data comes from
 *
 * The host half publishes a `sessionId -> code` verdict into this plugin's
 * settings namespace on a timer. This half polls `settings.describe` for it —
 * the same channel `dsh-session-prompt` and `dsh-archived-sessions` use, and the
 * only host-to-browser path available without patching dsh's generated Remote
 * bindings.
 *
 * The poll is started once by `apply` and broadcast to both consumers, so two
 * features cost one request stream. Titles and paths are *not* fetched: the
 * settings shell already hands a `settings.section` entry the `useSessions`
 * snapshot selector, and the sidebar already renders those titles itself.
 *
 * ## How a sidebar row is identified
 *
 * A session row's DOM carries no id. `SessionNodeItem` renders a `div` with
 * `role="treeitem"` and nothing that names the session — no `data-` attribute,
 * no `aria-label` beyond the title, and `node.id` is used only as a React key,
 * which does not reach the DOM. So the id has to be read back from React.
 *
 * Every DOM node React creates carries a `__reactFiber$…` back-reference.
 * Walking up from the row reaches the `SessionNodeItem` fiber, whose
 * `memoizedProps` hold the session node. This is the only way to do it without
 * patching dsh, and it is the fragile part of this file: the property name is a
 * React implementation detail (matched by prefix, so a React bump that changes
 * the random suffix is fine, but a bump that drops the property is not).
 *
 * `role="treeitem"` is shared by three different rows — a workspace header, a
 * search result, and a session — so the walk looks for the props only a session
 * row has. See `sessionIdOf` for the discriminator.
 *
 * If the walk ever fails, the consequence is that rows stop being marked, which
 * is exactly the behaviour before this file existed. Nothing is broken.
 *
 * Only platform-seeded modules are required (`react` and
 * `@deepseek-ai/dsh-client-ui-primitives`), so `dsh.client.external` stays empty
 * and this row adds no edge to the module graph.
 */
window.__ModuleLoader__.load({
	id: 'dsh-workspace-health',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement

		/** Settings namespace owned by the host half. */
		const NS = 'workspace-health'
		/** The settings slot the page occupies. */
		const SLOT = 'settings.section'
		/** Own id: a fresh key sits beside the shipped pages rather than replacing one. */
		const ENTRY_ID = 'workspace-health'
		/** How often the scan is re-read. */
		const POLL_MS = 5000
		/** Group key for sessions whose own header records no usable cwd. */
		const UNKNOWN = '\u0000unknown'
		/** Attribute marking a sidebar session row whose working directory is gone. */
		const MARK = 'data-dsh-orphan'
		/** Hover text required of that mark. */
		const MARK_TITLE = '当前会话工作区不存在'
		/** How far up the fiber tree to look for the owning component. */
		const FIBER_DEPTH = 12

		/** Display text per host classification code. */
		const REASON_TEXT = {
			missing: '目录不存在',
			'not-a-directory': '这个路径不是目录',
			'no-cwd': '会话没有记录工作目录',
		}

		const css = {
			hint: {
				margin: '0 0 14px',
				fontSize: 13,
				lineHeight: 1.7,
				color: 'var(--dsw-alias-label-secondary)',
			},
			summary: {
				margin: '0 0 14px',
				fontSize: 13,
				color: 'var(--dsw-alias-state-error-primary)',
			},
			group: { marginBottom: 18 },
			groupHead: {
				display: 'flex',
				alignItems: 'baseline',
				flexWrap: 'wrap',
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
			badge: {
				fontSize: 11,
				fontWeight: 400,
				padding: '1px 6px',
				borderRadius: 4,
				color: 'var(--dsw-alias-state-error-primary)',
				background: 'var(--dsw-alias-bg-layer-1)',
				border: '1px solid var(--dsw-alias-state-error-primary)',
			},
			row: {
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				padding: '6px 12px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 8,
				background: 'var(--dsw-alias-bg-layer-1)',
				marginBottom: 4,
			},
			title: {
				fontSize: 13,
				color: 'var(--dsw-alias-label-primary)',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			empty: { margin: '0', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
			loading: { margin: '0', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
			error: { margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
		}

		/**
		 * Styles for the sidebar mark.
		 *
		 * Anchored on `role="treeitem"` — a semantic attribute the browser rows
		 * own and a CSS-module rename cannot touch — plus the attribute this file
		 * adds. The descendant rule is what makes the title itself red: the title
		 * is its own `<span>` with its own `color`, so colouring only the row
		 * would be inherited by nothing. `<svg>`/`<path>` are excluded because
		 * they paint with `fill`, not `color`.
		 *
		 * @returns the stylesheet text.
		 */
		function marksCss() {
			return [
				'[role="treeitem"][' + MARK + '] { color: var(--dsw-alias-state-error-primary) !important; }',
				'[role="treeitem"][' + MARK + '] *:not(svg):not(path) { color: var(--dsw-alias-state-error-primary) !important; }',
			].join('\n')
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

		/* ── the shared scan ──────────────────────────────────────────────────── */

		/**
		 * The latest verdict, shared by both consumers so `apply` polls once.
		 *
		 * `orphans` stays `undefined` until the first successful reply, which is
		 * what keeps the sidebar unmarked (rather than marked-then-corrected)
		 * during startup.
		 */
		const health = {
			orphans: undefined,
			failure: undefined,
			listeners: new Set(),
		}

		/** Notify every subscriber that the verdict changed. */
		function notify() {
			for (const listener of Array.from(health.listeners)) {
				try {
					listener()
				} catch (error) {
					// One broken subscriber must not stop the others, and must not
					// escape into the poll loop that called this.
					console.warn('workspace-health: a subscriber threw', error)
				}
			}
		}

		/**
		 * Record a new verdict.
		 * @param orphans - sessionId -> code.
		 */
		function publishOrphans(orphans) {
			health.orphans = orphans
			health.failure = undefined
			notify()
		}

		/**
		 * Record a transport failure, keeping the last known verdict.
		 *
		 * Deliberately not clearing `orphans`: a hiccup would otherwise blink every
		 * mark off and back on, and an empty verdict would wrongly read as "all
		 * clear" on a page whose whole job is to report a problem.
		 * @param message - displayable failure text.
		 */
		function publishFailure(message) {
			health.failure = message
			notify()
		}

		/**
		 * Subscribe to verdict changes.
		 * @param listener - called on every change.
		 * @returns an unsubscribe function.
		 */
		function subscribe(listener) {
			health.listeners.add(listener)
			return () => { health.listeners.delete(listener) }
		}

		/* ── the sidebar mark ─────────────────────────────────────────────────── */

		/**
		 * Read the session id off a rendered sidebar row.
		 *
		 * React keeps a back-reference from every DOM node it creates to that
		 * node's fiber. Walking `return` from the row reaches the component that
		 * rendered it, and a session row is rendered by `SessionNodeItem`, whose
		 * props carry the session node.
		 *
		 * `role="treeitem"` identifies three unrelated rows, so the walk cannot
		 * simply take the first component it finds. The discriminator is the pair
		 * of props only a session row receives:
		 *
		 * - `node` — a workspace header gets `group`, and a search result gets
		 *   `result`; neither has `node`.
		 * - `onOpen` — a workspace header has no `onOpen`. A search result does,
		 *   which is exactly why `node` is required as well.
		 *
		 * @param element - a rendered `[role="treeitem"]`.
		 * @param cache - memo for the walk, keyed by element.
		 * @returns the session id, or `undefined` when this is not a session row.
		 */
		function sessionIdOf(element, cache) {
			if (cache !== undefined && cache.has(element)) return cache.get(element)

			let fiber
			for (const key of Object.keys(element)) {
				if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
					fiber = element[key]
					break
				}
			}

			let found
			for (let depth = 0; depth < FIBER_DEPTH && fiber !== undefined && fiber !== null; depth += 1) {
				const props = fiber.memoizedProps
				if (props !== undefined && props !== null && typeof props === 'object'
					&& props.node !== undefined && props.node !== null
					&& typeof props.node.id === 'string'
					&& typeof props.onOpen === 'function') {
					found = props.node.id
					break
				}
				fiber = fiber.return
			}

			// Only a definite answer is memoized. Caching a miss would pin the
			// decision made before React attached the reference, and the row would
			// stay unmarked forever.
			if (cache !== undefined && found !== undefined) cache.set(element, found)
			return found
		}

		/**
		 * Bring every rendered row in line with the current verdict.
		 *
		 * Setting and clearing the mark, rather than writing inline styles, keeps
		 * the stylesheet the single source of truth for what a mark looks like and
		 * makes the operation idempotent — which matters because it runs on every
		 * DOM mutation.
		 *
		 * @param orphans - sessionId -> code.
		 * @param cache - the session-id memo, shared across calls.
		 * @returns how many rows were left marked.
		 */
		function applyMarks(orphans, cache) {
			let marked = 0
			for (const row of document.querySelectorAll('[role="treeitem"]')) {
				const id = sessionIdOf(row, cache)
				const hit = id !== undefined && orphans !== undefined
					&& Object.prototype.hasOwnProperty.call(orphans, id)
				if (hit) {
					marked += 1
					if (row.getAttribute(MARK) !== 'true') {
						row.setAttribute(MARK, 'true')
						row.setAttribute('title', MARK_TITLE)
					}
				} else if (row.hasAttribute(MARK)) {
					row.removeAttribute(MARK)
					row.removeAttribute('title')
				}
			}
			return marked
		}

		/** Install the mark stylesheet once per document. */
		function injectMarksCss() {
			const id = 'dsh-workspace-health/marks'
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') !== null) return
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-workspace-health'
			tag.dataset.pluginCss = id
			tag.textContent = marksCss()
			document.head.appendChild(tag)
		}

		/**
		 * Keep the sidebar marked, for as long as this plugin is loaded.
		 *
		 * `MutationObserver` with `childList` and `subtree` only — deliberately not
		 * `attributes`, because this function writes attributes itself and would
		 * otherwise schedule a pass from every pass.
		 *
		 * Scrolling and re-renders produce bursts of mutations, so a pass is
		 * coalesced onto the next animation frame rather than run per notification.
		 *
		 * @returns a disposer that stops observing and unregisters.
		 */
		function startSidebarMarks() {
			injectMarksCss()
			const cache = new WeakMap()
			let frame

			const pass = () => {
				frame = undefined
				applyMarks(health.orphans, cache)
			}
			const schedule = () => {
				if (frame !== undefined) return
				frame = requestAnimationFrame(pass)
			}

			const observer = new MutationObserver(schedule)
			observer.observe(document.body, { childList: true, subtree: true })
			const unsubscribe = subscribe(schedule)
			schedule()

			return () => {
				observer.disconnect()
				unsubscribe()
				if (frame !== undefined) cancelAnimationFrame(frame)
			}
		}

		/* ── the settings page ────────────────────────────────────────────────── */

		/**
		 * Bucket unusable sessions by the directory they share.
		 *
		 * Grouping by directory rather than by session is the whole point of the
		 * page: one deleted directory typically strands several sessions, and it
		 * is repaired once. Sessions whose own header carried no usable cwd
		 * cannot be grouped that way and collect under a single trailing bucket.
		 *
		 * @param orphans - sessionId -> host classification code.
		 * @param sessions - the session snapshot, for titles and recorded cwd.
		 * @returns one group per directory, alphabetically, unknown-cwd last.
		 */
		function groupOrphans(orphans, sessions) {
			const source = orphans === undefined || orphans === null ? {} : orphans
			const byId = sessions === undefined || sessions === null ? {} : sessions.byId || {}
			const groups = new Map()

			for (const id of Object.keys(source).sort()) {
				const summary = byId[id]
				const raw = summary === undefined || summary === null ? undefined : summary.cwd
				const cwd = typeof raw === 'string' && raw.length > 0 ? raw : undefined
				const key = cwd === undefined ? UNKNOWN : cwd
				if (!groups.has(key)) {
					groups.set(key, { key, cwd, reason: source[id], rows: [] })
				}
				groups.get(key).rows.push({
					id,
					title: (summary && (summary.displayTitle || summary.title)) || id,
				})
			}

			return Array.from(groups.values()).sort((left, right) => {
				if (left.cwd === undefined && right.cwd === undefined) return 0
				if (left.cwd === undefined) return 1
				if (right.cwd === undefined) return -1
				return left.cwd.localeCompare(right.cwd)
			})
		}

		/**
		 * The page. The settings shell provides the snapshot selector; the host's
		 * verdict arrives through the shared scan.
		 * @param props - owner props plus the shell's standard settings props.
		 */
		function WorkspaceHealthSection(props) {
			const useSessions = props.useSessions
			const sessions = useSessions((snapshot) => snapshot)

			const [view, setView] = React.useState({ orphans: health.orphans, failure: health.failure })
			React.useEffect(() => subscribe(() => setView({ orphans: health.orphans, failure: health.failure })), [])

			const orphans = view.orphans
			const failure = view.failure
			const groups = React.useMemo(() => groupOrphans(orphans, sessions), [orphans, sessions])
			const total = groups.reduce((count, group) => count + group.rows.length, 0)

			const body = []
			body.push(h('p', { key: 'hint', style: css.hint },
				'删除一个工作区只会移除它的注册记录，目录和会话日志都保留；'
				+ '而每个会话的工作目录是写死在自己日志里的，不会被改写。'
				+ '所以目录一旦真的被删掉，受影响会话还会照常打开，'
				+ '直到某个工具碰到一个已经不存在的路径才报错——而报错只会提到那个文件。'))
			body.push(h('p', { key: 'hint2', style: css.hint },
				'工作目录不可用的会话在左侧栏里显示为红色，鼠标悬停会看到提示。'
				+ '下面按目录归好：把目录恢复、或在 DSH 里重新添加该工作区，就能一次修好一整组。'))

			if (failure !== undefined) {
				body.push(h('p', { key: 'failure', style: css.error }, '读取扫描结果失败：' + failure))
			}
			if (orphans === undefined) {
				body.push(h('p', { key: 'loading', style: css.loading }, '正在读取…'))
				return h('div', null, body)
			}
			if (total === 0) {
				body.push(h('p', { key: 'empty', style: css.empty }, '所有会话的工作目录都在。'))
				return h('div', null, body)
			}

			body.push(h('p', { key: 'summary', style: css.summary },
				`${total} 个会话的工作目录不可用，分布在 ${groups.length} 个目录下。`))

			for (const group of groups) {
				const head = []
				head.push(h('span', { key: 'path', style: css.groupPath },
					group.cwd === undefined ? '（未记录工作目录）' : group.cwd))
				head.push(h('span', { key: 'reason', style: css.badge },
					REASON_TEXT[group.reason] || group.reason || '状态未知'))
				const rows = group.rows.map((row) => h('div', { key: row.id, style: css.row },
					h('span', { style: css.title, title: row.title }, row.title),
				))
				body.push(h('div', { key: group.key, style: css.group },
					h('div', { style: css.groupHead }, head),
					rows,
				))
			}
			return h('div', null, body)
		}

		/**
		 * Client plugin body: start the sidebar mark and register the Settings page.
		 * @param ctx - client root context.
		 * @returns a disposer, for the loader that honours one.
		 */
		function apply(ctx) {
			// Started before the page is registered: the sidebar mark is the surface
			// a user meets without ever opening Settings.
			const stopMarks = startSidebarMarks()

			let alive = true
			const tick = async () => {
				let result
				try {
					result = await ctx.remote.settings.describe()
				} catch (error) {
					if (alive) publishFailure(messageOf(error))
					return
				}
				if (!alive) return
				if (result === undefined || result === null || result.ok !== true) {
					publishFailure(errorOf(result))
					return
				}
				const namespaces = (result.value && result.value.namespaces) || []
				const entry = namespaces.find((item) => item !== null && typeof item === 'object' && item.ns === NS)
				publishOrphans((entry && entry.value && entry.value.orphans) || {})
			}

			const timer = setInterval(() => { void tick() }, POLL_MS)
			void tick()

			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				id: ENTRY_ID,
				order: 110,
				label: '工作区健康',
			}, WorkspaceHealthSection))

			const cleanup = () => {
				alive = false
				clearInterval(timer)
				stopMarks()
			}
			// Two ways in, because the client loader's contract for a returned
			// function is not guaranteed: whichever it honours, both paths run the
			// same idempotent cleanup.
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => cleanup, 'workspace-health.lifecycle')
			}
			return cleanup
		}

		exports.apply = apply
		// `remote.settings` is required alongside `remote`: cordis resolves the
		// nested service by its own inject key, so a bare `remote` leaves
		// `ctx.remote.settings` throwing "cannot get property … without inject".
		exports.inject = ['slots', 'remote', 'remote.settings']
		// Exposed so verify.mjs can exercise the pure logic without a browser:
		// `apply` is never called there, so nothing is registered or observed.
		exports.groupOrphans = groupOrphans
		exports.sessionIdOf = sessionIdOf
		exports.applyMarks = applyMarks
		exports.marksCss = marksCss
		exports.REASON_TEXT = REASON_TEXT
		exports.MARK = MARK
		exports.MARK_TITLE = MARK_TITLE
		return module.exports
	},
})
