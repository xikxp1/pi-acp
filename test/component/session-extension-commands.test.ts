import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, PiTurnError } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { bounded, deferred, nextTick } from '../helpers/rpc-child.js'

function setup() {
  const proc = new FakePiRpcProcess()
  const response = deferred<void>()
  proc.prompt = async (message, attachments = []) => {
    proc.prompts.push({ message, attachments })
    await response.promise
  }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: [{ name: 'hello', description: '', content: 'Expanded $1', source: '(user)' }]
  })
  session.setExtensionCommands([{ name: 'hello', source: 'extension' }])
  return { proc, session, response }
}

test('extension command overrides template and completes without an agent run', async () => {
  const { proc, session, response } = setup()
  const turn = session.prompt('/hello world')
  assert.equal(proc.prompts[0]?.message, '/hello world')
  response.resolve()
  assert.equal(await bounded(turn), 'end_turn')
})

for (const responseFirst of [true, false]) {
  test(`extension waits for response and settlement (responseFirst=${responseFirst})`, async () => {
    const { proc, session, response } = setup()
    let completed = false
    const turn = session.prompt('/hello').then(reason => {
      completed = true
      return reason
    })
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_end' })
    if (responseFirst) response.resolve()
    else proc.emit({ type: 'agent_settled' })
    await nextTick()
    assert.equal(completed, false)
    if (responseFirst) proc.emit({ type: 'agent_settled' })
    else response.resolve()
    assert.equal(await bounded(turn), 'end_turn')
  })
}

test('extension response error after settlement rejects the turn', async () => {
  const { proc, session, response } = setup()
  const turn = session.prompt('/hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  const rejected = assert.rejects(bounded(turn), PiTurnError)
  response.reject(new Error('handler failed'))
  await rejected
})

test('extension cancellation without an agent run completes as cancelled', async () => {
  const { session, response } = setup()
  const turn = session.prompt('/hello')
  await session.cancel()
  response.resolve()
  assert.equal(await bounded(turn), 'cancelled')
})

test('refreshed extension names restore template expansion and exact matching', async () => {
  const { proc, session, response } = setup()
  session.setExtensionCommands([{ name: 'hello-other', source: 'extension' }])
  const turn = session.prompt('/hello world')
  assert.equal(proc.prompts[0]?.message, 'Expanded world')
  response.resolve()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await bounded(turn), 'end_turn')
})
