import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { bounded, createRpcChild } from '../helpers/rpc-child.js'

test('PiRpcProcess.spawn opts the child into subagent bridging even when env disables it', async t => {
  const rpc = createRpcChild()
  t.after(rpc.cleanup)
  const stderr = new PassThrough()
  Object.assign(rpc.child, { stderr })
  t.after(() => stderr.destroy())
  let options: SpawnOptions | undefined
  t.mock.method(childProcess, 'spawn', (_command: string, _args: string[], opts: SpawnOptions) => {
    options = opts
    setImmediate(() => rpc.child.emit('spawn'))
    return rpc.child as unknown as ChildProcessWithoutNullStreams
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const proc = await bounded(PiRpcProcess.spawn({ cwd: process.cwd(), env: { PI_ACP_SUBAGENTS: '0' } }))
  t.after(() => proc.dispose())
  assert.equal(options?.env?.PI_ACP_SUBAGENTS, '1')
})
