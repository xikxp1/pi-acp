import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { listPiSessions, readPiSessionBranch } from '../../src/acp/pi-sessions.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SubagentSessions, SUBAGENT_CAPABILITY, SUBAGENT_INFO } from '../../src/acp/subagent-sessions.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { bounded, nextTick } from '../helpers/rpc-child.js'

function parentHistory(data: object) {
  return (
    [
      {
        type: 'message',
        id: 'call',
        parentId: null,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'delegate', name: 'subagent', arguments: { task: 'Review' } }]
        }
      },
      { type: 'custom', id: 'registration', parentId: 'call', customType: 'pi-subagent-session', data }
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n'
  )
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-native-subagents-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const conn = new FakeAgentSideConnection()
  const registry = new SubagentSessions(asAgentConn(conn), join(directory, 'adapter'))
  registry.enabled = true
  const run = (parentToolCallId = 'delegate') => {
    const runId = randomUUID()
    const root = join(directory, runId)
    mkdirSync(root)
    const data = {
      version: 2,
      runId,
      parentToolCallId,
      parentPiSessionId: 'parent',
      title: 'Review code',
      sessionFile: join(root, 'session.jsonl'),
      eventsFile: join(root, 'events.jsonl'),
      outputFile: join(root, 'output.txt')
    }
    const registration = { ...data, type: 'register', cancelFile: join(root, `cancel-${randomUUID()}`) }
    const childId = `pi-child-${runId}`
    const journal: unknown[] = []
    let sequence = 0
    const receive = (event: object) => registry.receive('parent', directory, JSON.stringify(event), () => true)
    const event = (event: object) => {
      const envelope = { version: 2, type: 'event', runId, sequence: sequence++, event }
      journal.push(envelope)
      writeFileSync(data.eventsFile, journal.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      receive(envelope)
      return envelope
    }
    const status = (status: string) => {
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...data, status }))
      receive({ version: 2, type: 'status', runId, status })
    }
    return { data, registration, childId, event, status, receive, root }
  }
  return { directory, conn, registry, run }
}

for (const capability of [undefined, true, { version: '1' }, { version: 2 }, { version: 1 }]) {
  test(`native subagents negotiate only version 1: ${JSON.stringify(capability)}`, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { _meta: { [SUBAGENT_CAPABILITY]: capability } }
    })
    assert.deepEqual(
      response.agentCapabilities?._meta?.[SUBAGENT_CAPABILITY],
      capability && typeof capability === 'object' && capability.version === 1 ? { version: 1 } : undefined
    )
    agent.dispose()
  })
}

test('original parent tool links a registered inspect-only child; live load never spawns or prompts', async t => {
  const { directory, conn, registry, run } = fixture(t)
  const child = run()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'parent',
    cwd: directory,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as unknown as PiRpcProcess,
    subagentSessions: registry
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'subagentSessions', { value: registry })
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => {
    throw new Error('A child inspection must never spawn Pi')
  }
  t.after(() => {
    PiRpcProcess.spawn = originalSpawn
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'delegate',
    toolName: 'subagent',
    args: { description: 'Review code' }
  })
  proc.emit({
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'pi-acp:subagent-session',
    statusText: JSON.stringify(child.registration)
  })
  child.event({ type: 'message_end', message: { role: 'user', content: 'Task' } })
  child.event({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' }
  })
  await nextTick()
  assert.ok(conn.updates.every(update => update.sessionId === 'parent'))
  const calls = conn.updates.filter(({ update }) => update.sessionUpdate === 'tool_call')
  assert.equal(calls.length, 1)
  const link = conn.updates.find(({ update }) => update._meta?.subagent_session_info)
  assert.deepEqual(link?.update._meta?.subagent_session_info, { session_id: child.childId, message_start_index: 0 })
  await agent.loadSession({ sessionId: child.childId, cwd: directory, mcpServers: [] })
  child.status('completed')
  await nextTick()
  assert.equal(
    conn.updates.filter(
      update => update.sessionId === child.childId && update.update.sessionUpdate === 'agent_message_chunk'
    ).length,
    1
  )
  await assert.rejects(
    agent.prompt({ sessionId: child.childId, prompt: [{ type: 'text', text: 'Run' }] }),
    /inspect-only/
  )
  await assert.rejects(agent.setSessionMode({ sessionId: child.childId, modeId: 'high' }), /inspect-only/)
  assert.equal(proc.prompts.length, 0)
  assert.equal(proc.abortCount, 0)
})

test('load queues replay before concurrent live events, de-duplicates sequence and final messages, and close only unsubscribes', async t => {
  const { conn, registry, run } = fixture(t)
  const child = run()
  child.receive(child.registration)
  child.status('in_progress')
  child.event({ type: 'message_end', message: { role: 'user', content: 'Task' } })
  const first = child.event({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'one ' }
  })
  child.receive(first)
  let release!: () => void
  let started!: () => void
  const block = new Promise<void>(resolve => {
    release = resolve
  })
  const entered = new Promise<void>(resolve => {
    started = resolve
  })
  const send = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async update => {
    await send(update)
    if (update.update.sessionUpdate === 'user_message_chunk') {
      started()
      await block
    }
  }
  const loading = registry.load(child.childId)
  await bounded(entered)
  const repeatedLoad = registry.load(child.childId)
  child.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'two' } })
  child.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'one two' }] } })
  child.status('completed')
  release()
  await bounded(Promise.all([loading, repeatedLoad]))
  await nextTick()
  const text = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  )
  assert.deepEqual(text, ['one ', 'two'])
  assert.deepEqual(conn.updates.at(-1)?.update._meta?.[SUBAGENT_INFO], {
    parent_session_id: 'parent',
    parent_tool_call_id: 'delegate',
    status: 'completed'
  })
  registry.close(child.childId)
  assert.equal(existsSync(child.registration.cancelFile), false)
  conn.updates.length = 0
  await registry.load(child.childId)
  assert.deepEqual(
    conn.updates.flatMap(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
    ),
    ['one ', 'two']
  )
})

for (const terminalStatus of ['completed', 'failed']) {
  for (const cold of [false, true]) {
    test(`terminal child replay ends after the final marker: ${terminalStatus}, cold=${cold}`, async t => {
      const { registry, run, conn, directory } = fixture(t)
      const child = run()
      child.receive(child.registration)
      child.event({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL_MARKER' }] }
      })
      child.status(terminalStatus)
      const opened = cold ? new SubagentSessions(asAgentConn(conn), join(directory, 'adapter')) : registry
      opened.enabled = true
      await opened.load(child.childId)
      const statuses = conn.updates.flatMap(({ update }) => {
        const info = update._meta?.[SUBAGENT_INFO] as { status: string } | undefined
        return info ? [info.status] : []
      })
      assert.deepEqual(statuses, ['in_progress', terminalStatus])
      const firstTerminal = conn.updates.findIndex(
        ({ update }) => (update._meta?.[SUBAGENT_INFO] as { status?: string })?.status === terminalStatus
      )
      assert.ok(
        conn.updates
          .slice(0, firstTerminal)
          .some(
            ({ update }) =>
              update.sessionUpdate === 'agent_message_chunk' &&
              update.content.type === 'text' &&
              update.content.text === 'FINAL_MARKER'
          )
      )
      opened.cancel(child.childId)
      child.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'LATE' }] } })
      child.status('in_progress')
      await nextTick()
      assert.equal(existsSync(child.registration.cancelFile), false)
      assert.equal(conn.updates.length, firstTerminal + 1)
    })
  }
}

for (const failingDelivery of [1, 2, 3]) {
  test(`child load rejects replay delivery ${failingDelivery} and reopens cleanly`, async t => {
    const { registry, run, conn } = fixture(t)
    const child = run()
    child.receive(child.registration)
    child.event({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL_MARKER' }] }
    })
    child.status('completed')
    const send = conn.sessionUpdate.bind(conn)
    let deliveries = 0
    conn.sessionUpdate = async update => {
      if (++deliveries === failingDelivery) throw new Error('Replay transport failed')
      await send(update)
    }
    await assert.rejects(registry.load(child.childId), /Replay transport failed/)
    await nextTick()
    conn.updates.length = 0
    conn.sessionUpdate = send
    await registry.load(child.childId)
    assert.equal(conn.updates.length, 3)
    assert.equal(conn.updates[1].update.sessionUpdate, 'agent_message_chunk')
    assert.equal((conn.updates.at(-1)?.update._meta?.[SUBAGENT_INFO] as { status: string }).status, 'completed')
  })
}

test('closing a blocked replay allows an independent reopen without poisoning its queue', async t => {
  const { registry, run, conn } = fixture(t)
  const child = run()
  child.receive(child.registration)
  child.event({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL_MARKER' }] }
  })
  child.status('completed')
  const send = conn.sessionUpdate.bind(conn)
  let reject!: (error: Error) => void
  conn.sessionUpdate = () =>
    new Promise<void>((_resolve, fail) => {
      reject = fail
    })
  const first = registry.load(child.childId)
  const rejected = assert.rejects(first, /Disconnected/)
  await nextTick()
  registry.close(child.childId)
  conn.sessionUpdate = send
  await bounded(registry.load(child.childId))
  reject(new Error('Disconnected'))
  await rejected
  assert.equal(conn.updates.length, 3)
})

test('structured child tool events render a single tool with args, locations and final output', async t => {
  const { conn, registry, run } = fixture(t)
  const child = run()
  child.receive(child.registration)
  const call = { id: 'read-file', name: 'read', arguments: { path: '/tmp/file' } }
  child.event({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: call } })
  child.event({ type: 'message_end', message: { role: 'assistant', content: [{ ...call, type: 'toolCall' }] } })
  child.event({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments })
  const result = { content: [{ type: 'text', text: 'File contents' }] }
  child.event({
    type: 'tool_execution_update',
    toolCallId: call.id,
    toolName: call.name,
    partialResult: { content: [{ type: 'text', text: 'Reading' }] }
  })
  child.event({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError: false })
  child.event({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: call.id, toolName: call.name, ...result }
  })
  child.status('completed')
  await registry.load(child.childId)
  const tools = conn.updates.map(({ update }) => update).filter(update => 'toolCallId' in update)
  assert.equal(tools.filter(update => update.sessionUpdate === 'tool_call').length, 1)
  assert.equal(tools.filter(update => 'status' in update && update.status === 'completed').length, 1)
  assert.deepEqual(tools[0].rawInput, call.arguments)
  assert.deepEqual(tools[0].locations, [{ path: '/tmp/file' }])
  assert.deepEqual(tools.at(-1)?.content, [{ type: 'content', content: { type: 'text', text: 'File contents' } }])
})

test('restart restores exact child transcript and original parent link from custom entry or tool details', async t => {
  const { directory, conn, run } = fixture(t)
  const child = run()
  child.receive(child.registration)
  child.event({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Persisted answer' }] }
  })
  child.status('completed')
  const restarted = new SubagentSessions(asAgentConn(conn), join(directory, 'adapter'))
  restarted.enabled = true
  await restarted.load(child.childId)
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text === 'Persisted answer'
    )
  )
  assert.equal(readFileSync(join(directory, 'adapter', `${child.childId}.json`), 'utf8').includes('cancel-'), false)
  const parentFile = join(directory, 'parent.jsonl')
  writeFileSync(parentFile, parentHistory(child.data))
  const proc = new FakePiRpcProcess()
  proc.getMessages = async () => ({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'delegate', name: 'subagent', arguments: { task: 'Review' } }]
      },
      {
        role: 'toolResult',
        toolName: 'subagent',
        toolCallId: 'delegate',
        details: { subagentSession: child.data },
        content: [{ type: 'text', text: 'Answer' }]
      }
    ]
  })
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess
  t.after(() => {
    PiRpcProcess.spawn = originalSpawn
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'subagentSessions', { value: restarted })
  Object.defineProperty(agent, 'store', {
    value: { get: () => ({ cwd: directory, sessionFile: parentFile }), upsert: () => {} }
  })
  await agent.loadSession({ sessionId: 'parent', cwd: directory, mcpServers: [] })
  const parentTools = conn.updates.filter(
    ({ sessionId, update }) => sessionId === 'parent' && update.sessionUpdate === 'tool_call'
  )
  assert.equal(parentTools.length, 1)
  assert.deepEqual(parentTools[0].update._meta?.subagent_session_info, {
    session_id: child.childId,
    message_start_index: 0
  })
  agent.dispose()
})

test('interrupted child links survive without a final parent tool result', async t => {
  const { registry, run, directory, conn } = fixture(t)
  const child = run()
  child.status('in_progress')
  const parentFile = join(directory, 'parent.jsonl')
  writeFileSync(parentFile, parentHistory(child.data))
  const proc = new FakePiRpcProcess()
  proc.getMessages = async () => ({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'delegate', name: 'subagent', arguments: { task: 'Review' } }]
      }
    ]
  })
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess
  t.after(() => {
    PiRpcProcess.spawn = originalSpawn
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'subagentSessions', { value: registry })
  Object.defineProperty(agent, 'store', {
    value: { get: () => ({ cwd: directory, sessionFile: parentFile }), upsert: () => {} }
  })
  await agent.loadSession({ sessionId: 'parent', cwd: directory, mcpServers: [] })
  const call = conn.updates.find(({ update }) => update.sessionUpdate === 'tool_call')?.update
  assert.ok(call && call.sessionUpdate === 'tool_call')
  assert.equal(call.status, 'failed')
  assert.deepEqual(call._meta?.subagent_session_info, { session_id: child.childId, message_start_index: 0 })
  agent.dispose()
})

test('child cancellation is isolated, idempotent and not restored from stale metadata; parent failure finalizes children', async t => {
  const { registry, run, directory, conn } = fixture(t)
  const first = run('first')
  const second = run('second')
  first.receive(first.registration)
  second.receive(second.registration)
  registry.close(first.childId)
  registry.cancel(first.childId)
  registry.cancel(first.childId)
  assert.equal(existsSync(first.registration.cancelFile), true)
  assert.equal(existsSync(second.registration.cancelFile), false)
  const restarted = new SubagentSessions(asAgentConn(conn), join(directory, 'adapter'))
  restarted.enabled = true
  await restarted.load(second.childId)
  restarted.cancel(second.childId)
  assert.equal(existsSync(second.registration.cancelFile), false)
  registry.failParent('parent')
  await registry.load(first.childId)
  assert.equal((conn.updates.at(-1)?.update._meta?.[SUBAGENT_INFO] as { status: string }).status, 'failed')
})

test('live delivery failure is observed without poisoning a later child replay', async t => {
  const { registry, run, conn } = fixture(t)
  const child = run()
  child.receive(child.registration)
  await registry.load(child.childId)
  const send = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async () => {
    throw new Error('Live transport failed')
  }
  child.event({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Retained output' }] }
  })
  await nextTick()
  child.status('completed')
  conn.updates.length = 0
  conn.sessionUpdate = send
  await registry.load(child.childId)
  assert.equal(conn.updates.length, 3)
  assert.equal(conn.updates[1].update.sessionUpdate, 'agent_message_chunk')
})

test('persisted branch validation rejects cycles, duplicate IDs and missing parents', t => {
  const { directory } = fixture(t)
  const file = join(directory, 'invalid.jsonl')
  for (const entries of [
    [{ id: 'self', parentId: 'self' }],
    [
      { id: 'duplicate', parentId: null },
      { id: 'duplicate', parentId: null }
    ],
    [{ id: 'orphan', parentId: 'missing' }],
    [{ id: 'invalid', parentId: 42 }]
  ]) {
    writeFileSync(file, entries.map(entry => JSON.stringify({ type: 'custom', ...entry })).join('\n'))
    assert.throws(() => readPiSessionBranch(file), /Pi session tree/)
  }
  writeFileSync(file, JSON.stringify({ type: 'message', id: 'valid', parentId: null }) + '\n{"interrupted":')
  assert.equal(readPiSessionBranch(file).length, 1)
})

test('malformed, unowned and unnegotiated registrations cannot create native links', async t => {
  const { registry, run, directory } = fixture(t)
  const child = run()
  for (const patch of [
    { version: 1 },
    { runId: '../../bad' },
    { sessionFile: '/tmp/other.jsonl' },
    { cancelFile: '/tmp/arbitrary' },
    { parentToolCallId: '' },
    { title: null },
    { parentPiSessionId: 'bad\0id' }
  ]) {
    assert.equal(
      registry.receive('parent', directory, JSON.stringify({ ...child.registration, ...patch }), () => true),
      undefined
    )
  }
  assert.equal(
    registry.receive('parent', directory, JSON.stringify(child.registration), () => false),
    undefined
  )
  registry.enabled = false
  assert.equal(child.receive(child.registration), undefined)
  await assert.rejects(registry.load(child.childId), /not negotiated/)
})

test('child histories are hidden from root listing even when custom sessionDir contains them', t => {
  const { directory, run } = fixture(t)
  const child = run()
  const original = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = directory
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = original
  })
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ sessionDir: directory }))
  writeFileSync(
    child.data.sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: child.data.runId,
      cwd: directory,
      piSubagent: true,
      timestamp: new Date().toISOString()
    }) + '\n'
  )
  writeFileSync(
    join(directory, 'root.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'root', cwd: directory, timestamp: new Date().toISOString() }) +
      '\n'
  )
  assert.deepEqual(
    listPiSessions().map(session => session.sessionId),
    ['root']
  )
})

test('sequence gaps fail visibly; late output and statuses cannot reopen a terminal child', async t => {
  const { registry, run, conn } = fixture(t)
  const child = run()
  child.receive(child.registration)
  child.receive({
    version: 2,
    type: 'event',
    runId: child.data.runId,
    sequence: 2,
    event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'lost' }] } }
  })
  child.status('in_progress')
  child.status('completed')
  await registry.load(child.childId)
  assert.equal((conn.updates.at(-1)?.update._meta?.[SUBAGENT_INFO] as { status: string }).status, 'failed')
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text.includes('gap')
    )
  )
  assert.ok(
    !conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text === 'lost'
    )
  )
})

test('forked parent history cannot reparent an existing or previously unindexed child', t => {
  const { registry, run, directory } = fixture(t)
  const child = run()
  child.receive(child.registration)
  assert.equal(registry.restoreLink('fork', directory, 'delegate', child.data), undefined)
  const unindexed = run()
  assert.equal(
    registry.restoreLink('fork', directory, 'delegate', { ...unindexed.data, parentPiSessionId: 'parent' }),
    undefined
  )
  assert.equal(
    registry.restoreLink('fork', directory, 'delegate', { ...unindexed.data, parentPiSessionId: undefined }),
    undefined
  )
  assert.ok(registry.link('parent', 'delegate'))
})

test('missing child event journal falls back to real Pi history, never a new process', async t => {
  const { registry, run, conn } = fixture(t)
  const child = run()
  writeFileSync(
    child.data.sessionFile,
    [
      { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Task' } },
      {
        type: 'message',
        id: 'abandoned',
        parentId: 'root',
        message: { role: 'assistant', content: [{ type: 'text', text: 'UNSELECTED' }] }
      },
      {
        type: 'message',
        id: 'answer',
        parentId: 'root',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Real Pi history' }] }
      }
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n'
  )
  child.status('completed')
  registry.restoreLink('parent', child.root, 'delegate', child.data)
  await registry.load(child.childId)
  assert.ok(!JSON.stringify(conn.updates).includes('UNSELECTED'))
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text === 'Real Pi history'
    )
  )
})
