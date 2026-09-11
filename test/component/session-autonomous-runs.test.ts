import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { bounded, createRpcChild, deferred, nextTick, outcome, type RpcCommand } from '../helpers/rpc-child.js'

const busyError = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
const idle = { isStreaming: false, isCompacting: false }
const busy = { isStreaming: true, isCompacting: false }

function setup(t: TestContext, respond?: (command: RpcCommand) => boolean) {
  const rpc = createRpcChild({ respond })
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: rpc.proc,
    conn: asAgentConn(conn),
    fileCommands: [{ name: 'hello', description: '', content: 'Expanded $1', source: '(user)' }]
  })
  t.after(() => {
    session.dispose()
    rpc.cleanup()
  })
  const prompts = () => rpc.commands.filter(command => command.type === 'prompt')
  const lastCommand = (type: string) => {
    const command = rpc.commands.filter(command => command.type === type).at(-1)
    assert.ok(command, `missing ${type} command`)
    return command
  }
  const activity = () =>
    conn.updates.filter(({ update }) => update.sessionUpdate === 'session_info_update').at(-1)?.update._meta
  return { rpc, conn, session, prompts, lastCommand, activity }
}

test('autonomous restart after a completed ACP turn holds FIFO prompts until fully settled', async t => {
  const { rpc, session, prompts, activity, conn } = setup(t)
  const initial = session.prompt('initial')
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(initial), 'end_turn')
  await nextTick()
  assert.deepEqual(activity(), { piAcp: { queueDepth: 0, running: false } })

  rpc.send({ type: 'agent_start' })
  await nextTick()
  assert.deepEqual(activity(), { piAcp: { queueDepth: 0, running: true } })
  const first = session.prompt('one')
  const second = session.prompt('two')
  rpc.send({ type: 'agent_end', willRetry: true })
  rpc.send({ type: 'auto_retry_start', attempt: 1 })
  await nextTick()
  assert.deepEqual(
    prompts().map(c => c.message),
    ['initial']
  )
  assert.deepEqual(activity(), { piAcp: { queueDepth: 2, running: true } })
  rpc.send({ type: 'agent_start' })
  rpc.send({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'background failed' }
  })
  rpc.send({ type: 'agent_end' })
  await nextTick()
  assert.equal(prompts().length, 1)
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  assert.deepEqual(
    prompts().map(c => c.message),
    ['initial', 'one']
  )
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(first), 'end_turn')
  assert.deepEqual(
    prompts().map(c => c.message),
    ['initial', 'one', 'two']
  )
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
  await nextTick()
  assert.deepEqual(activity(), { piAcp: { queueDepth: 0, running: false } })
  assert.equal(
    conn.updates.filter(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text === 'Pi resumed work after a background update.'
    ).length,
    1
  )
})

for (const phase of ['compaction_start', 'auto_compaction_start']) {
  test(`${phase} without ACP ownership blocks dispatch until compaction ends`, async t => {
    const { rpc, session, prompts } = setup(t)
    rpc.send({ type: phase })
    const turn = session.prompt('wait for compaction')
    rpc.send({ type: 'agent_settled' })
    await nextTick()
    assert.equal(prompts().length, 0)
    rpc.send({ type: phase.replace('_start', '_end') })
    await nextTick()
    assert.equal(prompts().length, 1)
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    assert.equal(await bounded(turn), 'end_turn')
  })
}

for (const oldUsageFirst of [true, false]) {
  test(`restart during usage reporting invalidates stale completion (oldUsageFirst=${oldUsageFirst})`, async t => {
    const { rpc, session, prompts } = setup(t, command => command.type !== 'get_session_stats')
    let completed = false
    const first = session.prompt('one').then(reason => {
      completed = true
      return reason
    })
    const second = session.prompt('two')
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    await nextTick()
    const oldStats = rpc.commands.find(command => command.type === 'get_session_stats')
    assert.ok(oldStats)
    rpc.send({ type: 'agent_start' })
    if (oldUsageFirst) rpc.respond(oldStats)
    await nextTick()
    assert.equal(completed, false)
    assert.equal(prompts().length, 1)
    rpc.send({ type: 'agent_settled' })
    await nextTick()
    const newStats = rpc.commands.filter(command => command.type === 'get_session_stats').at(-1)
    assert.ok(newStats && newStats !== oldStats)
    rpc.respond(newStats)
    assert.equal(await bounded(first), 'end_turn')
    assert.equal(prompts().length, 2)
    if (!oldUsageFirst) rpc.respond(oldStats)
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    await nextTick()
    const lastStats = rpc.commands.filter(command => command.type === 'get_session_stats').at(-1)
    assert.ok(lastStats && lastStats !== newStats)
    rpc.respond(lastStats)
    assert.equal(await bounded(second), 'end_turn')
  })
}

test('restart while notification delivery is blocked cannot resolve the old settlement', async t => {
  const { rpc, conn, session, prompts } = setup(t)
  const gate = deferred<void>()
  t.after(() => gate.resolve())
  let completed = false
  const first = session.prompt('one').then(reason => {
    completed = true
    return reason
  })
  const second = session.prompt('two')
  await nextTick()
  conn.sessionUpdate = async message => {
    if (message.update.sessionUpdate === 'agent_message_chunk') await gate.promise
    conn.updates.push(message)
  }
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'last output' } })
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  rpc.send({ type: 'agent_start' })
  gate.resolve()
  await nextTick()
  assert.equal(completed, false)
  assert.equal(prompts().length, 1)
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(first), 'end_turn')
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
})

for (const settlementFirst of [true, false]) {
  test(`cancel autonomous work holds new messages until abort and settlement (settlementFirst=${settlementFirst})`, async t => {
    const { rpc, session, prompts, lastCommand, activity } = setup(t, command => command.type !== 'abort')
    rpc.send({ type: 'agent_start' })
    const cancelled = session.prompt('discard')
    const abort = session.cancel()
    const next = session.prompt('after cancel')
    assert.equal(await bounded(cancelled), 'cancelled')
    await nextTick()
    assert.equal(prompts().length, 0)
    const abortCommand = lastCommand('abort')
    if (settlementFirst) rpc.send({ type: 'agent_settled' })
    else rpc.respond(abortCommand)
    await nextTick()
    assert.equal(prompts().length, 0)
    assert.deepEqual(activity(), { piAcp: { queueDepth: 1, running: true } })
    if (settlementFirst) rpc.respond(abortCommand)
    else rpc.send({ type: 'agent_settled' })
    await bounded(abort)
    await nextTick()
    assert.deepEqual(
      prompts().map(c => c.message),
      ['after cancel']
    )
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    assert.equal(await bounded(next), 'end_turn')
  })
}

test('cancel during usage reporting invalidates completion and overlapping cancels share an abort', async t => {
  const { rpc, session, lastCommand } = setup(t, command => !['abort', 'get_session_stats'].includes(command.type))
  let completed = false
  const turn = session.prompt('one').then(reason => {
    completed = true
    return reason
  })
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  const oldStats = lastCommand('get_session_stats')
  const firstCancel = session.cancel()
  const secondCancel = session.cancel()
  rpc.respond(oldStats)
  await nextTick()
  assert.equal(completed, false)
  assert.equal(rpc.commands.filter(command => command.type === 'abort').length, 1)
  rpc.respond(lastCommand('abort'))
  await bounded(Promise.all([firstCancel, secondCancel]))
  await nextTick()
  const newStats = lastCommand('get_session_stats')
  assert.notEqual(newStats, oldStats)
  rpc.respond(newStats)
  assert.equal(await bounded(turn), 'cancelled')
})

test('busy rejection after a settled event safely retries the original expanded message and images in FIFO order', async t => {
  let firstAttempt = true
  const { rpc, session, prompts } = setup(t, command => {
    if (command.type !== 'prompt' || !firstAttempt) return true
    firstAttempt = false
    return false
  })
  const images = [{ type: 'image', data: 'image-data', mimeType: 'image/png' }]
  const first = session.prompt('/hello world', images)
  const second = session.prompt('two')
  const rejected = prompts()[0]!
  rpc.send({ type: 'agent_start' })
  rpc.respond(rejected, false, { error: busyError })
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  assert.deepEqual(
    prompts().map(c => c.message),
    ['Expanded world', 'Expanded world']
  )
  assert.deepEqual(prompts()[1]?.images, images)
  assert.equal('streamingBehavior' in prompts()[1]!, false)
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(first), 'end_turn')
  assert.deepEqual(
    prompts().map(c => c.message),
    ['Expanded world', 'Expanded world', 'two']
  )
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
})

for (const state of [busy, { isStreaming: false, isCompacting: true }]) {
  test(`busy rejection waits on reconciled state ${JSON.stringify(state)}`, async t => {
    const { rpc, session, prompts, lastCommand } = setup(t, command => !['prompt', 'get_state'].includes(command.type))
    const turn = session.prompt('one')
    rpc.respond(prompts()[0]!, false, {
      error: state.isStreaming
        ? busyError
        : 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
    })
    await nextTick()
    rpc.respond(lastCommand('get_state'), true, { data: state })
    await nextTick()
    assert.equal(prompts().length, 1)
    rpc.send({ type: state.isStreaming ? 'agent_end' : 'agent_settled' })
    await nextTick()
    assert.equal(prompts().length, 1)
    rpc.send({ type: state.isStreaming ? 'agent_settled' : 'compaction_end' })
    await nextTick()
    assert.equal(prompts().length, 2)
    rpc.respond(prompts()[1]!)
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    assert.equal(await bounded(turn), 'end_turn')
  })
}

for (const newerEvent of ['agent_start', 'agent_settled']) {
  test(`state reconciliation cannot overwrite a newer ${newerEvent}`, async t => {
    const { rpc, session, prompts, lastCommand } = setup(t, command => !['prompt', 'get_state'].includes(command.type))
    const turn = session.prompt('one')
    rpc.respond(prompts()[0]!, false, { error: busyError })
    await nextTick()
    const snapshot = newerEvent === 'agent_start' ? idle : busy
    rpc.respond(lastCommand('get_state'), true, { data: snapshot })
    rpc.send({ type: newerEvent })
    await nextTick()
    if (newerEvent === 'agent_start') {
      assert.equal(prompts().length, 1)
      rpc.send({ type: 'agent_settled' })
      await nextTick()
    }
    assert.equal(prompts().length, 2)
    rpc.respond(prompts()[1]!)
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    assert.equal(await bounded(turn), 'end_turn')
  })
}

for (const event of ['compaction_start', 'compaction_end']) {
  for (const agentBusy of [true, false]) {
    test(`reconciliation merges ${event} with independent streaming=${agentBusy}`, async t => {
      const { rpc, session, prompts, lastCommand } = setup(
        t,
        command => !['prompt', 'get_state'].includes(command.type)
      )
      const turn = session.prompt('one')
      rpc.respond(prompts()[0]!, false, {
        error: 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
      })
      await nextTick()
      rpc.respond(lastCommand('get_state'), true, {
        data: { isStreaming: agentBusy, isCompacting: event === 'compaction_end' }
      })
      rpc.send({ type: event })
      await nextTick()
      if (event === 'compaction_start') {
        assert.equal(prompts().length, 1)
        rpc.send({ type: 'compaction_end' })
        await nextTick()
      }
      if (agentBusy) {
        assert.equal(prompts().length, 1)
        rpc.send({ type: 'agent_settled' })
        await nextTick()
      }
      assert.equal(prompts().length, 2)
      rpc.respond(prompts()[1]!)
      rpc.send({ type: 'agent_start' })
      rpc.send({ type: 'agent_settled' })
      assert.equal(await bounded(turn), 'end_turn')
    })
  }
}

test('an obsolete usage response cannot overwrite usage from a newer settlement', async t => {
  const { rpc, conn, session, lastCommand } = setup(t, command => command.type !== 'get_session_stats')
  const turn = session.prompt('one')
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  const oldStats = lastCommand('get_session_stats')
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  rpc.respond(lastCommand('get_session_stats'), true, {
    data: { contextUsage: { tokens: 200, contextWindow: 1000 } }
  })
  assert.equal(await bounded(turn), 'end_turn')
  rpc.respond(oldStats, true, { data: { contextUsage: { tokens: 100, contextWindow: 1000 } } })
  await nextTick()
  assert.deepEqual(
    conn.updates.flatMap(({ update }) => (update.sessionUpdate === 'usage_update' ? [update.used] : [])),
    [200]
  )
})

test('busy rejection arriving after cancellation never resurrects the cancelled prompt', async t => {
  const { rpc, session, prompts } = setup(t, command => command.type !== 'prompt')
  const turn = session.prompt('discard')
  const abort = session.cancel()
  rpc.respond(prompts()[0]!, false, { error: busyError })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(turn), 'cancelled')
  await bounded(abort)
  await nextTick()
  assert.equal(prompts().length, 1)
  const next = session.prompt('new')
  rpc.respond(prompts()[1]!)
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(next), 'end_turn')
})

test('terminal failure during busy reconciliation rejects queued requests and ignores a late snapshot', async t => {
  const { rpc, session, prompts, lastCommand, activity } = setup(
    t,
    command => !['prompt', 'get_state'].includes(command.type)
  )
  const first = outcome(session.prompt('one'))
  const second = outcome(session.prompt('two'))
  rpc.respond(prompts()[0]!, false, { error: busyError })
  await nextTick()
  const snapshot = lastCommand('get_state')
  rpc.child.emit('exit', 1, null)
  assert.deepEqual(await bounded(Promise.all([first, second])), ['error', 'error'])
  rpc.respond(snapshot, true, { data: idle })
  await nextTick()
  assert.equal(prompts().length, 1)
  assert.deepEqual(activity(), { piAcp: { queueDepth: 0, running: false } })
})

for (const response of [{ data: {} }, { error: 'state unavailable' }]) {
  test(`failed or invalid state reconciliation never guesses idle: ${JSON.stringify(response)}`, async t => {
    const { rpc, session, prompts, lastCommand } = setup(t, command => !['prompt', 'get_state'].includes(command.type))
    const first = outcome(session.prompt('one'))
    const second = outcome(session.prompt('two'))
    rpc.respond(prompts()[0]!, false, { error: busyError })
    await nextTick()
    rpc.respond(lastCommand('get_state'), !('error' in response), response)
    assert.deepEqual(await bounded(Promise.all([first, second])), ['error', 'error'])
    assert.equal(prompts().length, 1)
  })
}

test('ordinary prompt errors are not retried and do not declare autonomous work idle', async t => {
  const { rpc, session, prompts, activity } = setup(t, command => command.type !== 'prompt')
  const first = outcome(session.prompt('one'))
  rpc.send({ type: 'agent_start' })
  rpc.respond(prompts()[0]!, false, { error: 'provider is busy' })
  assert.equal(await bounded(first), 'error')
  const next = session.prompt('two')
  await nextTick()
  assert.equal(prompts().length, 1)
  assert.deepEqual(activity(), { piAcp: { queueDepth: 1, running: true } })
  assert.equal(
    rpc.commands.some(command => command.type === 'get_state'),
    false
  )
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  rpc.respond(prompts()[1]!)
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(next), 'end_turn')
})

for (const abortAcknowledged of [true, false]) {
  test(`cancel reaches a prompt accepted after abort was sent (abortAcknowledged=${abortAcknowledged})`, async t => {
    const { rpc, session, prompts, lastCommand } = setup(t, command => !['prompt', 'abort'].includes(command.type))
    const first = session.prompt('cancel me')
    const cancel = session.cancel()
    const second = session.prompt('keep me')
    await nextTick()
    const originalAbort = lastCommand('abort')
    if (abortAcknowledged) {
      rpc.respond(originalAbort)
      await bounded(cancel)
    }
    rpc.respond(prompts()[0]!)
    rpc.send({ type: 'agent_start' })
    await nextTick()
    if (!abortAcknowledged) {
      rpc.respond(originalAbort)
      await bounded(cancel)
      await nextTick()
    }
    const repeatedAbort = lastCommand('abort')
    assert.notEqual(repeatedAbort, originalAbort)
    assert.equal(prompts().length, 1)
    rpc.send({ type: 'agent_settled' })
    rpc.respond(repeatedAbort)
    assert.equal(await bounded(first), 'cancelled')
    assert.deepEqual(
      prompts().map(command => command.message),
      ['cancel me', 'keep me']
    )
    rpc.respond(prompts()[1]!)
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_settled' })
    assert.equal(await bounded(second), 'end_turn')
  })
}

test('accepted response arriving after settlement is required before completing a normal prompt', async t => {
  const { rpc, session, prompts } = setup(t, command => command.type !== 'prompt')
  let completed = false
  const first = session.prompt('one').then(reason => {
    completed = true
    return reason
  })
  const second = session.prompt('two')
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  await nextTick()
  assert.equal(completed, false)
  assert.equal(prompts().length, 1)
  rpc.respond(prompts()[0]!)
  assert.equal(await bounded(first), 'end_turn')
  rpc.respond(prompts()[1]!)
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
})
