import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { bounded, createRpcChild, nextTick } from '../helpers/rpc-child.js'

for (const failure of ['exit', 'dispose', 'manager close', 'stdin close', 'child error'] as const) {
  test(`PiAcpSession: accepted and queued prompts settle after ${failure}`, async t => {
    const rpc = createRpcChild({ exitOnKill: failure === 'manager close' })
    t.after(rpc.cleanup)
    const sessions = new SessionManager()
    const session = sessions.getOrCreate('older', {
      cwd: process.cwd(),
      mcpServers: [],
      proc: rpc.proc,
      conn: asAgentConn(new FakeAgentSideConnection())
    })
    const first = session.prompt('one')
    const second = session.prompt('two')
    const third = session.prompt('three')
    await nextTick()
    assert.deepEqual(
      rpc.commands.filter(c => c.type === 'prompt').map(c => c.message),
      ['one']
    )
    if (failure === 'exit') rpc.child.emit('exit', 1, null)
    else if (failure === 'dispose') rpc.proc.dispose()
    else if (failure === 'manager close') sessions.closeAllExcept('new')
    else if (failure === 'stdin close') rpc.child.stdin.destroy()
    else rpc.child.emit('error', new Error('child failed'))

    assert.deepEqual(await bounded(Promise.all([first, second, third])), ['error', 'error', 'error'])
    assert.equal(await bounded(session.prompt('after termination')), 'error')
    assert.deepEqual(
      rpc.commands.filter(c => c.type === 'prompt').map(c => c.message),
      ['one']
    )
  })
}

test('PiAcpSession: exit before prompt acknowledgement settles the active and queued turns', async t => {
  const rpc = createRpcChild({ respond: command => command.type !== 'prompt' })
  t.after(rpc.cleanup)
  const session = new PiAcpSession({
    sessionId: 'older',
    cwd: process.cwd(),
    mcpServers: [],
    proc: rpc.proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const first = session.prompt('one')
  const second = session.prompt('two')
  rpc.child.emit('exit', 1, null)
  assert.deepEqual(await bounded(Promise.all([first, second])), ['error', 'error'])
  assert.equal(await bounded(session.prompt('later')), 'error')
})

test('PiAcpSession: acknowledged turns wait for agent_settled and then advance the queue', async t => {
  const rpc = createRpcChild()
  t.after(rpc.cleanup)
  const session = new PiAcpSession({
    sessionId: 'older',
    cwd: process.cwd(),
    mcpServers: [],
    proc: rpc.proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  let settled = false
  const first = session.prompt('one').then(reason => {
    settled = true
    return reason
  })
  const second = session.prompt('two')
  rpc.send({ type: 'agent_end' })
  await nextTick()
  assert.equal(settled, false)
  assert.equal(rpc.commands.filter(c => c.type === 'prompt').length, 1)
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(first), 'end_turn')
  assert.deepEqual(
    rpc.commands.filter(c => c.type === 'prompt').map(c => c.message),
    ['one', 'two']
  )
  await bounded(session.cancel())
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'cancelled')
})

test('PiAcpSession: late prompt rejection cannot settle a newer turn', async t => {
  const rpc = createRpcChild({ respond: command => command.type !== 'prompt' || command.message !== 'one' })
  t.after(rpc.cleanup)
  const session = new PiAcpSession({
    sessionId: 'older',
    cwd: process.cwd(),
    mcpServers: [],
    proc: rpc.proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const first = session.prompt('one')
  let secondSettled = false
  const second = session.prompt('two').then(reason => {
    secondSettled = true
    return reason
  })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(first), 'end_turn')
  const firstCommand = rpc.commands.find(c => c.type === 'prompt' && c.message === 'one')
  assert.ok(firstCommand)
  rpc.respond(firstCommand, false)
  await nextTick()
  assert.equal(secondSettled, false)
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
})
