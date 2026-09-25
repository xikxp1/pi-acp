import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { forkPiSessionFile, readPiSessionBranch } from '../../src/acp/pi-sessions.js'
import { SubagentSessions, SUBAGENT_CAPABILITY, SUBAGENT_INFO } from '../../src/acp/subagent-sessions.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test(
  'real Pi cold restart recovers compacted links only from the selected branch, without reparenting forks',
  { timeout: 30000 },
  async t => {
    if (spawnSync('pi', ['--version']).status !== 0) return t.skip('Pi CLI is not installed')
    const directory = mkdtempSync(join(tmpdir(), 'pi-compacted-children-'))
    const originalEnv = { ...process.env }
    process.env.PI_CODING_AGENT_DIR = join(directory, 'config')
    process.env.PI_OFFLINE = '1'
    delete process.env.PI_ACP_PI_COMMAND
    mkdirSync(process.env.PI_CODING_AGENT_DIR)
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR, 'settings.json'),
      JSON.stringify({ packages: [], extensions: [], enableInstallTelemetry: false })
    )
    t.after(() => {
      process.env = originalEnv
      rmSync(directory, { recursive: true, force: true })
    })
    const parent = randomUUID()
    const parentFile = join(directory, 'parent.jsonl')
    const timestamp = new Date().toISOString()
    const child = (call: string) => {
      const runId = randomUUID()
      const root = join(directory, runId)
      mkdirSync(root)
      const descriptor = {
        version: 2,
        runId,
        parentToolCallId: call,
        parentPiSessionId: parent,
        title: call,
        sessionFile: join(root, 'session.jsonl'),
        eventsFile: join(root, 'events.jsonl'),
        outputFile: join(root, 'output.txt')
      }
      writeFileSync(
        descriptor.eventsFile,
        JSON.stringify({
          version: 2,
          type: 'event',
          runId,
          sequence: 0,
          event: {
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: `FINAL:${call}` }] }
          }
        }) + '\n'
      )
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...descriptor, status: 'completed' }))
      return descriptor
    }
    const abandoned = child('abandoned')
    const old = child('old')
    const interrupted = child('interrupted')
    const kept = child('kept')
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
    const call = (id: string, parentId: string, name: string) => ({
      type: 'message',
      id,
      parentId,
      timestamp,
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: name, name: 'subagent', arguments: { task: `Original ${name}`, description: name } }
        ],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-4o',
        usage,
        stopReason: 'toolUse',
        timestamp: Date.now()
      }
    })
    const registration = (id: string, parentId: string, data: object) => ({
      type: 'custom',
      id,
      parentId,
      timestamp,
      customType: 'pi-subagent-session',
      data
    })
    const result = (id: string, parentId: string, data: typeof old) => ({
      type: 'message',
      id,
      parentId,
      timestamp,
      message: {
        role: 'toolResult',
        toolCallId: data.parentToolCallId,
        toolName: 'subagent',
        content: [{ type: 'text', text: 'Done' }],
        details: { subagentSession: data },
        isError: false,
        timestamp: Date.now()
      }
    })
    const entries = [
      { type: 'session', version: 3, id: parent, cwd: directory, timestamp },
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp,
        message: { role: 'user', content: 'Delegate work', timestamp: Date.now() }
      },
      call('abandoned-call', 'root', 'abandoned'),
      registration('abandoned-registration', 'abandoned-call', abandoned),
      call('old-call', 'root', 'old'),
      result('old-result', 'old-call', old),
      call('interrupted-call', 'old-result', 'interrupted'),
      registration('interrupted-registration', 'interrupted-call', interrupted),
      {
        type: 'message',
        id: 'keep-user',
        parentId: 'interrupted-registration',
        timestamp,
        message: { role: 'user', content: 'Continue', timestamp: Date.now() }
      },
      call('kept-call', 'keep-user', 'kept'),
      result('kept-result', 'kept-call', kept),
      {
        type: 'compaction',
        id: 'compact',
        parentId: 'kept-result',
        timestamp,
        summary: 'Earlier work summarized',
        firstKeptEntryId: 'keep-user',
        tokensBefore: 10000
      }
    ]
    writeFileSync(parentFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    assert.ok(!readPiSessionBranch(parentFile).some(entry => entry.id === 'abandoned-call'))
    const fork = forkPiSessionFile(parentFile, directory)
    const originalSpawn = PiRpcProcess.spawn
    let projected: unknown
    PiRpcProcess.spawn = async params => {
      const proc = await originalSpawn(params)
      const getMessages = proc.getMessages.bind(proc)
      proc.getMessages = async () => {
        projected = await getMessages()
        return projected
      }
      return proc
    }
    t.after(() => {
      PiRpcProcess.spawn = originalSpawn
    })
    for (const selected of [
      fork,
      { sessionId: parent, sessionFile: parentFile },
      { sessionId: parent, sessionFile: parentFile }
    ]) {
      const conn = new FakeAgentSideConnection()
      const registry = new SubagentSessions(asAgentConn(conn), join(directory, 'adapter'))
      const agent = new PiAcpAgent(asAgentConn(conn))
      Object.defineProperty(agent, 'subagentSessions', { value: registry })
      Object.defineProperty(agent, 'store', {
        value: { get: () => ({ cwd: directory, sessionFile: selected.sessionFile }), upsert: () => {} }
      })
      try {
        await agent.initialize({
          protocolVersion: 1,
          clientCapabilities: { _meta: { [SUBAGENT_CAPABILITY]: { version: 1 } } }
        })
        await agent.loadSession({ sessionId: selected.sessionId, cwd: directory, mcpServers: [] })
        const serialized = JSON.stringify(projected)
        assert.ok(!serialized.includes('Original old'))
        assert.ok(!serialized.includes('Original interrupted'))
        assert.ok(serialized.includes('Original kept'))
        const links = conn.updates.filter(
          ({ update }) => update.sessionUpdate === 'tool_call' && update._meta?.subagent_session_info
        )
        if (selected.sessionId === fork.sessionId) {
          assert.equal(links.length, 0)
          continue
        }
        assert.deepEqual(
          links.map(({ update }) => ('toolCallId' in update ? update.toolCallId : null)),
          ['old', 'interrupted', 'kept']
        )
        assert.deepEqual(
          links.map(({ update }) => ('rawInput' in update ? update.rawInput : null)),
          [old, interrupted, kept].map(data => ({
            task: `Original ${data.parentToolCallId}`,
            description: data.parentToolCallId
          }))
        )
        for (const data of [old, interrupted, kept]) {
          const childId = `pi-child-${data.runId}`
          await agent.loadSession({ sessionId: childId, cwd: directory, mcpServers: [] })
          const updates = conn.updates.filter(update => update.sessionId === childId)
          assert.equal(updates[1].update.sessionUpdate, 'agent_message_chunk')
          assert.equal((updates.at(-1)?.update._meta?.[SUBAGENT_INFO] as { status: string }).status, 'completed')
        }
        assert.equal(existsSync(join(directory, 'adapter', `pi-child-${abandoned.runId}.json`)), false)
      } finally {
        agent.dispose()
      }
    }
  }
)
