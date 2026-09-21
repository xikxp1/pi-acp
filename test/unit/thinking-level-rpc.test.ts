import test from 'node:test'
import assert from 'node:assert/strict'
import { bounded, createRpcChild } from '../helpers/rpc-child.js'

const validLevels = [
  { name: 'model without thinking support', levels: ['off'] },
  { name: 'model with max thinking', levels: ['off', 'high', 'max'] },
  {
    name: 'opaque values, order, duplicates, and whitespace',
    levels: ['vendor:future', ' high ', 'off', 'vendor:future', ' ']
  }
]

for (const { name, levels } of validLevels) {
  test(`thinking-level discovery preserves ${name}`, async t => {
    const rpc = createRpcChild({ respond: () => false })
    t.after(rpc.cleanup)
    const result = rpc.proc.getAvailableThinkingLevels()
    assert.equal(rpc.commands[0]!.type, 'get_available_thinking_levels')
    rpc.respond(rpc.commands[0]!, true, { data: { levels } })
    assert.deepEqual(await bounded(result), levels)
  })
}

const invalidData: Array<{ name: string; data: unknown }> = [
  { name: 'missing data', data: undefined },
  { name: 'null data', data: null },
  { name: 'primitive data', data: 'off' },
  { name: 'missing levels', data: {} },
  { name: 'bare levels array', data: ['off'] },
  { name: 'null levels', data: { levels: null } },
  { name: 'non-array levels', data: { levels: 'off' } },
  { name: 'empty levels', data: { levels: [] } },
  { name: 'empty string level', data: { levels: ['off', ''] } },
  { name: 'number level', data: { levels: ['off', 1] } },
  { name: 'null level', data: { levels: ['off', null] } },
  { name: 'boolean level', data: { levels: [false] } },
  { name: 'object level', data: { levels: [{ level: 'off' }] } },
  { name: 'nested array level', data: { levels: [['off']] } }
]

for (const { name, data } of invalidData) {
  test(`thinking-level discovery rejects ${name}`, async t => {
    const rpc = createRpcChild({ respond: () => false })
    t.after(rpc.cleanup)
    const rejection = assert.rejects(
      rpc.proc.getAvailableThinkingLevels(),
      /get_available_thinking_levels returned invalid data: expected a nonempty levels array of nonempty strings/
    )
    rpc.respond(rpc.commands[0]!, true, { data })
    await bounded(rejection)
  })
}

for (const error of ['Unknown command: get_available_thinking_levels', 'model discovery failed']) {
  test(`thinking-level discovery rejects failed RPC: ${error}`, async t => {
    const rpc = createRpcChild({ respond: () => false })
    t.after(rpc.cleanup)
    const rejection = assert.rejects(rpc.proc.getAvailableThinkingLevels(), failure => {
      assert.ok(failure instanceof Error)
      assert.ok(failure.message.includes(`get_available_thinking_levels failed: ${error}`))
      assert.match(failure.message, /requires Pi 0\.81\.0\+/)
      return true
    })
    rpc.respond(rpc.commands[0]!, false, { error, data: { levels: ['off'] } })
    await bounded(rejection)
  })
}

for (const level of ['off', 'max', 'vendor:future', ' high ']) {
  test(`setThinkingLevel forwards ${JSON.stringify(level)} unchanged`, async t => {
    const rpc = createRpcChild()
    t.after(rpc.cleanup)
    await bounded(rpc.proc.setThinkingLevel(level))
    assert.deepEqual(rpc.commands[0], { id: rpc.commands[0]!.id, type: 'set_thinking_level', level })
  })
}

test('setThinkingLevel rejects failed RPC', async t => {
  const rpc = createRpcChild({ respond: () => false })
  t.after(rpc.cleanup)
  const rejection = assert.rejects(
    rpc.proc.setThinkingLevel('vendor:future'),
    /pi set_thinking_level failed: unsupported level/
  )
  rpc.respond(rpc.commands[0]!, false, { error: 'unsupported level' })
  await bounded(rejection)
})
