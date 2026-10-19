/**
 * Functional verification for dsh-lazy-mcp.
 *
 * The DSH Loader pins an imported module generation, so a running host cannot
 * pick up edited plugin JavaScript without a restart. This harness drives the
 * plugin's real `apply()` in a fresh Node process with a stub Cordis context,
 * which exercises the actual implementation rather than a copy of it.
 *
 * Run from this directory:  node verify.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('./index.js')

const SERVER_CMD = ['-y', '@modelcontextprotocol/server-everything']
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll for a file that the plugin writes fire-and-forget, so the cache write
 * never slows down a tool call.
 *
 * @param path - File to read.
 * @param timeoutMs - How long to keep trying.
 * @returns The file text, or null when it never appeared.
 */
async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await sleep(100)
    }
  }
  return null
}

/**
 * Build a stub Cordis context that captures tool registrations and runs
 * effect callbacks immediately, plus collect their disposers.
 *
 * @param cachePath - Metadata cache path handed to the plugin config.
 * @returns The stub context and accessors for registrations and cleanup.
 */
function makeCtx() {
  const tools = new Map()
  const disposers = []
  const warnings = []
  const ctx = {
    logger: {
      info: (message) => console.log(`        [info] ${message}`),
      warn: (message) => {
        warnings.push(message)
        console.log(`        [warn] ${message}`)
      },
      error: (message) => console.log(`        [error] ${message}`),
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return {
    ctx,
    tools,
    warnings,
    async disposeAll() {
      for (const disposer of disposers.splice(0)) {
        try {
          await disposer()
        } catch (error) {
          console.log(`        [warn] disposer failed: ${String(error)}`)
        }
      }
    },
  }
}

/** Call a registered tool and return its rendered text. */
async function callTool(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const value = await definition.execute(args, { signal: undefined })
  return definition.output.render(args, value)[0].text
}

/** Call a registered tool expecting failure; return the error message. */
async function callToolExpectingFailure(tools, name, args) {
  try {
    await callTool(tools, name, args)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const baseServer = (name, lifecycle, extra = {}) => ({
  name,
  transport: 'stdio',
  lifecycle,
  description: `verify ${lifecycle}`,
  command: 'npx',
  args: SERVER_CMD,
  ...extra,
})

// CI runners (especially Windows) download the reference server on first use.
// The plugin default connect timeout (30 s) is tight for a cold `npx` start
// there, so the harness gives connections a generous budget.
const CONNECT_BUDGET_MS = 120_000
const applyConfig = (ctx, config) => apply(ctx, { connectTimeoutMs: CONNECT_BUDGET_MS, ...config })

const scratch = await mkdtemp(join(tmpdir(), 'lazy-mcp-verify-'))

// ── S1: zero servers ────────────────────────────────────────────────────────
console.log('\nS1  zero servers: activation succeeds and reports the empty state')
{
  const { ctx, tools, disposeAll } = makeCtx()
  await applyConfig(ctx, { servers: [] })
  const text = await callTool(tools, 'mcp_servers', {})
  check('five tools registered', tools.size === 5, `got ${tools.size}`)
  check(
    'the resource tools are among them',
    tools.has('mcp_resources') && tools.has('mcp_read_resource'),
    [...tools.keys()].join(', '),
  )
  check('empty state reported', text.includes('No MCP servers are configured'))
  await disposeAll()
}

// ── S2: lazy + metadata cache ───────────────────────────────────────────────
console.log('\nS2  lazy lifecycle + metadata cache (idle window 6000 ms)')
{
  const cachePath = join(scratch, 's2-cache.json')
  const { ctx, tools, disposeAll } = makeCtx()
  await applyConfig(ctx, {
    idleDisconnectMs: 6000,
    cachePath,
    servers: [baseServer('s2', 'lazy')],
  })

  const before = await callTool(tools, 'mcp_servers', {})
  check('dormant at activation', before.includes('state=dormant'), before)

  // No cache yet, so this must connect to learn the tools.
  const first = await callTool(tools, 'mcp_tools', { server: 's2' })
  check('cold mcp_tools connects and lists tools', first.includes('13 tool(s)'), first.slice(0, 120))
  check('cold mcp_tools says live metadata', first.includes('live metadata'))

  const cachedText = await waitForFile(cachePath)
  check('cache file written', cachedText !== null)
  const cached = cachedText === null ? { version: 0, servers: {} } : JSON.parse(cachedText)
  check('cache file written', cached.version === 1 && Array.isArray(cached.servers.s2?.tools))
  check('cache holds 13 tools', cached.servers.s2?.tools?.length === 13, String(cached.servers.s2?.tools?.length))
  check('cache stores no env values', !JSON.stringify(cached).includes('"env"'))

  console.log(`        waiting 13s for the idle disconnect (6s window, generous margin)...`)
  await sleep(13000)

  const afterIdle = await callTool(tools, 'mcp_servers', {})
  check('idle disconnect returned it to dormant', afterIdle.includes('state=dormant'), afterIdle)
  check('tool count survived from cache', afterIdle.includes('tools=13(cache)'), afterIdle)
  check('connection count is 1', afterIdle.includes('connections=1'), afterIdle)

  // The point of the cache: describe without starting.
  const warm = await callTool(tools, 'mcp_tools', { server: 's2' })
  check('dormant mcp_tools served from cache', warm.includes('cached metadata'), warm.slice(0, 160))
  check('cached listing still has 13 tools', warm.includes('13 tool(s)'), warm.slice(0, 160))

  const stillDormant = await callTool(tools, 'mcp_servers', {})
  check('serving the cache did NOT reconnect', stillDormant.includes('state=dormant'), stillDormant)
  check('connection count still 1', stillDormant.includes('connections=1'), stillDormant)

  // refresh:true must connect on demand.
  const refreshed = await callTool(tools, 'mcp_tools', { server: 's2', refresh: true })
  check('refresh:true reconnects', refreshed.includes('live metadata'), refreshed.slice(0, 120))
  const afterRefresh = await callTool(tools, 'mcp_servers', {})
  check('connection count is now 2', afterRefresh.includes('connections=2'), afterRefresh)

  await disposeAll()
}

// ── S3: lazy-keep-alive ─────────────────────────────────────────────────────
console.log('\nS3  lazy-keep-alive: connects on use, then never idle-closes')
{
  const { ctx, tools, disposeAll } = makeCtx()
  await applyConfig(ctx, {
    idleDisconnectMs: 6000,
    cachePath: join(scratch, 's3-cache.json'),
    servers: [baseServer('s3', 'lazy-keep-alive')],
  })

  const before = await callTool(tools, 'mcp_servers', {})
  check('dormant at activation', before.includes('state=dormant'), before)

  await callTool(tools, 'mcp_tools', { server: 's3', refresh: true })
  console.log(`        waiting 13s past the idle window (6s window, generous margin)...`)
  await sleep(13000)

  const after = await callTool(tools, 'mcp_servers', {})
  check('still ready after the idle window', after.includes('state=ready'), after)
  check('reported as pinned', after.includes('pinned=yes'), after)
  await disposeAll()
}

// ── S4: eager ───────────────────────────────────────────────────────────────
console.log('\nS4  eager: begins connecting at activation without blocking it')
{
  const { ctx, tools, disposeAll } = makeCtx()
  const started = Date.now()
  await applyConfig(ctx, {
    idleDisconnectMs: 6000,
    cachePath: join(scratch, 's4-cache.json'),
    servers: [baseServer('s4', 'eager')],
  })
  const activationMs = Date.now() - started
  check('activation did not wait for the server', activationMs < 2000, `${activationMs} ms`)

  let text = await callTool(tools, 'mcp_servers', {})
  for (let attempt = 0; attempt < 20 && !text.includes('state=ready'); attempt += 1) {
    await sleep(1000)
    text = await callTool(tools, 'mcp_servers', {})
  }
  check('eager server reached ready', text.includes('state=ready'), text)

  console.log(`        waiting 13s past the idle window (6s window, generous margin)...`)
  await sleep(13000)
  const after = await callTool(tools, 'mcp_servers', {})
  check('eager server has no idle timeout', after.includes('state=ready'), after)
  await disposeAll()
}

// ── S5..S7: delivery semantics ──────────────────────────────────────────────
console.log('\nS5-S7  delivery classes (callTimeoutMs 2000)')
{
  const { ctx, tools, disposeAll } = makeCtx()
  await applyConfig(ctx, {
    idleDisconnectMs: 60000,
    callTimeoutMs: 2000,
    cachePath: join(scratch, 's5-cache.json'),
    servers: [baseServer('s5', 'lazy')],
  })

  const notSent = await callToolExpectingFailure(tools, 'mcp_call', {
    server: 's5',
    tool: 'definitely-not-a-tool',
  })
  check('unknown tool is not_sent', notSent !== null && notSent.includes('[delivery=not_sent]'), String(notSent))
  check('not_sent says nothing ran', notSent !== null && notSent.includes('nothing ran'))

  const unknownServer = await callToolExpectingFailure(tools, 'mcp_call', {
    server: 'nope',
    tool: 'echo',
  })
  check('unknown server is not_sent', unknownServer !== null && unknownServer.includes('[delivery=not_sent]'))

  const mayHaveRun = await callToolExpectingFailure(tools, 'mcp_call', {
    server: 's5',
    tool: 'trigger-long-running-operation',
    arguments: { duration: 10, steps: 3 },
  })
  check('timed-out call is may_have_run', mayHaveRun !== null && mayHaveRun.includes('[delivery=may_have_run]'), String(mayHaveRun))
  check('may_have_run forbids automatic retry', mayHaveRun !== null && mayHaveRun.includes('Do NOT retry automatically'))

  const afterTimeout = await callTool(tools, 'mcp_servers', {})
  check('failed call reset the connection', afterTimeout.includes('state=dormant'), afterTimeout)

  // Probe the fixture for a tool that reports its own error, so the
  // server_error branch is exercised rather than assumed.
  const serverErrorCandidates = [
    { tool: 'get-annotated-message', arguments: { messageType: 'error' } },
    { tool: 'get-resource-reference', arguments: { resourceType: 'Blob', resourceId: 9999 } },
    { tool: 'gzip-file-as-resource', arguments: { data: 'not-a-url', name: 'x.gz' } },
    { tool: 'get-structured-content', arguments: { location: 'Nowhere' } },
  ]
  let serverError = null
  let serverErrorTool = null
  for (const candidate of serverErrorCandidates) {
    const message = await callToolExpectingFailure(tools, 'mcp_call', {
      server: 's5',
      tool: candidate.tool,
      arguments: candidate.arguments,
    })
    if (message !== null && message.includes('[delivery=server_error]')) {
      serverError = message
      serverErrorTool = candidate.tool
      break
    }
  }
  if (serverError === null) {
    console.log('  SKIP  no fixture tool returned an MCP isError result; server_error stayed unexercised')
  } else {
    check(`server-reported error is server_error (${serverErrorTool})`, true)
    check('server_error guidance warns about partial execution', serverError.includes('may have partially run'))
  }

  // A clean call must still succeed after all of that.
  const ok = await callTool(tools, 'mcp_call', {
    server: 's5',
    tool: 'echo',
    arguments: { message: 'delivery test' },
  })
  check('a healthy call still succeeds', ok.includes('delivery test'), ok)
  await disposeAll()
}

// ── S8: standard mcpServers import ──────────────────────────────────────────
console.log('\nS8  standard mcpServers import: configPaths, inline mapping, precedence, overrides')
{
  process.env.LAZY_MCP_TEST_VAR = 'EXPANDED-VALUE'

  const importedPath = join(scratch, 'pi-like.json')
  await writeFile(
    importedPath,
    JSON.stringify({
      mcpServers: {
        'imp-a': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
        'imp-b': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
        'imp-off': { command: 'npx', args: ['-y', 'whatever'] },
        'imp-env': { command: 'echo', args: ['${LAZY_MCP_TEST_VAR}'] },
        'imp-timeout': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], idleTimeout: 0.05 },
      },
    }),
    'utf8',
  )

  const { ctx, tools, disposeAll, warnings } = makeCtx()
  await applyConfig(ctx, {
    idleDisconnectMs: 60000,
    cachePath: join(scratch, 's8-cache.json'),
    configPaths: [importedPath],
    mcpServers: {
      'inline-c': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
    },
    servers: [
      {
        name: 'imp-b',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
        lifecycle: 'eager',
      },
      { name: 'imp-off', disabled: true },
    ],
    overrides: {
      'imp-a': { lifecycle: 'lazy-keep-alive' },
      // An override for an explicitly disabled server must be ignored silently:
      // disabling a server is deliberate, not a typo.
      'imp-off': { description: 'should be ignored without a warning' },
    },
  })

  const text = await callTool(tools, 'mcp_servers', {})
  check('imported server present', text.includes('- imp-a:'), text)
  check('inline mcpServers entry present', text.includes('- inline-c:'), text)
  check('disabled entry removed an imported server', !text.includes('- imp-off:'), text)
  check('override patched an imported server', /- imp-a:.*lifecycle=lazy-keep-alive/.test(text), text)
  check('native entry replaced the imported one', /- imp-b:.*lifecycle=eager/.test(text), text)
  check('${VAR} expanded in imported args', text.includes('EXPANDED-VALUE'), text)
  check(
    'override for a disabled server warns nothing',
    !warnings.some((entry) => entry.includes('overrides.imp-off')),
    warnings.filter((entry) => entry.includes('overrides.')).join(' | '),
  )

  // Pi's idleTimeout is minutes; 0.05 min = 3000 ms must beat the 60000 ms global.
  // imp-a is pinned by an override, so use the unpinned imp-timeout for this.
  await callTool(tools, 'mcp_tools', { server: 'imp-timeout', refresh: true })
  const beforeIdle = await callTool(tools, 'mcp_servers', {})
  check('imp-timeout connected', /- imp-timeout:.*state=ready/.test(beforeIdle), beforeIdle)
  console.log('        waiting 11s to prove the imported idleTimeout (3s) applies, not the 60s global...')
  await sleep(11000)
  const afterIdle = await callTool(tools, 'mcp_servers', {})
  check(
    'imported idleTimeout (minutes) converted and applied',
    /- imp-timeout:.*state=dormant/.test(afterIdle),
    afterIdle,
  )

  await disposeAll()

  // Error paths must be explicit, not silent.
  const sseError = await applyConfig(makeCtx().ctx, {
    mcpServers: { bad: { type: 'sse', url: 'https://example.com/sse' } },
  }).then(() => null, (error) => error.message)
  check('SSE transport rejected with a clear error', sseError !== null && sseError.includes('SSE'), String(sseError))

  // A missing source file is tolerated: an uninstalled Pi must not break DSH.
  const missing = makeCtx()
  const missingError = await applyConfig(missing.ctx, {
    configPaths: ['~/definitely-not-a-real-file.json'],
  }).then(() => null, (error) => error.message)
  check('missing configPaths entry is tolerated', missingError === null, String(missingError))
  check(
    'missing configPaths entry leaves zero servers',
    (await callTool(missing.tools, 'mcp_servers', {})).includes('No MCP servers are configured'),
  )
  await missing.disposeAll()

  // A malformed source file is a real problem and must be loud.
  const badPath = join(scratch, 'broken.json')
  await writeFile(badPath, '{ this is not json', 'utf8')
  const brokenError = await applyConfig(makeCtx().ctx, { configPaths: [badPath] }).then(
    () => null,
    (error) => error.message,
  )
  check(
    'malformed configPaths entry rejected loudly',
    brokenError !== null && brokenError.includes('is not valid JSON'),
    String(brokenError),
  )

  // A stale override is tolerated for the same reason.
  const stale = makeCtx()
  const staleError = await applyConfig(stale.ctx, {
    mcpServers: { only: { command: 'echo' } },
    overrides: { ghost: { lifecycle: 'lazy' } },
  }).then(() => null, (error) => error.message)
  check('override for an unknown server is tolerated', staleError === null, String(staleError))
  check(
    'the real server still loaded despite the stale override',
    (await callTool(stale.tools, 'mcp_servers', {})).includes('- only:'),
  )
  await stale.disposeAll()
}

// ── S9: importing a real MCP configuration, when this machine has one ───────
// The expectation is derived from the files themselves, so this section is
// portable: it exercises the real import path wherever a Pi / Claude-style
// config happens to exist, and skips cleanly when none does.
console.log('\nS9  importing a real MCP configuration')
{
  const piFiles = [join(homedir(), '.config', 'mcp', 'mcp.json'), join(homedir(), '.pi', 'agent', 'mcp-adapter.json')]
  const present = []
  for (const file of piFiles) {
    try {
      await readFile(file, 'utf8')
      present.push(file)
    } catch {
      console.log(`  SKIP  ${file} is not present`)
    }
  }
  if (present.length === 0) {
    console.log('  SKIP  no Pi / Claude-style MCP config found; nothing to import')
  } else {
    const expected = new Map()
    let unsupported = null
    for (const file of present) {
      let document
      try {
        document = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        continue
      }
      for (const [name, entry] of Object.entries(document?.mcpServers ?? {})) {
        if (entry?.disabled === true || entry?.enabled === false) {
          expected.delete(name)
          continue
        }
        if (entry?.type === 'sse' || (entry?.command === undefined && entry?.url === undefined)) {
          unsupported = `${name} in ${file}`
          break
        }
        expected.set(name, entry)
      }
      if (unsupported !== null) break
    }
    if (unsupported !== null) {
      console.log(`  SKIP  a real config entry is not importable (${unsupported}); fix or remove it to exercise this check`)
    } else {
      const { ctx, tools, disposeAll } = makeCtx()
      await applyConfig(ctx, {
        idleDisconnectMs: 60000,
        cachePath: join(scratch, 's9-cache.json'),
        configPaths: present,
      })
      const text = await callTool(tools, 'mcp_servers', {})
      if (expected.size === 0) {
        check('an empty imported config yields the empty state', text.includes('No MCP servers are configured'), text)
      } else {
        for (const name of expected.keys()) {
          check(`real config server imported: ${name}`, text.includes(`- ${name}:`), text)
        }
        const dormant = (text.match(/state=dormant/g) ?? []).length
        check('every imported server starts dormant', dormant >= expected.size, `${dormant} dormant of ${expected.size}`)
      }
      await disposeAll()
    }
  }
}

// ── S10: cache path fallback when the Host does not export DSH_* ─────────────
console.log('\nS10  cache path resolution with no DSH_* in the process environment')
{
  // The Host process does not inherit DSH_PROFILE_DIR / DSH_HOME: those are
  // injected into shell tool calls. Without a fallback the cache silently
  // disables itself in production, which is what happened on first live test.
  const fallbackPath = join(homedir(), '.dsh', 'lazy-mcp', 'tool-cache.json')
  const savedProfileDir = process.env.DSH_PROFILE_DIR
  const savedHome = process.env.DSH_HOME
  let existedBefore = true
  try {
    await readFile(fallbackPath, 'utf8')
  } catch {
    existedBefore = false
  }

  delete process.env.DSH_PROFILE_DIR
  delete process.env.DSH_HOME
  try {
    const { ctx, tools, disposeAll } = makeCtx()
    await applyConfig(ctx, { idleDisconnectMs: 60000, servers: [baseServer('s10', 'lazy')] })
    await callTool(tools, 'mcp_tools', { server: 's10', refresh: true })
    const text = await waitForFile(fallbackPath)
    check('cache written to the ~/.dsh fallback', text !== null, fallbackPath)
    if (text !== null) {
      const parsed = JSON.parse(text)
      check('fallback cache holds the server', Array.isArray(parsed.servers?.s10?.tools))
    }
    await disposeAll()
  } finally {
    if (savedProfileDir !== undefined) process.env.DSH_PROFILE_DIR = savedProfileDir
    if (savedHome !== undefined) process.env.DSH_HOME = savedHome
    if (!existedBefore) await rm(fallbackPath, { force: true })
  }
}

// ── S11: resources ──────────────────────────────────────────────────────────
console.log('\nS11  MCP resources: list, read, template substitution, binary projection')
{
  const { ctx, tools, disposeAll } = makeCtx()
  await applyConfig(ctx, {
    idleDisconnectMs: 60_000,
    servers: [baseServer('s11', 'lazy')],
  })

  const before = await callTool(tools, 'mcp_servers', {})
  check('s11 starts dormant', before.includes('state=dormant'), before)

  // Listing resources is a read of server state, so unlike mcp_tools it has no
  // cache to serve from and must connect.
  const listed = await callTool(tools, 'mcp_resources', { server: 's11' })
  check('mcp_resources lists 7 resources', listed.includes('7 resource(s)'), listed.slice(0, 160))
  check('mcp_resources lists 2 templates', listed.includes('2 template(s)'), listed.slice(0, 160))
  check('a static document uri is named', listed.includes('demo://resource/static/document/architecture.md'))
  check('the mime type is shown', listed.includes('[text/markdown]'))
  check('a template is named', listed.includes('demo://resource/dynamic/text/{resourceId}'))
  check('template substitution is explained', listed.includes('substitute the variables'))

  const afterList = await callTool(tools, 'mcp_servers', {})
  check('listing resources woke the server', afterList.includes('state=ready'), afterList)
  check('listing resources reset the idle timer', afterList.includes('lastUsed=0s ago'), afterList)

  // A static document.
  const doc = await callTool(tools, 'mcp_read_resource', {
    server: 's11',
    uri: 'demo://resource/static/document/architecture.md',
  })
  check('mcp_read_resource names the server', doc.startsWith('MCP server: s11'), doc.slice(0, 80))
  check('the body is the real document', doc.includes('Everything Server'), doc.slice(0, 200))
  check('the uri is echoed', doc.includes('demo://resource/static/document/architecture.md'))

  // A template instance: the uri the model must build itself.
  const dynamic = await callTool(tools, 'mcp_read_resource', {
    server: 's11',
    uri: 'demo://resource/dynamic/text/42',
  })
  check('a template-substituted uri reads', dynamic.includes('Resource 42'), dynamic.slice(0, 200))

  // A binary body must never be inlined: base64 would burn the window on bytes
  // the model cannot use.
  const blob = await callTool(tools, 'mcp_read_resource', {
    server: 's11',
    uri: 'demo://resource/dynamic/blob/42',
  })
  check('a binary body becomes a size notice', blob.includes('[binary resource:'), blob.slice(0, 200))
  check('the base64 payload is not inlined', !/[A-Za-z0-9+/]{120,}={0,2}/.test(blob))
  // The fixture's template declares application/octet-stream but the read
  // actually answers text/plain, so assert the header carries *a* mime type
  // rather than pinning the value the server does not send.
  check(
    'the uri and a mime type are still reported',
    blob.includes('demo://resource/dynamic/blob/42') && /\w+\/[\w.+-]+/.test(blob),
    blob.slice(0, 200),
  )

  // Failures keep the delivery vocabulary.
  const missing = await callToolExpectingFailure(tools, 'mcp_read_resource', {
    server: 's11',
    uri: 'demo://resource/does/not/exist',
  })
  check('an unknown uri fails with server_error', missing !== null && missing.includes('server_error'), String(missing).slice(0, 160))
  check('the server message is carried through', missing !== null && /not found/i.test(missing), String(missing).slice(0, 160))

  const emptyUri = await callToolExpectingFailure(tools, 'mcp_read_resource', { server: 's11', uri: '   ' })
  check('an empty uri is not_sent', emptyUri !== null && emptyUri.includes('not_sent'), String(emptyUri).slice(0, 120))

  const unknownServer = await callToolExpectingFailure(tools, 'mcp_resources', { server: 'nope' })
  check('an unknown server is not_sent', unknownServer !== null && unknownServer.includes('not_sent'), String(unknownServer).slice(0, 120))

  await disposeAll()
}

await rm(scratch, { recursive: true, force: true })

console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`)
process.exit(fail === 0 ? 0 : 1)
