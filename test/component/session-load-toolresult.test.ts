import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { command: 'echo hello' },
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession titles historic tool calls from assistant toolCall arguments', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_grep',
                name: 'grep',
                arguments: { pattern: 'foo', path: '/tmp/project/src' }
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_grep',
            toolName: 'grep',
            content: [{ type: 'text', text: 'src/a.ts:1:foo' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_orphan',
            toolName: 'read',
            content: [{ type: 'text', text: 'x' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const toolCalls = conn.updates.map(u => (u as any).update).filter(u => u?.sessionUpdate === 'tool_call')
    assert.equal(toolCalls.length, 2)

    assert.equal(toolCalls[0].toolCallId, 'call_grep')
    assert.equal(toolCalls[0].title, 'grep "foo" in src')
    assert.equal(toolCalls[0].kind, 'search')
    assert.deepEqual(toolCalls[0].rawInput, { pattern: 'foo', path: '/tmp/project/src' })

    assert.equal(toolCalls[1].toolCallId, 'call_orphan')
    assert.equal(toolCalls[1].title, 'read')
    assert.equal(toolCalls[1].kind, 'read')
    assert.equal(toolCalls[1].rawInput, null)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays thinking, images, locations and historic diffs', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look at this' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' }
            ]
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me edit the file.' },
              { type: 'text', text: 'Editing now.' },
              {
                type: 'toolCall',
                id: 'call_edit',
                name: 'edit',
                arguments: { path: 'src/a.ts', edits: [{ oldText: 'foo', newText: 'bar' }] }
              },
              {
                type: 'toolCall',
                id: 'call_write',
                name: 'write',
                arguments: { path: '/tmp/project/b.ts', content: 'new' }
              },
              { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'src/c.ts' } }
            ]
          },
          { role: 'toolResult', toolCallId: 'call_edit', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] },
          { role: 'toolResult', toolCallId: 'call_write', toolName: 'write', content: [{ type: 'text', text: 'ok' }] },
          {
            role: 'toolResult',
            toolCallId: 'call_read',
            toolName: 'read',
            content: [{ type: 'text', text: 'ENOENT' }],
            isError: true
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
    const updates = conn.updates.map(u => (u as any).update)

    const userChunks = updates.filter(u => u?.sessionUpdate === 'user_message_chunk')
    assert.deepEqual(
      userChunks.map(u => u.content),
      [
        { type: 'text', text: 'look at this' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    )

    const thought = updates.find(u => u?.sessionUpdate === 'agent_thought_chunk')
    assert.deepEqual(thought?.content, { type: 'text', text: 'Let me edit the file.' })
    const thoughtIx = updates.indexOf(thought)
    const textIx = updates.findIndex(
      u => u?.sessionUpdate === 'agent_message_chunk' && u.content?.text === 'Editing now.'
    )
    assert.ok(thoughtIx < textIx)

    const calls = Object.fromEntries(updates.filter(u => u?.sessionUpdate === 'tool_call').map(u => [u.toolCallId, u]))
    assert.deepEqual(calls.call_edit.locations, [{ path: '/tmp/project/src/a.ts' }])
    assert.deepEqual(calls.call_write.locations, [{ path: '/tmp/project/b.ts' }])
    assert.deepEqual(calls.call_read.locations, [{ path: '/tmp/project/src/c.ts' }])

    const results = Object.fromEntries(
      updates.filter(u => u?.sessionUpdate === 'tool_call_update').map(u => [u.toolCallId, u])
    )
    assert.deepEqual(results.call_edit.content, [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }])
    assert.equal(results.call_edit.rawOutput, undefined)
    assert.deepEqual(results.call_write.content, [
      { type: 'diff', path: '/tmp/project/b.ts', oldText: null, newText: 'new' }
    ])
    assert.equal(results.call_read.status, 'failed')
    assert.deepEqual(results.call_read.content, [{ type: 'content', content: { type: 'text', text: 'ENOENT' } }])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
