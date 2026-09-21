import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: setSessionMode rejects an unknown session without emitting updates', async t => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  t.after(() => agent.dispose())

  await assert.rejects(() => agent.setSessionMode({ sessionId: 'nope', modeId: 'medium' }), /invalid params/i)
  assert.deepEqual(conn.updates, [])
})
