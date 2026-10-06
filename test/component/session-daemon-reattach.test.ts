import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { AgentRuntime } from '../../src/acp/runtime.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { bounded, createRpcChild, nextTick } from '../helpers/rpc-child.js'

function setup(t: { after: (fn: () => void) => void; mock: { method: typeof test.mock.method } }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-reattach-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const runtime = new AgentRuntime({ durable: true })
  const entries = new Map<string, { sessionId: string; cwd: string; sessionFile: string }>()
  entries.set('s1', { sessionId: 's1', cwd: root, sessionFile: join(root, 's1.jsonl') })
  Object.defineProperty(runtime, 'store', {
    value: {
      get: (id: string) => entries.get(id) ?? null,
      upsert: () => {},
      delete: () => {}
    }
  })
  const children: ReturnType<typeof createRpcChild>[] = []
  t.mock.method(PiRpcProcess, 'spawn', async () => {
    const child = createRpcChild({ sessionId: 's1', exitOnKill: true })
    children.push(child)
    return child.proc
  })
  t.after(() => {
    runtime.sessions.disposeAll()
    for (const child of children) child.cleanup()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runtime, children }
}

const texts = (conn: FakeAgentSideConnection, kind: string) =>
  conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === kind)
    .map(u => ('content' in u && u.content && 'text' in u.content ? u.content.text : undefined))

test('daemon mode: a running turn survives disconnect and is replayed to the next client', async t => {
  const { root, runtime, children } = setup(t)
  const first = new FakeAgentSideConnection()
  const agent1 = new PiAcpAgent(asAgentConn(first), { runtime })
  await agent1.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
  const [child] = children
  assert.ok(child)

  void agent1.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
  await nextTick()
  child.send({ type: 'agent_start' })
  child.send({ type: 'message_start', message: { role: 'assistant', timestamp: 7, content: [] } })
  child.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } })
  child.send({
    type: 'tool_execution_start',
    toolCallId: 'tc',
    toolName: 'read',
    args: { path: join(root, 'a.txt') }
  })
  await nextTick()

  agent1.disconnect()
  await agent1.closeSession({ sessionId: 's1' })
  child.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } })
  await new Promise(resolve => setTimeout(resolve, 300))
  const session = runtime.sessions.maybeGet('s1')
  assert.ok(session, 'closing a busy session in daemon mode must keep it running')
  assert.equal(session.link.attached, null)
  assert.ok(!child.child.killed)
  const firstCount = first.updates.length

  const second = new FakeAgentSideConnection()
  const agent2 = new PiAcpAgent(asAgentConn(second), { runtime })
  const response = await bounded(agent2.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] }))
  assert.deepEqual(response._meta, { piAcp: { startupInfo: null, reattached: true } })
  assert.equal(children.length, 1, 'reattach must not spawn a new pi process')
  assert.equal(runtime.sessions.maybeGet('s1'), session)
  assert.equal(first.updates.length, firstCount, 'the detached client receives nothing more')

  assert.deepEqual(texts(second, 'agent_message_chunk'), ['Hello world'])
  assert.ok(second.updates.some(u => u.update.sessionUpdate === 'tool_call' && u.update.toolCallId === 'tc'))
  assert.ok(
    second.updates.some(
      u =>
        u.update.sessionUpdate === 'session_info_update' &&
        (u.update._meta as { piAcp?: { running?: boolean } })?.piAcp?.running === true
    )
  )

  child.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '!' } })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.deepEqual(texts(second, 'agent_message_chunk'), ['Hello world', '!'])
  assert.equal(first.updates.length, firstCount)
})

test('daemon mode: permission requests raised while detached go to the next client', async t => {
  const { root, runtime, children } = setup(t)
  const first = new FakeAgentSideConnection()
  const agent1 = new PiAcpAgent(asAgentConn(first), { runtime })
  await agent1.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
  const [child] = children
  assert.ok(child)
  agent1.disconnect()

  child.send({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', title: 'Proceed?' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(first.permissionRequests.length, 0)

  const second = new FakeAgentSideConnection()
  second.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'yes' } }
  const agent2 = new PiAcpAgent(asAgentConn(second), { runtime })
  await agent2.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
  for (let i = 0; i < 50 && !child.commands.some(c => c.type === 'extension_ui_response'); i++)
    await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(second.permissionRequests.length, 1)
  const answer = child.commands.find(c => c.type === 'extension_ui_response') as unknown as {
    id: string
    confirmed?: boolean
  }
  assert.deepEqual({ id: answer?.id, confirmed: answer?.confirmed }, { id: 'ui1', confirmed: true })
})

test('stdio mode: loadSession of an active session still restarts pi', async t => {
  const { root, children } = setup(t)
  const runtime = new AgentRuntime()
  Object.defineProperty(runtime, 'store', {
    value: {
      get: () => ({ sessionId: 's1', cwd: root, sessionFile: join(root, 's1.jsonl') }),
      upsert: () => {},
      delete: () => {}
    }
  })
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), { runtime })
  await agent.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
  await agent.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
  assert.equal(children.length, 2)
  assert.equal(children[0]?.child.killed, true)
  runtime.sessions.disposeAll()
})
