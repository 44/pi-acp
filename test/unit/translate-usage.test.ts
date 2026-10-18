import test from 'node:test'
import assert from 'node:assert/strict'
import { addPiMessageEnd, newTurnUsage, toAcpUsage } from '../../src/acp/translate/usage.js'

const assistant = (usage: any) => ({ role: 'assistant', content: [], usage })

test('toAcpUsage: returns undefined when the turn reported nothing', () => {
  assert.equal(toAcpUsage(newTurnUsage()), undefined)
})

test('toAcpUsage: maps a single assistant message', () => {
  const totals = newTurnUsage()
  assert.equal(
    addPiMessageEnd(
      totals,
      assistant({
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 10,
        reasoning: 5,
        totalTokens: 180,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 }
      })
    ),
    true
  )

  assert.deepEqual(toAcpUsage(totals), {
    totalTokens: 180,
    inputTokens: 100,
    outputTokens: 20,
    thoughtTokens: 5,
    cachedReadTokens: 50,
    cachedWriteTokens: 10,
    _meta: { piAcp: { cost: { amount: 0.0033, currency: 'USD' } } }
  })
})

test('toAcpUsage: sums every assistant message of one turn (tool loop)', () => {
  const totals = newTurnUsage()
  addPiMessageEnd(totals, assistant({ input: 10, output: 2, totalTokens: 12, cost: { total: 0.1 } }))
  addPiMessageEnd(totals, assistant({ input: 30, output: 4, totalTokens: 34, cost: { total: 0.2 } }))

  const usage = toAcpUsage(totals)
  assert.equal(usage?.totalTokens, 46)
  assert.equal(usage?.inputTokens, 40)
  assert.equal(usage?.outputTokens, 6)
  assert.deepEqual(usage?._meta, { piAcp: { cost: { amount: 0.30000000000000004, currency: 'USD' } } })
  // pi's `reasoning` is a subset of `output`; thoughtTokens must never inflate the totals.
  assert.equal(usage?.thoughtTokens, undefined)
})

test('addPiMessageEnd: ignores user/tool messages and empty usage', () => {
  const totals = newTurnUsage()
  assert.equal(addPiMessageEnd(totals, { role: 'user', usage: { input: 5, output: 5, totalTokens: 10 } }), false)
  assert.equal(addPiMessageEnd(totals, assistant(undefined)), false)
  assert.equal(addPiMessageEnd(totals, assistant({ input: 0, output: 0, totalTokens: 0 })), false)
  assert.equal(addPiMessageEnd(totals, null), false)
  assert.equal(toAcpUsage(totals), undefined)
})

test('addPiMessageEnd: tolerates malformed numbers', () => {
  const totals = newTurnUsage()
  addPiMessageEnd(totals, assistant({ input: 'nope', output: 3, totalTokens: 3, cacheRead: null }))

  const usage = toAcpUsage(totals)
  assert.equal(usage?.inputTokens, 0)
  assert.equal(usage?.outputTokens, 3)
  assert.equal(usage?.cachedReadTokens, undefined)
})
