import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { getAgentDir } from './pi-settings.js'
import { getPiAcpMcpPolicyPath } from './paths.js'

// Marker written into generated configs so we only ever overwrite / clean up files
// that pi-acp authored, never a hand-written `.pi/mcp.json`.
const GENERATED_MARKER = 'pi-acp'

type PiMcpBase = { exposure?: PiMcpExposure }
type PiMcpStdioEntry = PiMcpBase & { command: string; args?: string[]; env?: Record<string, string> }
/** pi's MCP tool exposure. `codemode` is pi's default: reachable from codemode scripts / tool_search. */
export type PiMcpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden'

type PiMcpHttpEntry = PiMcpBase & { url: string; headers?: Record<string, string> }
type PiMcpEntry = PiMcpStdioEntry | PiMcpHttpEntry

export type PiMcpConfig = {
  mcpServers: Record<string, PiMcpEntry>
  _generatedBy?: string
}

export type McpTranslation = {
  config: PiMcpConfig
  /** Names of servers we could not express in pi's native MCP schema (sse / acp). */
  skipped: string[]
  /** Names skipped because a policy said to defer to the user's own (lower-precedence) config. */
  preserved: string[]
}

/**
 * Policy consulted when generating ACP-provided servers, loaded from
 * `<pi-acp dataDir>/mcp-policy.json` (default `~/.pi/pi-acp/mcp-policy.json`).
 *
 * Why: the ACP `McpServer` shape can't express bearer auth, and a client-supplied server entry may
 * collide with one the user configured themselves (with its own credentials). So the operator
 * controls which servers pi-acp may register — **same semantics pi-subagents uses for tool/extension
 * inheritance** (`true | string[] | false` + an exclude denylist):
 *
 *  - `generate`: which servers pi-acp may write. `true`/`"*"`/omitted = all (default, current
 *    behavior), `string[]` = only those names, `false` = none. Servers NOT generated are
 *    **preserved** — pi-acp leaves the user's own (lower-precedence) `mcp.json` entry and its auth
 *    in place. (Names are case-insensitive.)
 *  - `exclude`: denylist applied after `generate` (exclude wins) — e.g. a globally-configured,
 *    bearer-auth'd server you never want pi-acp to override.
 *  - `auth`: for a server pi-acp DOES register, add `Authorization: Bearer ${VAR}` (+ extra
 *    headers). pi interpolates `${VAR}` at connect, so the token never travels in the payload and
 *    stays out of the client's hands.
 *
 *  - `defaultExposure` / `exposure`: pi's `codemode` default keeps MCP tools out of the model's tool
 *    list (they are reached through `codemode` scripts and `tool_search`). Set `"direct"` to declare
 *    them like built-in tools — what a client expecting the old pi-mcp-adapter behavior wants — or
 *    `"deferred"`/`"hidden"` per server.
 *
 * Shape: `{ "generate": true | "*" | ["a","b"] | false, "exclude": ["x"],
 *          "auth": { "<name>": { "bearerTokenEnv": "VAR", "headers": {…} } },
 *          "defaultExposure": "codemode", "exposure": { "<name>": "direct" } }`
 */
export type McpServerAuth = { bearerTokenEnv?: string; headers?: Record<string, string> }
export type McpPolicy = {
  generate?: boolean | '*' | string[]
  exclude?: string[]
  auth?: Record<string, McpServerAuth>
  /** Exposure applied to every generated server unless `exposure[name]` overrides it. */
  defaultExposure?: PiMcpExposure
  /** Per-server exposure override (case-insensitive names). */
  exposure?: Record<string, PiMcpExposure>
}

type NameValue = { name: string; value: string }

/** Load the MCP generation policy. Missing/invalid file → `{}` (default: generate all). */
export function loadMcpPolicy(path: string = getPiAcpMcpPolicyPath()): McpPolicy {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const obj = raw as {
      generate?: unknown
      exclude?: unknown
      auth?: unknown
      exposure?: unknown
      defaultExposure?: unknown
    }
    const out: McpPolicy = {}

    if (typeof obj.generate === 'boolean' || obj.generate === '*') out.generate = obj.generate
    else if (Array.isArray(obj.generate)) out.generate = obj.generate.filter((x): x is string => typeof x === 'string')

    if (Array.isArray(obj.exclude)) out.exclude = obj.exclude.filter((x): x is string => typeof x === 'string')

    const validExposures: readonly PiMcpExposure[] = ['codemode', 'deferred', 'direct', 'hidden']
    const asExposure = (v: unknown): PiMcpExposure | undefined =>
      typeof v === 'string' && (validExposures as readonly string[]).includes(v) ? (v as PiMcpExposure) : undefined

    out.defaultExposure = asExposure((obj as { defaultExposure?: unknown }).defaultExposure)
    if (!out.defaultExposure) delete out.defaultExposure

    const exposureRaw = (obj as { exposure?: unknown }).exposure
    if (exposureRaw && typeof exposureRaw === 'object' && !Array.isArray(exposureRaw)) {
      const exposure: Record<string, PiMcpExposure> = {}
      for (const [name, val] of Object.entries(exposureRaw as Record<string, unknown>)) {
        const parsed = asExposure(val)
        if (parsed) exposure[name] = parsed
      }
      if (Object.keys(exposure).length) out.exposure = exposure
    }

    if (obj.auth && typeof obj.auth === 'object') {
      const auth: Record<string, McpServerAuth> = {}
      for (const [name, val] of Object.entries(obj.auth as Record<string, unknown>)) {
        if (!val || typeof val !== 'object') continue
        const v = val as { bearerTokenEnv?: unknown; headers?: unknown }
        const entry: McpServerAuth = {}
        if (typeof v.bearerTokenEnv === 'string' && v.bearerTokenEnv) entry.bearerTokenEnv = v.bearerTokenEnv
        if (v.headers && typeof v.headers === 'object') {
          const headers: Record<string, string> = {}
          for (const [k, hv] of Object.entries(v.headers as Record<string, unknown>)) headers[k] = String(hv)
          if (Object.keys(headers).length) entry.headers = headers
        }
        auth[name] = entry
      }
      out.auth = auth
    }

    return out
  } catch {
    return {}
  }
}

/** Whether pi-acp may generate an entry for `name` (exclude wins over generate). Default: yes. */
function shouldGenerate(name: string, policy: McpPolicy): boolean {
  const lc = name.toLowerCase()
  if ((policy.exclude ?? []).some(n => n.toLowerCase() === lc)) return false
  const gen = policy.generate
  if (gen === false) return false
  if (gen === undefined || gen === true || gen === '*') return true
  return gen.some(n => n.toLowerCase() === lc)
}

/** Case-insensitive lookup: policy server names are matched leniently (README documents that). */
function lookup<T>(map: Record<string, T> | undefined, name: string): T | undefined {
  if (!map) return undefined
  if (name in map) return map[name]
  const lc = name.toLowerCase()
  for (const key of Object.keys(map)) if (key.toLowerCase() === lc) return map[key]
  return undefined
}

function toRecord(pairs: readonly NameValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    if (p && typeof p.name === 'string') out[p.name] = String(p.value ?? '')
  }
  return out
}

/**
 * Translate ACP `McpServer[]` into pi's native `mcpServers` entry shape (as in `mcp.json` and the
 * `pi.registerMcpServer()` config). stdio and http servers translate cleanly; sse / acp variants are
 * not expressible (pi rejects `sse`) and are reported as `skipped`.
 */
export function translateMcpServers(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = {}
): McpTranslation {
  const mcpServers: Record<string, PiMcpEntry> = {}
  const skipped: string[] = []
  const preserved: string[] = []

  for (const server of servers ?? []) {
    const name = String(server.name ?? '').trim()
    if (!name) continue

    if (!shouldGenerate(name, policy)) {
      // Not in the generate allowlist (or excluded) — leave the user's existing mcp.json entry
      // (and its auth) in place rather than overriding it.
      preserved.push(name)
      continue
    }

    const rule = lookup(policy.auth, name)
    const exposure = lookup(policy.exposure, name) ?? policy.defaultExposure
    const type = (server as { type?: string }).type

    if (!type || type === 'stdio') {
      const stdio = server as { command?: string; args?: string[]; env?: NameValue[] }
      const command = String(stdio.command ?? '').trim()
      if (!command) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpStdioEntry = {
        command,
        args: Array.isArray(stdio.args) ? stdio.args.map(String) : []
      }
      const env = toRecord(stdio.env)
      if (Object.keys(env).length) entry.env = env
      if (exposure) entry.exposure = exposure
      mcpServers[name] = entry
    } else if (type === 'http') {
      const http = server as { url?: string; headers?: NameValue[] }
      const url = String(http.url ?? '').trim()
      if (!url) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpHttpEntry = { url }
      // Client-sent headers, then policy headers, then a policy bearer — policy wins. The bearer is
      // written as `${VAR}` so pi resolves it at connect from the environment; the secret itself never
      // enters the payload.
      const headers: Record<string, string> = { ...toRecord(http.headers), ...(rule?.headers ?? {}) }
      if (rule?.bearerTokenEnv) headers['Authorization'] = `Bearer \${${rule.bearerTokenEnv}}`
      if (Object.keys(headers).length) entry.headers = headers
      if (exposure) entry.exposure = exposure
      mcpServers[name] = entry
    } else {
      // sse / acp: not expressible in pi's native MCP config shape.
      skipped.push(name)
    }
  }

  return { config: { mcpServers, _generatedBy: GENERATED_MARKER }, skipped, preserved }
}

export type McpConfigPayload = {
  /**
   * Base64 of `{ "mcpServers": { … } }`, handed to pi in `PI_ACP_MCP_CONFIG` for the bundled
   * extension (`src/pi-extension-mcp.ts`) to register with `pi.registerMcpServer()`. `null` when
   * there is nothing to register. Kept in the environment rather than a temp file so no
   * client-supplied secret is ever written to disk.
   */
  payload: string | null
  /** Servers we could not express in pi's config shape (sse / acp). */
  skipped: string[]
  /** Server names not generated because the policy said to defer to the user's own config. */
  preserved: string[]
}

function isGeneratedConfig(path: string): boolean {
  try {
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as { _generatedBy?: unknown }
    return existing?._generatedBy === GENERATED_MARKER
  } catch {
    return false
  }
}

/**
 * Encode the ACP-provided MCP servers for pi's native MCP support.
 *
 * pi has no flag for a session-scoped MCP config: it reads `~/.pi/agent/mcp.json` and the project's
 * `.pi/mcp.json`, and nothing else (`--no-mcp` is the only MCP flag). pi-acp therefore ships a small
 * extension (`src/pi-extension-mcp.ts`, loaded via `--extension`) that registers these servers with
 * `pi.registerMcpServer()` for the session. The config rides in `PI_ACP_MCP_CONFIG` as base64, so:
 *
 * - nothing is written to disk (no temp file, no client-supplied header/env secret in a file), and
 * - `<cwd>/.pi/mcp.json` is untouched — that path is pi's highest-precedence *project config
 *   namespace* (settings, prompts, trust, mcp); writing there overrode the user's global config,
 *   persisted past the session, and poisoned unrelated (even non-ACP) pi sessions in the same cwd.
 *
 * Registrations live exactly as long as the session and are never saved. Returns `payload: null`
 * when there is nothing to register.
 */
export function encodeMcpConfig(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = loadMcpPolicy()
): McpConfigPayload {
  const { config, skipped, preserved } = translateMcpServers(servers, policy)

  if (Object.keys(config.mcpServers).length === 0) {
    return { payload: null, skipped, preserved }
  }

  // A bearer token still travels as a header. The policy's `bearerTokenEnv` writes `${VAR}` instead,
  // which pi interpolates at connect, so the secret itself stays out of the payload.
  return { payload: Buffer.from(JSON.stringify(config), 'utf-8').toString('base64'), skipped, preserved }
}

/**
 * Best-effort removal of a stale `<cwd>/.pi/mcp.json` that a PREVIOUS pi-acp version generated
 * (marked `_generatedBy: pi-acp`). Older builds wrote into pi's project config namespace; a leftover
 * one still wins at highest precedence and would re-introduce the override/persistence hazard. Only
 * ever removes a file pi-acp authored — never a hand-written config.
 */
export function cleanupStaleGeneratedConfig(cwd: string): void {
  const path = join(cwd, '.pi', 'mcp.json')
  try {
    if (existsSync(path) && isGeneratedConfig(path)) rmSync(path, { force: true })
  } catch {
    // best effort
  }
}

/**
 * Best-effort check of pi settings for a `pi-mcp-adapter` package entry. An extension that registers
 * `/mcp` replaces pi's built-in MCP support, which means our `registerMcpServer()` calls go nowhere —
 * so the adapter is a *conflict* now, not a dependency.
 */
export function piMcpAdapterInstalled(cwd: string): boolean {
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(cwd, '.pi', 'settings.json')]
  for (const p of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(p, 'utf-8')) as { packages?: unknown }
      const pkgs = Array.isArray(settings.packages) ? settings.packages : []
      if (pkgs.some(pkg => typeof pkg === 'string' && pkg.includes('pi-mcp-adapter'))) return true
    } catch {
      // ignore missing / invalid settings
    }
  }
  return false
}

/**
 * Build a one-time, human-readable notice about MCP wiring: which servers we could
 * not translate, and whether `pi-mcp-adapter` is installed (it replaces pi's built-in
 * MCP support, which breaks registration). Returns null when there is nothing worth
 * telling the user.
 */
export function buildMcpNotice(
  cwd: string,
  result: Pick<McpConfigPayload, 'payload' | 'skipped' | 'preserved'>
): string | null {
  const lines: string[] = []

  if (result.payload && piMcpAdapterInstalled(cwd)) {
    lines.push(
      "MCP servers were provided, but `pi-mcp-adapter` is installed and replaces pi's built-in MCP support, " +
        'so they cannot be registered. Remove `pi-mcp-adapter` from your pi `packages` to use native MCP.'
    )
  }

  if (result.preserved?.length) {
    lines.push(`MCP servers deferred to your existing config (auth policy): ${result.preserved.join(', ')}.`)
  }

  if (result.skipped.length) {
    lines.push(`Skipped MCP servers not expressible for pi (sse/acp): ${result.skipped.join(', ')}.`)
  }

  return lines.length ? lines.join('\n') : null
}
