import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const firstContent = [
  { type: 'text', text: '  Original\n\t question  ' },
  { type: 'image', data: 'ignored', mimeType: 'image/png' },
  { type: 'text', text: `  second block ${'😀'.repeat(90)}  ` }
]
const firstTitle = Array.from(`Original question second block ${'😀'.repeat(90)}`)
  .slice(0, 80)
  .join('')
const savedTitle = 'Saved explicit name'
const newPrompt = 'A new prompt that must not become the restored title'

class RestoredPiRpcProcess extends FakePiRpcProcess {
  sessionName: string | undefined
  messageReads = 0
  disposed = false
  readonly names: string[] = []

  override async getState(): Promise<Record<string, unknown>> {
    return { ...(await super.getState()), sessionName: this.sessionName }
  }

  override async getMessages(): Promise<{ messages: Array<{ role: string; content: string }> }> {
    this.messageReads++
    return { messages: [{ role: 'user', content: 'Compacted RPC history starts here, not at the original question' }] }
  }

  async getCommands(): Promise<{ commands: never[] }> {
    return { commands: [] }
  }

  async setSessionName(name: string): Promise<void> {
    this.names.push(name)
    this.rename(name)
  }

  rename(name: string): void {
    this.sessionName = name
    this.emit({ type: 'session_info_changed', name })
  }

  override async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    await super.prompt(message, attachments)
    this.emit({ type: 'message_start', message: { role: 'user', content: message } })
    this.emit({ type: 'message_end', message: { role: 'user', content: message } })
    this.emit({ type: 'agent_settled' })
  }

  dispose(): void {
    this.disposed = true
  }
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (path !== join(root, 'map.json')) files[relative(root, path)] = readFileSync(path, 'utf8')
    }
  }
  visit(root)
  return files
}

function fixture(t: TestContext, options: { named?: boolean; external?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-title-restore-'))
  const piDir = join(root, 'pi')
  const cwd = join(root, 'project')
  const sessionDir = options.external ? join(root, 'archive') : join(piDir, 'sessions', 'project')
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const sessionFile = join(sessionDir, 'source.jsonl')
  const entries = [
    { type: 'session', version: 3, id: 'source', cwd, timestamp: '2026-02-11T00:00:00.000Z' },
    {
      type: 'message',
      id: 'first',
      parentId: null,
      timestamp: '2026-02-11T00:00:01.000Z',
      message: { role: 'user', content: firstContent }
    },
    {
      type: 'compaction',
      id: 'compacted',
      parentId: 'first',
      timestamp: '2026-02-11T00:00:02.000Z',
      summary: 'The original question has been compacted away in RPC history',
      firstKeptEntryId: 'later',
      tokensBefore: 10000
    },
    {
      type: 'message',
      id: 'later',
      parentId: 'compacted',
      timestamp: '2026-02-11T00:00:03.000Z',
      message: { role: 'user', content: 'A later saved message' }
    },
    ...(options.named ? [{ type: 'session_info', id: 'name', parentId: 'later', name: savedTitle }] : [])
  ]
  const history = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  writeFileSync(sessionFile, history)
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = piDir
  const store = new SessionStore(join(root, 'map.json'))
  if (options.external) store.upsert({ sessionId: 'source', cwd, sessionFile })
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'store', { value: store })
  const proc = new RestoredPiRpcProcess()
  const spawned: string[] = []
  t.mock.method(PiRpcProcess, 'spawn', async (params: Parameters<typeof PiRpcProcess.spawn>[0]) => {
    assert.ok(params.sessionPath)
    spawned.push(params.sessionPath)
    return proc as unknown as PiRpcProcess
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    agent.dispose()
    t.mock.timers.reset()
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    rmSync(root, { recursive: true, force: true })
  })
  const before = snapshot(root)
  const titles = () =>
    conn.updates.flatMap(({ sessionId, update }) =>
      update.sessionUpdate === 'session_info_update' && update.title ? [{ sessionId, title: update.title }] : []
    )
  const unchanged = (forkId?: string) => {
    const after = snapshot(root)
    if (forkId) {
      const forkFile = store.get(forkId)?.sessionFile
      assert.ok(forkFile)
      assert.equal(dirname(forkFile), dirname(sessionFile))
      const forkHistory = after[relative(root, forkFile)]
      assert.ok(forkHistory)
      const [header, ...rest] = forkHistory.split('\n')
      const parsed: unknown = JSON.parse(header!)
      assert.ok(parsed && typeof parsed === 'object')
      assert.equal('id' in parsed && parsed.id, forkId)
      assert.equal('parentSession' in parsed && parsed.parentSession, sessionFile)
      assert.deepEqual(rest, history.split('\n').slice(1))
      delete after[relative(root, forkFile)]
    }
    assert.deepEqual(after, before)
    assert.deepEqual(proc.names, [], 'display-only titles must not be persisted via RPC')
  }
  return {
    agent,
    proc,
    conn,
    spawned,
    sessionFile,
    store,
    titles,
    unchanged,
    params: { sessionId: 'source', cwd, mcpServers: [] },
    expectedTitle: options.named ? savedTitle : firstTitle
  }
}

for (const lifecycle of ['load', 'cold resume', 'auto-restore', 'fork'] as const) {
  for (const named of [false, true]) {
    for (const external of [false, true]) {
      test(`title restore: ${lifecycle}, ${named ? 'explicit name' : 'original first message'}, ${external ? 'known external file' : 'standard directory'}`, async t => {
        const f = fixture(t, { named, external })
        let sessionId = 'source'
        if (lifecycle === 'load') await f.agent.loadSession(f.params)
        else if (lifecycle === 'cold resume') await f.agent.resumeSession(f.params)
        else if (lifecycle === 'fork') sessionId = (await f.agent.unstable_forkSession(f.params)).sessionId
        else {
          assert.deepEqual(f.titles(), [])
          const result = await f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: newPrompt }] })
          assert.equal(result.stopReason, 'end_turn')
        }

        assert.deepEqual(f.titles(), [{ sessionId, title: f.expectedTitle }])
        assert.equal(f.spawned.length, 1)
        assert.equal(f.proc.messageReads, lifecycle === 'load' ? 1 : 0)
        assert.equal(f.store.get(sessionId)?.sessionFile, f.spawned[0])
        if (lifecycle === 'fork') {
          assert.notEqual(sessionId, 'source')
          assert.notEqual(f.spawned[0], f.sessionFile)
        } else assert.equal(f.spawned[0], f.sessionFile)

        const later = await f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: newPrompt }] })
        assert.equal(later.stopReason, 'end_turn')
        assert.deepEqual(f.titles(), [{ sessionId, title: f.expectedTitle }])
        f.unchanged(lifecycle === 'fork' ? sessionId : undefined)
        f.agent.dispose()
        assert.equal(f.proc.disposed, true)
      })
    }
  }
}

test('title restore: fork republishes its latest title after the new session ID is known', async t => {
  const f = fixture(t, { named: true })
  const result = await f.agent.unstable_forkSession(f.params)
  f.conn.updates.length = 0
  f.proc.rename('Latest fork title')
  await new Promise<void>(resolve => setImmediate(resolve))
  f.conn.updates.length = 0
  t.mock.timers.tick(0)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(f.titles(), [{ sessionId: result.sessionId, title: 'Latest fork title' }])
  f.unchanged(result.sessionId)
})

for (const named of [false, true]) {
  test(`title restore: warm resume republishes current title without reverting ${named ? 'saved name' : 'saved fallback'}`, async t => {
    const f = fixture(t, { named })
    await f.agent.resumeSession(f.params)
    assert.deepEqual(f.titles(), [{ sessionId: 'source', title: f.expectedTitle }])
    f.conn.updates.length = 0

    await f.agent.resumeSession(f.params)
    assert.deepEqual(f.titles(), [{ sessionId: 'source', title: f.expectedTitle }])
    f.conn.updates.length = 0

    f.proc.rename('Live extension rename')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(f.titles(), [{ sessionId: 'source', title: 'Live extension rename' }])
    f.conn.updates.length = 0

    await f.agent.resumeSession(f.params)
    await f.agent.prompt({ sessionId: 'source', prompt: [{ type: 'text', text: newPrompt }] })
    assert.deepEqual(f.titles(), [{ sessionId: 'source', title: 'Live extension rename' }])
    assert.equal(f.spawned.length, 1)
    assert.equal(f.proc.messageReads, 0)
    f.unchanged()
  })
}

for (const lifecycle of ['load', 'cold resume', 'fork'] as const) {
  test(`title restore: ${lifecycle} does not overwrite a live rename received while configuration is awaited`, async t => {
    const f = fixture(t, { named: true })
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => {
      enter = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    t.mock.method(f.proc, 'getAvailableThinkingLevels', async () => {
      enter()
      await gate
      return ['off', 'medium', 'high']
    })
    const operation =
      lifecycle === 'load'
        ? f.agent.loadSession(f.params)
        : lifecycle === 'fork'
          ? f.agent.unstable_forkSession(f.params)
          : f.agent.resumeSession(f.params)
    await entered
    assert.deepEqual(f.titles(), [])
    f.proc.rename('Rename during configuration')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.titles().length, 1, 'live rename is published before configuration completes')
    assert.equal(f.titles()[0]?.title, 'Rename during configuration')
    release()
    const result = await operation
    const sessionId = 'sessionId' in result ? result.sessionId : 'source'
    assert.equal(typeof sessionId, 'string')
    const expected = { sessionId, title: 'Rename during configuration' }
    assert.deepEqual(f.titles(), lifecycle === 'cold resume' ? [expected, expected] : [expected])
    f.unchanged(lifecycle === 'fork' && typeof sessionId === 'string' ? sessionId : undefined)
  })
}
