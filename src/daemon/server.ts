import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { PiAcpAgent } from '../acp/agent.js'
import { DEFAULT_DETACHED_INPUT_TIMEOUT_MS } from '../acp/client-link.js'
import { AgentRuntime } from '../acp/runtime.js'
import { compareVersions } from '../version.js'
import {
  DAEMON_PROTOCOL,
  ensurePrivateDir,
  parseHello,
  readHandshakeLine,
  socketStreams,
  writeHandshakeLine,
  type ClientHello,
  type DaemonHello,
  type DaemonPaths,
  type DaemonStatus
} from './protocol.js'

export const DEFAULT_SESSION_IDLE_MS = 2 * 60 * 60 * 1000
export const DEFAULT_EXIT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_REAP_INTERVAL_MS = 30 * 1000

export type DaemonOptions = {
  paths: DaemonPaths
  version: string
  /** Close a session's pi process after it was detached and idle this long. */
  sessionIdleMs?: number
  /** Exit after having no connections and no sessions this long. */
  exitIdleMs?: number
  detachedInputTimeoutMs?: number
  reapIntervalMs?: number
  log?: (message: string) => void
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid?: number) {
    super(`pi-acp daemon already running${pid ? ` (pid ${pid})` : ''}`)
    this.name = 'DaemonAlreadyRunningError'
  }
}

type Connection = { socket: Socket; agent?: PiAcpAgent }

/**
 * Long-lived owner of pi sessions. Each `pi-acp attach` relay becomes one ACP connection;
 * sessions survive disconnects and are reattached by `session/load` / `session/resume`.
 */
export class PiAcpDaemon {
  readonly runtime: AgentRuntime
  private readonly server: Server
  private readonly connections = new Set<Connection>()
  private readonly idleSince = new Map<string, number>()
  private readonly startedAt = new Date()
  private lastActivity = Date.now()
  private reaper: ReturnType<typeof setInterval> | undefined
  private stale = false
  private stopping: Promise<void> | undefined
  private lockHeld = false
  private resolveStopped!: () => void
  /** Resolves once the daemon has shut down. */
  readonly stopped = new Promise<void>(resolve => (this.resolveStopped = resolve))

  constructor(private readonly options: DaemonOptions) {
    this.runtime = new AgentRuntime({
      durable: true,
      detachedInputTimeoutMs: options.detachedInputTimeoutMs ?? DEFAULT_DETACHED_INPUT_TIMEOUT_MS
    })
    this.server = createServer(socket => void this.accept(socket))
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  private get lockPath(): string {
    return `${this.options.paths.socket}.lock`
  }

  async start(): Promise<void> {
    const { paths } = this.options
    if (process.platform !== 'win32') ensurePrivateDir(paths.dir)
    this.acquireLock()
    try {
      if (process.platform !== 'win32' && existsSync(paths.socket)) {
        if (await canConnect(paths.socket)) throw new DaemonAlreadyRunningError()
        unlinkSync(paths.socket)
      }
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(paths.socket, () => {
          this.server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.releaseLock()
      throw error
    }
    this.server.on('error', error => this.log(`server error: ${error.message}`))
    this.reaper = setInterval(() => this.reap(), this.options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS)
    this.reaper.unref?.()
    this.log(`listening on ${paths.socket} (pid ${process.pid}, version ${this.options.version})`)
  }

  status(): DaemonStatus {
    return {
      pid: process.pid,
      version: this.options.version,
      startedAt: this.startedAt.toISOString(),
      connections: this.connections.size,
      sessions: this.runtime.sessions.list().map(session => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        busy: session.busy,
        attached: session.link.attached !== null,
        ...(session.link.detachedAt !== undefined
          ? { detachedAt: new Date(session.link.detachedAt).toISOString() }
          : {})
      }))
    }
  }

  stop(reason = 'stop requested'): Promise<void> {
    this.stopping ??= (async () => {
      this.log(`stopping: ${reason}`)
      if (this.reaper) clearInterval(this.reaper)
      await new Promise<void>(resolve => {
        this.server.close(() => resolve())
        for (const { socket } of this.connections) socket.destroy()
      })
      this.runtime.sessions.disposeAll()
      if (process.platform !== 'win32') {
        try {
          unlinkSync(this.options.paths.socket)
        } catch {
          // already gone
        }
      }
      this.releaseLock()
      this.resolveStopped()
    })()
    return this.stopping
  }

  private hasBusySessions(): boolean {
    return this.runtime.sessions.list().some(session => session.busy)
  }

  /** Close idle detached sessions; exit when nothing is left to serve. */
  reap(now = Date.now()): void {
    if (this.stopping) return
    const sessions = this.runtime.sessions.list()
    const live = new Set(sessions.map(session => session.sessionId))
    for (const id of this.idleSince.keys()) if (!live.has(id)) this.idleSince.delete(id)

    const sessionIdleMs = this.options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS
    for (const session of sessions) {
      if (session.link.attached || session.busy) {
        this.idleSince.delete(session.sessionId)
        continue
      }
      const since = this.idleSince.get(session.sessionId) ?? now
      this.idleSince.set(session.sessionId, since)
      if (now - since >= sessionIdleMs) {
        this.log(`closing idle detached session ${session.sessionId}`)
        this.runtime.sessions.close(session.sessionId)
        this.idleSince.delete(session.sessionId)
      }
    }

    if (this.connections.size > 0) {
      this.lastActivity = now
      return
    }
    if (this.stale && !this.hasBusySessions()) {
      void this.stop('superseded by a newer pi-acp version')
      return
    }
    if (this.runtime.sessions.list().length > 0) {
      this.lastActivity = now
      return
    }
    if (now - this.lastActivity >= (this.options.exitIdleMs ?? DEFAULT_EXIT_IDLE_MS)) {
      void this.stop('idle')
    }
  }

  private async accept(socket: Socket): Promise<void> {
    socket.on('error', () => socket.destroy())
    const reply = (message: Omit<DaemonHello, 'type' | 'protocol' | 'version' | 'pid'>) =>
      writeHandshakeLine(socket, {
        type: 'hello',
        protocol: DAEMON_PROTOCOL,
        version: this.options.version,
        pid: process.pid,
        ...message
      })

    let hello: ClientHello | undefined
    let rest: Buffer
    try {
      const read = await readHandshakeLine(socket)
      hello = parseHello<ClientHello>(read.line)
      rest = read.rest
    } catch {
      socket.destroy()
      return
    }

    if (!hello || hello.protocol !== DAEMON_PROTOCOL) {
      reply({ error: `unsupported handshake (daemon protocol ${DAEMON_PROTOCOL})`, restart: !this.hasBusySessions() })
      socket.end()
      if (!this.hasBusySessions()) void this.stop('incompatible client protocol')
      return
    }
    if (hello.control === 'status') {
      reply({ status: this.status() })
      socket.end()
      return
    }
    if (hello.control === 'stop') {
      reply({})
      socket.end()
      void this.stop('stop requested by client')
      return
    }
    if (this.stopping) {
      reply({ restart: true })
      socket.end()
      return
    }
    if (compareVersions(hello.version, this.options.version) > 0) {
      if (!this.hasBusySessions()) {
        // Idle sessions are cheap to restore from disk; let the client start the newer daemon.
        reply({ restart: true })
        socket.end()
        void this.stop(`client version ${hello.version} is newer`)
        return
      }
      // Never kill a running turn for an upgrade: keep serving and exit once idle.
      this.stale = true
      this.log(`client version ${hello.version} is newer; will exit once running turns finish`)
    }

    reply({})
    this.serve(socket, rest)
  }

  private serve(socket: Socket, rest: Buffer): void {
    const { readable, writable } = socketStreams(socket, rest)
    const entry: Connection = { socket }
    this.connections.add(entry)
    this.lastActivity = Date.now()
    this.log(`client connected (${this.connections.size} active)`)
    const conn = new AgentSideConnection(
      c => {
        entry.agent = new PiAcpAgent(c, { runtime: this.runtime })
        return entry.agent
      },
      ndJsonStream(writable, readable)
    )
    void conn.closed.then(() => {
      entry.agent?.disconnect()
      this.connections.delete(entry)
      this.lastActivity = Date.now()
      socket.destroy()
      this.log(`client disconnected (${this.connections.size} active)`)
    })
  }

  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600)
        writeSync(fd, String(process.pid))
        closeSync(fd)
        this.lockHeld = true
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const pid = Number.parseInt(readOptional(this.lockPath), 10)
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
          throw new DaemonAlreadyRunningError(pid)
        }
        try {
          unlinkSync(this.lockPath)
        } catch {
          // raced with another starter; retry
        }
      }
    }
    throw new DaemonAlreadyRunningError()
  }

  private releaseLock(): void {
    if (!this.lockHeld) return
    this.lockHeld = false
    try {
      if (readOptional(this.lockPath) === String(process.pid)) unlinkSync(this.lockPath)
    } catch {
      // ignore
    }
  }
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function canConnect(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
