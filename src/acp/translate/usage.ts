import type { Cost, Usage, UsageUpdate } from '@agentclientprotocol/sdk'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function cost(value: unknown): { cost?: Cost } {
  return tokens(value) ? { cost: { amount: value, currency: 'USD' } } : {}
}

export function contextWindowFromState(state: unknown): number | undefined {
  const size = record(record(state)?.model)?.contextWindow
  return tokens(size) && size > 0 ? size : undefined
}

export function streamedUsageUpdate(event: unknown, size: number | undefined): UsageUpdate | undefined {
  if (!size || !tokens(size)) return undefined
  const ev = record(event)
  const message = record(ev?.message)
  const usage = record(
    ev?.type === 'message_end' ? (message?.role === 'assistant' ? message.usage : undefined) : ev?.usage
  )
  if (!usage) return undefined
  const { input, output, cacheRead, cacheWrite, totalTokens } = usage
  if (!tokens(input) || !tokens(output) || !tokens(cacheRead) || !tokens(cacheWrite)) return undefined
  const sum = input + output + cacheRead + cacheWrite
  const used = totalTokens === sum ? totalTokens : sum
  return { used, size }
}

export function sessionStatsUsageUpdate(stats: unknown): UsageUpdate | undefined {
  const data = record(stats)
  const context = record(data?.contextUsage)
  if (!tokens(context?.tokens) || !tokens(context?.contextWindow) || context.contextWindow === 0) return undefined
  return { used: context.tokens, size: context.contextWindow, ...cost(data?.cost) }
}

export function sessionStatsUsage(stats: unknown): Usage | undefined {
  const counts = record(record(stats)?.tokens)
  if (!counts) return undefined
  const { total, input, output, cacheRead, cacheWrite } = counts
  if (!tokens(total) || !tokens(input) || !tokens(output)) return undefined
  return {
    totalTokens: total,
    inputTokens: input,
    outputTokens: output,
    ...(tokens(cacheRead) ? { cachedReadTokens: cacheRead } : {}),
    ...(tokens(cacheWrite) ? { cachedWriteTokens: cacheWrite } : {})
  }
}
