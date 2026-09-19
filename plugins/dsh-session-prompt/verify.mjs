/**
 * Offline smoke test for dsh-session-prompt.
 *
 *   node verify.mjs
 *
 * Run it from the installed package directory (so `@deepseek-ai/schemastery`
 * resolves). It checks the host half's per-agent registration and the client
 * bundle's factory shape, then renders the control against a React stub and
 * asserts what each half does with one session's text. It does not touch the
 * running GUI.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const checks = []
const failures = []

function check(name, condition, detail) {
  checks.push(name)
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** A tick, so an awaited Remote round-trip can settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/* ── host half ───────────────────────────────────────────────────────────── */

console.log('\nhost half:')
const host = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)

equal('inject declares settings + systemPrompt + agents', host.inject, ['settings', 'systemPrompt', 'agents'])

/**
 * Build a fake host context whose settings namespace holds a real, mutable
 * value, mirroring the provider contract `scope.get()` reads.
 */
function makeHost() {
  const record = {
    namespaces: [],
    /** agent -> the section it registered */
    sections: new Map(),
    listeners: new Map(),
    effectLabels: [],
    /** The namespace's live value, as a provider would resolve it. */
    value: { prompts: {} },
    /** Agents the registry reports. */
    agents: [],
  }
  const makeAgent = (sessionId) => {
    const agent = { session: { id: sessionId } }
    agent.ctx = {
      inject(names, callback) {
        callback({ systemPrompt: { section: (section) => { record.sections.set(agent, section); return () => {} } } })
        return { dispose: () => Promise.resolve() }
      },
    }
    return agent
  }
  record.makeAgent = makeAgent
  record.addAgent = (sessionId) => {
    const agent = makeAgent(sessionId)
    record.agents.push(agent)
    const listener = record.listeners.get('agent/created')
    if (listener !== undefined) listener({ agent })
    return agent
  }
  const ctx = {
    logger: { warn() {} },
    effect(fn, label) {
      record.effectLabels.push(label)
      return fn()
    },
    on(event, listener) {
      record.listeners.set(event, listener)
      return () => {}
    },
    agents: { list: () => [...record.agents] },
    settings: {
      register(ns, schema, options) {
        record.namespaces.push({ ns, schema, options })
        return { get: () => record.value, watch: () => () => {} }
      },
    },
  }
  record.ctx = ctx
  return record
}

const off = makeHost()
off.addAgent('session-B') // alive before the plugin loads
host.apply(off.ctx, {})

equal('registers one settings namespace', off.namespaces.map((entry) => entry.ns), ['session-prompt'])
equal('registers no global prompt section', off.sections.size, 1)
equal('owning exactly one effect', off.effectLabels.length, 1)
check('subscribes to agent/created', off.listeners.has('agent/created'))
check('subscribes to agent/disposed', off.listeners.has('agent/disposed'))

const agentA = off.addAgent('session-A')
const agentB = off.agents[0]
const sectionA = off.sections.get(agentA)
const sectionB = off.sections.get(agentB)

check('every live agent got a section', sectionA !== undefined && sectionB !== undefined)
equal('section name', sectionA.name, 'user:session-prompt')
equal('section order (after persona 0, before plan 500)', sectionA.order, 10)
check('section text is a function, so it re-evaluates per request', typeof sectionA.text === 'function')

check('unset session renders to empty text', sectionA.text() === '' && sectionB.text() === '', JSON.stringify([sectionA.text(), sectionB.text()]))

// The decisive property: one session's text reaches that session and no other.
off.value.prompts = { 'session-A': 'always answer in Chinese', 'session-B': 'reply in Japanese' }
check('session A sees only its own text', sectionA.text() === 'always answer in Chinese', JSON.stringify(sectionA.text()))
check('session B sees only its own text', sectionB.text() === 'reply in Japanese', JSON.stringify(sectionB.text()))

off.value.prompts = { 'session-A': 'always answer in Chinese' }
check('a session with no entry renders empty while its neighbour does not', sectionA.text() === 'always answer in Chinese' && sectionB.text() === '', JSON.stringify([sectionA.text(), sectionB.text()]))

off.value = { prompts: undefined }
check('a malformed namespace value renders empty instead of throwing', sectionA.text() === '')

off.value = { prompts: { 'session-A': 'aaa', 'session-B': 'bbb' }, disabled: { 'session-A': true } }
check('a session switched off renders empty', sectionA.text() === '', JSON.stringify(sectionA.text()))
check('switching one session off leaves its neighbour injecting', sectionB.text() === 'bbb', JSON.stringify(sectionB.text()))

off.value = { prompts: { 'session-A': '   ' } }
check('whitespace-only text renders empty', sectionA.text() === '')

off.value = { prompts: { 'session-A': 'kept' }, disabled: { 'session-A': false } }
check('an explicit enabled:false neighbour keeps injecting', sectionA.text() === 'kept', JSON.stringify(sectionA.text()))

/* The real schema, through the real schemastery, must accept and default both maps. */
const parsed = host.Config({ prompts: { s1: 'hello' }, disabled: { s1: true } })
equal('schema defaults the disabled map when absent', host.Config({ prompts: { s1: 'x' } }).disabled, {})
equal('schema keeps a string text map', parsed.prompts, { s1: 'hello' })
equal('schema keeps a boolean disabled map', parsed.disabled, { s1: true })
equal('entryOf reports text plus enabled state', host.entryOf(parsed, 's1'), { text: 'hello', enabled: false })
check('promptOf suppresses a disabled session', host.promptOf(parsed, 's1') === '')
check('promptOf returns nothing for an unknown session', host.promptOf(parsed, 'absent') === '')

/* ── client bundle ───────────────────────────────────────────────────────── */

console.log('\nclient bundle:')

const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
check('bundle calls the module-loader facade', /window\.__ModuleLoader__\.load\(\{/.test(source))
equal('bundle declares the package id', /id:\s*'dsh-session-prompt'/.test(source), true)
check('bundle contains no import/export syntax', !/^\s*(import|export)\s/m.test(source))
check('bundle uses the composer send-button token', source.includes('--dsw-alias-button-info-fill'))
check('bundle writes through path-addressed mutate ops', source.includes("op: 'set'") && source.includes("op: 'unset'"))
check('bundle keeps the enable switch', source.includes('Switch'))

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}
await import(pathToFileURL(join(here, 'lib', 'client.js')).href)

check('bundle registers a factory', definition !== undefined && typeof definition.factory === 'function')
equal('bundle id is the package name', definition.id, 'dsh-session-prompt')

/** A React stub: enough for this plugin's render path, no DOM. */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children }
  },
  Fragment: Symbol('react.fragment'),
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(fn) {
    fn()
  },
  useRef(initial) {
    return { current: initial }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

const primitivesStub = {
  Button: () => null,
  Modal: () => null,
  Switch: () => null,
  IconContextInjectionOutline16: () => null,
}

const clientExports = definition.factory((specifier) => {
  if (specifier === 'react') return ReactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require("${specifier}")`)
})

check('client half exports apply', typeof clientExports.apply === 'function')
equal('client half declares its services', clientExports.inject, ['slots', 'remote', 'remote.settings'])

const store = { prompts: { 'session-A': 'always answer in Chinese' }, disabled: {}, revision: 7 }
const mutations = []

const clientCtx = {
  slots: {
    inject(slotName, callback) {
      check('registers into the composer tool row', slotName === 'conversation.input.left', slotName)
      callback()
    },
    register(options, component) {
      store.entry = { options, component }
      return () => {}
    },
  },
  remote: {
    settings: {
      async describe() {
        return {
          ok: true,
          value: {
            namespaces: [{
              ns: 'session-prompt',
              value: { prompts: { ...store.prompts }, disabled: { ...store.disabled } },
              revision: store.revision,
            }],
          },
        }
      },
      async mutate(ns, ops, expectedRevision) {
        mutations.push({ ns, ops, expectedRevision })
        const prompts = { ...store.prompts }
        const disabled = { ...store.disabled }
        for (const op of ops) {
          // The same op shape addresses either session-keyed map.
          const map = op.path[0] === 'disabled' ? disabled : prompts
          const key = String(op.path[1])
          if (op.op === 'set') map[key] = op.value
          else delete map[key]
        }
        store.prompts = prompts
        store.disabled = disabled
        store.revision += 1
        return { ok: true, value: { ns, value: { prompts, disabled }, revision: store.revision } }
      },
    },
  },
}

clientExports.apply(clientCtx)

const entry = store.entry
check('exactly one composer entry registered', entry !== undefined)
equal('entry id', entry.options.id, 'session-prompt')
equal('entry label is 会话提示词', entry.options.label, '会话提示词')
check('entry component is a function', typeof entry.component === 'function')

/** Walk an element tree, invoking function components, and collect every element seen. */
function collect(element, depth, out) {
  if (depth > 10 || element === null || element === undefined || typeof element !== 'object') return out
  out.push(element)
  const children = []
  if (Array.isArray(element.children)) children.push(...element.children)
  if (element.props && element.props.children !== undefined) children.push(element.props.children)
  if (typeof element.type === 'function') {
    const props = Object.assign({}, element.props, {
      children: element.children.length === 1 ? element.children[0] : element.children,
    })
    collect(element.type(props), depth + 1, out)
  }
  for (const child of children) collect(child, depth + 1, out)
  return out
}

/** Render the control for one session and return every element in its tree. */
function renderFor(sessionId) {
  const seen = []
  let error
  try {
    collect(ReactStub.createElement(entry.component, { sessionId }), 0, seen)
  } catch (caught) {
    error = caught
  }
  const control = seen.find((node) => node.props && node.props['data-session-prompt-active'] !== undefined)
  return { seen, control, error }
}

// First render kicks off the read; the Remote round-trip settles on a later tick.
const initial = renderFor('session-A')
check('control renders without throwing', initial.error === undefined, initial.error === undefined ? undefined : String(initial.error && initial.error.stack))
await settle()
await settle()

const active = renderFor('session-A')
check('renders a control marked active/inactive', active.control !== undefined)
equal('a session with a prompt renders active', active.control.props['data-session-prompt-active'], 'true')
equal('active control uses the send-button blue', active.control.props.style && active.control.props.style.background, 'var(--dsw-alias-button-info-fill)')
equal('active control uses the send-button foreground', active.control.props.style && active.control.props.style.color, '#fff')

const inactive = renderFor('session-B')
equal('a session with no prompt renders inactive', inactive.control.props['data-session-prompt-active'], 'false')
check('inactive control sets no background', inactive.control.props.style === undefined, JSON.stringify(inactive.control.props.style))

/* Saving one session must address that session and nothing else. */
const dialogProps = (tree) => {
  const dialog = tree.seen.find((node) => node.type === primitivesStub.Modal)
  return dialog === undefined ? undefined : dialog.props
}
const activeDialog = dialogProps(active)
check('the dialog is rendered for the current session', activeDialog !== undefined)
check('the dialog opens only when asked', activeDialog.open === false)

const hook = entry.options.inject
check('registration injects the session id as a fallback', typeof hook === 'function' && hook('session-X').slotSessionId === 'session-X')

/* The enable switch: per session, immediate, and it must not touch the text. */
const switchOf = (tree) => tree.seen.find((node) => node.type === primitivesStub.Switch)
const activeSwitch = switchOf(active)
check('the dialog offers an enable switch', activeSwitch !== undefined)
equal('the switch reads on for a session with a prompt', activeSwitch.props.checked, true)
equal('the switch writes immediately, not on save', typeof activeSwitch.props.onChange, 'function')

const emptySwitch = switchOf(inactive)
equal('the switch is disabled while a session has no text', emptySwitch.props.disabled, true)

// Flip session A off. Same tick, the composer button must stop being blue.
activeSwitch.props.onChange(false)
await settle()
await settle()

const disabled = renderFor('session-A')
equal('after switching off, the control is no longer active', disabled.control.props['data-session-prompt-active'], 'false')
check('after switching off, no background is applied', disabled.control.props.style === undefined, JSON.stringify(disabled.control.props.style))

const lastWrite = mutations[mutations.length - 1]
equal('switching off writes one op, to the disabled map only', lastWrite.ops, [{ op: 'set', path: ['disabled', 'session-A'], value: true }])
equal('switching off addresses only this session', lastWrite.ops[0].path[1], 'session-A')
check('switching off keeps the session text intact', store.prompts['session-A'] === 'always answer in Chinese', JSON.stringify(store.prompts))

equal('the switch now reads off', switchOf(disabled).props.checked, false)

// Flip it back on: the disabled entry is removed, and the text was never rewritten.
switchOf(disabled).props.onChange(true)
await settle()
await settle()

const reenabled = renderFor('session-A')
equal('switching back on restores the active state', reenabled.control.props['data-session-prompt-active'], 'true')
equal('switching back on unsets the disabled flag', mutations[mutations.length - 1].ops, [{ op: 'unset', path: ['disabled', 'session-A'] }])
equal('no write ever targeted the text while toggling', mutations.filter((m) => m.ops.some((op) => op.path[0] === 'prompts')).length, 0)
check('session B was never written to', mutations.every((m) => m.ops.every((op) => op.path[1] === 'session-A')), JSON.stringify(mutations))

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${checks.length} checks`)
  process.exit(0)
}
console.log(`FAIL — ${failures.length} of ${checks.length} checks failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
