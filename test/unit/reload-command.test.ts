import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { createRpcChild } from '../helpers/rpc-child.js'

type Entry = { sessionId: string; cwd: string; sessionFile: string; additionalDirectories?: string[] }

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-reload-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const dir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(dir, { recursive: true })
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'session', version: 3, id: 'reload-test', cwd: root, timestamp: '2026-06-16T00:00:00Z' }) +
      '\n'
  )

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const entries = new Map<string, Entry>([['reload-test', { sessionId: 'reload-test', cwd: root, sessionFile }]])
  Object.defineProperty(agent, 'store', {
    value: {
      get: (id: string) => entries.get(id),
      upsert: (entry: Entry) => entries.set(entry.sessionId, entry)
    }
  })

  const children: ReturnType<typeof createRpcChild>[] = []
  const spawns: Parameters<typeof PiRpcProcess.spawn>[0][] = []
  t.mock.method(PiRpcProcess, 'spawn', async (params: Parameters<typeof PiRpcProcess.spawn>[0]) => {
    spawns.push(params)
    const child = createRpcChild({ exitOnKill: true, sessionId: 'reload-test' })
    children.push(child)
    return child.proc
  })

  t.after(() => {
    agent.dispose()
    for (const child of children) child.cleanup()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })

  const sessions = () => (agent as unknown as { sessions: SessionManager }).sessions
  return { root, sessionFile, conn, agent, children, spawns, sessions }
}

const lastText = (conn: FakeAgentSideConnection) => {
  const chunks = conn.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk')
  const update = chunks.at(-1)?.update
  return update?.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : ''
}

test('/reload restarts the pi subprocess on the same session file', async t => {
  const { root, sessionFile, conn, agent, children, spawns, sessions } = setup(t)
  const params = { sessionId: 'reload-test', cwd: root, mcpServers: [] }
  await agent.resumeSession(params)
  const before = sessions().maybeGet(params.sessionId)
  assert.ok(before)
  await new Promise(resolve => setTimeout(resolve, 20))
  const commandsBefore = conn.updates.filter(u => u.update.sessionUpdate === 'available_commands_update').length

  const res = await agent.prompt({ sessionId: params.sessionId, prompt: [{ type: 'text', text: '/reload' }] })

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(children.length, 2)
  assert.equal(children[0].child.killed, true)
  assert.equal(spawns[1].sessionPath, sessionFile)
  assert.equal(spawns[1].cwd, root)
  const after = sessions().maybeGet(params.sessionId)
  assert.ok(after)
  assert.notEqual(after, before)
  assert.equal(after.proc, children[1].proc)
  assert.ok(!children[0].commands.some(c => c.type === 'prompt'))
  assert.ok(!children[1].commands.some(c => c.type === 'prompt'))
  assert.match(lastText(conn), /^Reloaded/)
  assert.ok(conn.updates.some(u => u.update.sessionUpdate === 'config_option_update'))

  await new Promise(resolve => setTimeout(resolve, 20))
  const commandsAfter = conn.updates.filter(u => u.update.sessionUpdate === 'available_commands_update')
  assert.equal(commandsAfter.length, commandsBefore + 1)
  const advertised = commandsAfter.at(-1)?.update
  assert.ok(
    advertised?.sessionUpdate === 'available_commands_update' &&
      advertised.availableCommands.some(c => c.name === 'reload')
  )
})

test('/reload is refused while the session is busy', async t => {
  const { root, conn, agent, children, sessions } = setup(t)
  const params = { sessionId: 'reload-test', cwd: root, mcpServers: [] }
  await agent.resumeSession(params)
  const session = sessions().maybeGet(params.sessionId)
  assert.ok(session)
  Object.defineProperty(session, 'busy', { get: () => true })

  const res = await agent.prompt({ sessionId: params.sessionId, prompt: [{ type: 'text', text: '/reload' }] })

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(children.length, 1)
  assert.equal(children[0].child.killed, false)
  assert.equal(sessions().maybeGet(params.sessionId), session)
  assert.match(lastText(conn), /Cannot reload while the agent is running/)
})
