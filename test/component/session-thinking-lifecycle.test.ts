import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { createRpcChild } from '../helpers/rpc-child.js'

for (const lifecycle of ['load', 'cold resume', 'warm resume', 'fork'] as const) {
  for (const failure of ['discovery', 'state', 'missing-current', 'inconsistent-current'] as const) {
    test(`thinking configuration: ${lifecycle} ${failure} failure preserves history and permits retry`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-thinking-lifecycle-'))
      const originalAgentDir = process.env.PI_CODING_AGENT_DIR
      process.env.PI_CODING_AGENT_DIR = root
      const sessionDir = join(root, 'sessions', 'project')
      mkdirSync(sessionDir, { recursive: true })
      const sessionFile = join(sessionDir, 'source.jsonl')
      const history =
        [
          { type: 'session', version: 3, id: 'source', cwd: root, timestamp: '2026-09-01T00:00:00Z' },
          { type: 'session_info', id: 'name', parentId: null, name: 'Saved session' }
        ]
          .map(entry => JSON.stringify(entry))
          .join('\n') + '\n'
      writeFileSync(sessionFile, history)
      const store = new SessionStore(join(root, 'map.json'))
      store.upsert({ sessionId: 'source', cwd: root, sessionFile })
      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn))
      const sessions = new SessionManager()
      Object.defineProperty(agent, 'store', { value: store })
      Object.defineProperty(agent, 'sessions', { value: sessions })
      const children: ReturnType<typeof createRpcChild>[] = []
      let shouldFail = true
      let historyReads = 0
      const makeChild = () => {
        const child = createRpcChild({
          exitOnKill: true,
          respond(command) {
            if (command.type === 'get_state') {
              const data = {
                thinkingLevel:
                  shouldFail && failure === 'missing-current'
                    ? undefined
                    : shouldFail && failure === 'inconsistent-current'
                      ? 'medium'
                      : 'max',
                model: { provider: 'test', id: 'model' }
              }
              child.respond(command, !(shouldFail && failure === 'state'), { data, error: 'state failed' })
              return false
            }
            if (command.type === 'get_available_thinking_levels') {
              child.respond(command, !(shouldFail && failure === 'discovery'), {
                data: { levels: ['off', 'max'] },
                error: 'discovery failed'
              })
              return false
            }
            if (command.type === 'get_messages') historyReads++
            return true
          }
        })
        children.push(child)
        return child
      }
      const existing = makeChild()
      const existingId = lifecycle === 'fork' || lifecycle === 'warm resume' ? 'source' : 'other'
      sessions.getOrCreate(existingId, {
        cwd: root,
        mcpServers: [],
        proc: existing.proc,
        conn: asAgentConn(conn)
      })
      let restoredId = 'source'
      let restoredFile = sessionFile
      t.mock.method(PiRpcProcess, 'spawn', async (params: Parameters<typeof PiRpcProcess.spawn>[0]) => {
        assert.ok(params.sessionPath)
        restoredFile = params.sessionPath
        restoredId = JSON.parse(readFileSync(restoredFile, 'utf8').split('\n')[0]!).id
        return makeChild().proc
      })
      t.mock.timers.enable({ apis: ['setTimeout'] })
      t.after(() => {
        agent.dispose()
        for (const child of children) child.cleanup()
        t.mock.timers.reset()
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir
        rmSync(root, { recursive: true, force: true })
      })
      const params = { sessionId: 'source', cwd: root, mcpServers: [] }
      const operation = () =>
        lifecycle === 'load'
          ? agent.loadSession(params)
          : lifecycle === 'fork'
            ? agent.unstable_forkSession(params)
            : agent.resumeSession(params)
      await assert.rejects(operation(), /state failed|discovery failed|thinking level absent/)

      const restored = children.at(-1)!
      const warm = lifecycle === 'warm resume'
      assert.equal(children.length, warm ? 1 : 2)
      assert.equal(restored.child.killed, !warm)
      assert.equal(existing.child.killed, false)
      assert.ok(sessions.maybeGet(existingId))
      if (!warm) assert.equal(sessions.maybeGet(restoredId), undefined)
      assert.equal(historyReads, 0)
      for (const { update } of conn.updates) {
        assert.equal(update.sessionUpdate, 'session_info_update')
        assert.equal(update.title, undefined)
        assert.deepEqual(update._meta, { piAcp: { queueDepth: 0, running: false } })
      }
      assert.equal(readFileSync(sessionFile, 'utf8'), history)
      assert.equal(store.get('source')?.sessionFile, sessionFile)
      assert.equal(store.get(restoredId)?.sessionFile, restoredFile)
      const restoredHistory = readFileSync(restoredFile, 'utf8')

      shouldFail = false
      const result =
        lifecycle === 'load'
          ? await agent.loadSession(params)
          : await agent.resumeSession({ ...params, sessionId: restoredId })
      assert.equal(result.modes?.currentModeId, 'max')
      assert.equal(children.length, warm ? 1 : 3)
      assert.equal(existing.child.killed, false)
      assert.equal(readFileSync(restoredFile, 'utf8'), restoredHistory)
      assert.equal(readFileSync(sessionFile, 'utf8'), history)
    })
  }
}
