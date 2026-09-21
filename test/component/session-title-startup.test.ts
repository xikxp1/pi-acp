import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

for (const source of ['initial state', 'configuration event'] as const) {
  for (const closed of [false, true]) {
    test(`startup title: ${source} ${closed ? 'is not republished after disposal' : 'is published after session/new response'}`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-title-startup-'))
      const piDir = join(root, 'pi')
      mkdirSync(piDir)
      writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ quietStartup: true }))
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR
      process.env.PI_CODING_AGENT_DIR = piDir
      const conn = new FakeAgentSideConnection()
      const proc = new FakePiRpcProcess()
      let name: string | undefined = source === 'initial state' ? 'Startup name' : undefined
      proc.getState = async () => ({ sessionId: 'startup', sessionName: name, thinkingLevel: 'medium' })
      proc.getAvailableThinkingLevels = async () => {
        if (source === 'configuration event') {
          name = 'Startup name'
          proc.emit({ type: 'session_info_changed', name })
        }
        return ['medium']
      }
      t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
      const sessions = new SessionManager()
      const store = new SessionStore(join(root, 'map.json'))
      Object.assign(sessions, { store })
      const agent = new PiAcpAgent(asAgentConn(conn))
      Object.assign(agent, { store, sessions })
      t.mock.timers.enable({ apis: ['setTimeout'] })
      t.after(() => {
        agent.dispose()
        t.mock.timers.reset()
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = oldAgentDir
        rmSync(root, { recursive: true, force: true })
      })
      const response = await agent.newSession({ cwd: root, mcpServers: [] })
      assert.equal(response.sessionId, 'startup')
      // Model clients which ignore notifications before the session ID is known.
      conn.updates.length = 0
      if (closed) agent.dispose()
      t.mock.timers.tick(0)
      await new Promise<void>(resolve => setImmediate(resolve))
      const titles = () =>
        conn.updates.flatMap(({ update }) =>
          update.sessionUpdate === 'session_info_update' && update.title ? [update.title] : []
        )
      assert.deepEqual(titles(), closed ? [] : ['Startup name'])
      if (closed) return

      proc.prompt = async message => {
        proc.emit({ type: 'message_start', message: { role: 'user', content: message } })
        proc.emit({ type: 'agent_settled' })
      }
      const result = await agent.prompt({
        sessionId: response.sessionId,
        prompt: [{ type: 'text', text: 'First task' }]
      })
      assert.equal(result.stopReason, 'end_turn')
      assert.deepEqual(titles(), ['Startup name'])
    })
  }
}
