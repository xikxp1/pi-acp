import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class TitleProcess extends FakePiRpcProcess {
  readonly names: string[] = []

  async setSessionName(name: string): Promise<void> {
    this.names.push(name)
  }
}

function fixture(t: TestContext, title?: string | null) {
  const conn = new FakeAgentSideConnection()
  const proc = new TitleProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    title
  })
  t.after(() => session.dispose())
  return { conn, proc, session }
}

function titles(conn: FakeAgentSideConnection): string[] {
  return conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'session_info_update' && typeof update.title === 'string' ? [update.title] : []
  )
}

function userMessage(proc: FakePiRpcProcess, content: unknown, type = 'message_start') {
  proc.emit({ type, message: { role: 'user', content } })
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const flush = (session: PiAcpSession) => (session as unknown as { flushEmits(): Promise<void> }).flushEmits()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

test('live titles: forward idle Pi renames immediately and suppress duplicate/invalid events', async t => {
  const { conn, proc, session } = fixture(t)
  proc.emit({ type: 'session_info_changed', name: '  Extension title  ' })
  proc.emit({ type: 'session_info_changed', name: 'Extension title' })
  for (const name of [undefined, null, 123, {}, '', ' \n\t ']) {
    proc.emit({ type: 'session_info_changed', name })
  }
  await flush(session)
  assert.deepEqual(titles(conn), ['Extension title'])
  const update = conn.updates[0].update
  assert.equal(update.sessionUpdate, 'session_info_update')
  if (update.sessionUpdate === 'session_info_update') assert.ok(Number.isFinite(Date.parse(update.updatedAt!)))
  proc.emit({ type: 'session_info_changed', name: 'Second title' })
  proc.emit({ type: 'session_info_changed', name: 'Extension title' })
  await flush(session)
  assert.deepEqual(titles(conn), ['Extension title', 'Second title', 'Extension title'])
})

test('live titles: first accepted user message publishes despite startup banner and before turn completion', async t => {
  const { conn, proc, session } = fixture(t)
  session.setStartupInfo('Startup banner')
  session.sendStartupInfoIfPending()
  const turn = session.prompt('First task')
  userMessage(proc, ' First\n task ')
  await flush(session)
  assert.deepEqual(titles(conn), ['First task'])
  assert.equal(conn.updates[0].update.sessionUpdate, 'agent_message_chunk')
  userMessage(proc, 'First task', 'message_end')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(titles(conn), ['First task'])
  assert.deepEqual(proc.names, [])
})

test('live titles: queued and later prompts cannot replace first-message preview', async t => {
  const { conn, proc, session } = fixture(t)
  const first = session.prompt('First task')
  const second = session.prompt('Queued task')
  userMessage(proc, 'First task')
  proc.emit({ type: 'agent_settled' })
  await first
  userMessage(proc, 'Queued task')
  proc.emit({ type: 'agent_settled' })
  await second
  assert.deepEqual(titles(conn), ['First task'])
})

test('live titles: fallback only considers usable user text and can use message_end', async t => {
  const { conn, proc, session } = fixture(t)
  for (const role of ['assistant', 'toolResult', 'custom', undefined]) {
    proc.emit({ type: 'message_start', message: { role, content: 'Not a user' } })
    proc.emit({ type: 'message_end', message: { role, content: 'Not a user' } })
  }
  for (const message of [undefined, null, 42, 'bad']) proc.emit({ type: 'message_start', message })
  for (const content of [undefined, null, [], [{ type: 'image' }], ' \n\t ']) userMessage(proc, content)
  await flush(session)
  assert.deepEqual(titles(conn), [])
  userMessage(
    proc,
    [{ type: 'text', text: ' Explain\n' }, { type: 'image' }, { type: 'text', text: '\tthis image ' }],
    'message_end'
  )
  await flush(session)
  assert.deepEqual(titles(conn), ['Explain this image'])
})

test('live titles: bounds preview at 80 Unicode code points without splitting surrogate pairs', async t => {
  const { conn, proc, session } = fixture(t)
  userMessage(proc, `${'中'.repeat(79)}😀 more`)
  await flush(session)
  assert.deepEqual(titles(conn), [`${'中'.repeat(79)}😀`])
})

for (const seed of [' Saved title ', null, ' \n ']) {
  test(`live titles: seeded title ${JSON.stringify(seed)} is published once and never overwritten by a prompt`, async t => {
    const { conn, proc, session } = fixture(t, seed)
    userMessage(proc, 'First task')
    userMessage(proc, 'First task', 'message_end')
    await flush(session)
    assert.deepEqual(titles(conn), [seed?.trim() || 'First task'])
  })
}

test('live titles: Pi names override fallback and remain untruncated', async t => {
  const { conn, proc, session } = fixture(t)
  userMessage(proc, 'First task')
  const name = 'Named  explicitly ' + '😀'.repeat(90)
  proc.emit({ type: 'session_info_changed', name })
  userMessage(proc, 'A later task')
  await flush(session)
  assert.deepEqual(titles(conn), ['First task', name])
})

test('live titles: explicit name arriving before first user message suppresses fallback', async t => {
  const { conn, proc, session } = fixture(t)
  proc.emit({ type: 'session_info_changed', name: 'Named by extension' })
  userMessage(proc, 'First task')
  await flush(session)
  assert.deepEqual(titles(conn), ['Named by extension'])
})

test('live titles: rejected prompts never acquire speculative titles', async t => {
  const { conn, proc, session } = fixture(t)
  proc.prompt = async () => {
    throw new Error('Rejected')
  }
  await assert.rejects(session.prompt('Not accepted'), /Rejected/)
  assert.deepEqual(titles(conn), [])
  assert.deepEqual(proc.names, [])
})

test('live titles: best-effort polling updates names but deduplicates events and never clears a title', async t => {
  const { conn, proc, session } = fixture(t)
  userMessage(proc, 'First task')
  for (const sessionName of [undefined, '', ' \n ']) {
    proc.getState = async () => ({ sessionName })
    await session.syncSessionName()
  }
  proc.getState = async () => {
    throw new Error('State unavailable')
  }
  await session.syncSessionName()
  proc.getState = async () => ({ sessionName: ' Polled name ' })
  await session.syncSessionName()
  proc.emit({ type: 'session_info_changed', name: 'Polled name' })
  await session.syncSessionName()
  assert.deepEqual(titles(conn), ['First task', 'Polled name'])
})

test('live titles: stale poll cannot overwrite a newer rename, even if that event repeats the current title', async t => {
  const { conn, proc, session } = fixture(t)
  proc.emit({ type: 'session_info_changed', name: 'Current name' })
  const state = deferred<Record<string, unknown>>()
  proc.getState = () => state.promise
  const polling = session.syncSessionName()
  proc.emit({ type: 'session_info_changed', name: 'Current name' })
  state.resolve({ sessionName: 'Stale name' })
  await polling
  await flush(session)
  assert.deepEqual(titles(conn), ['Current name'])
})

test('live titles: a polled explicit name still overrides a fallback created while polling', async t => {
  const { conn, proc, session } = fixture(t)
  const state = deferred<Record<string, unknown>>()
  proc.getState = () => state.promise
  const polling = session.syncSessionName()
  userMessage(proc, 'Fallback')
  state.resolve({ sessionName: 'Explicit name' })
  await polling
  assert.deepEqual(titles(conn), ['Fallback', 'Explicit name'])
})

test('live titles: /name RPC acknowledgement does not replay its name over a newer event', async t => {
  const { conn, proc, session } = fixture(t)
  const ack = deferred<void>()
  proc.setSessionName = async name => {
    proc.emit({ type: 'session_info_changed', name })
    await ack.promise
  }
  const setting = session.setSessionName('Requested name')
  proc.emit({ type: 'session_info_changed', name: 'Newer extension name' })
  ack.resolve()
  await setting
  assert.deepEqual(titles(conn), ['Requested name', 'Newer extension name'])
})

test('live titles: stale polling before a /name ACK cannot suppress the requested name', async t => {
  const { conn, proc, session } = fixture(t)
  await session.publishTitle('Old name')
  const state = deferred<Record<string, unknown>>()
  const ack = deferred<void>()
  proc.getState = () => state.promise
  proc.setSessionName = () => ack.promise
  const polling = session.syncSessionName()
  const setting = session.setSessionName('Requested name')
  state.resolve({ sessionName: 'Old name' })
  await polling
  ack.resolve()
  await setting
  assert.deepEqual(titles(conn), ['Old name', 'Requested name'])
})

test('live titles: /name ACK invalidates older polling still in flight', async t => {
  const { conn, proc, session } = fixture(t)
  const state = deferred<Record<string, unknown>>()
  proc.getState = () => state.promise
  const polling = session.syncSessionName()
  await session.setSessionName('Requested name')
  state.resolve({ sessionName: 'Old name' })
  await polling
  assert.deepEqual(titles(conn), ['Requested name'])
})

test('live titles: /name without a Pi event still publishes on success, never on failure', async t => {
  const { conn, proc, session } = fixture(t)
  await session.setSessionName('Requested name')
  proc.setSessionName = async () => {
    throw new Error('Name rejected')
  }
  await assert.rejects(session.setSessionName('Rejected name'), /Name rejected/)
  assert.deepEqual(titles(conn), ['Requested name'])
})

test('live titles: names stay ordered with coalesced deltas and prompt completion waits for delivery', async t => {
  const { conn, proc, session } = fixture(t)
  const blocked = deferred<void>()
  conn.sessionUpdate = async msg => {
    if (msg.update.sessionUpdate === 'session_info_update' && msg.update.title) await blocked.promise
    conn.updates.push(msg)
  }
  const turn = session.prompt('Task')
  let settled = false
  void turn.then(() => {
    settled = true
  })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Before' } })
  proc.emit({ type: 'session_info_changed', name: 'Live name' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'After' } })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(settled, false)
  assert.deepEqual(titles(conn), [])
  const before = conn.updates.find(({ update }) => update.sessionUpdate === 'agent_message_chunk')?.update
  assert.deepEqual(before, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before' } })
  blocked.resolve()
  assert.equal(await turn, 'end_turn')
  const order = conn.updates.flatMap(({ update }) => {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') return [update.content.text]
    if (update.sessionUpdate === 'session_info_update' && update.title) return [update.title]
    return []
  })
  assert.deepEqual(order, ['Before', 'Live name', 'After'])
})

test('live titles: delivery errors do not prevent later notifications or prompt completion', async t => {
  const { conn, proc, session } = fixture(t)
  conn.sessionUpdate = async msg => {
    if (msg.update.sessionUpdate === 'session_info_update' && msg.update.title === 'Fallback')
      throw new Error('Disconnected')
    conn.updates.push(msg)
  }
  const turn = session.prompt('Fallback')
  userMessage(proc, 'Fallback')
  proc.emit({ type: 'session_info_changed', name: 'New title' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(titles(conn), ['New title'])
})

test('live titles: disposal ignores late events and in-flight polling', async t => {
  const { conn, proc, session } = fixture(t)
  const state = deferred<Record<string, unknown>>()
  proc.getState = () => state.promise
  const polling = session.syncSessionName()
  session.dispose()
  proc.emit({ type: 'session_info_changed', name: 'Late event' })
  userMessage(proc, 'Late fallback')
  state.resolve({ sessionName: 'Late snapshot' })
  await polling
  await session.publishTitle('Late explicit publication')
  assert.deepEqual(titles(conn), [])
})

test('live titles: reconnect can republish the current title without changing its fallback guard', async t => {
  const { conn, proc, session } = fixture(t, 'Saved title')
  await session.publishTitle()
  await session.publishTitle()
  await session.publishTitle(undefined, { force: true })
  userMessage(proc, 'Later prompt')
  await flush(session)
  assert.deepEqual(titles(conn), ['Saved title', 'Saved title'])
})

test('live titles: session creation seeds a name already present in Pi state', async t => {
  const conn = new FakeAgentSideConnection()
  const proc = new TitleProcess()
  proc.getState = async () => ({ sessionId: 's1', sessionName: 'Startup name' })
  t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
  const manager = new SessionManager()
  t.after(() => manager.disposeAll())
  const session = await manager.create({ cwd: process.cwd(), mcpServers: [], conn: asAgentConn(conn) })
  userMessage(proc, 'First task')
  await flush(session)
  assert.deepEqual(titles(conn), ['Startup name'])
})
