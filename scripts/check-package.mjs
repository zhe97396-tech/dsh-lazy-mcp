#!/usr/bin/env node
/**
 * Repository consistency checks.
 *
 * The package identity (`package.json#name`) appears in three more places that a
 * rename must keep in sync: the browser module id in `client.js`, the Loader row
 * in `cordis.patch.yml`, and the naming declaration in `dsh-plugin.naming.json`.
 * This script fails when one of them drifts, and also verifies that the package
 * manifest only advertises files that exist.
 *
 * Run from the repository root:  node scripts/check-package.mjs
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function read(relative) {
  return readFile(join(root, relative), 'utf8')
}

const pkg = JSON.parse(await read('package.json'))
const name = pkg.name

console.log(`package identity: ${name}@${pkg.version}`)

// ── package.json ─────────────────────────────────────────────────────────
check('name is a valid npm package name', /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name), name)
check('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version), pkg.version)
check('publishable (private is not true)', pkg.private !== true)
check('license declared', typeof pkg.license === 'string' && pkg.license.length > 0)
check('LICENSE file exists', existsSync(join(root, 'LICENSE')))
check('repository points at GitHub', /^git\+https:\/\/github\.com\/.+\/.+\.git$/.test(pkg.repository?.url ?? ''), pkg.repository?.url)
check('engines.node declared', typeof pkg.engines?.node === 'string')

for (const file of pkg.files ?? []) {
  if (file.endsWith('/')) continue
  check(`files entry exists: ${file}`, existsSync(join(root, file)))
}

for (const entry of Object.values(pkg.exports ?? {})) {
  const target = typeof entry === 'string' ? entry : entry?.default
  if (target === undefined || target.endsWith('.json')) continue
  check(`export target exists: ${target}`, existsSync(join(root, target)))
}

// ── DSH manifest ─────────────────────────────────────────────────────────
check('dsh.bundle.patch declared', typeof pkg.dsh?.bundle?.patch === 'string')
check('dsh.client.platform is web', pkg.dsh?.client?.platform === 'web')
const patchPath = pkg.dsh?.bundle?.patch
if (patchPath !== undefined) {
  check(`bundle patch exists: ${patchPath}`, existsSync(join(root, patchPath)))
}

// ── identity lockstep ────────────────────────────────────────────────────
const client = await read('client.js')
const clientId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1]
check('client.js module id matches package name', clientId === name, clientId ?? 'not found')

const patch = await read(pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')
const rowName = patch.match(/^\s*name:\s*'?([^'\s#]+)'?/m)?.[1]
check('cordis.patch.yml row name matches package name', rowName === name, rowName ?? 'not found')

const index = await read('index.js')
const pluginName = index.match(/^const name = '([^']+)'/m)?.[1]
check('index.js plugin name is declared', typeof pluginName === 'string', pluginName ?? 'not found')

// ── naming declaration ───────────────────────────────────────────────────
const namingPath = 'dsh-plugin.naming.json'
check('naming declaration exists', existsSync(join(root, namingPath)))
if (existsSync(join(root, namingPath))) {
  const naming = JSON.parse(await read(namingPath))
  check('naming packageName matches package.json', naming.plugin?.packageName === name, naming.plugin?.packageName)
  check('naming declares the plugin module name', naming.names?.pluginNames?.includes(pluginName), JSON.stringify(naming.names?.pluginNames))

  const registeredTools = [...index.matchAll(/registerTool\(\{\s*name: '([^']+)'/g)].map((match) => match[1]).sort()
  const declaredTools = [...(naming.names?.tools ?? [])].sort()
  check('declared tools match the registered tools', JSON.stringify(registeredTools) === JSON.stringify(declaredTools), `${JSON.stringify(registeredTools)} vs ${JSON.stringify(declaredTools)}`)

  const route = naming.names?.routes?.[0]
  check('declared route exists in index.js', route !== undefined && index.includes(`path: '${route.path}'`), route?.path)
}

console.log(`\n${pass} checks, ${fail} failure(s)`)
process.exit(fail === 0 ? 0 : 1)
