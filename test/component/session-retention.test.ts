import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { bounded, createRpcChild, nextTick } from '../helpers/rpc-child.js'

for (const operation of ['new', 'load', 'restore'] as const) {
  test(`PiAcpAgent: session/${operation} preserves another session's active prompt and subprocess`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-retention-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = root
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      rmSync(root, { recursive: true, force: true })
    })
    const sessionsDir = join(root, 'sessions', '--test--')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, '0000_other.jsonl'),
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'other',
        timestamp: '2026-06-16T00:00:00.000Z',
        cwd: root
      }) + '\n'
    )

    const older = createRpcChild({ sessionId: 'older', exitOnKill: true })
    const other = createRpcChild({ sessionId: 'other', exitOnKill: true })
    t.after(older.cleanup)
    t.after(other.cleanup)
    let spawnCount = 0
    t.mock.method(PiRpcProcess, 'spawn', async () => (++spawnCount === 1 ? older.proc : other.proc))
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    t.after(() => agent.dispose())
    const created = await bounded(agent.newSession({ cwd: root, mcpServers: [] }))
    assert.equal(created.sessionId, 'older')
    let completed = false
    const active = agent
      .prompt({ sessionId: 'older', prompt: [{ type: 'text', text: 'keep working' }] })
      .then(result => {
        completed = true
        return result
      })
    await nextTick()
    assert.equal(older.commands.filter(c => c.type === 'prompt').length, 1)

    if (operation === 'new') await bounded(agent.newSession({ cwd: root, mcpServers: [] }))
    else if (operation === 'load') await bounded(agent.loadSession({ sessionId: 'other', cwd: root, mcpServers: [] }))
    else {
      const restored = agent.prompt({ sessionId: 'other', prompt: [{ type: 'text', text: 'restore me' }] })
      await nextTick()
      other.send({ type: 'agent_settled' })
      assert.equal((await bounded(restored)).stopReason, 'end_turn')
    }
    assert.equal(older.child.killed, false)
    assert.equal(completed, false)
    assert.equal(spawnCount, 2)
    older.send({ type: 'agent_settled' })
    assert.equal((await bounded(active)).stopReason, 'end_turn')

    const followup = agent.prompt({ sessionId: 'older', prompt: [{ type: 'text', text: 'continue' }] })
    await nextTick()
    older.send({ type: 'agent_settled' })
    assert.equal((await bounded(followup)).stopReason, 'end_turn')
    assert.equal(spawnCount, 2, 'the older session should not require restoration')
    agent.dispose()
    assert.equal(older.child.killed, true)
    assert.equal(other.child.killed, true)
  })
}
