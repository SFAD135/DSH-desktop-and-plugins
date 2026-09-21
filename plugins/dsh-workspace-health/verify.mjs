/**
 * Offline checks for dsh-workspace-health.
 *
 *   node verify.mjs
 *
 * Runs from this directory. The host half imports only node builtins plus
 * `@deepseek-ai/schemastery`; the client half is loaded through a stand-in
 * `window.__ModuleLoader__` with a minimal `react` mock, so the grouping logic
 * can be exercised without a browser.
 *
 * The decisive properties are: that the classification distinguishes a missing
 * directory from a plain file, that a steady state publishes nothing, and that
 * the client declares `remote.settings` (whose absence once shipped as a bug in
 * the sibling plugin).
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apply,
  classify,
  Config,
  HEALTHY,
  inject,
  MISSING,
  name,
  NAMESPACE,
  NO_CWD,
  NOT_A_DIRECTORY,
  SCAN_MS,
  scanHeaders,
} from './lib/index.js'

/** This plugin's directory: a real directory, used where a live cwd is needed. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** A path that is not expected to exist on any machine running these checks. */
const ABSENT = 'D:\\__workspace-health-absent__'

const checks = []
const failures = []

function check(label, condition, detail) {
  checks.push(label)
  if (!condition) failures.push(label)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}
function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** A stat stand-in: a Set of paths that are directories, and one that is a file. */
function statWith(directories, files = []) {
  const dirs = new Set(directories)
  const plain = new Set(files)
  return (path) => {
    if (dirs.has(path)) return { isDirectory: () => true }
    if (plain.has(path)) return { isDirectory: () => false }
    const error = new Error(`ENOENT: no such file or directory, stat '${path}'`)
    error.code = 'ENOENT'
    throw error
  }
}

/** Session headers as the session store reports them. */
function headersOf(entries) {
  return entries.map(([id, cwd]) => ({ id, cwd }))
}

/** Snapshot stand-in: the shape `sessionPersistence.list()` resolves to. */
function snapshotsOf(entries) {
  return headersOf(entries).map((header) => ({ header }))
}

/* ── host: shape ─────────────────────────────────────────────────────────── */

console.log('host shape:')

equal('name', name, 'workspace-health')
equal('inject declares settings + sessionPersistence', inject, ['settings', 'sessionPersistence'])
equal('namespace', NAMESPACE, 'workspace-health')
check('Config describes an orphans map', Config !== undefined && Config !== null)
check('a scan interval is declared', typeof SCAN_MS === 'number' && SCAN_MS > 0)

/* ── host: classification ────────────────────────────────────────────────── */

console.log('\nclassification:')

const stat = statWith(['D:\\live'], ['D:\\a-file.txt'])
equal('a directory is live', classify('D:\\live', stat), HEALTHY)
equal('a plain file is not a directory', classify('D:\\a-file.txt', stat), NOT_A_DIRECTORY)
equal('an absent path is missing', classify('D:\\gone', stat), MISSING)
equal('undefined cwd is reported as such', classify(undefined, stat), NO_CWD)
equal('an empty cwd is reported as such', classify('', stat), NO_CWD)
equal('a blank cwd is reported as such', classify('   ', stat), NO_CWD)
equal('a non-string cwd is reported as such', classify(42, stat), NO_CWD)

// And once against the real filesystem, so the injected probe cannot hide a
// misunderstanding about what statSync actually returns.
equal('a real directory classifies live', classify(process.cwd()), HEALTHY)
equal('a real absent path classifies missing', classify('D:\\__workspace-health-absent__'), MISSING)

/* ── host: scanning ──────────────────────────────────────────────────────── */

console.log('\nscanning:')

const mixed = headersOf([
  ['live-1', 'D:\\live'],
  ['live-2', 'D:\\live'],
  ['gone-1', 'D:\\gone'],
  ['file-1', 'D:\\a-file.txt'],
  ['nocwd-1', undefined],
])
equal('only the unusable sessions are reported', scanHeaders(mixed, stat), {
  'gone-1': MISSING,
  'file-1': NOT_A_DIRECTORY,
  'nocwd-1': NO_CWD,
})
equal('a fully healthy set reports nothing', scanHeaders(headersOf([['a', 'D:\\live']]), stat), {})
equal('an empty list reports nothing', scanHeaders([], stat), {})
equal('a missing input reports nothing', scanHeaders(undefined, stat), {})
equal('a null input reports nothing', scanHeaders(null, stat), {})
// A malformed entry is skipped rather than reported: without an id there is
// nothing the page could name, and it is not a finding about the user's disk.
equal('a null header is skipped', scanHeaders([null], stat), {})
equal('a header without an id is skipped', scanHeaders([{ cwd: 'D:\\gone' }], stat), {})
equal('an empty id is skipped', scanHeaders([{ id: '', cwd: 'D:\\gone' }], stat), {})
equal('a header with a null cwd is reported as having none', scanHeaders([{ id: 'x', cwd: null }], stat), { x: NO_CWD })

/* ── host: publishing ────────────────────────────────────────────────────── */

console.log('\npublishing:')

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const timers = []
const cleared = []
globalThis.setInterval = (fn) => {
  timers.push(fn)
  return timers.length
}
globalThis.clearInterval = (id) => { cleared.push(id) }

/** Let the fire-and-forget `scan()` inside the timer callback settle. */
const flush = () => new Promise((resolve) => realSetInterval(resolve, 0))

try {
  // `apply` scans through the real `statSync`, so these fixtures must name a
  // directory that genuinely exists (this one) and one that genuinely does not.
  const published = []
  let entries = [['live-1', HERE], ['gone-1', ABSENT]]
  const store = { list: async () => snapshotsOf(entries) }
  const disposers = []
  apply({
    settings: { register: () => ({ replace: async (value) => { published.push(value) } }) },
    sessionPersistence: store,
    effect: (fn) => { disposers.push(fn()) },
    logger: { warn: () => {} },
  }, {})

  equal('one timer is armed', timers.length, 1)
  equal('one disposer is registered', disposers.length, 1)
  await flush()
  equal('the first scan publishes once', published.length, 1)
  equal('the published value carries the orphan map', published[0], { orphans: { 'gone-1': MISSING } })

  // The same verdict must not be written again: this is what keeps a steady
  // state from rewriting the settings file every ten seconds.
  await timers[0]()
  await flush()
  equal('an unchanged verdict is not republished', published.length, 1)

  // Break a second session's directory and the verdict must change.
  entries = [['live-1', ABSENT + '\\also-gone'], ['gone-1', ABSENT]]
  await timers[0]()
  await flush()
  equal('a changed verdict is republished', published.length, 2)
  equal('the republished value is the new map', published[1], {
    orphans: { 'live-1': MISSING, 'gone-1': MISSING },
  })

  // A write that throws must not pin the browser to a stale verdict forever.
  const failing = []
  let fail = true
  apply({
    settings: {
      register: () => ({
        replace: async (value) => {
          failing.push(value)
          if (fail) throw new Error('disk is read-only')
        },
      }),
    },
    sessionPersistence: store,
    effect: (fn) => { disposers.push(fn()) },
    logger: { warn: () => {} },
  }, {})
  await flush()
  equal('a failed publish is recorded', failing.length, 1)
  fail = false
  await timers[1]()
  await flush()
  equal('the next tick retries a failed publish', failing.length, 2)

  // A store that throws must publish nothing at all: reporting every session as
  // broken because the listing hiccuped would be far worse than reporting none.
  const afterListingFailure = []
  apply({
    settings: { register: () => ({ replace: async (value) => { afterListingFailure.push(value) } }) },
    sessionPersistence: { list: async () => { throw new Error('store unavailable') } },
    effect: (fn) => { disposers.push(fn()) },
    logger: { warn: () => {} },
  }, {})
  await flush()
  await timers[2]()
  await flush()
  equal('a failed listing publishes nothing', afterListingFailure.length, 0)

  disposers[0]()
  equal('disposing the effect clears its timer', cleared.length, 1)
} finally {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}

/* ── client: module shape ────────────────────────────────────────────────── */

console.log('\nclient module:')

const spec = { captured: undefined }
globalThis.window = { __ModuleLoader__: { load: (value) => { spec.captured = value } } }
const clientUrl = new URL('./lib/client.js', import.meta.url)
await import(clientUrl.href)

check('the client registers exactly one module', spec.captured !== undefined)
equal('the module id matches the package', spec.captured.id, 'dsh-workspace-health')

const mockRequire = (request) => {
  if (request === 'react') {
    return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: (fn) => fn() }
  }
  if (request === '@deepseek-ai/dsh-client-ui-primitives') return { Button: () => null }
  throw new Error('unexpected require: ' + request)
}
const client = spec.captured.factory(mockRequire)

check('apply is exported', typeof client.apply === 'function')
// The regression that shipped once in the sibling plugin: a bare `remote`
// leaves `ctx.remote.settings` throwing at runtime.
equal('inject declares remote.settings', client.inject, ['slots', 'remote', 'remote.settings'])
check('groupOrphans is exported for these checks', typeof client.groupOrphans === 'function')
check('a code-to-text map is exported', typeof client.REASON_TEXT === 'object')
check('every host code has display text',
  [MISSING, NOT_A_DIRECTORY, NO_CWD].every((code) => typeof client.REASON_TEXT[code] === 'string'))
check('sessionIdOf is exported for these checks', typeof client.sessionIdOf === 'function')
check('applyMarks is exported for these checks', typeof client.applyMarks === 'function')
check('marksCss is exported for these checks', typeof client.marksCss === 'function')
check('a mark attribute is declared', typeof client.MARK === 'string' && client.MARK.length > 0)
check('the hover text is what the feature asked for', client.MARK_TITLE === '当前会话工作区不存在')

/* ── client: grouping ────────────────────────────────────────────────────── */

console.log('\ngrouping:')

const sessions = {
  byId: {
    a: { cwd: 'D:\\gone', title: '会话 A' },
    b: { cwd: 'D:\\gone', title: '会话 B' },
    c: { cwd: 'D:\\other', displayTitle: '会话 C', title: 'ignored' },
    d: {},
  },
}

const grouped = client.groupOrphans(
  { a: MISSING, b: MISSING, c: NOT_A_DIRECTORY, d: NO_CWD },
  sessions,
)
equal('one group per distinct directory, unknown last', grouped.map((group) => group.cwd), ['D:\\gone', 'D:\\other', undefined])
equal('sessions sharing a directory share a group', grouped[0].rows.map((row) => row.id), ['a', 'b'])
equal('the group carries the reason', grouped[0].reason, MISSING)
equal('displayTitle wins over title', grouped[1].rows[0].title, '会话 C')
equal('a session without a recorded cwd lands in the last group', grouped[2].rows[0].id, 'd')
const noSnapshot = client.groupOrphans({ zzz: MISSING }, {})
equal('a session with no snapshot still gets one group', noSnapshot.length, 1)
equal('its title falls back to the id', noSnapshot[0].rows[0].title, 'zzz')
check('its group records no path', noSnapshot[0].cwd === undefined)
check('its group key is the sentinel, so it cannot collide with a real path', noSnapshot[0].key.startsWith('\u0000'))
equal('groups are ordered by path', client.groupOrphans(
  { x: MISSING, y: MISSING },
  { byId: { x: { cwd: 'D:\\zzz' }, y: { cwd: 'D:\\aaa' } } },
).map((group) => group.cwd), ['D:\\aaa', 'D:\\zzz'])
equal('no orphans means no groups', client.groupOrphans({}, sessions), [])
equal('a missing input means no groups', client.groupOrphans(undefined, undefined), [])
equal('a null input means no groups', client.groupOrphans(null, null), [])

/* ── client: the sidebar mark ────────────────────────────────────────────── */

console.log('\nsidebar mark:')

/** A DOM stand-in: an attribute bag plus the React fiber back-reference. */
function fakeRow(fiber, attributes = {}, key = '__reactFiber$test') {
  const attrs = Object.assign({}, attributes)
  const element = {
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = value },
    removeAttribute: (name) => { delete attrs[name] },
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    __attrs: attrs,
  }
  if (fiber !== undefined) element[key] = fiber
  return element
}

/**
 * Build a fiber chain the way React nests it: the row's own fiber innermost,
 * each `return` pointing at the enclosing component.
 */
function fiberChain(...propList) {
  let parent
  for (const props of propList) parent = { memoizedProps: props, return: parent }
  return parent
}

/**
 * The nesting a session row really has: the row's `div`, then `HoverCard`, then
 * `SessionNodeItem` holding the props that name the session.
 */
function sessionRowFiber(id) {
  return fiberChain(
    { node: { id }, currentId: 'some-other-session', onOpen: () => {} },
    { anchor: null, content: null, disabled: false },
    { role: 'treeitem' },
  )
}

check('a session row yields its id', client.sessionIdOf(fakeRow(sessionRowFiber('s-1'))) === 's-1')
check('the fiber key is matched by prefix, not by exact name',
  client.sessionIdOf(fakeRow(sessionRowFiber('s-2'), {}, '__reactFiber$differentSuffix')) === 's-2')
check('React 16 spellings still work',
  client.sessionIdOf(fakeRow(sessionRowFiber('s-3'), {}, '__reactInternalInstance$test')) === 's-3')

// The three rows that share role="treeitem" must not be confused with each
// other. A workspace header has `group`; a search result has `result` and even
// an `onOpen`, which is why `node` is required as well.
check('a workspace header is not a session row',
  client.sessionIdOf(fakeRow(fiberChain({ group: { key: 'g' }, onToggle: () => {} }, { role: 'treeitem' }))) === undefined)
check('a search result is not a session row',
  client.sessionIdOf(fakeRow(fiberChain({ result: { id: 'r' }, currentId: 'c', onOpen: () => {} }, { role: 'treeitem' }))) === undefined)
check('a row with no fiber yields nothing', client.sessionIdOf(fakeRow(undefined)) === undefined)
check('a non-string node id is rejected',
  client.sessionIdOf(fakeRow(fiberChain({ node: { id: 42 }, onOpen: () => {} }))) === undefined)
check('a null node is rejected',
  client.sessionIdOf(fakeRow(fiberChain({ node: null, onOpen: () => {} }))) === undefined)
check('a node without onOpen is rejected',
  client.sessionIdOf(fakeRow(fiberChain({ node: { id: 'x' } }))) === undefined)

const deep = fiberChain(
  { node: { id: 'deep' }, onOpen: () => {} },
  ...Array.from({ length: 14 }, () => ({ filler: true })),
)
check('a component beyond the depth limit is not searched', client.sessionIdOf(fakeRow(deep)) === undefined)

const cache = new WeakMap()
const cachedRow = fakeRow(sessionRowFiber('cached'))
check('the walk finds the id', client.sessionIdOf(cachedRow, cache) === 'cached')
equal('a hit is memoized', cache.get(cachedRow), 'cached')

// A miss must NOT be memoized. React attaches the back-reference to a DOM node
// it created; caching the miss would freeze that row unmarked forever.
const lateRow = fakeRow(undefined)
check('a first look with no fiber yields nothing', client.sessionIdOf(lateRow, cache) === undefined)
check('that miss was not memoized', cache.has(lateRow) === false)
lateRow['__reactFiber$test'] = sessionRowFiber('late')
check('a later look succeeds once the reference is attached', client.sessionIdOf(lateRow, cache) === 'late')

const orphanRow = fakeRow(sessionRowFiber('orphan-1'))
const liveRow = fakeRow(sessionRowFiber('live-1'))
const recovered = fakeRow(sessionRowFiber('was-orphan'), {
  [client.MARK]: 'true',
  title: client.MARK_TITLE,
})

const previousDocument = globalThis.document
globalThis.document = { querySelectorAll: () => [orphanRow, liveRow, recovered] }
try {
  equal('only the orphan is counted', client.applyMarks({ 'orphan-1': MISSING }, new WeakMap()), 1)
  equal('the orphan row is marked', orphanRow.__attrs[client.MARK], 'true')
  equal('the orphan row gets the hover text', orphanRow.__attrs.title, client.MARK_TITLE)
  check('a live row is left alone', liveRow.hasAttribute(client.MARK) === false)
  check('a row that recovered loses its mark', recovered.hasAttribute(client.MARK) === false)
  check('a row that recovered loses its hover text', recovered.hasAttribute('title') === false)

  // Idempotence matters because a pass runs on every DOM mutation.
  equal('a second pass still counts the orphan', client.applyMarks({ 'orphan-1': MISSING }, new WeakMap()), 1)
  equal('and leaves the attribute as it was', orphanRow.__attrs[client.MARK], 'true')

  equal('an empty verdict unmarks everything', client.applyMarks({}, new WeakMap()), 0)
  check('the orphan row is unmarked', orphanRow.hasAttribute(client.MARK) === false)
  check('and its hover text is gone', orphanRow.hasAttribute('title') === false)
} finally {
  globalThis.document = previousDocument
}

const marks = client.marksCss()
check('the mark stylesheet anchors on the semantic role', marks.includes('[role="treeitem"]'))
check('it targets the declared attribute', marks.includes('[' + client.MARK + ']'))
check('it forces the colour, or the row rules would win', marks.includes('!important'))
check('it uses the theme error colour rather than a hard-coded red', marks.includes('--dsw-alias-state-error-primary'))
check('it does not try to recolour svg paint', marks.includes(':not(svg)'))

/* ── static regression ───────────────────────────────────────────────────── */

console.log('\nstatic regression:')

const clientSource = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

check('the page registers into settings.section', clientSource.includes("const SLOT = 'settings.section'"))
check('the page name matches the host namespace', clientSource.includes("const NS = 'workspace-health'"))
check('the client declares its own slot id', clientSource.includes("const ENTRY_ID = 'workspace-health'"))
equal('the manifest declares a web client half', manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform, 'web')
check('the manifest exports the client entry', manifest.exports['./client'] === './lib/client.js')

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${checks.length} checks`)
  process.exit(0)
}
console.log(`FAIL — ${failures.length} of ${checks.length}: ${failures.join(', ')}`)
process.exit(1)
