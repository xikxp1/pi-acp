import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import {
  additionalDirectoriesSystemPrompt,
  normalizeAdditionalDirectories,
  sameDirectories
} from '../../src/acp/additional-directories.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('normalizeAdditionalDirectories validates, dedupes, and drops cwd', () => {
  assert.deepEqual(normalizeAdditionalDirectories(undefined, '/repo'), [])
  assert.deepEqual(normalizeAdditionalDirectories([], '/repo'), [])
  assert.deepEqual(normalizeAdditionalDirectories(['/repo', '/a', '/a/', '/b'], '/repo'), ['/a', '/b'])
  assert.throws(
    () => normalizeAdditionalDirectories(['relative'], '/repo'),
    (err: any) => err.code === -32602
  )
})

test('sameDirectories compares ordered lists', () => {
  assert.ok(sameDirectories([], []))
  assert.ok(sameDirectories(['/a', '/b'], ['/a', '/b']))
  assert.ok(!sameDirectories(['/a', '/b'], ['/b', '/a']))
  assert.ok(!sameDirectories(['/a'], []))
})

test('additionalDirectoriesSystemPrompt lists roots or is undefined', () => {
  assert.equal(additionalDirectoriesSystemPrompt([]), undefined)
  const text = additionalDirectoriesSystemPrompt(['/a', '/b'])!
  assert.match(text, /workspace roots/)
  assert.match(text, /- \/a\n- \/b$/)
})

test('SessionStore persists additionalDirectories and keeps them when omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-store-'))
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 's', cwd: '/repo', sessionFile: '/f.jsonl', additionalDirectories: ['/a'] })
  assert.deepEqual(store.get('s')?.additionalDirectories, ['/a'])
  assert.deepEqual(new SessionStore(join(root, 'map.json')).get('s')?.additionalDirectories, ['/a'])
  store.upsert({ sessionId: 's', cwd: '/repo', sessionFile: '/f.jsonl' })
  assert.deepEqual(store.get('s')?.additionalDirectories, ['/a'])
  store.upsert({ sessionId: 's', cwd: '/repo', sessionFile: '/f.jsonl', additionalDirectories: [] })
  assert.equal(store.get('s')?.additionalDirectories, undefined)
})

function setupSessionsDir() {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-adddirs-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, '0000_source.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-1',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n'
  )
  return { root, sessionFile }
}

function fakeSpawn(spawned: any[]) {
  return async (params: any) => {
    spawned.push(params)
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium', sessionId: 'new-1', sessionFile: '/tmp/new.jsonl' }),
      getCommands: async () => ({ commands: [] }),
      dispose: () => {}
    } as any
  }
}

test('new sessions expose and persist roots without requiring client filesystem capabilities', async t => {
  const { root } = setupSessionsDir()
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const spawned: Parameters<typeof PiRpcProcess.spawn>[0][] = []
  t.mock.method(PiRpcProcess, 'spawn', fakeSpawn(spawned))
  const manager = new SessionManager()
  try {
    const session = await manager.create({
      cwd: '/tmp/project',
      mcpServers: [],
      additionalDirectories: ['/tmp/lib'],
      conn: asAgentConn(new FakeAgentSideConnection())
    })
    assert.equal(spawned[0].env?.PI_ACP_ADDITIONAL_DIRECTORIES, '["/tmp/lib"]')
    assert.deepEqual(new SessionStore().get(session.sessionId)?.additionalDirectories, ['/tmp/lib'])
  } finally {
    manager.disposeAll()
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: initialize advertises additionalDirectories; load/fork pass roots to pi', async () => {
  const { root } = setupSessionsDir()
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  const spawned: any[] = []
  ;(PiRpcProcess as any).spawn = fakeSpawn(spawned)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new SessionStore(join(root, 'map.json'))

    const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.additionalDirectories, {})

    await agent.loadSession({
      sessionId: 'sess-1',
      cwd: '/tmp/project',
      mcpServers: [],
      additionalDirectories: ['/tmp/lib', '/tmp/project']
    } as any)
    assert.equal(spawned.length, 1)
    assert.match(spawned[0].appendSystemPrompt, /- \/tmp\/lib$/)
    assert.equal(spawned[0].env.PI_ACP_ADDITIONAL_DIRECTORIES, '["/tmp/lib"]')
    assert.doesNotMatch(spawned[0].appendSystemPrompt, /\/tmp\/project/)

    // session/list reports the stored roots.
    const listed = await agent.listSessions({ cwd: '/tmp/project' } as any)
    assert.deepEqual(listed.sessions.find(s => s.sessionId === 'sess-1')?.additionalDirectories, ['/tmp/lib'])

    // Fork inherits nothing implicitly; the request list is authoritative.
    const fork = await agent.unstable_forkSession({
      sessionId: 'sess-1',
      cwd: '/tmp/project',
      mcpServers: [],
      additionalDirectories: ['/tmp/other']
    } as any)
    assert.equal(spawned.length, 2)
    assert.match(spawned[1].appendSystemPrompt, /- \/tmp\/other$/)
    assert.equal(spawned[1].env.PI_ACP_ADDITIONAL_DIRECTORIES, '["/tmp/other"]')
    assert.ok(fork.sessionId)

    // Without roots, no prompt addendum is passed and inherited roots are cleared.
    await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [] } as any)
    assert.equal(spawned.length, 3)
    assert.equal(spawned[2].appendSystemPrompt, undefined)
    assert.equal(spawned[2].env.PI_ACP_ADDITIONAL_DIRECTORIES, '[]')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: resume reuses the process for same roots and restarts pi when roots change', async () => {
  const { root } = setupSessionsDir()
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  const spawned: any[] = []
  ;(PiRpcProcess as any).spawn = fakeSpawn(spawned)

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    ;(agent as any).store = new SessionStore(join(root, 'map.json'))

    const resume = (additionalDirectories?: string[]) =>
      agent.resumeSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], additionalDirectories } as any)

    await resume(['/tmp/lib'])
    assert.equal(spawned.length, 1)

    await resume(['/tmp/lib'])
    assert.equal(spawned.length, 1)

    await resume(['/tmp/lib', '/tmp/extra'])
    assert.equal(spawned.length, 2)
    assert.match(spawned[1].appendSystemPrompt, /- \/tmp\/lib\n- \/tmp\/extra$/)
    assert.equal(spawned[1].env.PI_ACP_ADDITIONAL_DIRECTORIES, '["/tmp/lib","/tmp/extra"]')

    // Omitting the field means "no roots" per spec and therefore restarts again.
    await resume()
    assert.equal(spawned.length, 3)
    assert.equal(spawned[2].appendSystemPrompt, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
