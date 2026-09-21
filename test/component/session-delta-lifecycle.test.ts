import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { createRpcChild, deferred, nextTick, outcome, type RpcCommand } from '../helpers/rpc-child.js'

// Keep test deadlines real while the session's batching timers are frozen.
const deadline = setTimeout
const clearDeadline = clearTimeout

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = deadline(() => reject(new Error('operation did not settle within 1000ms')), 1000)
      })
    ])
  } finally {
    clearDeadline(timer)
  }
}

function setup(t: TestContext, respond?: (command: RpcCommand) => boolean) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const timers = t.mock.method(globalThis, 'setTimeout')
  const clears = t.mock.method(globalThis, 'clearTimeout')
  const rpc = createRpcChild({ respond })
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 'delta-lifecycle',
    cwd: process.cwd(),
    mcpServers: [],
    proc: rpc.proc,
    conn: asAgentConn(conn)
  })
  t.after(() => {
    session.dispose()
    rpc.cleanup()
  })
  const delta = (text: string, kind: 'text_delta' | 'thinking_delta' = 'text_delta') =>
    rpc.send({ type: 'message_update', assistantMessageEvent: { type: kind, delta: text } })
  const chunks = () =>
    conn.updates.flatMap(({ update }) =>
      (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') &&
      update.content.type === 'text'
        ? [{ kind: update.sessionUpdate, text: update.content.text }]
        : []
    )
  const texts = () => chunks().map(chunk => chunk.text)
  const prompts = () => rpc.commands.filter(command => command.type === 'prompt')
  const assertBatchTimersCleared = () => {
    const batches = timers.mock.calls.filter(call => {
      const delay = call.arguments[1]
      return typeof delay === 'number' && delay >= 100 && delay <= 250
    })
    assert.ok(batches.length > 0, 'expected a batching timer to have been scheduled')
    for (const batch of batches) {
      assert.ok(
        clears.mock.calls.some(call => call.arguments[0] === batch.result),
        'batching timer must be explicitly cleared at the lifecycle boundary'
      )
    }
  }
  return { rpc, conn, session, delta, chunks, texts, prompts, assertBatchTimersCleared }
}

function blockText(t: TestContext, conn: FakeAgentSideConnection, text: string) {
  const entered = deferred<void>()
  const release = deferred<void>()
  t.after(() => release.resolve())
  const previous = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    const update = message.update
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content.type === 'text' &&
      update.content.text === text
    ) {
      entered.resolve()
      await release.promise
    }
    await previous(message)
  }
  return { entered: entered.promise, release: () => release.resolve() }
}

for (const owned of [false, true]) {
  for (const boundary of ['message_end', 'turn_end', 'agent_end', 'agent_settled']) {
    for (const kind of ['text_delta', 'thinking_delta'] as const) {
      test(`${owned ? 'owned' : 'autonomous'} ${boundary} flushes ${kind} without waiting for a timer`, async t => {
        const { rpc, conn, session, delta, chunks, texts, prompts, assertBatchTimersCleared } = setup(t)
        let completed = false
        const turn = owned
          ? session.prompt('one').then(reason => {
              completed = true
              return reason
            })
          : undefined
        rpc.send({ type: 'agent_start' })
        await bounded(nextTick())
        conn.updates.length = 0
        delta('before ', kind)
        delta('boundary', kind)
        await bounded(nextTick())
        assert.deepEqual(chunks(), [])

        rpc.send({ type: boundary })
        await bounded(nextTick())
        assert.deepEqual(chunks()[0], {
          kind: kind === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
          text: 'before boundary'
        })
        assertBatchTimersCleared()
        assert.equal(completed, owned && boundary === 'agent_settled')
        if (!owned && boundary === 'agent_settled') {
          assert.deepEqual(texts(), ['before boundary', 'Background work finished.'])
        }
        if (boundary !== 'agent_settled') rpc.send({ type: 'agent_settled' })
        if (turn) assert.equal(await bounded(turn), 'end_turn')
        else assert.deepEqual(prompts(), [])
        await bounded(nextTick())
        const delivered = conn.updates.length
        t.mock.timers.tick(1000)
        await bounded(nextTick())
        assert.equal(conn.updates.length, delivered, 'boundary must not leave a duplicate timer delivery')
      })
    }
  }
}

for (const acknowledgementFirst of [true, false]) {
  test(`completion requires both final delta delivery and prompt ACK (ACK first=${acknowledgementFirst})`, async t => {
    const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(
      t,
      command => command.type !== 'prompt'
    )
    const gate = blockText(t, conn, 'final output')
    let completed = false
    const turn = session.prompt('one').then(reason => {
      completed = true
      return reason
    })
    rpc.send({ type: 'agent_start' })
    delta('final ')
    delta('output')
    rpc.send({ type: 'agent_settled' })
    await bounded(gate.entered)
    assert.equal(completed, false)
    assert.deepEqual(texts(), [])
    assertBatchTimersCleared()

    if (acknowledgementFirst) rpc.respond(prompts()[0]!)
    else gate.release()
    await bounded(nextTick())
    assert.equal(completed, false)
    if (acknowledgementFirst) gate.release()
    else rpc.respond(prompts()[0]!)
    assert.equal(await bounded(turn), 'end_turn')
    assert.deepEqual(texts(), ['final output'])
  })
}

for (const owned of [false, true]) {
  for (const settlementFirst of [true, false]) {
    test(`${owned ? 'owned' : 'autonomous'} cancel preserves buffered output and the abort barrier (settlement first=${settlementFirst})`, async t => {
      const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(
        t,
        command => command.type !== 'abort'
      )
      const first = owned ? session.prompt('active') : undefined
      rpc.send({ type: 'agent_start' })
      const discarded = session.prompt('discarded')
      await bounded(nextTick())
      conn.updates.length = 0
      delta('keep this output')
      const cancelled = session.cancel()
      const next = session.prompt('after cancel')
      assert.equal(await bounded(discarded), 'cancelled')
      await bounded(nextTick())
      assert.deepEqual(texts(), ['keep this output', 'Cleared queued prompts.', 'Queued message (position 1).'])
      assertBatchTimersCleared()
      const abort = rpc.commands.find(command => command.type === 'abort')
      assert.ok(abort)
      if (settlementFirst) rpc.send({ type: 'agent_settled' })
      else rpc.respond(abort)
      await bounded(nextTick())
      assert.deepEqual(
        prompts().map(command => command.message),
        owned ? ['active'] : []
      )
      if (settlementFirst) rpc.respond(abort)
      else rpc.send({ type: 'agent_settled' })
      await bounded(cancelled)
      if (first) assert.equal(await bounded(first), 'cancelled')
      await bounded(nextTick())
      assert.deepEqual(
        prompts().map(command => command.message),
        owned ? ['active', 'after cancel'] : ['after cancel']
      )
      rpc.send({ type: 'agent_start' })
      delta('next output')
      rpc.send({ type: 'agent_settled' })
      assert.equal(await bounded(next), 'end_turn')
      assert.equal(texts().at(-1), 'next output')
    })
  }
}

for (const failure of ['session dispose', 'process dispose', 'exit', 'stdin close', 'child error'] as const) {
  test(`${failure} drains buffered output before rejecting prompts and clears timers`, async t => {
    const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(t)
    const gate = blockText(t, conn, 'last output')
    const completed: string[] = []
    const track = (prompt: string) =>
      outcome(session.prompt(prompt)).then(reason => {
        completed.push(reason)
        return reason
      })
    const first = track('active')
    const second = track('queued')
    rpc.send({ type: 'agent_start' })
    await bounded(nextTick())
    conn.updates.length = 0
    delta('last ')
    delta('output')
    if (failure === 'session dispose') session.dispose()
    else if (failure === 'process dispose') rpc.proc.dispose()
    else if (failure === 'exit') rpc.child.emit('exit', 1, null)
    else if (failure === 'stdin close') rpc.child.stdin.destroy()
    else rpc.child.emit('error', new Error('child failed'))

    await bounded(gate.entered)
    assert.deepEqual(completed, [])
    assert.deepEqual(texts(), [])
    assertBatchTimersCleared()
    delta('late output must be ignored')
    t.mock.timers.tick(1000)
    await bounded(nextTick())
    assert.deepEqual(completed, [])
    gate.release()
    assert.deepEqual(await bounded(Promise.all([first, second])), ['error', 'error'])
    await bounded(nextTick())
    assert.deepEqual(texts(), ['last output'])
    assert.deepEqual(
      prompts().map(command => command.message),
      ['active']
    )
    const delivered = conn.updates.length
    session.dispose()
    delta('another late output')
    t.mock.timers.tick(1000)
    await bounded(nextTick())
    assert.equal(conn.updates.length, delivered)
  })
}

test('a failed repeated abort drains output before cancelling a late-accepted prompt', async t => {
  const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(
    t,
    command => !['prompt', 'abort'].includes(command.type)
  )
  const gate = blockText(t, conn, 'late accepted output')
  const completed: string[] = []
  const turn = outcome(session.prompt('one')).then(reason => {
    completed.push(reason)
    return reason
  })
  const cancelled = session.cancel()
  await bounded(nextTick())
  const initialAbort = rpc.commands.find(command => command.type === 'abort')
  assert.ok(initialAbort)
  rpc.respond(initialAbort)
  await bounded(cancelled)
  assert.deepEqual(completed, [])

  delta('late accepted output')
  rpc.respond(prompts()[0]!)
  await bounded(nextTick())
  const aborts = rpc.commands.filter(command => command.type === 'abort')
  assert.equal(aborts.length, 2)
  assert.deepEqual(texts(), [])
  rpc.respond(aborts[1]!, false, { error: 'repeated abort failed' })
  await bounded(gate.entered)
  await bounded(nextTick())
  assert.deepEqual(completed, [])
  assertBatchTimersCleared()
  t.mock.timers.tick(1000)
  await bounded(nextTick())
  assert.deepEqual(completed, [])
  gate.release()
  assert.equal(await bounded(turn), 'cancelled')
  assert.deepEqual(texts(), ['late accepted output'])
  await bounded(nextTick())
  const delivered = conn.updates.length
  t.mock.timers.tick(1000)
  await bounded(nextTick())
  assert.equal(conn.updates.length, delivered, 'no buffered text may arrive after cancellation')
  assert.equal(prompts().length, 1)
})

const busyFailures = [
  {
    activity: 'agent',
    error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    start: 'agent_start',
    end: 'agent_settled'
  },
  {
    activity: 'compaction',
    error: 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.',
    start: 'compaction_start',
    end: 'compaction_end'
  }
] as const

for (const busy of busyFailures) {
  for (const failure of ['failed', 'malformed'] as const) {
    test(`${busy.activity} busy reconciliation with ${failure} state drains output before rejecting queued requests`, async t => {
      const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(
        t,
        command => !['prompt', 'get_state'].includes(command.type)
      )
      const gate = blockText(t, conn, 'reconciliation output')
      const completed: string[] = []
      const track = (message: string) =>
        outcome(session.prompt(message)).then(reason => {
          completed.push(reason)
          return reason
        })
      const first = track('one')
      const second = track('two')
      rpc.respond(prompts()[0]!, false, { error: busy.error })
      await bounded(nextTick())
      const state = rpc.commands.find(command => command.type === 'get_state')
      assert.ok(state)
      conn.updates.length = 0
      delta('reconciliation output')
      if (failure === 'failed') rpc.respond(state, false, { error: 'state unavailable' })
      else rpc.respond(state, true, { data: { isStreaming: false, isCompacting: null } })
      await bounded(gate.entered)
      const third = track('three')
      await bounded(nextTick())
      assert.deepEqual(completed, [])
      assert.deepEqual(texts(), [])
      assertBatchTimersCleared()
      t.mock.timers.tick(1000)
      await bounded(nextTick())
      assert.deepEqual(completed, [])
      assert.deepEqual(
        prompts().map(command => command.message),
        ['one']
      )
      assert.equal(rpc.commands.filter(command => command.type === 'get_state').length, 1)
      gate.release()
      assert.deepEqual(await bounded(Promise.all([first, second, third])), ['error', 'error', 'error'])
      await bounded(nextTick())
      assert.equal(texts()[0], 'reconciliation output')
      assert.equal(prompts().length, 1)
      const delivered = conn.updates.length
      t.mock.timers.tick(1000)
      await bounded(nextTick())
      assert.equal(conn.updates.length, delivered)
    })

    for (const newerEvent of [busy.start, busy.end]) {
      test(`${newerEvent} during ${failure} ${busy.activity} reconciliation drain supersedes the failure and preserves FIFO`, async t => {
        const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(
          t,
          command => !['prompt', 'get_state'].includes(command.type)
        )
        const gate = blockText(t, conn, 'stale reconciliation output')
        const completed: string[] = []
        const track = (message: string) =>
          outcome(session.prompt(message)).then(reason => {
            completed.push(`${message}:${reason}`)
            return reason
          })
        const first = track('one')
        const second = track('two')
        rpc.respond(prompts()[0]!, false, { error: busy.error })
        await bounded(nextTick())
        const state = rpc.commands.find(command => command.type === 'get_state')
        assert.ok(state)
        conn.updates.length = 0
        delta('stale reconciliation output')
        if (failure === 'failed') rpc.respond(state, false, { error: 'state unavailable' })
        else rpc.respond(state, true, { data: { isStreaming: false, isCompacting: null } })
        await bounded(gate.entered)
        rpc.send({ type: newerEvent })
        const third = track('three')
        await bounded(nextTick())
        assert.deepEqual(completed, [])
        assert.deepEqual(
          prompts().map(command => command.message),
          ['one']
        )
        assertBatchTimersCleared()
        gate.release()
        await bounded(nextTick())
        assert.deepEqual(completed, [])
        assert.equal(texts()[0], 'stale reconciliation output')
        if (newerEvent === busy.start) {
          assert.equal(prompts().length, 1, 'newer activity must remain authoritative after the drain')
          rpc.send({ type: busy.end })
          await bounded(nextTick())
        }
        assert.deepEqual(
          prompts().map(command => command.message),
          ['one', 'one']
        )
        for (const [index, turn] of [first, second, third].entries()) {
          rpc.respond(prompts()[index + 1]!)
          rpc.send({ type: 'agent_start' })
          rpc.send({ type: 'agent_settled' })
          assert.equal(await bounded(turn), 'end_turn')
        }
        assert.deepEqual(completed, ['one:end_turn', 'two:end_turn', 'three:end_turn'])
        assert.deepEqual(
          prompts().map(command => command.message),
          ['one', 'one', 'two', 'three']
        )
        await bounded(nextTick())
        const delivered = conn.updates.length
        t.mock.timers.tick(1000)
        await bounded(nextTick())
        assert.equal(conn.updates.length, delivered)
      })
    }
  }
}

test('provider preflight rejection drains buffered text before failing active and queued prompts', async t => {
  const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(
    t,
    command => command.type !== 'prompt'
  )
  const gate = blockText(t, conn, 'preflight output')
  const completed: string[] = []
  const track = (message: string) =>
    outcome(session.prompt(message)).then(reason => {
      completed.push(reason)
      return reason
    })
  const first = track('one')
  const second = track('two')
  await bounded(nextTick())
  conn.updates.length = 0
  delta('preflight output')
  rpc.respond(prompts()[0]!, false, { error: 'provider preflight failed' })
  await bounded(gate.entered)
  await bounded(nextTick())
  assert.deepEqual(completed, [])
  assert.deepEqual(texts(), [])
  assert.equal(prompts().length, 1)
  assertBatchTimersCleared()
  gate.release()
  assert.deepEqual(await bounded(Promise.all([first, second])), ['error', 'error'])
  assert.deepEqual(texts(), ['preflight output'])
  await bounded(nextTick())
  const delivered = conn.updates.length
  t.mock.timers.tick(1000)
  await bounded(nextTick())
  assert.equal(conn.updates.length, delivered)
  assert.equal(prompts().length, 1)
})

test('FIFO prompts never share a batch and the next dispatch waits for final delivery', async t => {
  const { rpc, conn, session, delta, texts, prompts } = setup(t)
  const gate = blockText(t, conn, 'first tail')
  const first = session.prompt('one')
  const second = session.prompt('two')
  rpc.send({ type: 'agent_start' })
  await bounded(nextTick())
  conn.updates.length = 0
  delta('first ')
  delta('tail')
  rpc.send({ type: 'agent_settled' })
  await bounded(gate.entered)
  assert.deepEqual(
    prompts().map(command => command.message),
    ['one']
  )
  gate.release()
  assert.equal(await bounded(first), 'end_turn')
  assert.deepEqual(texts(), ['first tail'])
  assert.deepEqual(
    prompts().map(command => command.message),
    ['one', 'two']
  )
  rpc.send({ type: 'agent_start' })
  delta('second ')
  delta('tail')
  await bounded(nextTick())
  assert.deepEqual(texts(), ['first tail'])
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
  assert.deepEqual(texts(), ['first tail', 'second tail'])
})

test('restart during delayed final batch delivery invalidates the old settlement', async t => {
  const { rpc, conn, session, delta, texts, prompts, assertBatchTimersCleared } = setup(t)
  const gate = blockText(t, conn, 'old final output')
  let completed = false
  const first = session.prompt('one').then(reason => {
    completed = true
    return reason
  })
  const second = session.prompt('two')
  rpc.send({ type: 'agent_start' })
  await bounded(nextTick())
  conn.updates.length = 0
  delta('old final output')
  rpc.send({ type: 'agent_settled' })
  await bounded(gate.entered)
  await bounded(nextTick())
  rpc.send({ type: 'agent_start' })
  delta('restarted output')
  gate.release()
  await bounded(nextTick())
  assert.equal(completed, false)
  assert.deepEqual(
    prompts().map(command => command.message),
    ['one']
  )
  assert.deepEqual(texts(), ['old final output', 'restarted output'])
  assertBatchTimersCleared()
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(first), 'end_turn')
  assert.deepEqual(
    prompts().map(command => command.message),
    ['one', 'two']
  )
  rpc.send({ type: 'agent_start' })
  rpc.send({ type: 'agent_settled' })
  assert.equal(await bounded(second), 'end_turn')
})

test('settlement drains newly buffered deltas and notifications appended during a flush', async t => {
  const { rpc, conn, session, delta, texts, assertBatchTimersCleared } = setup(t)
  const firstGate = blockText(t, conn, 'initial output')
  const secondGate = blockText(t, conn, 'output during flush')
  const noticeGate = blockText(t, conn, 'notice during flush')
  let completed = false
  const turn = session.prompt('one').then(reason => {
    completed = true
    return reason
  })
  rpc.send({ type: 'agent_start' })
  delta('initial output')
  rpc.send({ type: 'agent_settled' })
  await bounded(firstGate.entered)
  delta('output during ')
  delta('flush')
  firstGate.release()
  await bounded(secondGate.entered)
  assert.equal(completed, false)
  assert.deepEqual(texts(), ['initial output'])
  session.setStartupInfo('notice during flush')
  session.sendStartupInfoIfPending()
  secondGate.release()
  await bounded(noticeGate.entered)
  assert.equal(completed, false)
  assert.deepEqual(texts(), ['initial output', 'output during flush'])
  noticeGate.release()
  assert.equal(await bounded(turn), 'end_turn')
  assert.deepEqual(texts(), ['initial output', 'output during flush', 'notice during flush'])
  assertBatchTimersCleared()
})
