import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const catalog = [
  { provider: 'http://localhost:8000', id: 'qwen3-27b' },
  { provider: 'lmstudio', id: 'google/gemma-3-12b' },
  { provider: 'https://example.test/v1', id: 'org/model' },
  { provider: 'other', id: 'test/alpha' },
  { provider: 'test', id: 'alpha' },
  { provider: 'test', id: 'shared' },
  { provider: 'other', id: 'shared' }
]

function fixture(models: unknown = catalog) {
  const conn = new FakeAgentSideConnection()
  const state = { thinkingLevel: 'off', model: { provider: 'test', id: 'alpha' } }
  const calls: Array<{ provider: string; modelId: string }> = []
  let contextRefreshes = 0
  const proc = {
    async getAvailableModels() {
      return { models }
    },
    async getAvailableThinkingLevels() {
      return ['off']
    },
    async getState() {
      return state
    },
    async setModel(provider: string, modelId: string) {
      calls.push({ provider, modelId })
      state.model = { provider, id: modelId }
    }
  }
  const session = {
    sessionId: 's1',
    proc,
    async refreshContextWindow() {
      contextRefreshes++
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'sessions', {
    value: { maybeGet: (id: string) => (id === session.sessionId ? session : undefined) }
  })
  return {
    agent,
    conn,
    proc,
    calls,
    get contextRefreshes() {
      return contextRefreshes
    }
  }
}

for (const api of ['config', 'legacy'] as const) {
  const select = (agent: PiAcpAgent, value: string) =>
    api === 'config'
      ? agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value })
      : agent.unstable_setSessionModel({ sessionId: 's1', modelId: value })

  const cases = [
    {
      name: 'URL provider',
      value: 'http://localhost:8000/qwen3-27b',
      provider: 'http://localhost:8000',
      modelId: 'qwen3-27b'
    },
    {
      name: 'namespaced model',
      value: 'lmstudio/google/gemma-3-12b',
      provider: 'lmstudio',
      modelId: 'google/gemma-3-12b'
    },
    {
      name: 'slashes in both parts',
      value: 'https://example.test/v1/org/model',
      provider: 'https://example.test/v1',
      modelId: 'org/model'
    },
    { name: 'bare namespaced model', value: 'google/gemma-3-12b', provider: 'lmstudio', modelId: 'google/gemma-3-12b' },
    { name: 'bare model', value: 'alpha', provider: 'test', modelId: 'alpha' },
    { name: 'qualified match before earlier bare match', value: 'test/alpha', provider: 'test', modelId: 'alpha' },
    { name: 'first bare match in catalog order', value: 'shared', provider: 'test', modelId: 'shared' },
    {
      name: 'unadvertised qualified fallback',
      value: 'custom/org/new-model',
      provider: 'custom',
      modelId: 'org/new-model'
    }
  ]
  for (const { name, value, provider, modelId } of cases) {
    test(`model selection (${api}): resolves ${name}`, async () => {
      const f = fixture()
      const response = await select(f.agent, value)
      assert.deepEqual(f.calls, [{ provider, modelId }])
      assert.equal(f.contextRefreshes, 1)
      assert.deepEqual(f.conn.updates[0], {
        sessionId: 's1',
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'off' }
      })
      assert.equal(f.conn.updates.length, 2)
      const update = f.conn.updates[1]!.update
      assert.equal(update.sessionUpdate, 'config_option_update')
      assert.equal(update.configOptions.find(option => option.id === 'model')?.currentValue, `${provider}/${modelId}`)
      if (api === 'config') assert.deepEqual(response, { configOptions: update.configOptions })
    })
  }

  for (const value of ['unknown', '', '/alpha', 'test/']) {
    test(`model selection (${api}): rejects invalid or unknown ${JSON.stringify(value)}`, async () => {
      const f = fixture()
      await assert.rejects(select(f.agent, value), { code: -32602 })
      assert.deepEqual(f.calls, [])
      assert.deepEqual(f.conn.updates, [])
      assert.equal(f.contextRefreshes, 0)
    })
  }

  test(`model selection (${api}): skips malformed catalog entries`, async () => {
    const f = fixture([null, {}, { provider: 42, id: 'alpha' }, { provider: '', id: 'alpha' }, ...catalog])
    await select(f.agent, 'alpha')
    assert.deepEqual(f.calls, [{ provider: 'test', modelId: 'alpha' }])
  })

  test(`model selection (${api}): retains qualified fallback with no catalog models`, async () => {
    const f = fixture(null)
    await select(f.agent, 'custom/org/model')
    assert.deepEqual(f.calls, [{ provider: 'custom', modelId: 'org/model' }])
  })

  test(`model selection (${api}): propagates catalog failure without guessing a provider`, async () => {
    const f = fixture()
    f.proc.getAvailableModels = async () => {
      throw new Error('catalog unavailable')
    }
    await assert.rejects(select(f.agent, 'http://localhost:8000/qwen3-27b'), /catalog unavailable/)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.conn.updates, [])
    assert.equal(f.contextRefreshes, 0)
  })
}
