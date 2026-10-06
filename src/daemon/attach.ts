import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DAEMON_PROTOCOL,
  ensurePrivateDir,
  parseHello,
  readHandshakeLine,
  writeHandshakeLine,
  type DaemonControl,
  type DaemonHello,
  type DaemonPaths
} from './protocol.js'

const START_TIMEOUT_MS = 15_000

export type AttachOptions = {
  paths: DaemonPaths
  version: string
  /** Command that starts a daemon in the foreground (it is detached by the caller). */
  daemonCommand?: { command: string; args: string[] }
  env?: NodeJS.ProcessEnv
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

export function defaultDaemonCommand(): { command: string; args: string[] } {
  // Re-run the current entrypoint (works for dist/index.js and `tsx src/index.ts`).
  return { command: process.execPath, args: [...process.execArgv, process.argv[1]!, 'daemon'] }
}

function spawnDaemon(options: AttachOptions): void {
  if (process.platform !== 'win32') ensurePrivateDir(options.paths.dir)
  const { command, args } = options.daemonCommand ?? defaultDaemonCommand()
  const log = openSync(options.paths.log, 'a', 0o600)
  try {
    // detached => new session (setsid): ssh hangups and Zed exiting do not reach the daemon.
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', log, log],
      env: options.env ?? process.env,
      // Loader flags in execArgv (e.g. `--import tsx`) resolve relative to the cwd.
      cwd: process.cwd()
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}

async function handshake(
  socket: Socket,
  options: AttachOptions,
  control?: DaemonControl
): Promise<{ hello: DaemonHello; rest: Buffer }> {
  writeHandshakeLine(socket, { type: 'hello', protocol: DAEMON_PROTOCOL, version: options.version, control })
  const { line, rest } = await readHandshakeLine(socket)
  const hello = parseHello<DaemonHello>(line)
  if (!hello) throw new Error('pi-acp daemon sent an invalid handshake')
  return { hello, rest }
}

/** Connect to a running daemon, starting (or upgrading) it when needed. */
export async function connectDaemon(options: AttachOptions): Promise<{ socket: Socket; rest: Buffer }> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let spawned = false
  let lastError: unknown
  while (Date.now() < deadline) {
    let socket: Socket
    try {
      socket = await connectSocket(options.paths.socket)
    } catch (error) {
      lastError = error
      if (!spawned) {
        spawnDaemon(options)
        spawned = true
      }
      await delay(100)
      continue
    }
    try {
      const { hello, rest } = await handshake(socket, options)
      if (hello.restart) {
        // The old daemon is exiting; start a fresh one once its socket is gone.
        socket.destroy()
        spawned = false
        await delay(200)
        continue
      }
      if (hello.error) throw new Error(`pi-acp daemon refused connection: ${hello.error}`)
      return { socket, rest }
    } catch (error) {
      socket.destroy()
      throw error
    }
  }
  throw new Error(
    `pi-acp daemon did not start within ${START_TIMEOUT_MS}ms (see ${options.paths.log}): ${String(lastError)}`
  )
}

/** Send a control request to a running daemon; returns undefined when none is running. */
export async function controlDaemon(options: AttachOptions, control: DaemonControl): Promise<DaemonHello | undefined> {
  let socket: Socket
  try {
    socket = await connectSocket(options.paths.socket)
  } catch {
    return undefined
  }
  try {
    return (await handshake(socket, options, control)).hello
  } finally {
    socket.destroy()
  }
}

/**
 * Relay this process's stdio (spawned by the ACP client, e.g. over ssh) to the daemon.
 * Losing either side ends the relay; the daemon keeps the sessions running.
 */
export async function runAttach(options: AttachOptions): Promise<number> {
  const { socket, rest } = await connectDaemon(options)
  if (rest.length) process.stdout.write(rest)

  return new Promise<number>(resolve => {
    let finished = false
    const finish = (code: number) => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(code)
    }

    process.stdin.on('data', chunk => {
      if (!socket.write(chunk)) {
        process.stdin.pause()
        socket.once('drain', () => process.stdin.resume())
      }
    })
    process.stdin.once('end', () => socket.end())
    process.stdin.once('close', () => socket.end())
    process.stdin.once('error', () => finish(0))

    socket.on('data', chunk => {
      if (!process.stdout.write(chunk)) {
        socket.pause()
        process.stdout.once('drain', () => socket.resume())
      }
    })
    socket.once('close', () => finish(0))
    socket.once('error', () => finish(1))
    process.stdout.once('error', () => finish(0))
    socket.resume()
    process.stdin.resume()
  })
}
