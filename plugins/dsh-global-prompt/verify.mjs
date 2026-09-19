/**
 * Offline smoke test for dsh-global-prompt.
 *
 *   node verify.mjs
 *
 * Run it from the installed package directory (so `@deepseek-ai/schemastery`
 * resolves). It checks the host half's registrations and the client bundle's
 * factory shape, then renders both client components against a React stub.
 * It does not touch the running GUI.
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

/* ── host half ───────────────────────────────────────────────────────────── */

console.log('\nhost half:')
const host = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)

equal('inject declares settings + systemPrompt', host.inject, ['settings', 'systemPrompt'])
check('Config is a schema', host.Config !== undefined && host.Config !== null)

/** Build a fake host context that records every registration and answers reads. */
function makeHostCtx(config) {
  const record = { namespaces: [], sections: [], variables: [], effects: [] }
  const ctx = {
    effect(fn, label) {
      record.effects.push(label)
      return fn()
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section)
        return () => {}
      },
      variable(variableName, provider) {
        record.variables.push({ name: variableName, provider })
        return () => {}
      },
      getSectionOrder() {
        return 0
      },
    },
    settings: {
      register(ns, schema, options) {
        const base = (options && options.base) || {}
        const value = { text: base.text ?? '', enabled: base.enabled ?? true }
        record.namespaces.push({ ns, schema, options })
        return { get: () => value, watch: () => () => {}, update: () => {} }
      },
    },
  }
  host.apply(ctx, config)
  return record
}

const off = makeHostCtx({ text: '', enabled: true })

equal('registers one settings namespace', off.namespaces.map((entry) => entry.ns), ['global-prompt'])
equal('registers one prompt section', off.sections.map((section) => section.name), [host.SECTION_NAME])
equal('section renders the variable reference', off.sections.map((section) => section.text), [`{{${host.VARIABLE_NAME}}}`])
equal('section sits after the persona prefix (order 0) and before guidance (order 500)', off.sections.map((section) => section.order), [10])
equal('registers one prompt variable', off.variables.map((entry) => entry.name), [host.VARIABLE_NAME])
check('variable name matches the prompt grammar', /^[a-z][a-z0-9_]*$/.test(host.VARIABLE_NAME))
equal('owns exactly two effects', off.effects.length, 2)
check('empty config renders to empty text', off.variables[0].provider() === '', JSON.stringify(off.variables[0].provider()))

const on = makeHostCtx({ text: 'always answer in Chinese', enabled: true })
check('configured text is what the model receives', on.variables[0].provider() === 'always answer in Chinese', JSON.stringify(on.variables[0].provider()))

const muted = makeHostCtx({ text: 'always answer in Chinese', enabled: false })
check('disabled namespace renders to empty text', muted.variables[0].provider() === '', JSON.stringify(muted.variables[0].provider()))

/* ── client bundle ───────────────────────────────────────────────────────── */

console.log('\nclient bundle:')

const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
check('bundle calls the module-loader facade', /window\.__ModuleLoader__\.load\(\{/.test(source))
equal('bundle declares the package id', /id:\s*'dsh-global-prompt'/.test(source), true)
check('bundle contains no import/export syntax', !/^\s*(import|export)\s/m.test(source))

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
equal('bundle id is the package name', definition.id, 'dsh-global-prompt')

/* A React stub: enough for this plugin's render path, no DOM. */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children }
  },
  Fragment: Symbol('react.fragment'),
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
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

const registrations = []
let injectedSlot
const clientCtx = {
  slots: {
    inject(slotName, callback) {
      injectedSlot = slotName
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  remote: {
    settings: {
      async describe() {
        return { ok: true, value: { namespaces: [{ ns: 'global-prompt', value: { text: 'hi', enabled: true }, revision: 3 }] } }
      },
      async update() {
        return { ok: true, value: { ns: 'global-prompt', value: { text: 'hi', enabled: true }, revision: 4 } }
      },
    },
  },
}

clientExports.apply(clientCtx)

equal('registers into the composer tool row', injectedSlot, 'conversation.input.left')
equal('registers exactly one composer entry', registrations.length, 1)

const entry = registrations[0]
equal('entry id', entry.options.id, 'global-prompt')
equal('entry carries the label', entry.options.label, '全局提示词')
check('entry component is a function', typeof entry.component === 'function')

/**
 * Walk the element tree, invoking every function element, so both components
 * and their render paths run. Guards against cycles and runaway depth.
 */
function render(element, depth) {
  if (depth > 10 || element === null || element === undefined || typeof element !== 'object') return
  const children = []
  if (Array.isArray(element.children)) children.push(...element.children)
  if (element.props && element.props.children !== undefined) children.push(element.props.children)
  if (typeof element.type === 'function') {
    const props = Object.assign({}, element.props, {
      children: element.children.length === 1 ? element.children[0] : element.children,
    })
    render(element.type(props), depth + 1)
  }
  for (const child of children) render(child, depth + 1)
}

let renderError
try {
  render(ReactStub.createElement(entry.component, {}), 0)
} catch (error) {
  renderError = error
}
check('both components render without throwing', renderError === undefined, renderError === undefined ? undefined : String(renderError && renderError.stack))

/* ── summary ─────────────────────────────────────────────────────────────── */

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${checks.length} checks`)
  process.exit(0)
}
console.log(`FAIL — ${failures.length} of ${checks.length} checks failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
