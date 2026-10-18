import { test } from 'node:test'
import assert from 'node:assert/strict'
import mcpBridge from '../../src/pi-extension-mcp.js'

type Call = { name: string; config: unknown }

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64')
}

/** Run the bridge with `payload` in the env and a stubbed stderr; returns what it did. */
function run(payload: string | undefined, registerMcpServer?: (name: string, config: unknown) => void) {
  const prevPayload = process.env.PI_ACP_MCP_CONFIG
  if (payload === undefined) delete process.env.PI_ACP_MCP_CONFIG
  else process.env.PI_ACP_MCP_CONFIG = payload

  const calls: Call[] = []
  const api = {
    ...(registerMcpServer ? { registerMcpServer } : {}),
    ...(registerMcpServer
      ? {}
      : {
          registerMcpServer: (name: string, config: unknown) => {
            calls.push({ name, config })
          }
        })
  }
  const prevWrite = process.stderr.write.bind(process.stderr)
  let stderr = ''
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    mcpBridge(api as any)
    return { calls, stderr, envAfter: process.env.PI_ACP_MCP_CONFIG }
  } finally {
    process.stderr.write = prevWrite
    if (prevPayload === undefined) delete process.env.PI_ACP_MCP_CONFIG
    else process.env.PI_ACP_MCP_CONFIG = prevPayload
  }
}

test('mcp bridge: registers every server from PI_ACP_MCP_CONFIG with pi.registerMcpServer', () => {
  const { calls, stderr, envAfter } = run(
    encode({
      mcpServers: {
        chrome: { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] },
        remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }
      }
    })
  )
  assert.equal(stderr, '')
  assert.deepEqual(calls, [
    { name: 'chrome', config: { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] } },
    { name: 'remote', config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } }
  ])
  // The payload is dropped from the environment so spawned MCP servers cannot inherit secrets.
  assert.equal(envAfter, undefined)
})

test('mcp bridge: inert without the env var (normal pi session)', () => {
  assert.deepEqual(run(undefined), { calls: [], stderr: '', envAfter: undefined })
})

test('mcp bridge: ignores a garbage payload instead of failing the session', () => {
  assert.deepEqual(run('not-base64-json'), { calls: [], stderr: '', envAfter: undefined })
})

test('mcp bridge: reports a pi without registerMcpServer() on stderr (never stdout: RPC channel)', () => {
  const prevPayload = process.env.PI_ACP_MCP_CONFIG
  process.env.PI_ACP_MCP_CONFIG = encode({ mcpServers: { a: { command: 'x' } } })
  const prevWrite = process.stderr.write.bind(process.stderr)
  let stderr = ''
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    mcpBridge({} as any)
    assert.match(stderr, /registerMcpServer/)
  } finally {
    process.stderr.write = prevWrite
    if (prevPayload === undefined) delete process.env.PI_ACP_MCP_CONFIG
    else process.env.PI_ACP_MCP_CONFIG = prevPayload
  }
})

test('mcp bridge: one bad server does not stop the others', () => {
  const registered: string[] = []
  const { stderr } = run(encode({ mcpServers: { good: { command: 'x' }, bad: { command: 'y' } } }), name => {
    if (name === 'bad') throw new Error('invalid config')
    registered.push(name)
  })
  assert.deepEqual(registered, ['good'])
  assert.match(stderr, /bad/)
})
