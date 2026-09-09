import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import extension, {
  SubagentsBridge,
  MAX_TEXT,
  type BridgePi,
  type BridgeContext
} from '../../extensions/pi-acp-subagents.js'
import { SubagentCards } from '../../src/acp/translate/subagents.js'
const globals = globalThis as unknown as Record<symbol, unknown>
const manager = Symbol.for('pi-subagents:manager')
const owner = Symbol.for('pi-acp:subagents:owner')
const bridges: SubagentsBridge[] = []
const previousEnv = process.env.PI_ACP_SUBAGENTS
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop()
  delete globals[manager]
  delete globals[owner]
  if (previousEnv === undefined) delete process.env.PI_ACP_SUBAGENTS
  else process.env.PI_ACP_SUBAGENTS = previousEnv
})
function setup(start = true, automaticTicks = false) {
  const snapshots: string[] = []
  const listeners = new Map<string, Set<(v: unknown) => void>>()
  const lifecycle = new Map<string, (e: unknown, c: BridgeContext) => void>()
  const cards: { agentId: string; runId: string; title: string; status: string; text: string; outputFile?: string }[] =
    []
  const records = new Map<string, Record<string, unknown>>()
  const pi: BridgePi = {
    events: {
      on(name, fn) {
        const set = listeners.get(name) ?? new Set()
        set.add(fn)
        listeners.set(name, set)
        return () => {
          set.delete(fn)
        }
      }
    },
    on(name, fn) {
      lifecycle.set(name, fn)
    }
  }
  const ctx: BridgeContext = {
    mode: 'rpc',
    ui: {
      setStatus(key, text) {
        assert.equal(key, 'pi-acp:subagent')
        snapshots.push(text)
        cards.push(JSON.parse(text))
      }
    }
  }
  globals[manager] = { getRecord: (id: string) => records.get(id) }
  const bridge = new SubagentsBridge(pi, ctx, automaticTicks)
  bridges.push(bridge)
  if (start) bridge.start()
  return {
    pi,
    ctx,
    cards,
    snapshots,
    records,
    bridge,
    lifecycle,
    listeners,
    emit(event: string, id = 'a', extra = {}) {
      for (const fn of listeners.get(`subagents:${event}`) ?? [])
        fn({ id, type: 'Explore', description: 'inspect', ...extra })
    },
    add(id = 'a', status = 'running') {
      const record: Record<string, unknown> = { status, startedAt: 100 }
      records.set(id, record)
      return record
    }
  }
}
const message = (text: string, timestamp = 101, role = 'assistant') => ({
  role,
  timestamp,
  content: [{ type: 'text', text }]
})
test('automatic polling emits snapshots and clears the interval after the last run', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const clear = t.mock.method(globalThis, 'clearInterval')
  const f = setup(true, true)
  const a = f.add()
  const b = f.add('b')
  f.emit('started')
  f.emit('started', 'b')
  a.session = { messages: [message('timer output')] }
  t.mock.timers.tick(250)
  assert.equal(f.cards.at(-1)?.text, 'timer output')
  a.status = 'completed'
  f.emit('completed')
  assert.equal(clear.mock.callCount(), 0)
  b.status = 'completed'
  f.emit('completed', 'b')
  assert.equal(clear.mock.callCount(), 1)
  const count = f.cards.length
  t.mock.timers.tick(1000)
  assert.equal(f.cards.length, count)
})

test('failed lifecycle events carry error text into a failed consumer card', () => {
  const f = setup()
  f.add()
  f.emit('started')
  f.emit('failed', 'a', { error: 'worker crashed' })
  const consumer = new SubagentCards()
  consumer.update(f.snapshots[0])
  const update = consumer.update(f.snapshots[1])
  assert.ok(update?.sessionUpdate === 'tool_call_update')
  assert.equal(update.status, 'failed')
  assert.deepEqual(update.content, [{ type: 'content', content: { type: 'text', text: 'worker crashed' } }])
})

test('nested and workflow streams do not affect an interleaved root run', () => {
  const f = setup()
  const root = f.add()
  f.add('child').parentAgentId = 'a'
  f.add('workflow').workflowId = 'w'
  f.emit('started')
  const runId = f.cards[0].runId
  for (const event of ['created', 'started', 'failed', 'completed']) {
    f.emit(event, 'child', { error: 'nested error' })
    f.emit(event, 'workflow')
    root.session = { messages: [message(event)] }
    f.bridge.tick()
  }
  assert.equal(f.cards.length, 5)
  assert.ok(f.cards.every(card => card.agentId === 'a' && card.runId === runId && card.status === 'in_progress'))
  assert.equal(f.cards.at(-1)?.text, 'completed')
})

test('factory is inert; activation requires opt-in RPC context', () => {
  const f = setup(false)
  extension(f.pi)
  assert.equal(f.listeners.size, 0)
  delete process.env.PI_ACP_SUBAGENTS
  f.lifecycle.get('session_start')!({}, f.ctx)
  assert.equal(f.listeners.size, 0)
  process.env.PI_ACP_SUBAGENTS = '1'
  f.lifecycle.get('session_start')!({}, { ...f.ctx, mode: 'interactive' })
  assert.equal(f.listeners.size, 0)
  f.lifecycle.get('session_start')!({}, f.ctx)
  assert.equal(f.listeners.size, 4)
  f.lifecycle.get('session_shutdown')!({}, f.ctx)
  assert.ok([...f.listeners.values()].every(s => s.size === 0))
})
test('queue, start, async attach, streaming finalization and deduplication', () => {
  const f = setup()
  const r = f.add('a', 'queued')
  f.emit('created')
  assert.equal(f.cards.at(-1)?.status, 'pending')
  const runId = f.cards[0].runId
  r.status = 'running'
  f.emit('started')
  f.emit('created')
  assert.equal(f.cards.length, 2)
  assert.equal(f.cards[1].runId, runId)
  f.bridge.tick()
  assert.equal(f.cards.length, 2)
  const partial = message('hello')
  const session = { messages: [] as unknown[], agent: { state: { streamingMessage: partial as unknown } } }
  r.session = session
  f.bridge.tick()
  assert.equal(f.cards.at(-1)?.text, 'hello')
  session.messages.push(message('hello'))
  session.agent.state.streamingMessage = message('hello')
  f.bridge.tick()
  assert.equal(f.cards.length, 3)
  session.agent.state.streamingMessage = undefined
  r.status = 'completed'
  r.result = 'hello'
  f.emit('completed')
  assert.equal(f.cards.at(-1)?.text, 'hello')
  assert.equal(f.cards.at(-1)?.status, 'completed')
  f.bridge.tick()
  f.emit('completed')
  assert.equal(f.cards.length, 4)
})
test('created without started preserves already available current-run output', () => {
  const f = setup()
  const r = f.add()
  r.session = {
    messages: [
      message('old history', 99),
      message('current assistant', 100),
      message('current tool result', 101, 'toolResult')
    ]
  }
  f.emit('created')
  assert.equal(f.cards.at(-1)?.text, 'current assistant\ncurrent tool result')
  f.bridge.tick()
  assert.equal(f.cards.length, 1)
})
test('only current-run assistant text and tool calls/results are displayed', () => {
  const f = setup()
  const r = f.add()
  f.emit('started')
  r.session = {
    messages: [
      message('inherited', 99),
      message('private user', 102, 'user'),
      message('system', 102, 'system'),
      {
        role: 'assistant',
        timestamp: 103,
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'toolCall', name: 'read', arguments: { path: '/tmp/file' } }
        ]
      },
      message('file content', 104, 'toolResult')
    ],
    agent: {
      state: {
        streamingMessage: {
          role: 'assistant',
          timestamp: 105,
          content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } }]
        }
      }
    }
  }
  f.bridge.tick()
  const text = f.cards.at(-1)!.text
  assert.match(text, /read.*\/tmp\/file/)
  assert.match(text, /file content/)
  assert.match(text, /bash.*pwd/)
  assert.doesNotMatch(text, /inherited|private user|system|secret/)
})
test('terminal lifecycle events capture results for every terminal status', () => {
  for (const terminal of ['error', 'stopped', 'aborted', 'completed', 'steered']) {
    const f = setup()
    const r = f.add()
    f.emit('started')
    r.status = terminal
    r.result = 'final'
    r.error = terminal === 'error' ? 'oops' : undefined
    r.outputFile = '/tmp/transcript'
    if (terminal === 'completed') f.emit('completed', 'a', { result: 'fast event result' })
    else f.emit(terminal === 'error' ? 'failed' : 'completed', 'a', { status: terminal })
    assert.equal(f.cards.at(-1)?.status, ['completed', 'steered'].includes(terminal) ? 'completed' : 'failed')
    assert.match(f.cards.at(-1)!.text, terminal === 'completed' ? /fast event result/ : /final/)
    if (terminal === 'error') assert.match(f.cards.at(-1)!.text, /oops/)
    assert.equal(f.cards.at(-1)?.outputFile, '/tmp/transcript')
    f.bridge.stop()
  }
})
test('delayed cleanup keeps polling non-terminal until the final lifecycle event', () => {
  for (const initialEvent of ['created', 'started']) {
    const f = setup()
    const r = f.add()
    f.emit(initialEvent)
    r.status = 'completed'
    r.result = 'Implemented changes'
    r.session = { messages: [message('Implemented changes')] }
    f.bridge.tick()
    assert.equal(f.cards.at(-1)?.status, 'in_progress')
    assert.equal(f.cards.at(-1)?.text, 'Implemented changes')
    r.result += '\nChanges saved to branch `pi-agent-test`. Merge with: `git merge pi-agent-test`'
    f.bridge.tick()
    assert.ok(f.cards.every(card => card.status === 'in_progress'))
    f.emit('completed', 'a', { result: r.result })
    assert.equal(f.cards.at(-1)?.status, 'completed')
    assert.ok(f.cards.at(-1)!.text.includes(String(r.result)))
    const count = f.cards.length
    f.bridge.tick()
    f.emit('completed')
    assert.equal(f.cards.length, count)
    assert.equal(f.cards.filter(card => card.status === 'completed').length, 1)
    f.bridge.stop()
  }
})
test('polling finalizes queued cancellations and pre-start failures without lifecycle completion', () => {
  for (const terminal of ['stopped', 'error']) {
    const f = setup()
    const r = f.add('a', 'queued')
    f.emit('created')
    r.status = terminal
    r.error = terminal === 'error' ? 'Startup failed' : undefined
    f.bridge.tick()
    assert.equal(f.cards.at(-1)?.status, 'failed')
    if (r.error) assert.equal(f.cards.at(-1)?.text, r.error)
    f.bridge.tick()
    assert.equal(f.cards.length, 2)
    f.bridge.stop()
  }
})
test('polling detaches a started run when its record disappears', () => {
  const f = setup()
  f.add()
  f.emit('started')
  f.records.delete('a')
  f.bridge.tick()
  assert.equal(f.cards.at(-1)?.status, 'failed')
  assert.match(f.cards.at(-1)!.text, /detached/)
  f.bridge.tick()
  assert.equal(f.cards.length, 2)
})
test('interleaved runs and resumed sessions use fresh IDs and exclude baseline', () => {
  const f = setup()
  const a = f.add()
  const b = f.add('b')
  f.emit('started')
  f.emit('started', 'b')
  const first = f.cards[0].runId
  a.session = { messages: [message('a text')] }
  b.session = { messages: [message('b text')] }
  f.bridge.tick()
  assert.equal(f.cards.at(-2)?.text, 'a text')
  assert.equal(f.cards.at(-1)?.text, 'b text')
  a.status = 'completed'
  f.emit('completed')
  a.status = 'running'
  a.startedAt = 101
  f.emit('started')
  assert.notEqual(f.cards.at(-1)?.runId, first)
  assert.equal(f.cards.at(-1)?.text, '')
  ;(a.session as { messages: unknown[] }).messages.push(message('new reply', 102))
  f.bridge.tick()
  assert.equal(f.cards.at(-1)?.text, 'new reply')
})
test('queued resume excludes previous output while startedAt still belongs to the old run', () => {
  for (const queuedStatus of ['queued', 'pending']) {
    const f = setup()
    const r = f.add()
    f.emit('started')
    const session = { messages: [message('previous reply', 101)] }
    r.session = session
    r.result = 'previous reply'
    r.status = 'completed'
    f.emit('completed')
    const firstRunId = f.cards.at(-1)!.runId
    r.status = queuedStatus
    r.result = undefined
    r.error = undefined
    f.emit('created')
    const queuedCard = f.cards.at(-1)!
    assert.notEqual(queuedCard.runId, firstRunId)
    assert.equal(queuedCard.status, 'pending')
    assert.equal(queuedCard.text, '')
    f.bridge.tick()
    assert.equal(f.cards.at(-1)?.text, '')
    r.status = 'running'
    r.startedAt = 200
    f.emit('started')
    session.messages.push(message('fresh reply', 200))
    f.bridge.tick()
    assert.equal(f.cards.at(-1)?.runId, queuedCard.runId)
    assert.equal(f.cards.at(-1)?.status, 'in_progress')
    assert.equal(f.cards.at(-1)?.text, 'fresh reply')
    f.bridge.stop()
  }
})
test('long descriptions produce wire-compatible bounded titles', () => {
  const f = setup()
  const r = f.add()
  f.emit('started', 'a', { description: 'x'.repeat(1000) })
  assert.equal(f.cards.at(-1)?.title.length, 512)
  assert.ok(f.cards.at(-1)?.title.startsWith('Explore: '))
  r.session = { messages: [message('visible output')] }
  f.bridge.tick()
  assert.equal(f.cards.at(-1)?.title.length, 512)
  assert.equal(f.cards.at(-1)?.text, 'visible output')
  const consumer = new SubagentCards()
  const first = consumer.update(f.snapshots[0])
  assert.ok(first?.sessionUpdate === 'tool_call')
  assert.equal(first.title, f.cards[0].title)
  assert.equal(first.status, 'in_progress')
  const update = consumer.update(f.snapshots[1])
  assert.ok(update?.sessionUpdate === 'tool_call_update')
  assert.equal(update.toolCallId, first.toolCallId)
  assert.equal(update.status, 'in_progress')
  assert.deepEqual(update.content, [{ type: 'content', content: { type: 'text', text: 'visible output' } }])
})
test('bounded snapshots carry explicit truncation notice', () => {
  const f = setup()
  const r = f.add()
  f.emit('started')
  r.session = { messages: [message('x'.repeat(MAX_TEXT * 3) + 'tail')] }
  f.bridge.tick()
  assert.equal(f.cards.at(-1)?.text.length, MAX_TEXT)
  assert.match(f.cards.at(-1)!.text, /truncated/)
  assert.ok(f.cards.at(-1)!.text.endsWith('tail'))
})
test('registry absence/incompatibility and non-root ownership never create cards', () => {
  const f = setup()
  f.emit('started')
  f.add().parentAgentId = 'parent'
  f.emit('created')
  f.add().workflowId = 'workflow'
  f.emit('started')
  globals[manager] = {
    getRecord() {
      throw new Error('incompatible')
    }
  }
  f.emit('started')
  delete globals[manager]
  f.emit('started')
  assert.equal(f.cards.length, 0)
})
test('duplicate activation cannot emit or tear down owner; shutdown detaches and allows reload', () => {
  const f = setup()
  const duplicate = new SubagentsBridge(f.pi, f.ctx, false)
  bridges.push(duplicate)
  assert.equal(duplicate.start(), false)
  f.add()
  f.emit('started')
  duplicate.stop()
  f.bridge.tick()
  assert.equal(f.cards.length, 1)
  f.bridge.stop()
  assert.equal(f.cards.at(-1)?.status, 'failed')
  assert.match(f.cards.at(-1)!.text, /detached/)
  assert.ok([...f.listeners.values()].every(s => s.size === 0))
  f.bridge.tick()
  assert.equal(f.cards.length, 2)
  assert.equal(duplicate.start(), true)
  f.emit('started')
  assert.equal(f.cards.length, 3)
})
