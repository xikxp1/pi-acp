import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

import { bounded, nextTick } from '../helpers/rpc-child.js'

for (const concurrent of [false, true])
  test(`loadSession replays notifications and tool calls in order (concurrent live cards: ${concurrent})`, async t => {
    const originalSpawn = PiRpcProcess.spawn
    const proc = new FakePiRpcProcess()
    proc.getMessages = async () => ({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'assistant once' }] },
        { role: 'custom', customType: 'subagent-notification', display: false, content: 'secret' },
        {
          role: 'custom',
          customType: 'subagent-notification',
          display: true,
          content: [
            { type: 'text', text: 'review done' },
            { type: 'image', data: 'ignored' }
          ]
        },
        { role: 'custom', display: true, content: 'string notification' },
        {
          role: 'custom',
          customType: 'subagent-notification',
          display: true,
          content:
            '<task-notification><task-id>a</task-id><summary>Done</summary><result>Review</result></task-notification>',
          details: {
            id: 'a',
            description: 'Review',
            status: 'completed',
            toolUses: 1,
            durationMs: 10,
            resultPreview: 'Review preview',
            others: [
              {
                id: 'b',
                description: 'Tests',
                status: 'failed',
                toolUses: 2,
                durationMs: 20,
                resultPreview: 'Test preview',
                error: 'Failed',
                outputFile: '/tmp/test.txt'
              }
            ]
          }
        },
        {
          role: 'toolResult',
          toolName: 'Agent',
          toolCallId: 'call',
          details: { description: 'Review changes', subagentType: 'reviewer' },
          content: [{ type: 'text', text: 'result' }]
        },
        {
          role: 'toolResult',
          toolName: 'Agent',
          toolCallId: 'display',
          details: { displayName: 'Named worker', description: 'Tests' },
          content: []
        }
      ]
    })
    PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess
    try {
      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn))
      Object.defineProperty(agent, 'store', {
        value: {
          get: () => ({
            sessionId: 's1',
            cwd: '/tmp/project',
            sessionFile: '/tmp/s.jsonl',
            updatedAt: new Date().toISOString()
          }),
          upsert: () => {}
        }
      })
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      t.after(() => release())
      let started!: () => void
      const replayStarted = new Promise<void>(resolve => {
        started = resolve
      })
      const originalUpdate = conn.sessionUpdate.bind(conn)
      conn.sessionUpdate = async msg => {
        await originalUpdate(msg)
        if (
          concurrent &&
          msg.update.sessionUpdate === 'agent_message_chunk' &&
          msg.update.content.type === 'text' &&
          msg.update.content.text === 'assistant once'
        ) {
          started()
          await blocked
        }
      }
      const loading = agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] })
      if (concurrent) {
        await bounded(replayStarted)
        for (const status of ['in_progress', 'completed'])
          proc.emit({
            type: 'extension_ui_request',
            method: 'setStatus',
            statusKey: 'pi-acp:subagent',
            statusText: JSON.stringify({
              version: 1,
              agentId: 'worker',
              runId: 'live',
              title: 'Live review',
              status,
              text: status
            })
          })
        await bounded(nextTick())
        assert.deepEqual(
          conn.updates
            .map(u => u.update)
            .filter(u => 'toolCallId' in u)
            .map(u => u.sessionUpdate),
          ['tool_call', 'tool_call_update']
        )
        release()
      }
      await bounded(loading)
      const updates = conn.updates.map(u => u.update)
      assert.deepEqual(
        updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content),
        [
          { type: 'text', text: 'assistant once' },
          { type: 'text', text: '\nreview done\n' },
          { type: 'text', text: '\nstring notification\n' },
          {
            type: 'text',
            text: '\nSubagent: Review (a)\n\nStatus: completed\n\nTool uses: 1\n\nDuration: 10 ms\n\nResult:\nReview preview\n\nSubagent: Tests (b)\n\nStatus: failed\n\nTool uses: 2\n\nDuration: 20 ms\n\nResult:\nTest preview\n\nError: Failed\n\nOutput file: /tmp/test.txt\n'
          }
        ]
      )
      assert.deepEqual(
        updates
          .filter(u => u.sessionUpdate === 'agent_message_chunk' || 'toolCallId' in u)
          .map(u => ('toolCallId' in u ? `${u.sessionUpdate}:${u.toolCallId}` : u.sessionUpdate)),
        [
          'agent_message_chunk',
          ...(concurrent ? ['tool_call:pi-subagent-live', 'tool_call_update:pi-subagent-live'] : []),
          'agent_message_chunk',
          'agent_message_chunk',
          'agent_message_chunk',
          'tool_call:call',
          'tool_call_update:call',
          'tool_call:display',
          'tool_call_update:display'
        ]
      )
      const call = updates.find(u => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call')
      assert.ok(call && call.sessionUpdate === 'tool_call')
      assert.equal(call.title, 'Agent (reviewer): Review changes')
      const named = updates.find(u => u.sessionUpdate === 'tool_call' && u.toolCallId === 'display')
      assert.ok(named && named.sessionUpdate === 'tool_call')
      assert.equal(named.title, 'Agent (Named worker): Tests')
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  })
