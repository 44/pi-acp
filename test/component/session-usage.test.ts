import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc, session }
}

const assistantMessage = (usage: any) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [], usage }
})

test('PiAcpSession: resolves the turn with summed per-turn usage', async () => {
  const { proc, session } = makeSession()

  const turn = session.prompt('hello')

  proc.emit({ type: 'agent_start' })
  proc.emit(
    assistantMessage({ input: 12, output: 3, cacheRead: 4, reasoning: 1, totalTokens: 15, cost: { total: 0.02 } })
  )
  proc.emit({ type: 'turn_end' })
  // A tool-loop continuation produces a second assistant message inside the same ACP turn.
  proc.emit(assistantMessage({ input: 20, output: 5, totalTokens: 25, cost: { total: 0.03 } }))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const result = await turn
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.usage?.inputTokens, 32)
  assert.equal(result.usage?.outputTokens, 8)
  assert.equal(result.usage?.totalTokens, 40)
  assert.equal(result.usage?.cachedReadTokens, 4)
  assert.equal(result.usage?.thoughtTokens, 1)
  assert.equal((result.usage?._meta as any)?.piAcp?.cost?.amount, 0.05)
})

test('PiAcpSession: omits usage when pi reports none', async () => {
  const { proc, session } = makeSession()

  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit(assistantMessage(undefined))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const result = await turn
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.usage, undefined)
})

test('PiAcpSession: usage is per-turn, not cumulative across turns', async () => {
  const { proc, session } = makeSession()

  const first = session.prompt('one')
  proc.emit(assistantMessage({ input: 100, output: 50, totalTokens: 150 }))
  proc.emit({ type: 'agent_settled' })
  assert.equal((await first).usage?.totalTokens, 150)

  const second = session.prompt('two')
  proc.emit(assistantMessage({ input: 10, output: 5, totalTokens: 15 }))
  proc.emit({ type: 'agent_settled' })
  assert.equal((await second).usage?.totalTokens, 15)
})

test('PiAcpSession: cancelled turn keeps the usage accrued so far', async () => {
  const { proc, session } = makeSession()

  const turn = session.prompt('hello')
  proc.emit(assistantMessage({ input: 7, output: 1, totalTokens: 8 }))
  await session.cancel()
  proc.emit({ type: 'agent_settled' })

  const result = await turn
  assert.equal(result.stopReason, 'cancelled')
  assert.equal(result.usage?.totalTokens, 8)
})

test('PiAcpSession: queued turn starts with a clean usage accumulator', async () => {
  const { proc, session } = makeSession()

  const first = session.prompt('one')
  const second = session.prompt('two')

  proc.emit(assistantMessage({ input: 40, output: 2, totalTokens: 42 }))
  proc.emit({ type: 'agent_settled' })
  await first

  proc.emit(assistantMessage({ input: 3, output: 1, totalTokens: 4 }))
  proc.emit({ type: 'agent_settled' })

  assert.equal((await second).usage?.totalTokens, 4)
})

test('PiAcpAgent: forwards per-turn usage from the session', async () => {
  const { PiAcpAgent } = await import('../../src/acp/agent.js')
  const conn = new FakeAgentSideConnection()
  const usage = { totalTokens: 12, inputTokens: 10, outputTokens: 2 }

  const fakeSession = {
    sessionId: 's1',
    proc: new FakePiRpcProcess(),
    prompt: async () => ({ stopReason: 'end_turn', usage }),
    wasCancelRequested: () => false
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: () => fakeSession,
    get: () => fakeSession
  }

  const res = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } as any)
  assert.deepEqual(res, { stopReason: 'end_turn', usage })
})
