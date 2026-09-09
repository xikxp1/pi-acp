import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, PiTurnError } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { bounded, nextTick } from '../helpers/rpc-child.js'

function setup() {
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

function finishRun(proc: FakePiRpcProcess, message: Record<string, unknown>) {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_end', message: { role: 'assistant', content: [], ...message } })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'agent_settled' })
}

test('PiAcpSession: assistant stopReason "length" maps to max_tokens', async () => {
  const { proc, session } = setup()
  const p = session.prompt('hello')
  finishRun(proc, { stopReason: 'length' })
  assert.equal(await bounded(p), 'max_tokens')
})

test('PiAcpSession: assistant stopReason "error" rejects with PiTurnError carrying errorMessage', async () => {
  const { proc, session } = setup()
  const p = session.prompt('hello')
  finishRun(proc, { stopReason: 'error', errorMessage: '529 overloaded_error: Overloaded' })
  await assert.rejects(bounded(p), (err: unknown) => {
    assert.ok(err instanceof PiTurnError)
    assert.equal(err.message, '529 overloaded_error: Overloaded')
    return true
  })
})

test('PiAcpSession: assistant stopReason "aborted" maps to cancelled', async () => {
  const { proc, session } = setup()
  const p = session.prompt('hello')
  finishRun(proc, { stopReason: 'aborted', errorMessage: 'aborted' })
  assert.equal(await bounded(p), 'cancelled')
})

test('PiAcpSession: exhausted auto-retry rejects with finalError', async () => {
  const { proc, session } = setup()
  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'x' }
  })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 0 })
  proc.emit({ type: 'agent_end', willRetry: true })
  proc.emit({ type: 'auto_retry_end', success: false, attempt: 1, finalError: '529 overloaded_error: Overloaded' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'agent_settled' })
  await assert.rejects(bounded(p), (err: unknown) => err instanceof PiTurnError && /Overloaded/.test(err.message))
})

test('PiAcpSession: successful retry after an error message resolves end_turn', async () => {
  const { proc, session } = setup()
  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'x' }
  })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0 })
  proc.emit({ type: 'agent_end', willRetry: true })
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 1 })
  finishRun(proc, { stopReason: 'stop' })
  assert.equal(await bounded(p), 'end_turn')
})

test('PiAcpSession: cancel takes precedence over an error outcome', async () => {
  const { proc, session } = setup()
  const p = session.prompt('hello')
  await session.cancel()
  finishRun(proc, { stopReason: 'error', errorMessage: 'aborted by user' })
  assert.equal(await bounded(p), 'cancelled')
})

test('PiAcpSession: error outcome does not leak into the next turn', async () => {
  const { proc, session } = setup()
  const first = session.prompt('one')
  finishRun(proc, { stopReason: 'error', errorMessage: 'boom' })
  await assert.rejects(bounded(first), PiTurnError)
  await nextTick()

  const second = session.prompt('two')
  finishRun(proc, { stopReason: 'stop' })
  assert.equal(await bounded(second), 'end_turn')
})
