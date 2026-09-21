import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'
import { bounded, createRpcChild } from '../helpers/rpc-child.js'

function fixture(t: TestContext) {
  const rpc = createRpcChild({ respond: () => false })
  t.after(rpc.cleanup)
  const events: PiRpcEvent[] = []
  rpc.proc.onEvent(event => events.push(event))
  return { ...rpc, events }
}

function textEvent(delta: string): PiRpcEvent {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }
}

for (const text of ['before\u2028after', 'before\u2029after', 'before\u2028middle\u2029after']) {
  test(`RPC framing preserves Unicode separators ${JSON.stringify(text)}`, t => {
    const { proc, child, events } = fixture(t)
    const expected = [textEvent(text), textEvent(`${text} continued`), { type: 'agent_settled' }]
    child.stdout.write(expected.map(event => JSON.stringify(event)).join('\n') + '\n')
    assert.deepEqual(events, expected)
    assert.deepEqual(proc.consumePreludeLines(), [])
  })
}

test('RPC framing correlates responses containing Unicode separators', async t => {
  const { proc, child, commands, events } = fixture(t)
  const result = proc.getState()
  const data = { sessionName: 'before\u2028middle\u2029after' }
  child.stdout.write(
    JSON.stringify({ type: 'response', id: commands[0]!.id, command: 'get_state', success: true, data }) + '\n'
  )
  assert.deepEqual(await bounded(result), data)
  assert.deepEqual(events, [])
  assert.deepEqual(proc.consumePreludeLines(), [])
})

test('RPC framing decodes UTF-8 split across byte boundaries and waits for LF', t => {
  const { proc, child, events } = fixture(t)
  const expected = textEvent('café 漢字 🙂 \u2028 \u2029')
  const bytes = Buffer.from(JSON.stringify(expected))
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
  assert.deepEqual(events, [])
  child.stdout.write('\n')
  assert.deepEqual(events, [expected])
  assert.deepEqual(proc.consumePreludeLines(), [])
})

test('RPC framing accepts split CRLF, blank lines, and multiple records per chunk', t => {
  const { proc, child, events } = fixture(t)
  const first = textEvent('first')
  const second = textEvent('second\nline\rreturn')
  child.stdout.write('\n \t\r\n' + JSON.stringify(first) + '\r')
  assert.deepEqual(events, [])
  child.stdout.write('\n' + JSON.stringify(second) + '\r\n\n')
  assert.deepEqual(events, [first, second])
  assert.deepEqual(proc.consumePreludeLines(), [])
})

test('RPC framing preserves prelude capture without treating bare CR or Unicode separators as delimiters', t => {
  const { proc, child, events } = fixture(t)
  child.stdout.write('\u001b[32mPi banner\u001b[0m\rSkills\u2028Extensions\u2029Prompts')
  assert.deepEqual(proc.consumePreludeLines(), [])
  child.stdout.write('\r\n' + JSON.stringify(textEvent('ready')) + '\n')
  assert.deepEqual(proc.consumePreludeLines(), ['Pi banner\rSkills\u2028Extensions\u2029Prompts'])
  assert.deepEqual(proc.consumePreludeLines(), [])
  assert.deepEqual(events, [textEvent('ready')])
})

test('RPC framing accepts streams already decoded as strings', t => {
  const { child, events } = fixture(t)
  child.stdout.setEncoding('utf8')
  const expected = textEvent('hello\u2028世界\u2029🙂')
  child.stdout.write(JSON.stringify(expected) + '\n')
  assert.deepEqual(events, [expected])
})

test('RPC framing flushes a final unterminated response at EOF', async t => {
  const { proc, child, commands, events } = fixture(t)
  const result = proc.getState()
  const data = { sessionName: 'final\u2028🙂' }
  const ended = once(child.stdout, 'end')
  child.stdout.end(JSON.stringify({ type: 'response', id: commands[0]!.id, command: 'get_state', success: true, data }))
  await bounded(ended)
  assert.deepEqual(await bounded(result), data)
  assert.deepEqual(events, [])
  assert.deepEqual(proc.consumePreludeLines(), [])
})

test('RPC framing flushes pending decoder bytes into the final prelude at EOF', async t => {
  const { proc, child, events } = fixture(t)
  child.stdout.write(Buffer.concat([Buffer.from('incomplete '), Buffer.from([0xe2, 0x80])]))
  const ended = once(child.stdout, 'end')
  child.stdout.end()
  await bounded(ended)
  assert.deepEqual(proc.consumePreludeLines(), ['incomplete \ufffd'])
  assert.deepEqual(events, [])
})

for (const failure of ['dispose', 'exit', 'error'] as const) {
  test(`RPC framing stops reading and rejects pending requests after ${failure}`, async t => {
    const { proc, child, events } = fixture(t)
    const rejected = assert.rejects(proc.getState(), /disposed|exited|test error/)
    child.stdout.write('{"type":"partial')
    if (failure === 'dispose') proc.dispose()
    else if (failure === 'exit') child.emit('exit', 1, null)
    else child.emit('error', new Error('test error'))
    await bounded(rejected)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stdout.listenerCount('end'), 0)
    child.stdout.emit('data', Buffer.from('"}\n' + JSON.stringify(textEvent('late')) + '\nlate prelude'))
    child.stdout.emit('end')
    assert.deepEqual(events, [])
    assert.deepEqual(proc.consumePreludeLines(), [])
  })
}

test('RPC framing stops processing a chunk when an event handler disposes the process', t => {
  const { proc, child, events } = fixture(t)
  const first = textEvent('first')
  proc.onEvent(() => proc.dispose())
  child.stdout.write(JSON.stringify(first) + '\n' + JSON.stringify(textEvent('late')) + '\nlate prelude\n')
  assert.deepEqual(events, [first])
  assert.deepEqual(proc.consumePreludeLines(), [])
})
