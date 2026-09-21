import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest
} from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { createRpcChild, type RpcCommand } from '../helpers/rpc-child.js'

type Command = RpcCommand & { level?: string; provider?: string; modelId?: string }
type Controls = {
  state: Record<string, unknown>
  discovery: unknown
  failCommand?: string
  mutate?: (command: Command) => void
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-model-thinking-'))
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalPath = process.env.PATH
  process.env.PI_CODING_AGENT_DIR = root
  // Prevent synchronous startup version probes from launching a real pi or npm.
  process.env.PATH = root
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ quietStartup: true }))
  const dir = join(root, 'sessions', 'project')
  mkdirSync(dir, { recursive: true })
  const sessionId = 'model-thinking-session'
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root, timestamp: '2026-06-16T00:00:00Z' }) + '\n'
  )

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new SessionManager()
  const store = new SessionStore(join(root, 'session-map.json'))
  Object.defineProperty(agent, 'sessions', { value: sessions })
  Object.defineProperty(agent, 'store', { value: store })
  Object.defineProperty(sessions, 'store', { value: store })
  store.upsert({ sessionId, cwd: root, sessionFile })

  const controls: Controls = {
    state: {
      sessionId,
      sessionFile,
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'alpha', contextWindow: 1000 }
    },
    discovery: { levels: ['off', 'medium', 'max'] }
  }
  const children: ReturnType<typeof createRpcChild>[] = []
  const makeChild = () => {
    const child = createRpcChild({
      exitOnKill: true,
      respond(rawCommand) {
        const command = rawCommand as Command
        if (command.type === controls.failCommand) {
          child.respond(command, false, { error: `injected ${command.type} failure` })
          return false
        }
        let data: unknown
        switch (command.type) {
          case 'get_state':
            data = controls.state
            break
          case 'get_available_models':
            data = { models: ['alpha', 'beta', 'gamma'].map(id => ({ provider: 'test', id, name: id })) }
            break
          case 'get_available_thinking_levels':
            data = controls.discovery
            break
          case 'set_thinking_level':
          case 'set_model':
            if (controls.mutate) controls.mutate(command)
            else if (command.type === 'set_thinking_level') controls.state.thinkingLevel = command.level
            else controls.state.model = { provider: command.provider, id: command.modelId }
            // The mutation response is deliberately not the authoritative applied state.
            data = { thinkingLevel: 'stale', model: { provider: 'test', id: 'stale' } }
            break
          default:
            return true
        }
        child.respond(command, true, { data })
        return false
      }
    })
    children.push(child)
    return child
  }
  t.mock.method(PiRpcProcess, 'spawn', async () => makeChild().proc)
  // Keep deferred command advertisements out of configuration assertions.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    agent.dispose()
    for (const child of children) child.cleanup()
    t.mock.timers.reset()
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  })

  const activate = () => {
    const child = makeChild()
    const session = sessions.getOrCreate(sessionId, {
      cwd: root,
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: child.proc
    })
    return { child, session }
  }
  return { agent, conn, controls, children, activate, sessionId, params: { sessionId, cwd: root, mcpServers: [] } }
}

type Configuration = {
  configOptions?: SessionConfigOption[] | null
  modes?: {
    currentModeId: string
    availableModes: Array<{ id: string; name: string; description?: string | null }>
  } | null
  models?: { currentModelId: string } | null
}

function expectedThinking(levels: string[], current: string) {
  return {
    type: 'select',
    id: 'thought_level',
    category: 'thought_level',
    name: 'Thinking',
    description: 'Set the reasoning effort for this session',
    currentValue: current,
    options: levels.map(value => ({ value, name: `Thinking: ${value}`, description: null }))
  }
}

function assertConfiguration(result: Configuration, levels: string[], current: string, model = 'test/alpha') {
  assert.deepEqual(result.modes, {
    currentModeId: current,
    availableModes: levels.map(id => ({ id, name: `Thinking: ${id}`, description: null }))
  })
  assert.deepEqual(
    result.configOptions?.find(option => option.id === 'thought_level'),
    expectedThinking(levels, current)
  )
  assert.equal(result.models?.currentModelId, model)
  assert.equal(result.configOptions?.find(option => option.id === 'model')?.currentValue, model)
}

function assertUpdates(f: ReturnType<typeof fixture>, levels: string[], current: string, model = 'test/alpha') {
  assert.equal(f.conn.updates.length, 2)
  assert.deepEqual(f.conn.updates[0], {
    sessionId: f.sessionId,
    update: { sessionUpdate: 'current_mode_update', currentModeId: current }
  })
  const notification = f.conn.updates[1]
  assert.equal(notification.sessionId, f.sessionId)
  assert.equal(notification.update.sessionUpdate, 'config_option_update')
  if (notification.update.sessionUpdate !== 'config_option_update') assert.fail('Missing configuration update')
  const options = notification.update.configOptions
  assert.deepEqual(
    options.find(option => option.id === 'thought_level'),
    expectedThinking(levels, current)
  )
  assert.equal(options.find(option => option.id === 'model')?.currentValue, model)
  return options
}

const configurations = [
  { name: 'off-only', levels: ['off'], current: 'off' },
  { name: 'max without xhigh', levels: ['off', 'low', 'high', 'max'], current: 'max' },
  { name: 'opaque ordered levels', levels: ['adaptive/v2', 'off', '  budget:8192  '], current: 'adaptive/v2' }
]

for (const lifecycle of ['new', 'load', 'cold resume', 'warm resume', 'fork'] as const) {
  for (const { name, levels, current } of configurations) {
    test(`model-aware thinking: ${lifecycle} advertises exactly ${name}`, async t => {
      const f = fixture(t)
      f.controls.discovery = { levels }
      f.controls.state.thinkingLevel = current
      if (lifecycle === 'warm resume') f.activate()
      const result =
        lifecycle === 'new'
          ? await f.agent.newSession(f.params)
          : lifecycle === 'load'
            ? await f.agent.loadSession(f.params)
            : lifecycle === 'fork'
              ? await f.agent.unstable_forkSession(f.params)
              : await f.agent.resumeSession(f.params)
      assertConfiguration(result, levels, current)
      assert.equal(f.children.length, 1)
      const commands = f.children[0].commands
      // New-session allocation needs its own state read; configuration shares one snapshot.
      assert.equal(commands.filter(command => command.type === 'get_state').length, lifecycle === 'new' ? 2 : 1)
      assert.equal(commands.filter(command => command.type === 'get_available_thinking_levels').length, 1)
      assert.equal(commands.filter(command => command.type === 'get_available_models').length, 1)
      if (lifecycle === 'warm resume') assert.equal(f.children[0].child.killed, false)
    })
  }
}

const thinkingPaths = ['legacy mode', 'thinking config'] as const
const setterPaths = [...thinkingPaths, 'legacy model', 'model config'] as const
type SetterPath = (typeof setterPaths)[number]

async function setOption(f: ReturnType<typeof fixture>, path: SetterPath, value: unknown) {
  if (path === 'legacy mode') {
    return f.agent.setSessionMode({ sessionId: f.sessionId, modeId: value } as unknown as SetSessionModeRequest)
  }
  if (path === 'legacy model') {
    assert.equal(typeof value, 'string')
    return f.agent.unstable_setSessionModel({ sessionId: f.sessionId, modelId: value as string })
  }
  return f.agent.setSessionConfigOption({
    sessionId: f.sessionId,
    configId: path === 'model config' ? 'model' : 'thought_level',
    value
  } as unknown as SetSessionConfigOptionRequest)
}

for (const path of thinkingPaths) {
  for (const { name, levels, current } of configurations) {
    test(`model-aware thinking: ${path} publishes clamped ${name} from applied state`, async t => {
      const f = fixture(t)
      const { child, session } = f.activate()
      const refresh = t.mock.method(session, 'refreshContextWindow')
      f.controls.mutate = () => {
        f.controls.state.thinkingLevel = current
        f.controls.discovery = { levels }
      }
      const requested = '  vendor:future-effort  '
      const result = await setOption(f, path, requested)
      assert.deepEqual(
        child.commands
          .filter(command => command.type === 'set_thinking_level')
          .map(command => (command as Command).level),
        [requested]
      )
      assert.equal(child.commands.filter(command => command.type === 'get_state').length, 1)
      assert.equal(refresh.mock.callCount(), 0)
      const options = assertUpdates(f, levels, current)
      if (path === 'thinking config') assert.deepEqual(result, { configOptions: options })
      else assert.deepEqual(result, {})
    })
  }

  test(`model-aware thinking: ${path} round-trips an opaque level without trimming`, async t => {
    const f = fixture(t)
    const { child } = f.activate()
    const level = '  budget:8192  '
    f.controls.discovery = { levels: [level] }
    await setOption(f, path, level)
    assert.equal((child.commands[0] as Command).level, level)
    assertUpdates(f, [level], level)
  })

  for (const invalid of ['', undefined, null, 42, false, {}, ['high']]) {
    test(`model-aware thinking: ${path} rejects ${JSON.stringify(invalid)} before mutation`, async t => {
      const f = fixture(t)
      const { child } = f.activate()
      await assert.rejects(setOption(f, path, invalid), { code: -32602 })
      assert.deepEqual(child.commands, [])
      assert.deepEqual(f.conn.updates, [])
    })
  }
}

for (const path of ['legacy model', 'model config'] as const) {
  test(`model-aware thinking: ${path} refreshes model-specific levels and context on every switch`, async t => {
    const f = fixture(t)
    const { child, session } = f.activate()
    const refresh = t.mock.method(session, 'refreshContextWindow')
    const transitions = [
      { model: 'beta', levels: ['off'], current: 'off', contextWindow: 2048 },
      { model: 'gamma', levels: ['off', 'high', 'max'], current: 'max', contextWindow: 8192 },
      { model: 'alpha', levels: ['adaptive/v2', 'off'], current: 'adaptive/v2', contextWindow: 32768 }
    ]
    for (const [index, transition] of transitions.entries()) {
      f.conn.updates.length = 0
      child.commands.length = 0
      f.controls.mutate = command => {
        assert.equal(command.provider, 'test')
        assert.equal(command.modelId, transition.model)
        f.controls.state.model = { provider: 'test', id: transition.model, contextWindow: transition.contextWindow }
        f.controls.state.thinkingLevel = transition.current
        f.controls.discovery = { levels: transition.levels }
      }
      const result = await setOption(f, path, `test/${transition.model}`)
      const options = assertUpdates(f, transition.levels, transition.current, `test/${transition.model}`)
      assert.equal(refresh.mock.callCount(), index + 1)
      assert.equal((session as unknown as { contextWindow?: number }).contextWindow, transition.contextWindow)
      assert.deepEqual(
        child.commands.map(command => command.type),
        ['set_model', 'get_state', 'get_state', 'get_available_models', 'get_available_thinking_levels']
      )
      if (path === 'model config') assert.deepEqual(result, { configOptions: options })
      else assert.equal(result, undefined)
    }
  })
}

type FailureCase = { name: string; configure: (controls: Controls, mutation: string) => void; error: RegExp }
const failures: FailureCase[] = [
  ...[undefined, null, '', 42, 'not-advertised'].map(thinkingLevel => ({
    name: `invalid applied thinking level ${JSON.stringify(thinkingLevel)}`,
    configure: (controls: Controls) => {
      controls.mutate = () => {
        controls.state.thinkingLevel = thinkingLevel
      }
    },
    error: /thinking level absent from available levels/
  })),
  ...[null, {}, { levels: [] }, { levels: ['off', ''] }, { levels: ['medium', 42] }, { levels: 'medium' }].map(
    discovery => ({
      name: `invalid discovery ${JSON.stringify(discovery)}`,
      configure: (controls: Controls) => {
        controls.discovery = discovery
      },
      error: /get_available_thinking_levels returned invalid data/
    })
  ),
  {
    name: 'discovery RPC failure',
    configure: controls => {
      controls.failCommand = 'get_available_thinking_levels'
    },
    error: /injected get_available_thinking_levels failure/
  },
  {
    name: 'get_state RPC failure',
    configure: controls => {
      controls.failCommand = 'get_state'
    },
    error: /injected get_state failure/
  },
  {
    name: 'mutation RPC failure',
    configure: (controls, mutation) => {
      controls.failCommand = mutation
    },
    error: /injected set_(thinking_level|model) failure/
  }
]

for (const path of setterPaths) {
  for (const failure of failures) {
    test(`model-aware thinking: ${path} emits no success on ${failure.name}`, async t => {
      const f = fixture(t)
      const { child } = f.activate()
      const model = path === 'legacy model' || path === 'model config'
      const mutation = model ? 'set_model' : 'set_thinking_level'
      failure.configure(f.controls, mutation)
      await assert.rejects(setOption(f, path, model ? 'test/beta' : 'max'), failure.error)
      assert.equal(child.commands.filter(command => command.type === mutation).length, 1)
      assert.deepEqual(f.conn.updates, [])
      if (f.controls.failCommand === mutation) {
        assert.deepEqual(
          child.commands.map(command => command.type),
          [mutation]
        )
      }
    })
  }
}
