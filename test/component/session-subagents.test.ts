import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SubagentCards } from '../../src/acp/translate/subagents.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

import { bounded, nextTick } from '../helpers/rpc-child.js'

const tick = () => bounded(nextTick())
function setup() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { conn, proc, session }
}
function snapshot(runId: string, text = 'working', status = 'in_progress') {
  return { version: 1, agentId: 'worker', runId, title: `Review ${runId}`, status, text }
}
function send(proc: FakePiRpcProcess, payload: unknown) {
  proc.emit({
    type: 'extension_ui_request',
    id: 'fire-and-forget',
    method: 'setStatus',
    statusKey: 'pi-acp:subagent',
    statusText: JSON.stringify(payload)
  })
}

test('displayed custom messages emit only at message_end; hidden and assistant finals are ignored', async () => {
  const { proc, conn } = setup()
  const message = {
    role: 'custom',
    customType: 'subagent-notification',
    display: true,
    content: [
      { type: 'text', text: 'done' },
      { type: 'image', data: 'hidden' },
      { type: 'text', text: 'next' }
    ]
  }
  proc.emit({ type: 'message_start', message })
  proc.emit({ type: 'message_end', message: { ...message, display: false } })
  proc.emit({ type: 'message_end', message: { ...message, role: 'assistant' } })
  proc.emit({ type: 'message_end', message })
  proc.emit({ type: 'message_end', message: { ...message, content: 'string result' } })
  await tick()
  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\ndone\nnext\n' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\nstring result\n' } }
    ]
  )
})

test('structured XML subagent notifications render readable results and grouped members', async () => {
  const { proc, conn } = setup()
  const message = {
    role: 'custom',
    customType: 'subagent-notification',
    display: true,
    content:
      '<task-notification><task-id>a</task-id><summary>Review done</summary><result>Preview</result></task-notification>',
    details: {
      id: 'a',
      description: 'Review code',
      status: 'completed',
      toolUses: 2,
      durationMs: 100,
      resultPreview: 'Found a bug',
      outputFile: '/tmp/a.txt',
      others: [
        {
          id: 'b',
          description: 'Run tests',
          status: 'failed',
          toolUses: 1,
          durationMs: 50,
          resultPreview: 'One test failed',
          error: 'Test failure',
          outputFile: '/tmp/b.txt'
        }
      ]
    }
  }
  proc.emit({ type: 'message_end', message: { ...message, display: false } })
  proc.emit({ type: 'message_end', message })
  await tick()
  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update
  assert.ok(update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
  for (const text of [
    'Subagent: Review code (a)',
    'Status: completed',
    'Found a bug',
    '/tmp/a.txt',
    'Subagent: Run tests (b)',
    'Status: failed',
    'One test failed',
    'Error: Test failure',
    '/tmp/b.txt'
  ])
    assert.ok(update.content.text.includes(text), text)
  assert.ok(!update.content.text.includes('<task-notification>'))
})

test('prompt rejection preserves background cards until terminal disposal', async () => {
  const { proc, conn, session } = setup()
  send(proc, snapshot('background', 'before rejection'))
  proc.prompt = async () => {
    throw new Error('prompt rejected')
  }
  assert.equal(await bounded(session.prompt('rejected')), 'error')
  send(proc, snapshot('background', 'still running'))
  await tick()
  const cards = () => conn.updates.map(u => u.update).filter(u => 'toolCallId' in u)
  assert.equal(cards().length, 2)
  const update = cards()[1]!
  assert.ok(update.sessionUpdate === 'tool_call_update')
  assert.equal(update.status, 'in_progress')
  assert.equal(update.toolCallId, 'pi-subagent-background')
  session.dispose()
  await tick()
  assert.deepEqual(cards()[2], {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'pi-subagent-background',
    status: 'failed'
  })
})

test('cancel preserves background cards until their failed lifecycle snapshot arrives', async () => {
  const { proc, conn, session } = setup()
  const turn = session.prompt('start')
  send(proc, snapshot('active'))
  await bounded(session.cancel())
  proc.emit({ type: 'agent_settled' })
  assert.equal(await bounded(turn), 'cancelled')
  await tick()
  assert.equal(conn.updates.filter(u => 'status' in u.update && u.update.status === 'failed').length, 0)
  send(proc, snapshot('active', 'aborted', 'failed'))
  send(proc, snapshot('active', 'late'))
  await tick()
  const cards = conn.updates.map(u => u.update).filter(u => 'toolCallId' in u)
  assert.equal(cards.length, 2)
  const terminal = cards[1]
  assert.ok(terminal.sessionUpdate === 'tool_call_update')
  assert.equal(terminal.status, 'failed')
  assert.deepEqual(terminal.content, [{ type: 'content', content: { type: 'text', text: 'aborted' } }])
  session.dispose()
})

test('snapshot wire bound accepts worst-case escaped text at parsed limit', () => {
  const cards = new SubagentCards()
  const text = '\u0001'.repeat(65536)
  const accepted = cards.update(JSON.stringify(snapshot('escaped', text)))
  assert.ok(accepted && accepted.sessionUpdate === 'tool_call')
  assert.deepEqual(accepted.content, [{ type: 'content', content: { type: 'text', text } }])
  assert.equal(cards.update(JSON.stringify(snapshot('oversized', text + '\u0001'))), undefined)
})

test('foreground Agent title and activity preserve real content without changing other tools', async () => {
  const { proc, conn } = setup()
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 'a', name: 'Agent', arguments: {} } }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'a',
    toolName: 'Agent',
    args: { description: 'Review code', subagent_type: 'Explore' }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'a',
    partialResult: {
      content: [{ type: 'text', text: 'actual output' }],
      details: { activity: 'Reading files', toolUses: 3 }
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: { description: 'ignore' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'b',
    partialResult: { content: [{ type: 'text', text: 'file' }], details: { activity: 'ignore', toolUses: 9 } }
  })
  await tick()
  const updates = conn.updates.map(u => u.update)
  assert.equal((updates[1] as { title?: string }).title, 'Agent (Explore): Review code')
  assert.deepEqual((updates[2] as { content?: unknown }).content, [
    { type: 'content', content: { type: 'text', text: 'Reading files\n\nTool uses: 3\n\nactual output' } }
  ])
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'a',
    toolName: 'Agent',
    result: { content: [{ type: 'text', text: 'final review' }], details: { activity: 'Done', toolUses: 4 } }
  })
  await tick()
  const terminal = conn.updates.at(-1)!.update
  assert.ok(terminal.sessionUpdate === 'tool_call_update')
  assert.equal(terminal.status, 'completed')
  assert.deepEqual(terminal.content, [{ type: 'content', content: { type: 'text', text: 'final review' } }])
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'a',
    partialResult: {
      content: [{ type: 'text', text: 'ordinary output' }],
      details: { activity: 'must not appear', toolUses: 99 }
    }
  })
  await tick()
  const subsequent = conn.updates.at(-1)!.update
  assert.ok(subsequent.sessionUpdate === 'tool_call_update')
  assert.deepEqual(subsequent.content, [{ type: 'content', content: { type: 'text', text: 'ordinary output' } }])
  assert.equal((updates[3] as { title?: string }).title, 'read')
  assert.deepEqual((updates[4] as { content?: unknown }).content, [
    { type: 'content', content: { type: 'text', text: 'file' } }
  ])
})

test('two interleaved live cards replace snapshots, outlive spawn/settlement, and resume with fresh run ids', async () => {
  const { proc, conn, session } = setup()
  const turn = session.prompt('start')
  send(proc, snapshot('a', 'one'))
  send(proc, snapshot('b', 'two'))
  send(proc, snapshot('a', 'one'))
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'spawn',
    toolName: 'Agent',
    result: { content: [{ type: 'text', text: 'spawned' }] }
  })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await bounded(turn), 'end_turn')
  send(proc, snapshot('a', 'one plus more'))
  send(proc, { ...snapshot('b', 'finished', 'completed'), outputFile: '/tmp/b.txt' })
  send(proc, snapshot('b', 'late'))
  send(proc, snapshot('b', 'other final', 'failed'))
  send(proc, snapshot('b-resume', 'resumed'))
  await tick()
  const cards = conn.updates
    .map(u => u.update)
    .filter(u => 'toolCallId' in u && u.toolCallId.startsWith('pi-subagent-'))
  assert.equal(cards.length, 5)
  assert.deepEqual(
    cards.map(u => u.sessionUpdate),
    ['tool_call', 'tool_call', 'tool_call_update', 'tool_call_update', 'tool_call']
  )
  assert.deepEqual((cards[2] as { content?: unknown }).content, [
    { type: 'content', content: { type: 'text', text: 'one plus more' } }
  ])
  assert.deepEqual((cards[3] as { locations?: unknown }).locations, [{ path: '/tmp/b.txt' }])
  assert.equal(proc.extensionUiResponses.length, 0)
  session.dispose()
  await tick()
  const failed = conn.updates.map(u => u.update).filter(u => 'status' in u && u.status === 'failed')
  assert.deepEqual(
    failed.map(u => ('toolCallId' in u ? u.toolCallId : '')),
    ['pi-subagent-a', 'pi-subagent-b-resume']
  )
  send(proc, snapshot('after-dispose'))
  await tick()
  assert.equal(
    conn.updates.some(u => 'toolCallId' in u.update && u.update.toolCallId === 'pi-subagent-after-dispose'),
    false
  )
})

test('malformed reserved statuses are silent and fire-and-forget', async () => {
  const { proc, conn } = setup()
  for (const payload of [
    null,
    [],
    {},
    { ...snapshot('a'), version: 2 },
    { ...snapshot('a'), status: 'bad' },
    { ...snapshot('a'), status: ['completed'] },
    { ...snapshot('a'), text: 'x'.repeat(65537) },
    { ...snapshot('a'), runId: '' },
    { ...snapshot('a'), outputFile: 'relative' }
  ])
    send(proc, payload)
  proc.emit({
    type: 'extension_ui_request',
    id: 'bad',
    method: 'setStatus',
    statusKey: 'pi-acp:subagent',
    statusText: '{'
  })
  await tick()
  assert.equal(conn.updates.length, 0)
  assert.equal(proc.extensionUiResponses.length, 0)
})

test('process failure fails active cards once and removes event subscriptions', async () => {
  class FailingProcess extends FakePiRpcProcess {
    failure?: (error: Error) => void
    onFailure(handler: (error: Error) => void) {
      this.failure = handler
      return () => {
        this.failure = undefined
      }
    }
  }
  const conn = new FakeAgentSideConnection()
  const proc = new FailingProcess()
  new PiAcpSession({
    sessionId: 'failure',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  send(proc, snapshot('active'))
  send(proc, snapshot('done', 'finished', 'completed'))
  proc.failure?.(new Error('subprocess exited'))
  send(proc, snapshot('late'))
  await tick()
  const cards = conn.updates.map(u => u.update).filter(u => 'toolCallId' in u)
  assert.equal(cards.length, 3)
  assert.deepEqual(cards[2], { sessionUpdate: 'tool_call_update', toolCallId: 'pi-subagent-active', status: 'failed' })
  assert.equal(proc.failure, undefined)
})

test('card tracker keeps monotonic status, bounded tombstones, and clears on failure', () => {
  const cards = new SubagentCards()
  const update = (run: string, status = 'in_progress') => cards.update(JSON.stringify(snapshot(run, 'text', status)))
  assert.ok(update('a'))
  assert.equal(update('a', 'pending'), undefined)
  assert.ok(update('a', 'completed'))
  assert.equal(update('a'), undefined)
  for (let i = 1; i < 4096; i++) assert.ok(update(String(i), 'completed'))
  assert.equal(update('overflow'), undefined)
  assert.deepEqual(cards.fail(), [])
  assert.ok(update('fresh'))
  assert.deepEqual(cards.fail(), [
    { sessionUpdate: 'tool_call_update', toolCallId: 'pi-subagent-fresh', status: 'failed' }
  ])
})
