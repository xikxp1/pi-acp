import test from 'node:test'
import assert from 'node:assert/strict'
import type { Usage } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { total: 0.25 } }

class UsageProcess extends FakePiRpcProcess {
  size = 200000
  contextTokens: number | null = 180
  failStats = false
  statsCalls = 0
  override async getState() {
    return { model: { contextWindow: this.size } }
  }
  async getSessionStats() {
    this.statsCalls++
    if (this.failStats) throw new Error('stats unavailable')
    return {
      contextUsage: { tokens: this.contextTokens, contextWindow: this.size },
      cost: 0.5,
      tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 100, total: 1600 }
    }
  }
}

function setup() {
  const proc = new UsageProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 'usage',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { proc, conn, session }
}

test('streams changed usage at most once per second and flushes final stats before resolving', async t => {
  const { proc, conn, session } = setup()
  await session.refreshContextWindow()
  let now = 0
  t.mock.method(performance, 'now', () => now)
  let finalUsage: Usage | undefined
  const prompt = session.prompt('hello', [], value => {
    finalUsage = value
  })
  proc.emit({ type: 'message_update', usage })
  now = 500
  proc.emit({ type: 'message_update', usage: { ...usage, output: 30, totalTokens: 170 } })
  now = 1000
  proc.emit({ type: 'message_update', usage })
  proc.emit({ type: 'message_end', message: { role: 'assistant', usage: { ...usage, output: 30, totalTokens: 170 } } })
  proc.emit({ type: 'agent_settled' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  const updates = conn.updates.map(entry => entry.update).filter(update => update.sessionUpdate === 'usage_update')
  assert.deepEqual(
    updates.map(update => update.used),
    [160, 170, 180]
  )
  assert.ok(updates.slice(0, -1).every(update => !Object.hasOwn(update, 'cost')))
  assert.equal(proc.statsCalls, 1)
  assert.equal(finalUsage?.totalTokens, 1600)
  assert.deepEqual(updates.at(-1)?.cost, { amount: 0.5, currency: 'USD' })
})

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
const contextValues = (conn: FakeAgentSideConnection) =>
  conn.updates.flatMap(({ update }) => (update.sessionUpdate === 'usage_update' ? [update.used] : []))

test('zero placeholders between prompts and model responses retain context without consuming the throttle', async t => {
  const { proc, conn, session } = setup()
  t.after(() => session.dispose())
  await session.refreshContextWindow()
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const first = session.prompt('first')
  proc.emit({ type: 'message_update', usage })
  proc.emit({ type: 'agent_settled' })
  await first
  assert.deepEqual(contextValues(conn), [160, 180])

  const second = session.prompt('second')
  proc.emit({ type: 'message_update', usage: emptyUsage })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(contextValues(conn), [160, 180])
  now = 1
  proc.emit({ type: 'message_update', usage: { ...usage, input: 110, totalTokens: 170 } })
  now = 1100
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', usage: emptyUsage } })
  proc.emit({ type: 'message_update', usage: emptyUsage })
  now = 1101
  proc.emit({ type: 'message_update', usage: { ...usage, input: 120, totalTokens: 180 } })
  proc.emit({ type: 'agent_settled' })
  await second
  assert.deepEqual(contextValues(conn), [160, 180, 170, 180, 180])
})

test('all-zero provider usage waits for final authoritative context instead of displaying zero', async t => {
  const { proc, conn, session } = setup()
  t.after(() => session.dispose())
  await session.refreshContextWindow()
  const prompt = session.prompt('hello')
  proc.emit({ type: 'message_update', usage: emptyUsage })
  proc.emit({ type: 'message_end', message: { role: 'assistant', usage: emptyUsage } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(contextValues(conn), [])
  proc.emit({ type: 'agent_settled' })
  await prompt
  assert.deepEqual(contextValues(conn), [180])
})

test('real context decreases after compaction are not clamped to the previous reading', async t => {
  const { proc, conn, session } = setup()
  t.after(() => session.dispose())
  await session.refreshContextWindow()
  proc.contextTokens = null
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const prompt = session.prompt('hello')
  proc.emit({ type: 'message_update', usage })
  proc.emit({ type: 'compaction_start' })
  proc.emit({ type: 'compaction_end' })
  now = 1100
  proc.emit({ type: 'message_update', usage: emptyUsage })
  proc.emit({ type: 'message_update', usage: { ...emptyUsage, input: 40, output: 10, totalTokens: 50 } })
  proc.emit({ type: 'agent_settled' })
  await prompt
  assert.deepEqual(contextValues(conn), [160, 50])
})

test('authoritative final zero context still reaches the client', async t => {
  const { proc, conn, session } = setup()
  t.after(() => session.dispose())
  await session.refreshContextWindow()
  proc.contextTokens = 0
  const prompt = session.prompt('hello')
  proc.emit({ type: 'message_update', usage })
  proc.emit({ type: 'agent_settled' })
  await prompt
  assert.deepEqual(contextValues(conn), [160, 0])
})

test('unknown context suppresses streaming and stats failure does not fail a turn', async () => {
  const { proc, conn, session } = setup()
  proc.failStats = true
  const prompt = session.prompt('hello')
  proc.emit({ type: 'message_update', usage })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.equal(
    conn.updates.some(entry => entry.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('model refresh replaces cached context window', async () => {
  const { proc, conn, session } = setup()
  await session.refreshContextWindow()
  proc.size = 400000
  await session.refreshContextWindow()
  const prompt = session.prompt('hello')
  proc.emit({ type: 'message_update', usage })
  proc.emit({ type: 'agent_settled' })
  await prompt
  const updates = conn.updates.map(entry => entry.update).filter(update => update.sessionUpdate === 'usage_update')
  assert.deepEqual(
    updates.map(update => update.size),
    [400000, 400000]
  )
})
