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

for (const phase of ['accepted', 'awaiting acknowledgement', 'settling'] as const) {
  test(`PiAcpSession: failure while ${phase} drains terminal cards before settling prompts`, async t => {
    const rpc = createRpcChild({
      respond: command => phase !== 'awaiting acknowledgement' || command.type !== 'prompt'
    })
    t.after(rpc.cleanup)
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    t.after(() => release())
    let terminalStarted!: () => void
    const terminalDelivery = new Promise<void>(resolve => {
      terminalStarted = resolve
    })
    const conn = new FakeAgentSideConnection()
    conn.sessionUpdate = async msg => {
      if (msg.update.sessionUpdate === 'tool_call_update' && msg.update.status === 'failed') {
        terminalStarted()
        await blocked
      }
      conn.updates.push(msg)
    }
    const session = new PiAcpSession({
      sessionId: 'older',
      cwd: process.cwd(),
      mcpServers: [],
      proc: rpc.proc,
      conn: asAgentConn(conn)
    })
    const settled: string[] = []
    const first = session.prompt('one').then(reason => {
      settled.push(reason)
      return reason
    })
    const second = session.prompt('two').then(reason => {
      settled.push(reason)
      return reason
    })
    rpc.send({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'pi-acp:subagent',
      statusText: JSON.stringify({
        version: 1,
        agentId: 'worker',
        runId: 'active',
        title: 'Review',
        status: 'in_progress',
        text: 'working'
      })
    })
    await bounded(nextTick())
    assert.ok(
      conn.updates.some(
        ({ update }) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'pi-subagent-active'
      )
    )
    if (phase === 'settling') rpc.send({ type: 'agent_settled' })
    rpc.child.emit('exit', 1, null)
    session.dispose()
    await bounded(terminalDelivery)
    await bounded(nextTick())
    assert.deepEqual(settled, [])
    assert.equal(
      conn.updates.some(({ update }) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed'),
      false
    )
    release()
    assert.deepEqual(await bounded(Promise.all([first, second])), ['error', 'error'])
    await bounded(nextTick())
    const terminal = conn.updates.filter(
      ({ update }) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed'
    )
    assert.equal(terminal.length, 1)
    assert.deepEqual(conn.updates.at(-1)?.update, {
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: 0, running: false } }
    })
    assert.equal(rpc.commands.filter(command => command.type === 'prompt').length, 1)
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
