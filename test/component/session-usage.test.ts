import test from 'node:test'
import assert from 'node:assert/strict'
import type { Usage } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { total: 0.25 } }

class UsageProcess extends FakePiRpcProcess {
  size = 200000
  failStats = false
  statsCalls = 0
  override async getState() {
    return { model: { contextWindow: this.size } }
  }
  async getSessionStats() {
    this.statsCalls++
    if (this.failStats) throw new Error('stats unavailable')
    return {
      contextUsage: { tokens: 180, contextWindow: this.size },
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
