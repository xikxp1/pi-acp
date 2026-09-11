import test from 'node:test'
import assert from 'node:assert/strict'
import { PiRpcPromptBusyError } from '../../src/pi-rpc/process.js'
import { bounded, createRpcChild } from '../helpers/rpc-child.js'

const knownBusyErrors = [
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
  'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
]

for (const message of [...knownBusyErrors, 'provider is busy', 'Agent is already processing. unknown failure']) {
  test(`prompt rejection classification: ${message}`, async t => {
    const rpc = createRpcChild({ respond: () => false })
    t.after(rpc.cleanup)
    const result = rpc.proc.prompt('one')
    const rejection = assert.rejects(result, error => {
      assert.ok(error instanceof Error)
      assert.equal(error instanceof PiRpcPromptBusyError, knownBusyErrors.includes(message))
      if (error instanceof PiRpcPromptBusyError) {
        assert.equal(error.activity, message === knownBusyErrors[0] ? 'agent' : 'compaction')
      }
      assert.equal(error.message, `pi prompt failed: ${message}`)
      return true
    })
    rpc.respond(rpc.commands[0]!, false, { error: message })
    await bounded(rejection)
  })
}

test('busy-state reconciliation can bound get_state and ignores its late response', async t => {
  const rpc = createRpcChild({ respond: () => false })
  t.after(rpc.cleanup)
  await bounded(assert.rejects(rpc.proc.getState(1), /get_state timed out/))
  const expired = rpc.commands[0]!
  const next = rpc.proc.getState()
  rpc.respond(expired)
  rpc.respond(rpc.commands[1]!)
  assert.ok(await bounded(next))
})
