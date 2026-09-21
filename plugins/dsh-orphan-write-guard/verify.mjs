/**
 * Offline checks for dsh-orphan-write-guard.
 *
 *   node verify.mjs
 *
 * Runs from this directory: the plugin imports only node builtins, so no
 * profile install is needed to exercise it.
 *
 * The decisive properties are narrowness and blast radius — the guard must
 * catch exactly the orphaned session home and leave every ordinary write,
 * every other tool, and every malformed argument untouched.
 */
import { existsSync } from 'node:fs'
import {
  absoluteTarget,
  apply,
  denialFor,
  inject,
  isWithin,
  name,
  normalize,
  orphanFor,
  PATH_FIELD,
  WRITE_TOOL,
} from './lib/index.js'

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

/** A registry stand-in: `headers` is all this plugin reads. */
function registryOf(entries) {
  return { headers: new Map(entries.map(([id, cwd]) => [id, { id, cwd }])) }
}

/** `exists` is injected everywhere so no check touches the real filesystem. */
const nothingExists = () => false
const everythingExists = () => true

/* ── shape ───────────────────────────────────────────────────────────────── */

console.log('plugin shape:')

equal('name', name, 'orphan-write-guard')
equal('inject declares tools + workspaceRegistry', inject, ['tools', 'workspaceRegistry'])
equal('guards the write tool', WRITE_TOOL, 'write')
equal('reads the file_path argument', PATH_FIELD, 'file_path')

/* ── path containment ────────────────────────────────────────────────────── */

console.log('\npath containment:')

check('a path is within itself', isWithin('D:\\proj\\a', 'D:\\proj\\a'))
check('a child is within its parent', isWithin('D:\\proj\\a\\f.txt', 'D:\\proj\\a'))
check('case differences do not matter', isWithin('d:\\PROJ\\a\\f.txt', 'D:\\proj\\A'))
check('a trailing separator does not matter', isWithin('D:\\proj\\a\\f.txt', 'D:\\proj\\a\\'))
// The boundary that a naive startsWith gets wrong.
check('a sibling with a shared prefix is not contained', !isWithin('D:\\proj\\ab\\f.txt', 'D:\\proj\\a'))
check('an ancestor is not within its child', !isWithin('D:\\proj', 'D:\\proj\\a'))
check('an unrelated path is not contained', !isWithin('D:\\elsewhere\\f.txt', 'D:\\proj\\a'))
check('a relative path is never contained', !isWithin('a\\f.txt', 'D:\\proj\\a'))

equal('normalize strips the trailing separator', normalize('D:\\proj\\a\\'), 'd:\\proj\\a')

/* ── orphan detection ────────────────────────────────────────────────────── */

console.log('\norphan detection:')

const orphaned = registryOf([['s1', 'D:\\Codex projects\\DSH-TEST']])
check(
  'a write into a vanished session home is caught',
  orphanFor(orphaned, 'D:\\Codex projects\\DSH-TEST\\test.txt', nothingExists) === 'D:\\Codex projects\\DSH-TEST',
)
check(
  'the home directory itself counts',
  orphanFor(orphaned, 'D:\\Codex projects\\DSH-TEST', nothingExists) === 'D:\\Codex projects\\DSH-TEST',
)
check(
  'a write into a deeper missing subdirectory is caught too',
  orphanFor(orphaned, 'D:\\Codex projects\\DSH-TEST\\sub\\deep\\f.txt', nothingExists) === 'D:\\Codex projects\\DSH-TEST',
)

check(
  'an intact session home does not block its own writes',
  orphanFor(orphaned, 'D:\\Codex projects\\DSH-TEST\\test.txt', everythingExists) === undefined,
)
check(
  'an unrelated new directory is left alone',
  orphanFor(orphaned, 'D:\\Codex projects\\BRAND-NEW\\f.txt', nothingExists) === undefined,
)
check(
  'a new subdirectory of an existing home is left alone',
  orphanFor(orphaned, 'D:\\Codex projects\\DSH-plugins\\fresh\\f.txt', everythingExists) === undefined,
)
check('an empty header map never blocks', orphanFor(registryOf([]), 'D:\\x\\f.txt', nothingExists) === undefined)
check('a missing registry never blocks', orphanFor(undefined, 'D:\\x\\f.txt', nothingExists) === undefined)
check(
  'a header without a cwd is skipped',
  orphanFor({ headers: new Map([['s1', {}]]) }, 'D:\\x\\f.txt', nothingExists) === undefined,
)
check(
  'the reason names the directory',
  denialFor('D:\\Codex projects\\DSH-TEST').includes('D:\\Codex projects\\DSH-TEST'),
)
check(
  'the reason offers a way forward',
  denialFor('D:\\x').includes('create it deliberately'),
)

/* ── the registered guard ────────────────────────────────────────────────── */

console.log('\nthe registered guard:')

// The registered closure uses the real `existsSync`, so this fixture must be a
// path that genuinely does not exist — a real directory would be correctly
// allowed, and the check would be measuring nothing.
const GHOST = 'D:\\Codex projects\\__orphan-write-guard-absent__'
check('the fixture directory really is absent', !existsSync(GHOST))
check('an intact real directory is present for the control', existsSync('D:\\Codex projects\\DSH-plugins'))

const registered = []
const disposers = []
apply({
  workspaceRegistry: registryOf([['s1', GHOST]]),
  tools: {
    guard(fn) {
      registered.push(fn)
      return () => {
        const at = registered.indexOf(fn)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  },
  effect(fn) {
    disposers.push(fn())
  },
})

equal('one guard is registered', registered.length, 1)
const guard = registered[0]

const write = (path) => guard({ name: 'write', arguments: { [PATH_FIELD]: path } })

check('a write into the orphaned home is denied', typeof write(GHOST + '\\test.txt') === 'string')
check('the home directory itself is denied', typeof write(GHOST) === 'string')
check('an intact home is allowed', write('D:\\Codex projects\\DSH-plugins\\f.txt') === undefined)
check('an unrelated new path is allowed', write('D:\\Codex projects\\FRESH\\f.txt') === undefined)

check('read is untouched', guard({ name: 'read', arguments: { [PATH_FIELD]: GHOST + '\\test.txt' } }) === undefined)
check('edit is untouched', guard({ name: 'edit', arguments: { [PATH_FIELD]: GHOST + '\\test.txt' } }) === undefined)
check('bash is untouched', guard({ name: 'bash', arguments: { command: 'echo hi > ' + GHOST + '\\test.txt' } }) === undefined)

/* ── relative paths (the hole that shipped in v1) ────────────────────────── */

console.log('\nrelative paths:')

/** The exact shape dsh-tool-fs reads: exec.agent.session.header.cwd. */
const execWithCwd = (cwd) => ({ agent: { session: { header: { cwd } } } })
/** A write call carrying both the argument bag and the agent's session cwd. */
const guardWrite = (path, cwd) => guard({ ...execWithCwd(cwd), name: 'write', arguments: { [PATH_FIELD]: path } })

check('an absolute path passes through untouched', absoluteTarget(execWithCwd('D:\\a'), 'D:\\b\\f.txt') === 'D:\\b\\f.txt')
equal('a relative path resolves against the session cwd', normalize(absoluteTarget(execWithCwd('D:\\a'), 'f.txt')), 'd:\\a\\f.txt')
equal('a parent segment is resolved away', normalize(absoluteTarget(execWithCwd('D:\\a\\b'), '..\\f.txt')), 'd:\\a\\f.txt')
check('no agent means no base', absoluteTarget({}, 'f.txt') === undefined)
check('no session means no base', absoluteTarget({ agent: {} }, 'f.txt') === undefined)
check('no cwd means no base', absoluteTarget(execWithCwd(undefined), 'f.txt') === undefined)
check('an empty cwd means no base', absoluteTarget(execWithCwd(''), 'f.txt') === undefined)
check('a null exec is tolerated', absoluteTarget(null, 'f.txt') === undefined)

// These two are the regression: v1 compared the raw argument, so a relative
// path was never absolute and the guard returned early on every one of them.
check('a RELATIVE path onto the orphan is denied', typeof guardWrite('test.txt', GHOST) === 'string')
check('a relative path with a parent segment is denied', typeof guardWrite('sub\\..\\x.txt', GHOST) === 'string')
check('a relative path from a live cwd is allowed', guardWrite('test.txt', 'D:\\Codex projects\\DSH-plugins') === undefined)
check('a relative path with no session base is allowed', guard({ name: 'write', arguments: { [PATH_FIELD]: 'test.txt' } }) === undefined)

check('a null exec is ignored', guard(null) === undefined)
check('a null argument bag is ignored', guard({ name: 'write', arguments: null }) === undefined)
check('a non-string path is ignored', guard({ name: 'write', arguments: { [PATH_FIELD]: 42 } }) === undefined)
check('a blank path is ignored', guard({ name: 'write', arguments: { [PATH_FIELD]: '   ' } }) === undefined)

equal('the effect registered a disposer', disposers.length, 1)
disposers[0]()
equal('disposing unregisters the guard', registered.length, 0)

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${checks.length} checks`)
  process.exit(0)
}
console.log(`FAIL — ${failures.length} of ${checks.length}: ${failures.join(', ')}`)
process.exit(1)
