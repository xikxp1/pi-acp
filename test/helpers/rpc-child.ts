import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiTurnError, type StopReason } from '../../src/acp/session.js'

export type RpcCommand = { id: string; type: string; message?: string; images?: unknown[] }

export function createRpcChild(
  options: {
    sessionId?: string
    respond?: (command: RpcCommand) => boolean
    exitOnKill?: boolean
  } = {}
) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const commands: RpcCommand[] = []
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killed: false,
    kill() {
      child.killed = true
      if (options.exitOnKill) child.emit('exit', null, 'SIGTERM')
      return true
    }
  })
  const send = (event: unknown) => stdout.write(`${JSON.stringify(event)}\n`)
  const respond = (command: RpcCommand, success = true, overrides: { error?: string; data?: unknown } = {}) => {
    const data =
      command.type === 'get_state'
        ? {
            sessionId: options.sessionId ?? 'older',
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' },
            isStreaming: false,
            isCompacting: false
          }
        : command.type === 'get_available_models'
          ? { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
          : command.type === 'get_messages'
            ? { messages: [] }
            : {}
    send({
      type: 'response',
      id: command.id,
      command: command.type,
      success,
      data,
      ...(!success ? { error: 'prompt failed' } : {}),
      ...overrides
    })
  }
  let buffer = ''
  stdin.on('data', chunk => {
    buffer += String(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const command = JSON.parse(buffer.slice(0, newline)) as RpcCommand
      buffer = buffer.slice(newline + 1)
      commands.push(command)
      if (options.respond?.(command) !== false) respond(command)
    }
  })
  const Constructor = PiRpcProcess as unknown as new (child: ChildProcessWithoutNullStreams) => PiRpcProcess
  const proc = new Constructor(child as unknown as ChildProcessWithoutNullStreams)
  return {
    proc,
    child,
    commands,
    send,
    respond,
    cleanup() {
      proc.dispose()
      stdin.destroy()
      stdout.destroy()
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle within 1000ms')), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves a prompt to its stop reason, or 'error' when it rejects with PiTurnError. */
export function outcome(promise: Promise<StopReason>): Promise<StopReason | 'error'> {
  return promise.catch(err => {
    if (err instanceof PiTurnError) return 'error' as const
    throw err
  })
}

export const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))
