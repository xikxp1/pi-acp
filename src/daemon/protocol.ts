import type { Socket } from 'node:net'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPiAcpDir } from '../acp/paths.js'

/** Version of the attach <-> daemon handshake (the ACP traffic after it is passed through untouched). */
export const DAEMON_PROTOCOL = 1

const MAX_HANDSHAKE_BYTES = 64 * 1024

export type DaemonControl = 'status' | 'stop'

export type ClientHello = {
  type: 'hello'
  protocol: number
  version: string
  control?: DaemonControl
}

export type DaemonSessionStatus = {
  sessionId: string
  cwd: string
  busy: boolean
  attached: boolean
  detachedAt?: string
}

export type DaemonStatus = {
  pid: number
  version: string
  startedAt: string
  connections: number
  sessions: DaemonSessionStatus[]
}

export type DaemonHello = {
  type: 'hello'
  protocol: number
  version: string
  pid: number
  /** The daemon agreed to exit so the client can start one matching its version. */
  restart?: boolean
  status?: DaemonStatus
  error?: string
}

export type DaemonPaths = { dir: string; socket: string; log: string }

export function getDaemonPaths(env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const dir = env.PI_ACP_DAEMON_DIR?.trim() || join(getPiAcpDir(), 'daemon')
  return { dir, socket: join(dir, 'daemon.sock'), log: join(dir, 'daemon.log') }
}

/** The socket grants full control of the user's pi sessions; only the owner may reach it. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/**
 * Read one newline-terminated line, leaving the socket paused with any bytes after the
 * newline returned in `rest`, so the caller can hand the stream to another consumer.
 */
export function readHandshakeLine(socket: Socket, timeoutMs = 10_000): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('end', onClosed)
      socket.off('close', onClosed)
      socket.off('error', onError)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline === -1) {
        if (buffer.length > MAX_HANDSHAKE_BYTES) fail(new Error('pi-acp daemon handshake too large'))
        return
      }
      socket.pause()
      cleanup()
      resolve({ line: buffer.subarray(0, newline).toString('utf8'), rest: buffer.subarray(newline + 1) })
    }
    const onClosed = () => fail(new Error('pi-acp daemon connection closed during handshake'))
    const onError = (error: Error) => fail(error)
    const timer = setTimeout(() => fail(new Error('pi-acp daemon handshake timed out')), timeoutMs)
    socket.on('data', onData)
    socket.once('end', onClosed)
    socket.once('close', onClosed)
    socket.once('error', onError)
    socket.resume()
  })
}

export function writeHandshakeLine(socket: Socket, message: ClientHello | DaemonHello): void {
  socket.write(`${JSON.stringify(message)}\n`)
}

export function parseHello<T extends ClientHello | DaemonHello>(line: string): T | undefined {
  try {
    const value = JSON.parse(line) as Partial<T> | null
    if (value?.type !== 'hello' || typeof value.protocol !== 'number' || typeof value.version !== 'string') return
    return value as T
  } catch {
    return undefined
  }
}

/** Web streams over a socket, starting with bytes already consumed during the handshake. */
export function socketStreams(
  socket: Socket,
  rest: Buffer = Buffer.alloc(0)
): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        try {
          if (error) controller.error(error)
          else controller.close()
        } catch {
          // already closed
        }
      }
      if (rest.length) controller.enqueue(new Uint8Array(rest))
      socket.on('data', (chunk: Buffer) => {
        if (!done) controller.enqueue(new Uint8Array(chunk))
      })
      socket.once('end', () => finish())
      socket.once('close', () => finish())
      socket.once('error', error => finish(error))
      socket.resume()
    }
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>(resolve => {
        if (socket.destroyed || !socket.writable) return resolve()
        try {
          socket.write(chunk, () => resolve())
        } catch {
          resolve()
        }
      })
    },
    close() {
      socket.end()
    }
  })
  return { readable, writable }
}
