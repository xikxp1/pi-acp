import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcEvent, PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

type Notification = Parameters<FakeAgentSideConnection['sessionUpdate']>[0]
type DeltaKind = 'text_delta' | 'thinking_delta'

class ControlledConnection extends FakeAgentSideConnection {
  blocked = true
  pending: { resolve: () => void; reject: (error: Error) => void } | undefined

  override async sessionUpdate(message: Notification): Promise<void> {
    this.updates.push(message)
    if (this.blocked) {
      await new Promise<void>((resolve, reject) => {
        assert.equal(this.pending, undefined, 'notifications must be delivered serially')
        this.pending = { resolve, reject }
      })
    }
  }

  release(error?: Error): void {
    const pending = this.pending
    assert.ok(pending, 'a notification must be in flight')
    this.pending = undefined
    if (error) pending.reject(error)
    else pending.resolve()
  }
}

function setup(t: TestContext, conn = new FakeAgentSideConnection()) {
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'delta-coalescing',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  const clock = { now: 0 }
  t.mock.method(performance, 'now', () => clock.now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(async () => {
    session.dispose()
    if (conn instanceof ControlledConnection) {
      conn.blocked = false
      if (conn.pending) conn.release()
    }
    await nextTurn()
    t.mock.timers.reset()
  })
  const delta = (text: string, kind: DeltaKind = 'text_delta') => {
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: kind, delta: text } })
  }
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms)
    await nextTurn()
  }
  return { conn, proc, session, clock, delta, tick }
}

function chunks(conn: FakeAgentSideConnection) {
  return conn.updates.flatMap(({ update }) => {
    if (
      (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') &&
      update.content.type === 'text'
    ) {
      return [{ kind: update.sessionUpdate, text: update.content.text }]
    }
    return []
  })
}

for (const kind of ['text_delta', 'thinking_delta'] as const) {
  test(`delta coalescing: adjacent ${kind} use a fixed 100ms window, not a debounce`, async t => {
    const { conn, delta, tick } = setup(t)
    delta('first ', kind)
    await tick(60)
    delta('second ', kind)
    await tick(39)
    delta('third', kind)
    assert.deepEqual(chunks(conn), [])
    await tick(1)
    assert.deepEqual(chunks(conn), [
      { kind: kind === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk', text: 'first second third' }
    ])
    await tick(250)
    assert.equal(conn.updates.length, 1)
  })
}

test('delta coalescing: empty deltas neither start a timer nor split a different-kind batch', async t => {
  const { conn, delta, tick } = setup(t)
  delta('')
  delta('', 'thinking_delta')
  await tick(50)
  delta('a')
  await tick(49)
  delta('', 'thinking_delta')
  delta('b')
  await tick(50)
  assert.deepEqual(chunks(conn), [])
  await tick(1)
  assert.deepEqual(chunks(conn), [{ kind: 'agent_message_chunk', text: 'ab' }])
  delta('')
  await tick(250)
  assert.equal(conn.updates.length, 1)
})

test('delta coalescing: text/thought switches preserve chronological chunks', async t => {
  const { conn, proc, delta, tick } = setup(t)
  delta('text ')
  delta('one')
  delta('think ', 'thinking_delta')
  delta('one', 'thinking_delta')
  delta('text two')
  delta('think two', 'thinking_delta')
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  await nextTurn()
  assert.deepEqual(chunks(conn), [
    { kind: 'agent_message_chunk', text: 'text one' },
    { kind: 'agent_thought_chunk', text: 'think one' },
    { kind: 'agent_message_chunk', text: 'text two' },
    { kind: 'agent_thought_chunk', text: 'think two' }
  ])
  await tick(250)
  assert.equal(conn.updates.length, 4)
})

const boundaries: PiRpcEvent[] = [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'message_end', message: { role: 'assistant' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_end' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } },
  { type: 'turn_end' }
]
for (const boundary of boundaries) {
  const name = boundary.assistantMessageEvent
    ? String((boundary.assistantMessageEvent as { type: string }).type)
    : boundary.type
  test(`delta coalescing: ${name} flushes before the next same-kind delta`, async t => {
    const { conn, proc, delta, tick } = setup(t)
    delta('before')
    proc.emit(boundary)
    await nextTurn()
    assert.deepEqual(chunks(conn), [{ kind: 'agent_message_chunk', text: 'before' }])
    delta('after')
    await tick(99)
    assert.equal(conn.updates.length, 1)
    await tick(1)
    assert.deepEqual(
      chunks(conn).map(chunk => chunk.text),
      ['before', 'after']
    )
  })
}

test('delta coalescing: tool, direct ACP, and status updates stay between their surrounding text', async t => {
  const { conn, proc, session, delta, tick } = setup(t)
  delta('before tool')
  proc.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'pwd' } })
  delta('before terminal')
  session.attachClientTerminal('tool-1', 'terminal-1')
  delta('before completion')
  proc.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', isError: false, result: {} })
  delta('before status')
  proc.emit({ type: 'auto_retry_end', success: true })
  delta('after status')
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  await nextTurn()
  assert.deepEqual(
    conn.updates.map(({ update }) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') return update.content.text
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        return { type: update.sessionUpdate, status: update.status, content: update.content }
      }
      return update.sessionUpdate
    }),
    [
      'before tool',
      { type: 'tool_call', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'tool-1' }] },
      'before terminal',
      { type: 'tool_call_update', status: undefined, content: [{ type: 'terminal', terminalId: 'terminal-1' }] },
      'before completion',
      { type: 'tool_call_update', status: 'completed', content: undefined },
      'before status',
      'Retry finished, resuming.',
      'after status'
    ]
  )
  await tick(250)
  assert.equal(conn.updates.length, 9)
})

test('delta coalescing: usage on a delta-bearing event separates earlier text from its new delta', async t => {
  const { conn, proc, session, delta } = setup(t)
  t.mock.method(proc, 'getState', async () => ({ model: { contextWindow: 200000 } }))
  await session.refreshContextWindow()
  void session.prompt('hello').catch(() => {})
  await nextTurn()
  conn.updates.length = 0
  delta('before usage')
  proc.emit({
    type: 'message_update',
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    assistantMessageEvent: { type: 'text_delta', delta: 'after usage' }
  })
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  await nextTurn()
  assert.deepEqual(
    conn.updates.map(({ update }) => update.sessionUpdate),
    ['agent_message_chunk', 'usage_update', 'agent_message_chunk']
  )
  assert.deepEqual(
    chunks(conn).map(chunk => chunk.text),
    ['before usage', 'after usage']
  )
})

test('delta coalescing: threshold counts UTF-16 units after append without splitting oversized deltas', async t => {
  const { conn, delta, tick } = setup(t)
  const prefix = '😀'.repeat(8191) + 'x'
  assert.equal(prefix.length, 16383)
  delta(prefix)
  await nextTurn()
  assert.equal(conn.updates.length, 0)
  delta('y')
  await nextTurn()
  assert.deepEqual(
    chunks(conn).map(chunk => chunk.text),
    [prefix + 'y']
  )
  const oversized = '🌍'.repeat(10000)
  delta('prefix:')
  delta(oversized)
  await nextTurn()
  assert.deepEqual(
    chunks(conn).map(chunk => chunk.text),
    [prefix + 'y', 'prefix:' + oversized]
  )
  delta('tail')
  await tick(100)
  assert.deepEqual(
    chunks(conn).map(chunk => chunk.text),
    [prefix + 'y', 'prefix:' + oversized, 'tail']
  )
  assert.equal(
    chunks(conn)
      .map(chunk => chunk.text)
      .join(''),
    prefix + 'y' + 'prefix:' + oversized + 'tail'
  )
})

for (const depth of [1, 2, 3, 8]) {
  test(`delta coalescing: ${depth} in-flight plus queued notifications select the bounded pressure window`, async t => {
    const conn = new ControlledConnection()
    const { proc, delta, tick } = setup(t, conn)
    for (let index = 0; index < depth; index++) proc.emit({ type: 'auto_retry_end', success: true })
    await nextTurn()
    assert.equal(conn.updates.length, 1)
    delta('buffered')
    conn.blocked = false
    conn.release()
    await nextTurn()
    assert.equal(conn.updates.length, depth)
    const delay = Math.min(250, Math.max(1, depth) * 100)
    await tick(delay - 1)
    assert.equal(conn.updates.length, depth)
    await tick(1)
    assert.equal(chunks(conn).at(-1)?.text, 'buffered')
    assert.equal(conn.updates.length, depth + 1)
    delta('recovered')
    await tick(99)
    assert.equal(conn.updates.length, depth + 1)
    await tick(1)
    assert.equal(chunks(conn).at(-1)?.text, 'recovered')
  })
}

for (const latency of [21, 41, 1000]) {
  test(`delta coalescing: measured ${latency}ms client delivery increases the next window`, async t => {
    const conn = new ControlledConnection()
    const { proc, clock, delta, tick } = setup(t, conn)
    delta('prime')
    proc.emit({ type: 'message_end', message: { role: 'assistant' } })
    await nextTurn()
    clock.now += latency
    conn.blocked = false
    conn.release()
    await nextTurn()
    delta('adaptive')
    const delay = Math.min(250, Math.ceil(latency / 20) * 100)
    await tick(delay - 1)
    assert.deepEqual(
      chunks(conn).map(chunk => chunk.text),
      ['prime']
    )
    await tick(1)
    assert.deepEqual(
      chunks(conn).map(chunk => chunk.text),
      ['prime', 'adaptive']
    )
  })
}

test('delta coalescing: simultaneous queue and latency pressure use their maximum, not their sum', async t => {
  const conn = new ControlledConnection()
  const { proc, clock, delta, tick } = setup(t, conn)
  proc.emit({ type: 'auto_retry_end', success: true })
  await nextTurn()
  clock.now = 21
  conn.release()
  await nextTurn()
  proc.emit({ type: 'auto_retry_end', success: true })
  proc.emit({ type: 'auto_retry_end', success: true })
  await nextTurn()
  delta('combined pressure')
  conn.blocked = false
  conn.release()
  await nextTurn()
  assert.equal(conn.updates.length, 3)
  await tick(199)
  assert.equal(conn.updates.length, 3)
  await tick(1)
  assert.equal(chunks(conn).at(-1)?.text, 'combined pressure')
  assert.equal(conn.updates.length, 4)
})

test('delta coalescing: delivery latency EMA decays with successful fast notifications', async t => {
  const conn = new ControlledConnection()
  const { proc, clock, delta, tick } = setup(t, conn)
  delta('prime')
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  await nextTurn()
  clock.now = 60
  conn.blocked = false
  conn.release()
  await nextTurn()
  // EMA before each new batch: 60, 45, 33.75, 25.3125, 18.984375ms.
  for (const [index, delay] of [250, 250, 200, 200, 100].entries()) {
    delta(`batch-${index}`)
    await tick(delay - 1)
    assert.equal(conn.updates.length, index + 1)
    await tick(1)
    assert.equal(chunks(conn).at(-1)?.text, `batch-${index}`)
    assert.equal(conn.updates.length, index + 2)
  }
})

test('delta coalescing: slow producer and client preserve all text with substantially fewer notifications', async t => {
  const conn = new ControlledConnection()
  const { clock, delta, tick } = setup(t, conn)
  const pieces = Array.from({ length: 50 }, (_, index) => `${index}:😀 `)
  for (const piece of pieces) {
    delta(piece)
    await tick(10)
    if (conn.pending) {
      clock.now += 80
      conn.release()
      await nextTurn()
    }
  }
  conn.blocked = false
  await tick(250)
  assert.equal(
    chunks(conn)
      .map(chunk => chunk.text)
      .join(''),
    pieces.join('')
  )
  assert.equal(chunks(conn).length, 3)
  assert.ok(chunks(conn).length < pieces.length / 10)
})

test('delta coalescing: rejected notifications release queue pressure and do not poison later batches', async t => {
  const conn = new ControlledConnection()
  const { proc, delta, tick } = setup(t, conn)
  for (const text of ['rejected first', 'rejected second', 'delivered third']) {
    delta(text)
    proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  }
  await nextTurn()
  conn.release(new Error('client rejected first update'))
  await nextTurn()
  conn.release(new Error('client rejected second update'))
  await nextTurn()
  conn.blocked = false
  conn.release()
  await nextTurn()
  assert.deepEqual(
    chunks(conn).map(chunk => chunk.text),
    ['rejected first', 'rejected second', 'delivered third']
  )
  delta('healthy ')
  delta('batch')
  await tick(99)
  assert.equal(conn.updates.length, 3)
  await tick(1)
  assert.deepEqual(
    chunks(conn).map(chunk => chunk.text),
    ['rejected first', 'rejected second', 'delivered third', 'healthy batch']
  )
})
