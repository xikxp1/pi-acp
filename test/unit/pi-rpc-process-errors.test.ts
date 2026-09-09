import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function createProcess(stdin: Writable) {
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdin, stdout })
  const Constructor = PiRpcProcess as unknown as new (child: ChildProcessWithoutNullStreams) => PiRpcProcess
  const proc = new Constructor(child as unknown as ChildProcessWithoutNullStreams)
  return {
    proc,
    child,
    cleanup: () => {
      stdin.destroy()
      stdout.destroy()
    }
  }
}

test('stdin EPIPE rejects concurrent and future requests without an unhandled error', async t => {
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(error))
    }
  })
  const { proc, cleanup } = createProcess(stdin)
  t.after(cleanup)

  await Promise.all([assert.rejects(proc.getState(), error), assert.rejects(proc.getAvailableModels(), error)])
  // Let the stream emit its error separately from the write callback.
  await new Promise<void>(resolve => setImmediate(resolve))
  await assert.rejects(proc.getState(), error)
  await assert.rejects(proc.sendExtensionUiResponse({ id: 'ui', cancelled: true }), error)
})

test('stdin close rejects pending requests and future writes', async t => {
  const stdin = new PassThrough()
  const { proc, cleanup } = createProcess(stdin)
  t.after(cleanup)
  const pending = assert.rejects(proc.getState(), /stdin closed/)
  stdin.destroy()
  await pending
  await assert.rejects(proc.getState(), /stdin closed/)
})

test('process exit rejects pending and future requests', async t => {
  const { proc, child, cleanup } = createProcess(new PassThrough())
  t.after(cleanup)
  const pending = assert.rejects(proc.getState(), /pi process exited/)
  child.emit('exit', 1, null)
  await pending
  await assert.rejects(proc.getState(), /pi process exited/)
})

test('writes to already destroyed stdin reject before the close event', async t => {
  const stdin = new PassThrough()
  const { proc, cleanup } = createProcess(stdin)
  t.after(cleanup)
  stdin.destroy()
  await assert.rejects(proc.getState(), /stdin is not writable/)
})
