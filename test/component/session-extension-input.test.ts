import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { CreateElicitationResponse } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture(t: TestContext) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    clientSupportsFormElicitation: true
  })
  t.after(() => session.dispose())
  return { conn, proc }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

const cases: Array<{
  name: string
  response: CreateElicitationResponse
  expected: { value: string } | { cancelled: true }
}> = [
  {
    name: 'entered text',
    response: { action: 'accept', content: { answer: 'Some context' } },
    expected: { value: 'Some context' }
  },
  { name: 'explicit empty string', response: { action: 'accept', content: { answer: '' } }, expected: { value: '' } },
  { name: 'omitted blank field from Zed', response: { action: 'accept', content: {} }, expected: { value: '' } },
  { name: 'omitted content', response: { action: 'accept' }, expected: { value: '' } },
  {
    name: 'untrimmed whitespace',
    response: { action: 'accept', content: { answer: ' \n\t ' } },
    expected: { value: ' \n\t ' }
  },
  { name: 'decline', response: { action: 'decline' }, expected: { cancelled: true } },
  {
    name: 'cancel',
    response: { action: 'cancel' },
    expected: { cancelled: true }
  },
  { name: 'non-string number', response: { action: 'accept', content: { answer: 0 } }, expected: { cancelled: true } },
  {
    name: 'non-string boolean',
    response: { action: 'accept', content: { answer: false } },
    expected: { cancelled: true }
  },
  { name: 'non-string array', response: { action: 'accept', content: { answer: [] } }, expected: { cancelled: true } }
]

for (const method of ['input', 'editor'] as const) {
  for (const { name, response, expected } of cases) {
    test(`extension ${method}: ${name}`, async t => {
      const { conn, proc } = fixture(t)
      conn.nextElicitationResponse = response
      proc.emit({
        type: 'extension_ui_request',
        id: 'ui-text',
        method,
        title: 'Enter text',
        ...(method === 'input' ? { placeholder: 'Any text' } : { prefill: 'Existing draft' })
      })
      await tick()
      assert.deepEqual(conn.elicitationRequests, [
        {
          mode: 'form',
          sessionId: 's1',
          message: 'Enter text',
          requestedSchema: {
            type: 'object',
            properties: {
              answer: {
                type: 'string',
                title: method === 'input' ? 'Answer' : 'Text',
                ...(method === 'input' ? { description: 'Any text' } : { default: 'Existing draft' })
              }
            }
          }
        }
      ])
      // Clearing an editor must not restore its prefill or become cancellation.
      assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-text', ...expected }])
    })
  }

  test(`extension ${method}: elicitation failure remains cancellation`, async t => {
    const { conn, proc } = fixture(t)
    conn.unstable_createElicitation = async () => {
      throw new Error('Disconnected')
    }
    proc.emit({ type: 'extension_ui_request', id: 'ui-error', method, title: 'Enter text' })
    await tick()
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-error', cancelled: true }])
  })
}

test('ask_user dialogs: select an answer then submit the optional comment blank', async t => {
  const { conn, proc } = fixture(t)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  proc.emit({
    type: 'extension_ui_request',
    id: 'selection',
    method: 'select',
    title: 'Choose one',
    options: ['First', 'Second']
  })
  await tick()
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'selection', value: 'First' }])

  conn.nextElicitationResponse = { action: 'accept', content: {} }
  proc.emit({
    type: 'extension_ui_request',
    id: 'comment',
    method: 'input',
    title: 'Add context for your selection',
    placeholder: 'Optional comment (press Enter to skip)...'
  })
  await tick()
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'selection', value: 'First' },
    { id: 'comment', value: '' }
  ])
})
