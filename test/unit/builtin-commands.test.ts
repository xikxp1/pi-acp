import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

class NamingPiRpcProcess extends FakePiRpcProcess {
  sessionName: string | undefined
  readonly names: string[] = []

  constructor(private readonly emitBeforeAck: boolean) {
    super()
  }

  async setSessionName(name: string): Promise<void> {
    this.names.push(name)
    this.sessionName = name
    if (this.emitBeforeAck) this.emit({ type: 'session_info_changed', name })
  }

  override async getState(): Promise<Record<string, unknown>> {
    return { ...(await super.getState()), sessionName: this.sessionName }
  }

  override async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    await super.prompt(message, attachments)
    this.emit({ type: 'message_start', message: { role: 'user', content: message } })
    this.emit({ type: 'message_end', message: { role: 'user', content: message } })
    this.emit({ type: 'agent_settled' })
  }
}

for (const emitBeforeAck of [true, false]) {
  test(`PiAcpAgent: /name deduplicates name events ${emitBeforeAck ? 'before' : 'after'} ACK and later polling`, async t => {
    const conn = new FakeAgentSideConnection()
    const proc = new NamingPiRpcProcess(emitBeforeAck)
    const sessions = new SessionManager()
    const session = sessions.getOrCreate('s1', {
      cwd: process.cwd(),
      mcpServers: [],
      proc: proc as unknown as PiRpcProcess,
      conn: asAgentConn(conn)
    })
    const agent = new PiAcpAgent(asAgentConn(conn))
    Object.defineProperty(agent, 'sessions', { value: sessions })
    t.after(() => agent.dispose())
    const titles = () =>
      conn.updates.flatMap(({ update }) =>
        update.sessionUpdate === 'session_info_update' && update.title ? [update.title] : []
      )

    const res = await agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: '/name My Session' }]
    })

    assert.equal(res.stopReason, 'end_turn')
    assert.equal(proc.prompts.length, 0)
    assert.deepEqual(proc.names, ['My Session'])
    assert.deepEqual(titles(), ['My Session'])
    const last = conn.updates.at(-1)?.update
    assert.ok(last?.sessionUpdate === 'agent_message_chunk' && last.content.type === 'text')
    assert.match(last.content.text, /Session name set: My Session/)

    proc.emit({ type: 'session_info_changed', name: 'My Session' })
    proc.emit({ type: 'session_info_changed', name: 'My Session' })
    const later = await agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'A later user message must not replace the name' }]
    })
    await session.syncSessionName()
    await session.syncSessionName()

    assert.equal(later.stopReason, 'end_turn')
    assert.equal(proc.prompts.length, 1)
    assert.deepEqual(proc.names, ['My Session'])
    assert.deepEqual(titles(), ['My Session'])
  })
}
