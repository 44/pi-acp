import type { Usage } from '@agentclientprotocol/sdk'

/**
 * Per-turn token/cost accumulator.
 *
 * ACP's `PromptResponse.usage` is scoped to a single prompt turn, while pi reports usage
 * per assistant message. One ACP turn can contain several assistant messages (tool loops,
 * retries, follow-up continuations), so the deltas are summed here.
 */
export type TurnUsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  totalTokens: number
  costUsd: number
  messages: number
}

export function newTurnUsage(): TurnUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costUsd: 0, messages: 0 }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function addPiMessageUsage(totals: TurnUsageTotals, usage: any): boolean {
  if (!usage || typeof usage !== 'object') return false

  const totalTokens = num(usage.totalTokens)
  const input = num(usage.input)
  const output = num(usage.output)

  // Providers that report nothing (or a stop with no tokens) must not create a message entry.
  if (!totalTokens && !input && !output) return false

  totals.input += input
  totals.output += output
  totals.cacheRead += num(usage.cacheRead)
  totals.cacheWrite += num(usage.cacheWrite)
  // pi includes reasoning inside `output`; keep it as a subset, never add it to the total.
  totals.reasoning += num(usage.reasoning)
  totals.totalTokens += totalTokens
  totals.costUsd += num(usage.cost?.total)
  totals.messages += 1
  return true
}

/** Accumulate usage from a pi `message_end` / assistant message payload. */
export function addPiMessageEnd(totals: TurnUsageTotals, message: unknown): boolean {
  const m = message as { role?: unknown; usage?: unknown } | null
  if (m?.role !== 'assistant') return false
  return addPiMessageUsage(totals, m.usage)
}

/**
 * Convert to ACP `Usage`. Returns `undefined` when the turn reported nothing, so callers can
 * omit the optional field instead of sending zeros.
 */
export function toAcpUsage(totals: TurnUsageTotals): Usage | undefined {
  if (totals.messages === 0) return undefined

  const usage: Usage = {
    totalTokens: totals.totalTokens,
    inputTokens: totals.input,
    outputTokens: totals.output
  }

  if (totals.reasoning > 0) usage.thoughtTokens = totals.reasoning
  if (totals.cacheRead > 0) usage.cachedReadTokens = totals.cacheRead
  if (totals.cacheWrite > 0) usage.cachedWriteTokens = totals.cacheWrite
  // ACP's `Usage` has no cost field (only the cumulative `usage_update` does), so expose the
  // turn's cost as adapter metadata instead of dropping it.
  if (totals.costUsd > 0) {
    usage._meta = { piAcp: { cost: { amount: totals.costUsd, currency: 'USD' } } }
  }

  return usage
}
