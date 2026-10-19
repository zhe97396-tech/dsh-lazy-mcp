/**
 * Lazy-loading MCP gateway for DeepSeek Harness.
 *
 * The shipped `@deepseek-ai/dsh-mcp-client` connects every configured server
 * while the plugin activates and awaits the initial connection plus tool
 * discovery, so all servers are live before the first turn and stay live until
 * the Harness restarts. This plugin inverts that:
 *
 *   1. Activation starts nothing (unless a server opts into `eager` /
 *      `keep-alive`). Servers begin as *dormant* records.
 *   2. The first tool call that needs a server connects it on demand.
 *   3. Under the default `lazy` lifecycle, a connection is closed after
 *      `idleDisconnectMs` of inactivity and the server process is released.
 *
 * Three small model-facing tools keep the standing tool-definition cost flat
 * regardless of how many servers are configured:
 *
 *   mcp_servers  - list configured servers, lifecycle, state (never connects)
 *   mcp_tools    - list one server's tools; served from cache while dormant
 *   mcp_call     - invoke one tool, connecting on demand
 *
 * Extension point notes:
 *   - Registrations and the connection pool are owned by `ctx.effect`, so plugin
 *     unload and HMR dispose every server cleanly.
 *   - The gateway imports nothing from `@deepseek-ai/*`, so a Harness peer-range
 *     change cannot break it. Its only runtime dependency is the MCP SDK, the
 *     same one the official bridge uses.
 *
 * @module dsh-lazy-mcp
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
const name = 'lazy-mcp'

/** Services this plugin requires: the model-facing tool registry. */
const inject = ['tools']

const DEFAULT_IDLE_DISCONNECT_MS = 600_000
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const MIN_IDLE_DISCONNECT_MS = 1_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Lifecycle modes, mirroring the vocabulary the Pi MCP adapter established. */
const LIFECYCLE_MODES = ['lazy', 'eager', 'keep-alive', 'lazy-keep-alive']

/** Cache file format version; bump when the shape or fold semantics change. */
const CACHE_VERSION = 1
const CACHE_MAX_TOOLS_PER_SERVER = 2_000
const CACHE_MAX_BYTES = 8 * 1024 * 1024

/** Env names the subprocess seam treats as credential-shaped. */
const CREDENTIAL_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The subprocess seam's scrubbed parent environment: credential-shaped names
 * and every stale `DSH_*` name are dropped, so a child server never inherits
 * this process's model keys. A server that needs a secret gets it through its
 * own explicit `env` mapping.
 *
 * @returns A fresh environment mapping safe to hand to a child process.
 */
function scrubbedParentEnv() {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('DSH_')) continue
    if (CREDENTIAL_ENV_PATTERN.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Read a bounded integer from raw config.
 *
 * @param value - Raw config value.
 * @param fallback - Value used when the field is omitted.
 * @param where - Dotted path used in the error message.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @returns The validated number.
 */
function readBoundedInt(value, fallback, where, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where} must be a finite number`)
  }
  const int = Math.trunc(value)
  if (int < min || int > max) throw new Error(`${where} must be between ${min} and ${max}`)
  return int
}

/**
 * Read a string map (env / headers) from raw config.
 *
 * @param value - Raw config value.
 * @param where - Dotted path used in the error message.
 * @returns A plain string-to-string mapping.
 */
function readStringMap(value, where) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be a mapping`)
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') throw new Error(`${where}.${key} must be a string`)
    out[key] = raw
  }
  return out
}

/**
 * Expand a leading `~/` or `~\` to the user's home directory.
 *
 * @param path - Possibly home-relative path.
 * @returns An absolute path when the input was home-relative.
 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Expand `${VAR}` and `$VAR` from the process environment, the way the Pi MCP
 * adapter does for shared config files. An unknown name is left literal rather
 * than becoming an empty string, so a mistake is visible instead of silent.
 *
 * @param text - Text that may contain environment references.
 * @returns The expanded text.
 */
function expandVars(text) {
  return text
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => process.env[name] ?? match)
}

/**
 * Translate one entry of a standard `mcpServers` mapping into this plugin's
 * server shape.
 *
 * Standard MCP uses `command`/`args` for stdio and `url`/`headers` for HTTP, so
 * both the Pi adapter's shared files and a Claude Code / Cursor / `.mcp.json`
 * file can be imported unchanged. Pi-specific tuning fields are honoured where
 * this plugin has an equivalent: `lifecycle` maps directly, and `idleTimeout`
 * (minutes) becomes `idleDisconnectMs`.
 *
 * @param serverName - The mapping key, used as the server name.
 * @param definition - The raw standard server entry.
 * @param where - Dotted path used in error messages.
 * @returns A server entry in this plugin's native shape.
 */
function fromStandardServer(serverName, definition, where) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error(`${where} must be a mapping`)
  }
  const declaredType = typeof definition.type === 'string' ? definition.type.toLowerCase() : undefined
  if (declaredType === 'sse') {
    throw new Error(`${where}: the SSE transport is not supported; use a streamable-http URL instead`)
  }

  const out = { name: serverName }
  if (typeof definition.description === 'string') out.description = definition.description
  if (typeof definition.lifecycle === 'string') out.lifecycle = definition.lifecycle
  if (typeof definition.idleDisconnectMs === 'number') out.idleDisconnectMs = definition.idleDisconnectMs
  else if (typeof definition.idleTimeout === 'number') out.idleDisconnectMs = definition.idleTimeout * 60_000
  if (definition.disabled === true || definition.enabled === false) out.disabled = true

  if (typeof definition.url === 'string' && definition.url !== '') {
    out.transport = 'streamable-http'
    out.url = expandVars(definition.url)
    if (definition.headers !== undefined) {
      out.headers = {}
      for (const [key, value] of Object.entries(definition.headers)) {
        out.headers[key] = expandVars(String(value))
      }
    }
    return out
  }

  if (typeof definition.command === 'string' && definition.command !== '') {
    out.transport = 'stdio'
    out.command = definition.command
    if (definition.args !== undefined) {
      if (!Array.isArray(definition.args)) throw new Error(`${where}.args must be an array`)
      out.args = definition.args.map((value) => expandVars(String(value)))
    }
    if (definition.env !== undefined) {
      if (definition.env === null || typeof definition.env !== 'object' || Array.isArray(definition.env)) {
        throw new Error(`${where}.env must be a mapping`)
      }
      out.env = {}
      for (const [key, value] of Object.entries(definition.env)) {
        out.env[key] = expandVars(String(value))
      }
    }
    if (typeof definition.cwd === 'string' && definition.cwd !== '') {
      out.cwd = expandHome(expandVars(definition.cwd))
    }
    return out
  }

  throw new Error(`${where}: needs either "command" (stdio) or "url" (streamable-http)`)
}

/**
 * Read standard `mcpServers` mappings out of external JSON config files.
 *
 * This is what makes an existing Pi, Claude Code, Cursor, or `.mcp.json` setup
 * reusable: point `configPaths` at those files and their servers appear here,
 * so the other tool stays the source of truth.
 *
 * @param configPaths - Home-relative or absolute JSON file paths.
 * @param logger - Optional Cordis logger.
 * @returns Standard-shape entries translated to this plugin's shape.
 */
async function loadExternalServerEntries(configPaths, logger) {
  if (configPaths === undefined) return []
  const entries = []
  for (const rawPath of configPaths) {
    const path = expandHome(String(rawPath))
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // A missing file is tolerated so an uninstalled source tool cannot stop
      // the Harness from starting; any other read failure is a real problem.
      if (error?.code === 'ENOENT') {
        logger?.warn?.(`lazy-mcp: configPaths entry "${String(rawPath)}" does not exist; skipped`)
        continue
      }
      throw new Error(
        `lazy-mcp: cannot read configPaths entry "${String(rawPath)}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(
        `lazy-mcp: configPaths entry "${String(rawPath)}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const servers = parsed?.mcpServers
    if (servers === undefined) {
      logger?.warn?.(`lazy-mcp: "${String(rawPath)}" has no top-level "mcpServers" object; skipped`)
      continue
    }
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
      throw new Error(`lazy-mcp: "${String(rawPath)}".mcpServers must be a mapping`)
    }
    for (const [serverName, definition] of Object.entries(servers)) {
      entries.push(fromStandardServer(serverName, definition, `${String(rawPath)}#mcpServers.${serverName}`))
    }
  }
  return entries
}

/**
 * Merge every server source into one list, in precedence order.
 *
 * Later sources win on a name collision: imported files, then an inline
 * `mcpServers` mapping, then the native `servers` array, then per-field
 * `overrides`. An entry marked `disabled` removes that name entirely, which is
 * how an imported server is switched off without editing the other tool's file.
 *
 * @param raw - Raw row config.
 * @param imported - Entries read from `configPaths`.
 * @param logger - Optional Cordis logger, used for tolerated problems.
 * @returns The merged raw server entries, before validation.
 */
function buildRawEntries(raw, imported, logger) {
  const byName = new Map()
  /** Names an explicit `disabled: true` removed, so their override is not a typo. */
  const disabledNames = new Set()
  const put = (entry) => {
    if (entry.disabled === true) {
      byName.delete(entry.name)
      disabledNames.add(entry.name)
      return
    }
    byName.set(entry.name, entry)
  }

  for (const entry of imported) put(entry)

  if (raw.mcpServers !== undefined) {
    if (raw.mcpServers === null || typeof raw.mcpServers !== 'object' || Array.isArray(raw.mcpServers)) {
      throw new Error('lazy-mcp: mcpServers must be a mapping')
    }
    for (const [serverName, definition] of Object.entries(raw.mcpServers)) {
      put(fromStandardServer(serverName, definition, `lazy-mcp: mcpServers.${serverName}`))
    }
  }

  if (raw.servers !== undefined) {
    if (!Array.isArray(raw.servers)) throw new Error('lazy-mcp: servers must be an array')
    for (const [index, entry] of raw.servers.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`lazy-mcp: servers[${index}] must be a mapping`)
      }
      put({ ...entry })
    }
  }

  if (raw.overrides !== undefined) {
    if (raw.overrides === null || typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) {
      throw new Error('lazy-mcp: overrides must be a mapping')
    }
    for (const [serverName, patch] of Object.entries(raw.overrides)) {
      const existing = byName.get(serverName)
      if (existing === undefined) {
        // Warn instead of throwing: the imported files are a live source, so a
        // server can legitimately disappear from them between restarts. An
        // explicitly disabled server is not a typo, so it stays silent.
        if (!disabledNames.has(serverName)) {
          logger?.warn?.(`lazy-mcp: overrides.${serverName} does not match any configured or imported server; ignored`)
        }
        continue
      }
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error(`lazy-mcp: overrides.${serverName} must be a mapping`)
      }
      byName.set(serverName, { ...existing, ...patch, name: serverName })
    }
  }

  return [...byName.values()]
}

/**
 * Validate and normalize the row's raw `config`.
 *
 * No `Config` schema is declared, so this is the single place that decides what
 * a usable configuration is; every failure names the exact path.
 *
 * @param raw - Raw `config` mapping from the Loader row.
 * @param rawEntries - Merged server entries from {@link buildRawEntries}.
 * @returns Normalized gateway settings with per-server defaults applied.
 */
function normalizeConfig(raw, rawEntries) {

  const idleDisconnectMs = readBoundedInt(
    raw.idleDisconnectMs,
    DEFAULT_IDLE_DISCONNECT_MS,
    'lazy-mcp: idleDisconnectMs',
    MIN_IDLE_DISCONNECT_MS,
    MAX_TIMER_DELAY_MS,
  )
  const connectTimeoutMs = readBoundedInt(
    raw.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    'lazy-mcp: connectTimeoutMs',
    MIN_IDLE_DISCONNECT_MS,
    MAX_TIMER_DELAY_MS,
  )
  const callTimeoutMs = readBoundedInt(
    raw.callTimeoutMs,
    DEFAULT_CALL_TIMEOUT_MS,
    'lazy-mcp: callTimeoutMs',
    MIN_IDLE_DISCONNECT_MS,
    MAX_TIMER_DELAY_MS,
  )

  let cachePath
  if (raw.cachePath !== undefined && raw.cachePath !== null) {
    if (typeof raw.cachePath !== 'string' || raw.cachePath === '') {
      throw new Error('lazy-mcp: cachePath must be a non-empty string')
    }
    cachePath = raw.cachePath
  }

  const seen = new Set()
  const servers = rawEntries.map((entry, index) => {
    const where = `lazy-mcp: servers[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} must be a mapping`)
    }
    const serverName = entry.name
    if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error(`${where}.name must match ${String(SERVER_NAME_PATTERN)}`)
    }
    if (seen.has(serverName)) throw new Error(`${where}.name "${serverName}" is already used by another server`)
    seen.add(serverName)

    const lifecycle = entry.lifecycle ?? 'lazy'
    if (!LIFECYCLE_MODES.includes(lifecycle)) {
      throw new Error(`${where}.lifecycle must be one of ${LIFECYCLE_MODES.join(', ')}`)
    }

    const description = typeof entry.description === 'string' ? entry.description : ''
    const idleDisconnectMsExplicit = entry.idleDisconnectMs !== undefined && entry.idleDisconnectMs !== null
    const serverIdleMs = readBoundedInt(
      entry.idleDisconnectMs,
      idleDisconnectMs,
      `${where}.idleDisconnectMs`,
      MIN_IDLE_DISCONNECT_MS,
      MAX_TIMER_DELAY_MS,
    )

    if (entry.transport === 'stdio') {
      if (typeof entry.command !== 'string' || entry.command === '') {
        throw new Error(`${where}.command is required for a stdio server`)
      }
      const args = entry.args ?? []
      if (!Array.isArray(args)) throw new Error(`${where}.args must be an array`)
      return {
        serverName,
        description,
        lifecycle,
        transport: 'stdio',
        command: entry.command,
        args: args.map(String),
        env: readStringMap(entry.env, `${where}.env`),
        cwd: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined,
        idleDisconnectMs: serverIdleMs,
        idleDisconnectMsExplicit,
      }
    }

    if (entry.transport === 'streamable-http') {
      if (typeof entry.url !== 'string' || entry.url === '') {
        throw new Error(`${where}.url is required for a streamable-http server`)
      }
      let parsed
      try {
        parsed = new URL(entry.url)
      } catch {
        throw new Error(`${where}.url is not a valid absolute URL`)
      }
      return {
        serverName,
        description,
        lifecycle,
        transport: 'streamable-http',
        url: parsed,
        headers: readStringMap(entry.headers, `${where}.headers`),
        idleDisconnectMs: serverIdleMs,
        idleDisconnectMsExplicit,
      }
    }

    throw new Error(`${where}.transport must be "stdio" or "streamable-http"`)
  })

  return { servers, idleDisconnectMs, connectTimeoutMs, callTimeoutMs, cachePath }
}

/**
 * Resolve the metadata cache path.
 *
 * Order: explicit `cachePath` config, then `$DSH_PROFILE_DIR`, then `$DSH_HOME`,
 * then the conventional `~/.dsh`. The Host process does not necessarily inherit
 * the `DSH_*` variables — they are injected into shell tool calls — so the last
 * fallback is what keeps caching working in a normally launched Harness.
 *
 * @param resolved - Normalized gateway settings.
 * @returns An absolute cache path.
 */
function resolveCachePath(resolved) {
  if (resolved.cachePath !== undefined) return resolved.cachePath
  const fromEnv = process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return join(fromEnv, 'lazy-mcp', 'tool-cache.json')
  return join(homedir(), '.dsh', 'lazy-mcp', 'tool-cache.json')
}

/**
 * A stable fingerprint of everything that can change a server's tool list.
 * Environment *values* are excluded so secrets never reach the cache file; a
 * changed key set still invalidates, because that can change the tool list.
 *
 * @param server - Normalized server record.
 * @returns A short hex digest.
 */
function fingerprintOf(server) {
  const identity = {
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    envKeys: server.env === undefined ? [] : Object.keys(server.env).sort(),
    url: server.transport === 'streamable-http' ? server.url.href : undefined,
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)
}

/**
 * Read the metadata cache, tolerating every failure.
 *
 * A missing, unreadable, malformed, or wrong-version cache is not an error: it
 * just means no server has cached metadata yet.
 *
 * @param cachePath - Absolute cache path, or undefined when caching is off.
 * @param logger - Optional Cordis logger.
 * @returns A cache object with a `servers` mapping.
 */
async function loadCache(cachePath, logger) {
  const empty = { version: CACHE_VERSION, servers: {} }
  if (cachePath === undefined) return empty
  try {
    const text = await readFile(cachePath, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return empty
    if (parsed.version !== CACHE_VERSION) return empty
    if (parsed.servers === null || typeof parsed.servers !== 'object') return empty
    return { version: CACHE_VERSION, servers: parsed.servers }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`lazy-mcp: ignoring unusable metadata cache at ${cachePath}: ${String(error)}`)
    }
    return empty
  }
}

/**
 * Write the metadata cache atomically (temp file plus rename).
 *
 * @param cachePath - Absolute cache path, or undefined when caching is off.
 * @param cache - The cache object to persist.
 * @param logger - Optional Cordis logger.
 */
async function saveCache(cachePath, cache, logger) {
  if (cachePath === undefined) return
  try {
    const text = JSON.stringify(cache)
    if (text.length > CACHE_MAX_BYTES) {
      logger?.warn?.(`lazy-mcp: metadata cache exceeds ${CACHE_MAX_BYTES} bytes; not written`)
      return
    }
    await mkdir(dirname(cachePath), { recursive: true })
    const temp = `${cachePath}.tmp`
    await writeFile(temp, text, 'utf8')
    await rename(temp, cachePath)
  } catch (error) {
    logger?.warn?.(`lazy-mcp: could not write metadata cache at ${cachePath}: ${String(error)}`)
  }
}

/**
 * Where the browser-adjustable settings live.
 *
 * Beside the metadata cache, so the plugin owns exactly one directory and the
 * cache path's own fallback chain (explicit `cachePath` → `$DSH_PROFILE_DIR` →
 * `$DSH_HOME` → `~/.dsh`) is reused instead of duplicated.
 *
 * @param cachePath - Resolved cache path, or undefined when caching is off.
 * @returns The absolute settings path.
 */
function resolveSettingsPath(cachePath) {
  const dir = cachePath === undefined ? join(homedir(), '.dsh', 'lazy-mcp') : dirname(cachePath)
  return join(dir, 'settings.json')
}

/**
 * Read the settings file, tolerating every failure.
 *
 * A missing, unreadable, malformed, or out-of-range file is not an error: it
 * means no override is in effect and the configured default stands.
 *
 * @param settingsPath - Absolute settings path.
 * @param logger - Optional Cordis logger.
 * @returns A settings object, possibly empty.
 */
async function loadSettings(settingsPath, logger) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const settings = {}
    const idle = readBoundedInt(
      parsed.idleDisconnectMs,
      undefined,
      `${settingsPath}.idleDisconnectMs`,
      MIN_IDLE_DISCONNECT_MS,
      MAX_TIMER_DELAY_MS,
    )
    if (idle !== undefined) settings.idleDisconnectMs = idle
    return settings
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`lazy-mcp: ignoring unreadable settings at ${settingsPath}: ${String(error)}`)
    }
    return {}
  }
}

/**
 * Write the settings file atomically, or remove it when nothing is overridden.
 *
 * @param settingsPath - Absolute settings path.
 * @param settings - The settings to persist; an empty object removes the file.
 * @param logger - Optional Cordis logger.
 * @returns True when the file now matches `settings`.
 */
async function saveSettings(settingsPath, settings, logger) {
  try {
    await mkdir(dirname(settingsPath), { recursive: true })
    if (Object.keys(settings).length === 0) {
      // An absent file is the canonical "no override", so restoring the default
      // removes it rather than writing an empty object a later reader must
      // interpret.
      await rm(settingsPath, { force: true })
      return true
    }
    const temp = `${settingsPath}.tmp`
    await writeFile(temp, JSON.stringify(settings), 'utf8')
    await rename(temp, settingsPath)
    return true
  } catch (error) {
    logger?.warn?.(`lazy-mcp: could not write settings at ${settingsPath}: ${String(error)}`)
    return false
  }
}

/**
 * Render one configured server's transport target for human display.
 *
 * @param server - Normalized server record.
 * @returns A short target description.
 */
function describeTarget(server) {
  if (server.transport === 'stdio') return [server.command, ...server.args].join(' ')
  return server.url.href
}

/** Largest settings request body accepted, in bytes. */
const SETTINGS_BODY_MAX_BYTES = 4_096

/**
 * Read and parse one bounded JSON request body.
 *
 * @param req - The Node request.
 * @returns The parsed value, or undefined for an empty body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > SETTINGS_BODY_MAX_BYTES) {
        reject(new Error(`body exceeds ${SETTINGS_BODY_MAX_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Answer one request with a JSON body.
 *
 * @param req - The Node request, read only for its method.
 * @param res - The Node response.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(req, res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * The browser-facing status payload: one compact row per configured server,
 * plus the effective idle window and the bounds the panel may set it within.
 *
 * Deliberately excludes the transport target and every environment value. The
 * panel exists to answer "which servers are there and what are they doing",
 * not to mirror the configuration, and `describeTarget` can carry a command
 * line while `server.env` can carry secrets. Timestamps are absolute epoch
 * milliseconds; the browser formats them, so no clock is assumed here.
 *
 * @param resolved - The resolved gateway configuration.
 * @param records - The live per-server records.
 * @param settings - The effective browser-adjustable settings.
 * @param configuredIdleDisconnectMs - The idle window the config alone implies.
 * @returns A JSON-serializable snapshot.
 */
function serverSnapshot(resolved, records, settings, configuredIdleDisconnectMs) {
  return {
    generatedAt: Date.now(),
    idleDisconnectMs: resolved.idleDisconnectMs,
    settings: {
      overridden: settings.idleDisconnectMs !== undefined,
      configuredIdleDisconnectMs,
      minIdleDisconnectMs: MIN_IDLE_DISCONNECT_MS,
      maxIdleDisconnectMs: MAX_TIMER_DELAY_MS,
    },
    servers: resolved.servers.map((server) => {
      const record = records.get(server.serverName)
      return {
        name: server.serverName,
        description: server.description,
        lifecycle: server.lifecycle,
        transport: server.transport,
        status: record.status,
        toolCount: record.toolCount,
        metadataSource: record.metadataSource,
        connectedAt: record.connectedAt ?? null,
        lastUsedAt: record.lastUsedAt ?? null,
        lastError: record.lastError ?? null,
        connects: record.connects,
        pinned: record.pinned,
        // A per-server window in the config outranks the panel's global value;
        // the panel marks those rows so a change there is not expected to move.
        idleDisconnectMsExplicit: server.idleDisconnectMsExplicit === true,
      }
    }),
  }
}

/**
 * Race a promise against a deadline.
 *
 * The losing promise keeps a rejection handler attached so a late failure can
 * never surface as an unhandled rejection.
 *
 * @param promise - Work to bound.
 * @param ms - Deadline in milliseconds.
 * @param what - Label used in the timeout error.
 * @returns The promise's value.
 */
async function withTimeout(promise, ms, what) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Flatten MCP content blocks into bounded plain text.
 *
 * Images, audio, embedded resources, and unknown blocks become an explicit
 * marker instead of being dropped silently.
 *
 * @param content - Raw MCP `content` array, if the server returned one.
 * @param limit - Maximum characters kept per block.
 * @returns A readable text rendering.
 */
function summarizeContent(content, limit = 8_000) {
  if (!Array.isArray(content)) return '(no content)'
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      parts.push(String(block))
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text.length > limit ? `${block.text.slice(0, limit)}\n… [truncated]` : block.text)
      continue
    }
    if (block.type === 'image') {
      parts.push(`[image omitted: ${block.mimeType ?? 'unknown type'}]`)
      continue
    }
    if (block.type === 'audio') {
      parts.push(`[audio omitted: ${block.mimeType ?? 'unknown type'}]`)
      continue
    }
    if (block.type === 'resource') {
      const uri = block.resource?.uri
      parts.push(typeof uri === 'string' ? `[resource: ${uri}]` : '[resource]')
      continue
    }
    parts.push(`[${String(block.type ?? 'unknown')} block]`)
  }
  return parts.length > 0 ? parts.join('\n') : '(no content)'
}

/**
 * Flatten MCP `resources/read` contents into bounded plain text.
 *
 * A resource body carries either `text` or `blob`, never both. Binary payloads
 * are deliberately **not** inlined: a base64 body would spend the context
 * window on data the model cannot use, so it becomes a length notice — the
 * same shape the official `dsh-mcp-resources` projects. The uri and mimeType
 * stay visible either way, so the model can still say what it found.
 *
 * @param contents - Raw MCP `contents` array from a read result.
 * @param limit - Maximum characters kept per text body.
 * @returns A readable text rendering.
 */
function summarizeResourceContents(contents, limit = 8_000) {
  if (!Array.isArray(contents) || contents.length === 0) return '(no content)'
  const parts = []
  for (const entry of contents) {
    if (typeof entry !== 'object' || entry === null) {
      parts.push(String(entry))
      continue
    }
    const header = [entry.uri, entry.mimeType]
      .filter((value) => typeof value === 'string' && value !== '')
      .join('  ')
    const lead = header === '' ? '' : `${header}\n`
    if (typeof entry.text === 'string') {
      const body = entry.text.length > limit ? `${entry.text.slice(0, limit)}\n… [truncated]` : entry.text
      parts.push(`${lead}${body}`)
      continue
    }
    if (typeof entry.blob === 'string') {
      parts.push(`${lead}[binary resource: ${entry.blob.length} base64 characters; available to programmatic callers]`)
      continue
    }
    parts.push(`${lead}[resource with neither text nor blob]`)
  }
  return parts.join('\n\n')
}

/**
 * Whether an error means "this server does not implement that method".
 *
 * The JSON-RPC code is the reliable signal; the message check is a fallback
 * for transports that lose the code.
 *
 * @param error - The thrown value.
 * @returns True when the server answered "method not found".
 */
function isMethodNotFound(error) {
  const code = error?.code ?? error?.cause?.code
  if (code === -32601) return true
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|not supported|-32601/i.test(message)
}

/**
 * How far a failed `mcp_call` got, so the model can decide whether retrying is
 * safe. This mirrors the delivery vocabulary the Pi MCP adapter established.
 *
 * `not_sent`      the request never reached the server; nothing ran.
 * `server_error`  the server answered with an error; it may have partially run.
 * `may_have_run`  the request was sent and the outcome is unknown.
 */
const DELIVERY_GUIDANCE = {
  not_sent: 'The request never reached the MCP server, so nothing ran. Fix the cause and retry.',
  server_error: 'The MCP server answered with an error. The tool may have partially run; read the error before retrying.',
  may_have_run:
    'The request was sent and the outcome is unknown. Do NOT retry automatically: confirm the effect first '
    + '(for example re-read the affected resource) or ask the user. The connection was reset, so the next call reconnects.',
}

/**
 * Build a failure that names its delivery class and tells the model what is
 * safe to do next.
 *
 * @param delivery - One of the DELIVERY_GUIDANCE keys.
 * @param detail - The underlying problem.
 * @returns An Error carrying the delivery class.
 */
function deliveryError(delivery, detail) {
  const error = new Error(`[delivery=${delivery}] ${detail}\n${DELIVERY_GUIDANCE[delivery]}`)
  error.delivery = delivery
  return error
}

/**
 * The shared output contract for every gateway tool: a canonical value carrying
 * one text block, and the text projection the model sees.
 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      content: { type: 'array', items: {} },
    },
    required: ['content'],
    additionalProperties: false,
  },
  render(_args, value) {
    const blocks = Array.isArray(value?.content) ? value.content : []
    const text = blocks
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((entry) => entry !== '')
      .join('\n')
    return [{ type: 'text', text: text === '' ? '(no content)' : text }]
  },
}

/**
 * Wrap readable text as the canonical tool value.
 *
 * @param text - Text the model should read.
 * @returns The canonical value matching {@link TEXT_OUTPUT}.
 */
function textValue(text) {
  return { content: [{ type: 'text', text }] }
}

/**
 * Lazy MCP gateway plugin entry.
 *
 * @param ctx - Cordis context carrying the `tools` service.
 * @param config - Raw row configuration, validated here.
 */
async function apply(ctx, config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('lazy-mcp: config must be a mapping')
  const logger = ctx.logger
  if (raw.configPaths !== undefined && !Array.isArray(raw.configPaths)) {
    throw new Error('lazy-mcp: configPaths must be an array')
  }
  const imported = await loadExternalServerEntries(raw.configPaths, logger)
  const resolved = normalizeConfig(raw, buildRawEntries(raw, imported, logger))
  const cachePath = resolveCachePath(resolved)
  const cache = await loadCache(cachePath, logger)

  // The browser-adjustable settings layer sits above the row config: the panel
  // is how a user changes the idle window without editing a profile file, and
  // its value must survive a restart. `configuredIdleDisconnectMs` remembers
  // what the config alone implies, so "restore default" is a delete.
  const settingsPath = resolveSettingsPath(cachePath)
  const configuredIdleDisconnectMs = resolved.idleDisconnectMs
  const settings = await loadSettings(settingsPath, logger)

  /**
   * Push one effective idle window onto the resolved configuration.
   *
   * Only servers *without* an explicit per-server `idleDisconnectMs` follow it:
   * an explicit value in the config is a deliberate per-server decision and
   * outranks a global panel setting. `record.server` is the same object as the
   * matching `resolved.servers` entry, so the live records follow this too.
   *
   * @param idleMs - The effective idle window in milliseconds.
   */
  function setEffectiveIdleMs(idleMs) {
    resolved.idleDisconnectMs = idleMs
    for (const server of resolved.servers) {
      if (!server.idleDisconnectMsExplicit) server.idleDisconnectMs = idleMs
    }
  }

  if (settings.idleDisconnectMs !== undefined) setEffectiveIdleMs(settings.idleDisconnectMs)

  /** @type {Map<string, object>} One live record per configured server. */
  const records = new Map()
  for (const server of resolved.servers) {
    const record = {
      server,
      fingerprint: fingerprintOf(server),
      status: 'dormant',
      client: undefined,
      transport: undefined,
      pending: undefined,
      idleTimer: undefined,
      tools: undefined,
      toolCount: -1,
      metadataSource: 'none',
      metadataFetchedAt: undefined,
      connectedAt: undefined,
      lastUsedAt: undefined,
      lastError: undefined,
      connects: 0,
      pinned: false,
    }
    loadCachedMetadata(record)
    records.set(server.serverName, record)
  }

  /** Serializes cache writes so two connects cannot clobber each other. */
  let cacheWriteChain = Promise.resolve()
  function persistCache() {
    cacheWriteChain = cacheWriteChain.then(() => saveCache(cachePath, cache, logger))
    return cacheWriteChain
  }

  /**
   * The cache entry for one record, when it matches the server's current
   * configuration. A changed command, argument list, or env key set makes the
   * entry unusable, because any of those can change the tool list.
   *
   * @param record - The record to look up.
   * @returns The usable cache entry, or undefined.
   */
  function cacheHitFor(record) {
    const hit = cache.servers[record.server.serverName]
    if (hit === undefined) return undefined
    if (hit.fingerprint !== record.fingerprint) return undefined
    if (!Array.isArray(hit.tools)) return undefined
    return hit
  }

  /**
   * Give a record tool metadata without connecting it.
   *
   * Prefers the on-disk cache; falls back to whatever this process already
   * learned from a live connection, so a dormant server stays describable even
   * before its cache write has landed.
   *
   * @param record - The record to populate.
   * @returns True when the record now has usable metadata.
   */
  function loadCachedMetadata(record) {
    const hit = cacheHitFor(record)
    if (hit !== undefined) {
      record.tools = hit.tools
      record.toolCount = hit.tools.length
      record.metadataSource = 'cache'
      record.metadataFetchedAt = hit.fetchedAt
      return true
    }
    if (Array.isArray(record.tools) && record.tools.length > 0) {
      record.metadataSource = 'memory'
      return true
    }
    return false
  }

  /**
   * Resolve one configured server record or throw a model-readable error.
   *
   * @param serverName - Name as configured.
   * @returns The record.
   */
  function requireRecord(serverName) {
    const record = records.get(serverName)
    if (record === undefined) {
      const known = [...records.keys()]
      throw new Error(
        known.length === 0
          ? `Unknown MCP server "${String(serverName)}": this gateway has no servers configured.`
          : `Unknown MCP server "${String(serverName)}". Configured servers: ${known.join(', ')}.`,
      )
    }
    return record
  }

  /**
   * Whether this record's idle timer should be armed at all.
   *
   * `lazy` and (before its first connect) `lazy-keep-alive` always idle-close.
   * `eager` and `keep-alive` stay resident unless the server explicitly sets
   * `idleDisconnectMs`. A record pinned by `lazy-keep-alive` never closes.
   *
   * @param record - The record to test.
   * @returns True when an idle deadline applies.
   */
  function idleEnabled(record) {
    if (record.pinned) return false
    if (record.server.lifecycle === 'lazy') return true
    if (record.server.lifecycle === 'lazy-keep-alive') return true
    return record.server.idleDisconnectMsExplicit
  }

  /**
   * (Re)arm the idle deadline for one record.
   *
   * @param record - The record to arm.
   */
  function touchIdle(record) {
    if (record.idleTimer !== undefined) {
      clearTimeout(record.idleTimer)
      record.idleTimer = undefined
    }
    if (!idleEnabled(record)) return
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined
      void disconnect(record, 'idle timeout')
    }, record.server.idleDisconnectMs)
    record.idleTimer.unref?.()
  }

  /**
   * Close one server connection and release its process.
   *
   * Cached tool metadata is kept: that is the whole point of the cache, so a
   * dormant server can still be described without being started.
   *
   * @param record - The record to drop.
   * @param reason - Why the connection ended, for the log.
   */
  async function disconnect(record, reason) {
    if (record.idleTimer !== undefined) {
      clearTimeout(record.idleTimer)
      record.idleTimer = undefined
    }
    const client = record.client
    const transport = record.transport
    record.client = undefined
    record.transport = undefined
    record.connectedAt = undefined
    record.status = 'dormant'
    // Fall back to metadata so the server can still be described while it is
    // dormant; that is the whole point of keeping the cache.
    loadCachedMetadata(record)
    if (client === undefined && transport === undefined) return
    try {
      await (client !== undefined ? client.close() : transport.close())
      logger?.info?.(`lazy-mcp(${record.server.serverName}): disconnected (${reason})`)
    } catch (error) {
      logger?.warn?.(`lazy-mcp(${record.server.serverName}): close failed during ${reason}: ${String(error)}`)
    }
  }

  /**
   * Build a transport for one server from its normalized configuration.
   *
   * @param server - Normalized server record.
   * @returns A ready-to-connect MCP transport.
   */
  function createTransport(server) {
    if (server.transport === 'stdio') {
      return new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...scrubbedParentEnv(), ...server.env },
        cwd: server.cwd,
      })
    }
    return new StreamableHTTPClientTransport(server.url, { requestInit: { headers: server.headers } })
  }

  /**
   * Connect one server on demand and cache its tool list.
   *
   * Concurrent callers share one in-flight attempt. A failure resets the record
   * to `dormant` so the next call retries instead of latching an error.
   *
   * @param record - The record to bring up.
   */
  async function ensureReady(record) {
    if (record.status === 'ready' && record.client !== undefined) {
      touchIdle(record)
      return
    }
    if (record.pending !== undefined) {
      await record.pending
      touchIdle(record)
      return
    }

    const label = `lazy-mcp(${record.server.serverName})`
    record.status = 'connecting'
    record.pending = (async () => {
      const transport = createTransport(record.server)
      const client = new Client(
        { name: 'dsh-lazy-mcp', version: '0.2.0' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } },
      )
      try {
        await withTimeout(client.connect(transport), resolved.connectTimeoutMs, `${label}: connect`)
        const hasTools = client.getServerCapabilities()?.tools !== undefined
        const listed = hasTools ? await client.listTools(undefined, { cacheMode: 'refresh' }) : { tools: [] }
        record.client = client
        record.transport = transport
        record.tools = listed.tools ?? []
        record.toolCount = record.tools.length
        record.metadataSource = 'live'
        record.metadataFetchedAt = Date.now()
        record.status = 'ready'
        record.connectedAt = Date.now()
        record.lastError = undefined
        record.connects += 1
        if (record.server.lifecycle === 'lazy-keep-alive') record.pinned = true
        cache.servers[record.server.serverName] = {
          fingerprint: record.fingerprint,
          fetchedAt: record.metadataFetchedAt,
          tools: record.tools.slice(0, CACHE_MAX_TOOLS_PER_SERVER),
        }
        void persistCache()
        logger?.info?.(
          `lazy-mcp(${record.server.serverName}): connected on demand, ${record.toolCount} tool(s)`,
        )
      } catch (error) {
        try {
          await transport.close()
        } catch {
          // The connect attempt already failed; a failed close adds nothing.
        }
        record.client = undefined
        record.transport = undefined
        record.status = 'dormant'
        record.lastError = error instanceof Error ? error.message : String(error)
        throw new Error(`${label}: could not connect — ${record.lastError}`)
      } finally {
        record.pending = undefined
      }
    })()

    await record.pending
    touchIdle(record)
  }

  /**
   * Look up one tool in a record's current (live or cached) tool list.
   *
   * @param record - A record with metadata.
   * @param toolName - The server's own tool name.
   * @returns The upstream tool descriptor.
   */
  function requireTool(record, toolName) {
    const tool = (record.tools ?? []).find((entry) => entry.name === toolName)
    if (tool === undefined) {
      const available = (record.tools ?? []).map((entry) => entry.name)
      throw new Error(
        available.length === 0
          ? `MCP server "${record.server.serverName}" exposes no tools.`
          : `MCP server "${record.server.serverName}" has no tool "${String(toolName)}". Available: ${available.join(', ')}.`,
      )
    }
    return tool
  }

  const serverNames = resolved.servers.map((server) => server.serverName)
  const serverList = serverNames.length === 0 ? '(none configured)' : serverNames.join(', ')

  /**
   * Register one gateway tool as an owned effect.
   *
   * @param definition - The tool definition to register.
   */
  function registerTool(definition) {
    ctx.effect(() => ctx.tools.register(definition), `lazy-mcp.tool.${definition.name}`)
  }

  registerTool({
    name: 'mcp_servers',
    description:
      'List the MCP servers this gateway can reach, with each one\'s lifecycle, connection state, and tool count. '
      + 'Never connects anything, so calling it is free and does not start a server. '
      + `Configured: ${serverList}.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    timeoutMs: 5_000,
    execute() {
      const now = Date.now()
      const lines = resolved.servers.map((server) => {
        const record = records.get(server.serverName)
        const bits = [`lifecycle=${server.lifecycle}`, `transport=${server.transport}`]
        if (record.status === 'dormant' && record.lastError !== undefined) {
          bits.push('state=dormant (last connect failed)')
        } else {
          bits.push(`state=${record.status}`)
        }
        if (record.toolCount >= 0) bits.push(`tools=${record.toolCount}(${record.metadataSource})`)
        if (record.pinned) bits.push('pinned=yes')
        if (record.connectedAt !== undefined) bits.push(`connected=${Math.round((now - record.connectedAt) / 1000)}s ago`)
        if (record.lastUsedAt !== undefined) bits.push(`lastUsed=${Math.round((now - record.lastUsedAt) / 1000)}s ago`)
        if (record.connects > 0) bits.push(`connections=${record.connects}`)
        if (record.lastError !== undefined) bits.push(`lastError=${record.lastError}`)
        return `- ${server.serverName}: target=${describeTarget(server)} ${bits.join(' ')}`
      })
      const header = resolved.servers.length === 0
        ? 'No MCP servers are configured. Add entries under `servers` in the lazy-mcp row of the profile patch.'
        : 'Lifecycle: lazy connects on first use and disconnects when idle; lazy-keep-alive stops disconnecting after '
          + 'its first use; eager and keep-alive connect at startup and stay resident. '
          + `Idle window for lazy servers: ${Math.round(resolved.idleDisconnectMs / 1000)}s.`
      return textValue([header, ...lines].join('\n'))
    },
  })

  registerTool({
    name: 'mcp_tools',
    description:
      'List one MCP server\'s tools with their input schemas. Served from cached metadata while the server is dormant, '
      + 'so this does NOT start it; pass refresh: true to connect and re-read the live list. '
      + `Servers: ${serverList}.`,
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: `Server name. One of: ${serverList}.` },
        refresh: {
          type: 'boolean',
          description: 'Connect to the server and re-read its live tool list instead of using cached metadata.',
        },
      },
      required: ['server'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.connectTimeoutMs + 5_000,
    async execute(args) {
      const record = requireRecord(args?.server)
      const wantsRefresh = args?.refresh === true

      const offline = record.metadataSource === 'cache' || record.metadataSource === 'memory'
      if (!wantsRefresh && record.status !== 'ready' && offline) {
        const ageSeconds = record.metadataFetchedAt === undefined
          ? 'unknown'
          : `${Math.round((Date.now() - record.metadataFetchedAt) / 1000)}s`
        const sourceLabel = record.metadataSource === 'cache' ? 'cached metadata' : 'in-memory metadata'
        const lines = (record.tools ?? []).map((tool) => {
          const description = (tool.description ?? '').replace(/\s+/g, ' ').trim()
          return `- ${tool.name}: ${description === '' ? '(no description)' : description}\n  inputSchema: ${JSON.stringify(tool.inputSchema ?? {})}`
        })
        return textValue([
          `Server "${record.server.serverName}" is dormant; this list is ${sourceLabel} (age ${ageSeconds}).`,
          `It has ${record.toolCount} tool(s). Calling mcp_call will start it; pass refresh: true to start it now.`,
          ...lines,
        ].join('\n'))
      }

      try {
        await ensureReady(record)
      } catch (error) {
        throw deliveryError('not_sent', error instanceof Error ? error.message : String(error))
      }
      record.lastUsedAt = Date.now()
      const lines = (record.tools ?? []).map((tool) => {
        const description = (tool.description ?? '').replace(/\s+/g, ' ').trim()
        return `- ${tool.name}: ${description === '' ? '(no description)' : description}\n  inputSchema: ${JSON.stringify(tool.inputSchema ?? {})}`
      })
      return textValue(
        [`Server "${record.server.serverName}" is connected with ${record.toolCount} tool(s) (live metadata):`, ...lines].join('\n'),
      )
    },
  })

  registerTool({
    name: 'mcp_call',
    description:
      'Invoke one tool on one MCP server, connecting (and if needed starting) that server on demand. '
      + 'Call mcp_tools first to learn the exact tool name and argument schema. '
      + 'A failure reports a delivery class: not_sent means nothing ran, server_error means the server '
      + 'answered with an error, may_have_run means the outcome is unknown and must not be retried blindly. '
      + `Servers: ${serverList}.`,
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: `Server name. One of: ${serverList}.` },
        tool: { type: 'string', description: 'The tool name as reported by mcp_tools.' },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments object matching that tool\'s inputSchema. Omit for a no-argument tool.',
        },
      },
      required: ['server', 'tool'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.callTimeoutMs + 5_000,
    isConcurrencySafe() {
      // Two calls to the same dormant server share one connect; different
      // servers are fully independent, so parallel dispatch is safe.
      return true
    },
    async execute(args, exec) {
      if (typeof args !== 'object' || args === null) {
        throw deliveryError('not_sent', 'mcp_call requires an object argument')
      }

      let record
      let tool
      try {
        record = requireRecord(args.server)
        await ensureReady(record)
        tool = requireTool(record, args.tool)
      } catch (error) {
        throw deliveryError('not_sent', error instanceof Error ? error.message : String(error))
      }

      const callArgs = typeof args.arguments === 'object' && args.arguments !== null ? args.arguments : {}
      record.lastUsedAt = Date.now()

      let result
      try {
        result = await record.client.callTool(
          { name: tool.name, arguments: callArgs },
          { signal: exec?.signal, timeout: resolved.callTimeoutMs },
        )
      } catch (error) {
        // The request left this process, so the outcome is unknown. Reset the
        // connection so a later call starts from a clean transport.
        const message = error instanceof Error ? error.message : String(error)
        await disconnect(record, 'call failed')
        throw deliveryError('may_have_run', `mcp_call ${record.server.serverName}/${tool.name} failed: ${message}`)
      }

      if (result?.isError === true) {
        throw deliveryError(
          'server_error',
          `mcp_call ${record.server.serverName}/${tool.name} reported an error:\n${summarizeContent(result?.content)}`,
        )
      }

      if (record.status === 'ready') touchIdle(record)
      const text = summarizeContent(result?.content)
      const structured = result?.structuredContent
      const trailer = structured === undefined
        ? ''
        : `\n\nstructuredContent: ${JSON.stringify(structured).slice(0, 4_000)}`
      return textValue(`${text}${trailer}`)
    },
  })

  // MCP exposes three primitives, not one: tools (functions the model calls),
  // resources (documents and data it can read), and prompts. Only the tool side
  // is useful without a registry the server agreed to populate, so these two
  // tools bridge the read half for any server that advertises it — including
  // servers whose value is almost entirely in their resources.
  //
  // Both connect on demand through the same `ensureReady` the tool side uses,
  // so a resource read shares the lazy lifecycle, the idle reclaim, and the
  // delivery vocabulary. Unlike `mcp_tools` there is no metadata cache: a
  // resource list is not something to hold stale, and the SDK's own per-client
  // response cache already dies with the connection.
  registerTool({
    name: 'mcp_resources',
    description:
      'List one MCP server\'s resources and resource templates: the documents and data it exposes for reading, '
      + 'as opposed to the functions mcp_tools lists. Read one with mcp_read_resource. '
      + 'Unlike mcp_tools this always connects — a resource list is never served from a cache — so it starts a '
      + 'dormant server. A server that exposes no resources reports that instead of failing. '
      + `Servers: ${serverList}.`,
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: `Server name. One of: ${serverList}.` },
      },
      required: ['server'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.connectTimeoutMs + 5_000,
    isConcurrencySafe() {
      // Read-only against the server, and a shared connect for a dormant one.
      return true
    },
    async execute(args, exec) {
      let record
      try {
        record = requireRecord(args?.server)
        await ensureReady(record)
      } catch (error) {
        throw deliveryError('not_sent', error instanceof Error ? error.message : String(error))
      }
      record.lastUsedAt = Date.now()

      let listed
      let templates
      try {
        listed = await record.client.listResources(undefined, { signal: exec?.signal })
        templates = await record.client.listResourceTemplates(undefined, { signal: exec?.signal })
      } catch (error) {
        // Both calls are reads: nothing on the server changed, so a retry is
        // always safe, and "the server does not do resources" is a fact rather
        // than a failure worth a delivery class.
        if (isMethodNotFound(error)) {
          return textValue(
            `Server "${record.server.serverName}" does not expose MCP resources `
            + '(it answered "method not found" for resources/list). Use mcp_tools for its functions.',
          )
        }
        throw deliveryError(
          'not_sent',
          `mcp_resources ${record.server.serverName} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const resources = Array.isArray(listed?.resources) ? listed.resources : []
      const resourceTemplates = Array.isArray(templates?.resourceTemplates) ? templates.resourceTemplates : []
      const lines = [
        `Server "${record.server.serverName}" exposes ${resources.length} resource(s) `
        + `and ${resourceTemplates.length} template(s):`,
      ]
      for (const resource of resources) {
        const description = typeof resource?.description === 'string' ? ` — ${resource.description.replace(/\s+/g, ' ').trim()}` : ''
        const mime = typeof resource?.mimeType === 'string' ? ` [${resource.mimeType}]` : ''
        lines.push(`- ${resource?.uri ?? '(no uri)'}${mime}${description}`)
      }
      if (resourceTemplates.length > 0) {
        lines.push('Templates (substitute the variables, then read the resulting uri):')
        for (const template of resourceTemplates) {
          const description = typeof template?.description === 'string' ? ` — ${template.description.replace(/\s+/g, ' ').trim()}` : ''
          const mime = typeof template?.mimeType === 'string' ? ` [${template.mimeType}]` : ''
          lines.push(`- ${template?.uriTemplate ?? '(no uriTemplate)'}${mime}${description}`)
        }
      }
      if (resources.length === 0 && resourceTemplates.length === 0) {
        lines.push('(This server advertises the capability but lists nothing.)')
      }
      return textValue(lines.join('\n'))
    },
  })

  registerTool({
    name: 'mcp_read_resource',
    description:
      'Read one MCP resource by its exact uri, connecting (and if needed starting) that server on demand. '
      + 'Get the uri from mcp_resources, including by substituting a resource template. '
      + 'Text bodies are returned whole up to a bound; binary bodies are reported by size instead of inlined. '
      + `Servers: ${serverList}.`,
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: `Server name. One of: ${serverList}.` },
        uri: { type: 'string', description: 'The exact resource uri, as reported by mcp_resources.' },
      },
      required: ['server', 'uri'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.callTimeoutMs + 5_000,
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      if (typeof args?.uri !== 'string' || args.uri.trim() === '') {
        throw deliveryError('not_sent', 'mcp_read_resource requires a non-empty uri')
      }
      const uri = args.uri.trim()

      let record
      try {
        record = requireRecord(args.server)
        await ensureReady(record)
      } catch (error) {
        throw deliveryError('not_sent', error instanceof Error ? error.message : String(error))
      }
      record.lastUsedAt = Date.now()

      let result
      try {
        result = await record.client.readResource({ uri }, { signal: exec?.signal })
      } catch (error) {
        // A read is idempotent, so a retry can never double-apply anything —
        // the delivery class exists only to keep the vocabulary uniform.
        if (isMethodNotFound(error)) {
          throw deliveryError(
            'server_error',
            `mcp_read_resource ${record.server.serverName}: the server does not implement resources/read`,
          )
        }
        throw deliveryError(
          'server_error',
          `mcp_read_resource ${record.server.serverName} ${uri} failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }

      if (record.status === 'ready') touchIdle(record)
      return textValue(
        `MCP server: ${record.server.serverName}\n${summarizeResourceContents(result?.contents)}`,
      )
    },
  })

  ctx.effect(
    () => async () => {
      for (const record of [...records.values()]) {
        await disconnect(record, 'plugin dispose')
      }
      await cacheWriteChain
    },
    'lazy-mcp.connections',
  )

  // The browser status panel's data source and its one setting. `webServer` is
  // the Host's HTTP carrier and is absent in the headless and SDK profiles, so
  // this is a soft dependency read through `ctx.get`: the three gateway tools
  // work everywhere, and the panel simply does not exist where no browser
  // carrier is composed.
  //
  // `GET` is read-only and never touches a server, so opening the panel cannot
  // wake anything. `POST`/`DELETE` change only the idle window: no server is
  // connected, disconnected, or reconfigured, and a running deadline is merely
  // re-armed. The carrier is loopback-only, and the payload is bounded and
  // validated before anything is written.
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({
        kind: 'exact',
        path: '/lazy-mcp/state',
        handler: async (req, res) => {
          const snapshot = () => serverSnapshot(resolved, records, settings, configuredIdleDisconnectMs)

          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(req, res, 200, snapshot())
            return
          }

          if (req.method === 'POST' || req.method === 'DELETE') {
            let idleMs
            if (req.method === 'DELETE') {
              delete settings.idleDisconnectMs
              idleMs = configuredIdleDisconnectMs
            } else {
              let body
              try {
                body = await readJsonBody(req)
              } catch (error) {
                sendJson(req, res, 400, { error: String(error?.message ?? error) })
                return
              }
              let requested
              try {
                requested = readBoundedInt(
                  body?.idleDisconnectMs,
                  undefined,
                  'idleDisconnectMs',
                  MIN_IDLE_DISCONNECT_MS,
                  MAX_TIMER_DELAY_MS,
                )
              } catch (error) {
                sendJson(req, res, 400, { error: String(error?.message ?? error) })
                return
              }
              if (requested === undefined) {
                sendJson(req, res, 400, { error: 'idleDisconnectMs is required' })
                return
              }
              settings.idleDisconnectMs = requested
              idleMs = requested
            }

            setEffectiveIdleMs(idleMs)
            // Re-arm only what is already connected: a dormant record has no
            // deadline to move, and arming one would be a lie.
            for (const record of records.values()) {
              if (record.status === 'ready') touchIdle(record)
            }
            const persisted = await saveSettings(settingsPath, settings, logger)
            logger?.info?.(`lazy-mcp: idle window set to ${idleMs} ms (persisted=${persisted})`)
            sendJson(req, res, 200, { ...snapshot(), persisted })
            return
          }

          res.writeHead(405, { allow: 'GET, HEAD, POST, DELETE' })
          res.end()
        },
      }),
      'lazy-mcp.statusRoute',
    )
  }

  // `eager` and `keep-alive` begin connecting at activation, but activation
  // never waits on them: a slow or broken server must not delay Harness
  // startup, which is the failure this plugin exists to avoid.
  for (const record of records.values()) {
    const { lifecycle } = record.server
    if (lifecycle !== 'eager' && lifecycle !== 'keep-alive') continue
    void ensureReady(record).catch((error) => {
      logger?.warn?.(`lazy-mcp(${record.server.serverName}): ${lifecycle} connect failed: ${String(error)}`)
    })
  }

  const configured = resolved.servers.length
  const cached = [...records.values()].filter((record) => record.metadataSource === 'cache').length
  logger?.info?.(
    `lazy-mcp: ready with ${configured} server(s)`
    + (imported.length > 0 ? ` (${imported.length} imported from ${(raw.configPaths ?? []).length} config file(s))` : '')
    + (cached > 0 ? `; ${cached} with cached metadata` : '')
    + `; idle disconnect after ${resolved.idleDisconnectMs} ms`
    + (cachePath === undefined ? '; metadata cache disabled' : `; cache at ${cachePath}`),
  )
}

export { apply, inject, name }
