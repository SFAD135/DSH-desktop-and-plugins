/**
 * Offline checks for dsh-archived-sessions (host half).
 *
 *   node verify.mjs
 *
 * Run from the installed package directory
 * (`<profile>/node_modules/dsh-archived-sessions`) so the shared
 * `@deepseek-ai/schemastery` dependency resolves.
 *
 * The decisive property is that the inverse is a real registry mutation, not a
 * file edit: it must travel the same serialized operation chain the first-party
 * `archiveSession()` uses, must be idempotent, and must never touch an id the
 * caller did not name.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const checks = []
const failures = []

function check(name, condition, detail) {
  checks.push(name)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(name)
}
function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
/** Let queued microtasks and immediates run, so an async drain can settle. */
const settle = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

const host = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)

console.log('host half:')

equal('inject declares settings + workspaceRegistry', host.inject, ['settings', 'workspaceRegistry'])
equal('plugin name', host.name, 'archived-sessions')
equal('settings namespace', host.NAMESPACE, 'archived-sessions')

const parsedEmpty = host.Config({})
equal('schema defaults an absent requests map', parsedEmpty.requests, {})
equal('schema defaults an absent results map', parsedEmpty.results, {})
equal('schema keeps a supplied requests map', host.Config({ requests: { n: 'session-a' } }).requests, { n: 'session-a' })

/**
 * A fake registry that mirrors the real contract: one serialized operation
 * chain, a state snapshot, and a setState that swaps it.
 */
function makeRegistry(archived) {
  const record = {
    writes: [],
    state: { initialized: true, workspaceIds: [], archivedSessionIds: [...archived] },
  }
  let chain = Promise.resolve()
  record.registry = {
    enqueueOperation(operation) {
      const result = chain.then(operation)
      chain = result.then(() => {}, () => {})
      return result
    },
    requireState() {
      return record.state
    },
    async setState(next) {
      record.writes.push([...next.archivedSessionIds])
      record.state = next
    },
  }
  return record
}

/* ── the inverse itself ──────────────────────────────────────────────────── */

console.log('\nthe inverse mutation:')

const direct = makeRegistry(['session-a', 'session-b'])
check('restoring an archived session reports a change', (await host.unarchiveVia(direct.registry, 'session-a')) === true)
equal('only the named id is removed', direct.state.archivedSessionIds, ['session-b'])
equal('the write went through the serialized chain', direct.writes.length, 1)

check('restoring it again reports no change', (await host.unarchiveVia(direct.registry, 'session-a')) === false)
equal('an already-restored session is not rewritten', direct.writes.length, 1)
equal('the neighbour is untouched', direct.state.archivedSessionIds, ['session-b'])

/* ── the request pump ────────────────────────────────────────────────────── */

console.log('\nthe request pump:')

/** A fake settings provider with the real scope shape and watcher fan-out. */
function makeSettings() {
  const scope = { resolved: undefined, watchers: new Set(), sections: [] }
  const api = {
    register(ns, schema, options) {
      scope.ns = ns
      scope.resolved = schema(options?.base ?? {})
      return {
        get: () => scope.resolved,
        watch(callback) {
          scope.watchers.add(callback)
          return () => scope.watchers.delete(callback)
        },
        replace(section) {
          scope.sections.push(section)
          scope.resolved = schema(section)
          for (const callback of [...scope.watchers]) callback()
          return Promise.resolve()
        },
        update(patch) {
          scope.resolved = schema({ ...scope.resolved, ...patch })
          for (const callback of [...scope.watchers]) callback()
          return Promise.resolve()
        },
      }
    },
  }
  return {
    api,
    scope,
    /** Stand in for a client `settings.mutate` writing the requests map. */
    write(next) {
      scope.resolved = { ...scope.resolved, requests: next }
      for (const callback of [...scope.watchers]) callback()
    },
  }
}

const settings = makeSettings()
const registry = makeRegistry(['session-x', 'session-y'])
const warnings = []
host.apply({
  logger: { warn: (message) => warnings.push(message) },
  settings: settings.api,
  workspaceRegistry: registry.registry,
}, {})

equal('registers exactly the archived-sessions namespace', settings.scope.ns, 'archived-sessions')
await settle()
equal('an empty namespace drains to nothing', registry.writes.length, 0)

settings.write({ 'nonce-1': 'session-x' })
await settle()
equal('a request restores its session', registry.state.archivedSessionIds, ['session-y'])
equal('the outcome is recorded for the caller', settings.scope.resolved.results['nonce-1'], 'ok')
equal('the request is still readable by the client', settings.scope.resolved.requests['nonce-1'], 'session-x')

const settled = JSON.stringify(settings.scope.resolved)
const writeCount = registry.writes.length
await settle(30)
equal('writing the result back does not loop', JSON.stringify(settings.scope.resolved), settled)
equal('and causes no repeated registry write', registry.writes.length, writeCount)

/* ── isolation between concurrent requests ───────────────────────────────── */

settings.write({ 'nonce-a': 'session-y', 'nonce-b': 'session-y' })
await settle()
equal('two nonces naming one session are each reported', {
  a: settings.scope.resolved.results['nonce-a'],
  b: settings.scope.resolved.results['nonce-b'],
}, { a: 'ok', b: 'ok' })
equal('the second restore was a no-op write', registry.state.archivedSessionIds, [])
equal('the whole archive set is now empty', registry.state.archivedSessionIds.length, 0)

/* ── a failing registry surfaces as a result, not a hang ─────────────────── */

const failing = makeSettings()
host.apply({
  logger: { warn: () => {} },
  settings: failing.api,
  workspaceRegistry: {
    enqueueOperation() { return Promise.reject(new Error('registry is unavailable')) },
    requireState() { throw new Error('never reached') },
    async setState() {},
  },
}, {})
failing.write({ 'nonce-bad': 'session-z' })
await settle()
equal('a failed restore records the reason', failing.scope.resolved.results['nonce-bad'], 'error: registry is unavailable')

/* ── the client half stays a hand-written bundle ─────────────────────────── */

console.log('\nclient bundle:')

const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
check('bundle calls the module-loader facade', /window\.__ModuleLoader__\.load\(\{/.test(source))
equal('bundle declares the package id', /id:\s*'dsh-archived-sessions'/.test(source), true)
check('bundle contains no import/export syntax', !/^\s*(import|export)\s/m.test(source))
check('bundle reads the workspaces service', source.includes('workspaces'))
check('bundle writes through path-addressed mutate ops', source.includes("op: 'set'") || source.includes('op: "set"'))
// cordis resolves a nested service by its own inject key: declaring only
// `remote` leaves `ctx.remote.settings` throwing at call time, in the browser,
// where no unit test of the host half would ever see it.
check('bundle declares the remote.settings inject key', /exports\.inject\s*=\s*\[[^\]]*['"]remote\.settings['"]/.test(source))

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${checks.length} checks`)
  process.exit(0)
}
console.log(`FAIL — ${failures.length} of ${checks.length} checks failed: ${failures.join(', ')}`)
process.exit(1)
