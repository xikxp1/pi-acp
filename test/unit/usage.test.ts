import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWindowFromState,
  streamedUsageUpdate,
  sessionStatsUsage,
  sessionStatsUsageUpdate
} from '../../src/acp/translate/usage.js'

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { total: 0.25 } }
const stats = {
  tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 100, total: 1600 },
  cost: 0.5,
  contextUsage: { tokens: 160, contextWindow: 200000, percent: 0.08 }
}

test('maps latest streamed snapshot without accumulating snapshots or reporting per-message cost', () => {
  const expected = { used: 160, size: 200000 }
  assert.deepEqual(streamedUsageUpdate({ type: 'message_update', usage }, 200000), expected)
  assert.deepEqual(
    streamedUsageUpdate({ type: 'message_end', message: { role: 'assistant', usage } }, 200000),
    expected
  )
  assert.deepEqual(streamedUsageUpdate({ usage: { ...usage, totalTokens: 999 } }, 200000), expected)
  assert.equal(streamedUsageUpdate({ usage }, undefined), undefined)
  assert.equal(streamedUsageUpdate({ type: 'message_end', message: { role: 'toolResult', usage } }, 200000), undefined)
})

test('maps final current context independently from cumulative session tokens', () => {
  assert.deepEqual(sessionStatsUsageUpdate(stats), { used: 160, size: 200000, cost: { amount: 0.5, currency: 'USD' } })
  assert.deepEqual(sessionStatsUsageUpdate({ ...stats, cost: 0 }), {
    used: 160,
    size: 200000,
    cost: { amount: 0, currency: 'USD' }
  })
  assert.deepEqual(sessionStatsUsageUpdate({ contextUsage: stats.contextUsage }), { used: 160, size: 200000 })
})

test('skips unavailable context and post-compaction null tokens', () => {
  for (const contextUsage of [undefined, null, { tokens: null, contextWindow: 200000, percent: null }]) {
    assert.equal(sessionStatsUsageUpdate({ ...stats, contextUsage }), undefined)
    assert.ok(sessionStatsUsage({ ...stats, contextUsage }))
  }
  assert.equal(sessionStatsUsageUpdate(null), undefined)
})

test('maps PromptResponse Usage from session totals', () => {
  assert.deepEqual(sessionStatsUsage(stats), {
    totalTokens: 1600,
    inputTokens: 1000,
    outputTokens: 200,
    cachedReadTokens: 300,
    cachedWriteTokens: 100
  })
  assert.equal(sessionStatsUsage({}), undefined)
  assert.equal(sessionStatsUsage(null), undefined)
})

test('reads a valid model context window and rejects unavailable values', () => {
  assert.equal(contextWindowFromState({ model: { contextWindow: 200000 } }), 200000)
  for (const state of [null, {}, { model: null }, { model: { contextWindow: 0 } }])
    assert.equal(contextWindowFromState(state), undefined)
})
