/**
 * Native-MCP bridge extension for `pi-acp`.
 *
 * pi-acp receives MCP servers from the ACP client (`session/new`, `session/load`,
 * `session/resume`), but pi itself has no command-line way to accept them: MCP is configured from
 * `~/.pi/agent/mcp.json` and `<cwd>/.pi/mcp.json` only. Writing the client's servers into the
 * project's config namespace is not acceptable (it overrides the user's config, persists past the
 * session, and leaks into unrelated pi sessions in the same directory), and the temp-file overlay
 * pi-acp used to pass to `pi-mcp-adapter` needs a third-party extension and lands client secrets on
 * disk.
 *
 * pi >= 1.3 exposes `pi.registerMcpServer()`, which registers a server for the current session and
 * never saves it — exactly the semantics ACP `mcpServers` has. This extension (bundled with pi-acp,
 * loaded with `--extension`) registers the client's servers that way, so pi's own MCP machinery
 * (exposure, codemode, tool_search, `/mcp`, OAuth) applies.
 *
 * The payload travels in `PI_ACP_MCP_CONFIG` as base64 of `{ "mcpServers": { … } }` (the same entry
 * shape as `mcp.json`). Nothing is written to disk and nothing survives the session; the variable is
 * deleted from the environment so server processes cannot inherit it. Inert when it is unset, so
 * loading this file in a normal `pi` session does nothing.
 *
 * Types are declared locally on purpose: pi-acp drives pi over RPC and does not depend on
 * `@earendil-works/pi-coding-agent`. Pi injects the real API at load time.
 */

const ENV_VAR = 'PI_ACP_MCP_CONFIG'

interface PiMcpExtensionApi {
  registerMcpServer?: (name: string, config: unknown) => void
}

/** Never write to stdout: under `--mode rpc` stdout carries the protocol. */
function warn(message: string): void {
  try {
    process.stderr.write(`[pi-acp] ${message}\n`)
  } catch {
    // stderr gone; nothing useful left to do
  }
}

function decodeServers(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const trimmed = raw.trim()
    // Accept plain JSON too, so the bridge is easy to test by hand.
    const text = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf-8')
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const servers = (parsed as { mcpServers?: unknown }).mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    return servers as Record<string, unknown>
  } catch {
    return null
  }
}

export default function (pi: PiMcpExtensionApi) {
  const servers = decodeServers(process.env[ENV_VAR])

  // Drop the payload (it may hold client-supplied header/env secrets) before any MCP server process
  // or tool-spawned child inherits our environment.
  delete process.env[ENV_VAR]

  if (!servers) return

  if (typeof pi.registerMcpServer !== 'function') {
    warn('pi does not expose registerMcpServer(); native MCP needs pi >= 1.3 — MCP servers not loaded')
    return
  }

  for (const [name, config] of Object.entries(servers)) {
    try {
      pi.registerMcpServer(name, config)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      warn(`could not register MCP server "${name}": ${detail}`)
    }
  }
}
