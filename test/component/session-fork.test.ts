import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { forkPiSessionFile, listPiSessions } from '../../src/acp/pi-sessions.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

const entries = [
  JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-1',
    timestamp: '2026-02-11T00:00:00.000Z',
    cwd: '/tmp/project'
  }),
  JSON.stringify({
    type: 'message',
    id: 'a1',
    parentId: null,
    timestamp: '2026-02-11T00:00:01.000Z',
    message: { role: 'user', content: 'Hello' }
  }),
  JSON.stringify({
    type: 'session_info',
    id: 'c3',
    parentId: 'a1',
    timestamp: '2026-02-11T00:00:03.000Z',
    name: 'Named'
  })
]

function setupSessionsDir() {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, '0000_source.jsonl')
  writeFileSync(sessionFile, entries.join('\n') + '\n')
  return { root, sessionFile }
}

function withAgentDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  return fn().finally(() => {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  })
}

test('forkPiSessionFile copies entries under a fresh header id next to the source', () => {
  const { root, sessionFile } = setupSessionsDir()
  const forked = forkPiSessionFile(sessionFile, '/tmp/other')

  assert.notEqual(forked.sessionId, 'sess-1')
  assert.equal(dirname(forked.sessionFile), dirname(sessionFile))
  assert.ok(forked.sessionFile.endsWith(`_${forked.sessionId}.jsonl`))

  const lines = readFileSync(forked.sessionFile, 'utf8').split('\n')
  const header = JSON.parse(lines[0]!)
  assert.equal(header.type, 'session')
  assert.equal(header.id, forked.sessionId)
  assert.equal(header.cwd, '/tmp/other')
  assert.equal(header.parentSession, sessionFile)
  assert.deepEqual(lines.slice(1), entries.slice(1).concat(['']))

  // Source is untouched.
  assert.equal(readFileSync(sessionFile, 'utf8'), entries.join('\n') + '\n')
  assert.equal(readdirSync(dirname(sessionFile)).length, 2)

  return withAgentDir(root, async () => {
    const ids = listPiSessions().map(s => s.sessionId)
    assert.ok(ids.includes('sess-1'))
    assert.ok(ids.includes(forked.sessionId))
  })
})

test('forkPiSessionFile rejects files without a session header', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const bad = join(root, 'bad.jsonl')
  writeFileSync(bad, JSON.stringify({ type: 'message' }) + '\n')
  assert.throws(() => forkPiSessionFile(bad, '/tmp'), /Invalid pi session header/)
})

test('PiAcpAgent: unstable_forkSession spawns a new pi on the copied file and returns a new sessionId', async () => {
  const { root, sessionFile } = setupSessionsDir()
  const spawned: string[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawned.push(params.sessionPath)
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' }),
      getCommands: async () => ({ commands: [] }),
      dispose: () => {}
    } as any
  }

  try {
    await withAgentDir(root, async () => {
      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn))

      const res = await agent.unstable_forkSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [] } as any)

      assert.ok(res.sessionId)
      assert.notEqual(res.sessionId, 'sess-1')
      assert.equal(spawned.length, 1)
      assert.notEqual(spawned[0], sessionFile)
      assert.ok(spawned[0]!.endsWith(`_${res.sessionId}.jsonl`))
      assert.equal((res as any)._meta.piAcp.forkedFrom, 'sess-1')
      assert.ok('configOptions' in res)

      // The fork is now a known session: resume must reuse it without spawning again.
      await agent.resumeSession({ sessionId: res.sessionId, cwd: '/tmp/project', mcpServers: [] } as any)
      assert.equal(spawned.length, 1)

      // The fork inherits the source title for the thread header.
      const info = conn.updates
        .map(u => (u as any).update)
        .find(u => u?.sessionUpdate === 'session_info_update' && u.title)
      assert.equal(info?.title, 'Named')
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: unstable_forkSession rejects unknown sessions and relative cwd', async () => {
  const { root } = setupSessionsDir()
  await withAgentDir(root, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    await assert.rejects(
      agent.unstable_forkSession({ sessionId: 'nope', cwd: '/tmp/project', mcpServers: [] } as any),
      (err: any) => err.code === -32602 && /Unknown sessionId/.test(String(err.data))
    )
    await assert.rejects(
      agent.unstable_forkSession({ sessionId: 'sess-1', cwd: 'relative', mcpServers: [] } as any),
      (err: any) => err.code === -32602 && /absolute path/.test(String(err.data))
    )
  })
})
