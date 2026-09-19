/**
 * Pre-flight check: does the shipped Loader path resolve this row?
 *
 *   node preflight.mjs <profileDir>
 *
 * Mirrors what dsh does for a bare `name:` row and what client-modules does for
 * a `dsh.client` declaration, without needing the running Host.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = process.argv[2]
if (profileDir === undefined) {
  console.error('usage: node preflight.mjs <profileDir>')
  process.exit(2)
}

const packageName = 'dsh-session-prompt'
const legacyPackage = 'dsh-global-prompt'
const checks = []
const failures = []

function check(name, condition, detail) {
  checks.push(name)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(name)
}

console.log(`profile: ${profileDir}`)

/* 1. Node resolution from the profile anchor — the Loader's second anchor is
      the profile directory for a bare row name. */
const require = createRequire(join(profileDir, 'package.json'))
let entryPath
try {
  entryPath = require.resolve(packageName)
  check(`require.resolve("${packageName}") succeeds`, true)
} catch (error) {
  check(`require.resolve("${packageName}") succeeds`, false, String(error && error.message))
}

/* 2. The package manifest the Loader would read. */
let pkg
let pkgPath
try {
  pkgPath = require.resolve(`${packageName}/package.json`)
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  check('manifest is readable', true)
} catch (error) {
  check('manifest is readable', false, String(error && error.message))
}
if (pkg !== undefined) {
  check('manifest package name matches the row name', pkg.name === packageName, pkg.name)
  check('dsh.client.platform is "web"', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client))

  const clientField = pkg.exports?.['./client']
  const clientRel = typeof clientField === 'string' ? clientField : clientField?.default
  check('exports["./client"] resolves to a string path', typeof clientRel === 'string', JSON.stringify(clientField))
  const clientPath = typeof clientRel === 'string' ? join(dirname(pkgPath), clientRel) : undefined
  check('client bundle exists on disk', clientPath !== undefined && existsSync(clientPath), clientPath)
}

/* 3. The host half imports cleanly — including its schemastery dependency,
      which must resolve through the shared profiles node_modules closure. */
if (entryPath !== undefined) {
  let host
  try {
    host = await import(pathToFileURL(entryPath).href)
    check('host half imports', true)
  } catch (error) {
    check('host half imports', false, String(error && error.message))
  }
  if (host !== undefined) {
    check('host half exports apply()', typeof host.apply === 'function')
    check('host half exports inject []', Array.isArray(host.inject), JSON.stringify(host.inject))
    check('host half exports a Config schema', host.Config !== undefined)
  }
}

/* 4. The Loader row is present in the profile patch layer, and the superseded
      global-prompt plugin is gone — it would otherwise still inject into every
      session. */
const patchPath = join(profileDir, 'cordis.patch.yml')
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
check('cordis.patch.yml mounts this package', patch.includes(packageName))
check('cordis.patch.yml no longer mounts the superseded package', !patch.includes(legacyPackage))
check('cordis.patch.yml has no UTF-8 BOM', !patch.startsWith('\uFEFF'))
check('the superseded package directory is gone', !existsSync(join(profileDir, 'node_modules', legacyPackage)))

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${checks.length} checks`)
  process.exit(0)
}
console.log(`FAIL — ${failures.length} of ${checks.length} checks failed: ${failures.join(', ')}`)
process.exit(1)
