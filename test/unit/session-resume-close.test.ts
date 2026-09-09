import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { createRpcChild } from '../helpers/rpc-child.js'

test('stable session lifecycle capabilities are advertised', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const result = await agent.initialize({ protocolVersion: 1 })
  assert.deepEqual(result.agentCapabilities?.sessionCapabilities?.resume, {})
  assert.deepEqual(result.agentCapabilities?.sessionCapabilities?.close, {})
  assert.deepEqual(await agent.closeSession({ sessionId: 'unknown' }), {})
})

test('resume reuses active sessions without replay; close preserves persistence and is idempotent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const dir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(dir, { recursive: true })
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'resume-test', cwd: root, timestamp: '2026-06-16T00:00:00Z' }),
      JSON.stringify({ type: 'session_info', name: 'Stored title', timestamp: '2026-06-16T00:00:01Z' })
    ].join('\n') + '\n'
  )
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const internals = agent as unknown as { sessions: SessionManager; store: SessionStore }
  const entries = new Map<string, { sessionId: string; cwd: string; sessionFile: string }>()
  entries.set('resume-test', { sessionId: 'resume-test', cwd: root, sessionFile })
  Object.defineProperty(agent, 'store', {
    value: {
      get: (id: string) => entries.get(id),
      upsert: (entry: { sessionId: string; cwd: string; sessionFile: string }) => entries.set(entry.sessionId, entry)
    }
  })
  const children: ReturnType<typeof createRpcChild>[] = []
  t.mock.method(PiRpcProcess, 'spawn', async (params: Parameters<typeof PiRpcProcess.spawn>[0]) => {
    assert.equal(params.sessionPath, sessionFile)
    const child = createRpcChild({ exitOnKill: true })
    children.push(child)
    return child.proc
  })
  try {
    const params = { sessionId: 'resume-test', cwd: root, mcpServers: [] }
    const response = await agent.resumeSession(params)
    assert.ok(response.configOptions?.length)
    assert.ok(response.modes)
    assert.deepEqual(response._meta, { piAcp: { startupInfo: null } })
    const session = internals.sessions.maybeGet(params.sessionId)
    assert.ok(session)
    assert.equal(session.proc, children[0].proc)
    await agent.resumeSession(params)
    assert.equal(internals.sessions.maybeGet(params.sessionId), session)
    assert.equal(children.length, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(conn.updates.some(u => u.update.sessionUpdate === 'available_commands_update'))
    assert.ok(
      conn.updates.some(u => u.update.sessionUpdate === 'session_info_update' && u.update.title === 'Stored title')
    )
    assert.ok(
      !conn.updates.some(
        u => u.update.sessionUpdate === 'user_message_chunk' || u.update.sessionUpdate === 'agent_message_chunk'
      )
    )
    assert.ok(!children[0].commands.some(c => c.type === 'get_messages'))
    assert.deepEqual(await agent.closeSession(params), {})
    assert.ok(children[0].commands.some(c => c.type === 'abort'))
    assert.equal(children[0].child.killed, true)
    assert.equal(internals.sessions.maybeGet(params.sessionId), undefined)
    assert.deepEqual(await agent.closeSession(params), {})
    assert.ok(existsSync(sessionFile))
    assert.ok(entries.has(params.sessionId))
    await agent.resumeSession(params)
    assert.equal(children.length, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    const restored = internals.sessions.maybeGet(params.sessionId)
    assert.ok(restored)
    t.mock.method(restored, 'cancel', async () => {
      throw new Error('abort failed')
    })
    assert.deepEqual(await agent.closeSession(params), {})
    assert.equal(children[1].child.killed, true)
    await assert.rejects(agent.resumeSession({ ...params, sessionId: 'unknown' }), { code: -32602 })
    await assert.rejects(agent.resumeSession({ ...params, cwd: 'relative' }), { code: -32602 })
  } finally {
    agent.dispose()
    for (const child of children) child.cleanup()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
