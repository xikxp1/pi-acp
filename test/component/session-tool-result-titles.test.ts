import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const textResult = (...texts: string[]) => ({ content: texts.map(text => ({ type: 'text', text })) })

type Scenario = {
  toolName?: string
  args?: Record<string, unknown>
  isError?: boolean
}

function toolUpdates(conn: FakeAgentSideConnection) {
  return conn.updates.map(message => message.update).filter(update => 'toolCallId' in update)
}

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-result-titles-'))
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = cwd
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    rmSync(cwd, { recursive: true, force: true })
  })

  // Both the agent and its session manager own stores; neither may touch the user's map.
  t.mock.method(SessionStore.prototype, 'get', () => ({
    sessionId: 'result-titles',
    cwd,
    sessionFile: join(cwd, 'session.jsonl'),
    updatedAt: '2026-01-01T00:00:00.000Z'
  }))
  t.mock.method(SessionStore.prototype, 'upsert', () => {})

  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 'result-titles',
    cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  t.after(() => session.dispose())

  const replayProc = new FakePiRpcProcess()
  const replayConn = new FakeAgentSideConnection()
  t.mock.method(PiRpcProcess, 'spawn', async () => replayProc as unknown as PiRpcProcess)
  const agent = new PiAcpAgent(asAgentConn(replayConn))
  t.after(() => agent.dispose())

  function start({ toolName = 'deploy', args = { path: 'production' } }: Scenario = {}) {
    proc.emit({ type: 'tool_execution_start', toolCallId: 'call', toolName, args })
  }

  async function complete(result: unknown, scenario: Scenario = {}, omitToolName = false) {
    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 'call',
      ...(omitToolName ? {} : { toolName: scenario.toolName ?? 'deploy' }),
      isError: scenario.isError ?? false,
      result
    })
    await tick()
    const updates = toolUpdates(conn)
    const call = updates.find(update => update.sessionUpdate === 'tool_call')
    const end = updates.filter(update => update.sessionUpdate === 'tool_call_update').at(-1)
    assert.ok(call && end)
    return { call, end }
  }

  async function both(result: unknown, scenario: Scenario = {}) {
    const { toolName = 'deploy', args = { path: 'production' }, isError = false } = scenario
    start(scenario)
    const live = await complete(result, scenario)
    const replayResult = {
      role: 'toolResult',
      toolCallId: 'call',
      toolName,
      isError,
      ...(typeof result === 'string' ? textResult(result) : (result as Record<string, unknown>))
    }
    t.mock.method(replayProc, 'getMessages', async () => ({
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: toolName, arguments: args }] },
        replayResult
      ]
    }))
    await agent.loadSession({ sessionId: 'result-titles', cwd, mcpServers: [] })
    await tick()
    const updates = toolUpdates(replayConn)
    const call = updates.find(update => update.sessionUpdate === 'tool_call')
    const end = updates.filter(update => update.sessionUpdate === 'tool_call_update').at(-1)
    assert.ok(call && end)
    assert.equal(live.call.title, call.title)
    assert.equal(live.end.title, end.title)
    assert.equal(live.end.status, isError ? 'failed' : 'completed')
    assert.equal(end.status, live.end.status)
    return { live, replay: { call, end }, replayResult }
  }

  return { proc, conn, start, complete, both }
}

for (const scenario of [
  {
    name: 'successful text blocks',
    result: textResult('  Deployed ', 'successfully  '),
    summary: 'Deployed successfully'
  },
  {
    name: 'failed text blocks',
    result: textResult('  Permission denied  '),
    summary: 'Permission denied',
    isError: true
  },
  { name: 'plain string', result: '  Deployment queued  ', summary: 'Deployment queued' }
]) {
  test(`tool result titles: ${scenario.name} agree live and on replay`, async t => {
    const { both } = fixture(t)
    const { live, replay, replayResult } = await both(scenario.result, scenario)
    assert.equal(live.call.title, 'deploy production')
    assert.equal(live.end.title, `deploy: ${scenario.summary}`)
    assert.deepEqual(live.end.rawOutput, scenario.result)
    assert.deepEqual(replay.end.rawOutput, replayResult)
  })
}

for (const length of [80, 81]) {
  test(`tool result titles: ${length} Unicode code points retain full output live and on replay`, async t => {
    const { both } = fixture(t)
    const text = '🚀'.repeat(length)
    const result = textResult(text)
    const { live, replay, replayResult } = await both(result)
    const summary = length === 80 ? text : `${'🚀'.repeat(79)}…`
    for (const { end } of [live, replay]) {
      assert.equal(end.title, `deploy: ${summary}`)
      assert.equal(Array.from(end.title!.slice('deploy: '.length)).length, 80)
      assert.deepEqual(end.content, [{ type: 'content', content: { type: 'text', text } }])
    }
    assert.deepEqual(live.end.rawOutput, result)
    assert.deepEqual(replay.end.rawOutput, replayResult)
  })
}

for (const [name, result] of [
  ['empty text', textResult('   ')],
  ['empty content', { content: [] }],
  ['non-text content', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }],
  [
    'mixed content',
    {
      content: [
        { type: 'text', text: 'Deployed' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    }
  ],
  ['object JSON', textResult('{"deployed":true}')],
  ['array JSON', textResult('["deployed"]')],
  ['JSON within individual blocks', textResult('Deployed ', '{"count":1}')],
  ['non-text result object', { deployed: true }]
] as const) {
  test(`tool result titles: ${name} preserves descriptive titles live and on replay`, async t => {
    const { both } = fixture(t)
    const { live, replay } = await both(result)
    for (const { call, end } of [live, replay]) {
      assert.equal(call.title, 'deploy production')
      assert.equal(end.title, undefined)
      assert.equal(end.title ?? call.title, 'deploy production')
    }
  })
}

test('tool result titles: all line separators preserve descriptive titles', async t => {
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    await t.test(JSON.stringify(separator), async t => {
      const { both } = fixture(t)
      const { live, replay } = await both(textResult(`Deployed${separator}`))
      for (const { call, end } of [live, replay]) {
        assert.equal(end.title, undefined)
        assert.equal(end.title ?? call.title, 'deploy production')
      }
    })
  }
})

test('tool result titles: specialized tools retain their input-based titles live and on replay', async t => {
  const scenarios = [
    { toolName: 'read', args: { path: 'src/index.ts' }, title: 'read src/index.ts' },
    { toolName: 'grep', args: { pattern: 'needle', path: 'src' }, title: 'grep "needle" in src' },
    { toolName: 'fetch_content', args: { url: 'https://example.com' }, title: 'fetch_content https://example.com' },
    { toolName: 'bash', args: { command: 'echo ready' }, title: 'echo ready' },
    { toolName: 'powershell', args: { path: 'release.ps1' }, title: 'powershell release.ps1' },
    { toolName: 'todo', args: { path: 'release-plan' }, title: 'todo release-plan' },
    { toolName: 'think', args: { path: 'release-plan' }, title: 'think release-plan' },
    {
      toolName: 'Agent',
      args: { description: 'Review changes', subagent_type: 'reviewer' },
      title: 'Agent (reviewer): Review changes'
    },
    { toolName: 'subagent', args: { description: 'Review changes' }, title: 'subagent: Review changes' },
    { toolName: 'SuBaGeNt', args: { path: 'review' }, title: 'SuBaGeNt review' }
  ]
  for (const scenario of scenarios) {
    await t.test(scenario.toolName, async t => {
      const { both } = fixture(t)
      const { live, replay } = await both({ ...textResult('Ready'), args: scenario.args }, scenario)
      for (const { call, end } of [live, replay]) {
        assert.equal(call.title, scenario.title)
        assert.equal(end.title, undefined)
        assert.equal(end.title ?? call.title, scenario.title)
      }
    })
  }
})

test('tool result titles: partial results never replace the title before completion', async t => {
  const { proc, conn, start, complete } = fixture(t)
  start()
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'call',
    toolName: 'deploy',
    partialResult: textResult('Uploading')
  })
  await tick()
  const updates = toolUpdates(conn)
  assert.equal(updates.length, 2)
  assert.equal(updates[0]!.title, 'deploy production')
  assert.equal(updates[1]!.status, 'in_progress')
  assert.equal(updates[1]!.title, undefined)
  assert.deepEqual(updates[1]!.content, [{ type: 'content', content: { type: 'text', text: 'Uploading' } }])
  const { end } = await complete(textResult('Deployed'))
  assert.equal(end.title, 'deploy: Deployed')
  assert.equal(end.status, 'completed')
})

test('tool result titles: missing live end toolName safely leaves descriptive title unchanged', async t => {
  const { start, complete } = fixture(t)
  start()
  const result = textResult('Deployed')
  const { call, end } = await complete(result, {}, true)
  assert.equal(end.status, 'completed')
  assert.equal(end.title, undefined)
  assert.equal(end.title ?? call.title, 'deploy production')
  assert.deepEqual(end.rawOutput, result)
  assert.deepEqual(end.content, [{ type: 'content', content: { type: 'text', text: 'Deployed' } }])
})
