import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveTurn, committedMessages } from '../../src/acp/live-turn.js'

test('LiveTurn: snapshots streamed text and pending tool calls', () => {
  const live = new LiveTurn()
  live.resetMessage(1)
  live.appendDelta('agent_thought_chunk', 'think')
  live.appendDelta('agent_message_chunk', 'hel')
  live.appendDelta('agent_message_chunk', 'lo')
  live.record({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'read', status: 'pending' })
  live.record({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', rawInput: { path: 'x' } })
  live.record({ sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed' })

  assert.deepEqual(live.snapshot(), [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'a',
      title: 'read',
      status: 'in_progress',
      rawInput: { path: 'x' },
      content: undefined
    }
  ])
})

test('LiveTurn: accumulates emulated terminal output and drops client terminals', () => {
  const live = new LiveTurn()
  live.record({
    sessionUpdate: 'tool_call',
    toolCallId: 'b',
    title: 'ls',
    status: 'in_progress',
    content: [{ type: 'terminal', terminalId: 'b' }],
    _meta: { terminal_info: { terminal_id: 'b', cwd: '/' } }
  })
  live.record({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'b',
    _meta: { terminal_output: { terminal_id: 'b', data: 'one\n' } }
  })
  live.record({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'b',
    _meta: { terminal_output: { terminal_id: 'b', data: 'two\n' } }
  })
  live.record({
    sessionUpdate: 'tool_call',
    toolCallId: 'c',
    title: 'make',
    content: [{ type: 'terminal', terminalId: 'client-term' }]
  })

  const [b, output, c] = live.snapshot()
  assert.deepEqual((b as { content: unknown }).content, [{ type: 'terminal', terminalId: 'b' }])
  assert.deepEqual(output, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'b',
    _meta: { terminal_output: { terminal_id: 'b', data: 'one\ntwo\n' } }
  })
  assert.deepEqual((c as { content: unknown }).content, [])
})

test('LiveTurn: committed messages are not repeated in the snapshot', () => {
  const live = new LiveTurn()
  live.resetMessage(42)
  live.appendDelta('agent_message_chunk', 'done')
  live.record({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x' })
  live.record({ sessionUpdate: 'tool_call', toolCallId: 'u', title: 'y' })
  const committed = committedMessages({
    messages: [
      { role: 'assistant', timestamp: 42, content: [] },
      { role: 'toolResult', toolCallId: 't' }
    ]
  })
  assert.deepEqual(
    live.snapshot(committed).map(u => u.sessionUpdate + ('toolCallId' in u ? `:${u.toolCallId}` : '')),
    ['tool_call:u']
  )

  live.commitTool('t')
  live.commitTool('u')
  live.resetMessage()
  assert.deepEqual(live.snapshot(), [])
})
