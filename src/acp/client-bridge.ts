import type { AgentSideConnection, TerminalHandle } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { bashOutputDelta } from './translate/bash.js'

export type ClientCapabilities = { read?: boolean; write?: boolean; terminal?: boolean }
export type BridgeConnection = Pick<AgentSideConnection, 'readTextFile' | 'writeTextFile' | 'createTerminal'>

export type TerminalRunHooks = {
  onTerminalCreated?: (toolCallId: string | undefined, terminalId: string) => void
}

type BridgeRequest = {
  id?: unknown
  op?: unknown
  path?: unknown
  content?: unknown
  toolCallId?: unknown
  command?: unknown
  cwd?: unknown
  env?: unknown
  run?: unknown
}

type BridgeMessage =
  | { id: string | null; content?: string; error?: string }
  | { id: string; event: 'created'; terminalId: string }
  | { id: string; event: 'output'; data: string }
  | { id: string; event: 'exit'; exitCode: number | null; signal: string | null }

type RunningTerminal = { handle: TerminalHandle; socket: Socket }

export const TERMINAL_POLL_INTERVAL_MS = 150
const TERMINAL_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024

/**
 * Per-session IPC bridge that lets pi extensions delegate filesystem and terminal
 * operations to the ACP client. Protocol: newline-delimited JSON over a local socket.
 * Terminal runs stream `created`/`output`/`exit` events keyed by the request id.
 */
export class ClientBridge {
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer(socket => this.accept(socket))
  private readonly terminals = new Map<string, RunningTerminal>()
  private closed = false
  private readonly directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'pi-acp-'))
  readonly path = this.directory ? join(this.directory, 'bridge.sock') : `\\\\.\\pipe\\pi-acp-${randomUUID()}`

  private constructor(
    private readonly conn: BridgeConnection,
    private readonly sessionId: () => string,
    private readonly caps: ClientCapabilities,
    private readonly hooks: TerminalRunHooks
  ) {}

  static async create(
    conn: BridgeConnection,
    sessionId: () => string,
    caps: ClientCapabilities = {},
    hooks: TerminalRunHooks = {}
  ): Promise<ClientBridge | undefined> {
    if (!caps.read && !caps.write && !caps.terminal) return undefined
    const bridge = new ClientBridge(conn, sessionId, caps, hooks)
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.server.once('error', reject)
        bridge.server.listen(bridge.path, () => {
          bridge.server.off('error', reject)
          resolve()
        })
      })
      bridge.server.on('error', () => bridge.close())
      return bridge
    } catch (error) {
      bridge.close()
      throw error
    }
  }

  get env(): NodeJS.ProcessEnv {
    const fsCaps = [this.caps.read && 'read', this.caps.write && 'write'].filter(Boolean).join(',')
    return {
      // Env names are kept for compatibility with already installed pi-acp-fs extensions.
      PI_ACP_FS_SOCKET: this.path,
      PI_ACP_FS_CAPS: fsCaps || undefined,
      PI_ACP_TERMINAL: this.caps.terminal ? '1' : undefined
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const { handle } of this.terminals.values()) {
      void handle.kill().catch(() => {})
      void handle.release().catch(() => {})
    }
    this.terminals.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server.close()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.sockets.delete(socket)
      // pi went away mid-command: do not leave the client terminal running.
      for (const [id, entry] of this.terminals) {
        if (entry.socket !== socket) continue
        this.terminals.delete(id)
        void entry.handle.kill().catch(() => {})
      }
    })
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) void this.respond(socket, line)
      }
    })
  }

  private send(socket: Socket, message: BridgeMessage): void {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n')
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let id: string | null = null
    try {
      const request = JSON.parse(line) as BridgeRequest | null
      if (typeof request?.id !== 'string') throw new Error('Invalid request id')
      id = request.id
      const sessionId = this.sessionId()
      if (!sessionId) throw new Error('Session is not ready')
      if (request.op === 'readTextFile' && this.caps.read) {
        const result = await this.conn.readTextFile({ sessionId, path: this.absolutePath(request.path) })
        this.send(socket, { id, content: result.content })
      } else if (request.op === 'writeTextFile' && this.caps.write && typeof request.content === 'string') {
        await this.conn.writeTextFile({ sessionId, path: this.absolutePath(request.path), content: request.content })
        this.send(socket, { id })
      } else if (request.op === 'terminalRun' && this.caps.terminal) {
        await this.runTerminal(socket, id, sessionId, request)
      } else if (request.op === 'terminalKill' && this.caps.terminal) {
        const target = typeof request.run === 'string' ? this.terminals.get(request.run) : undefined
        if (target) await target.handle.kill()
        this.send(socket, { id })
      } else {
        throw new Error('Unsupported bridge operation or capability')
      }
    } catch (error) {
      this.send(socket, { id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private absolutePath(value: unknown): string {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Expected absolute path')
    return value
  }

  private async runTerminal(socket: Socket, id: string, sessionId: string, request: BridgeRequest): Promise<void> {
    if (typeof request.command !== 'string' || !request.command) throw new Error('Expected command')
    const cwd = typeof request.cwd === 'string' && isAbsolute(request.cwd) ? request.cwd : undefined
    const env = terminalEnv(request.env)
    const toolCallId = typeof request.toolCallId === 'string' ? request.toolCallId : undefined

    // Any failure up to here means the client never started the command; the
    // extension treats a plain error response as "safe to run locally".
    const handle = await this.conn.createTerminal({
      sessionId,
      command: request.command,
      args: [],
      cwd,
      env,
      outputByteLimit: TERMINAL_OUTPUT_BYTE_LIMIT
    })
    this.terminals.set(id, { handle, socket })
    this.send(socket, { id, event: 'created', terminalId: handle.id })
    this.hooks.onTerminalCreated?.(toolCallId, handle.id)

    let sent = ''
    const pump = async (): Promise<void> => {
      const { output, truncated } = await handle.currentOutput()
      const delta = truncated ? truncatedOutputDelta(sent, output) : bashOutputDelta(sent, output)
      sent = output
      if (delta) this.send(socket, { id, event: 'output', data: delta })
    }

    let exited = false
    const exitPromise = handle.waitForExit().finally(() => {
      exited = true
    })
    const poller = (async () => {
      while (!exited && !this.closed) {
        try {
          await pump()
        } catch {
          // Output polling is best-effort; the final read after exit is authoritative.
        }
        await new Promise(resolve => setTimeout(resolve, TERMINAL_POLL_INTERVAL_MS))
      }
    })()

    try {
      const exit = await exitPromise
      await poller
      try {
        await pump()
      } catch {
        // ignore
      }
      this.send(socket, {
        id,
        event: 'exit',
        exitCode: typeof exit.exitCode === 'number' ? exit.exitCode : null,
        signal: typeof exit.signal === 'string' ? exit.signal : null
      })
    } finally {
      this.terminals.delete(id)
      void handle.release().catch(() => {})
    }
  }
}

function terminalEnv(value: unknown): { name: string; value: string }[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return entries.length ? entries.map(([name, value]) => ({ name, value })) : undefined
}

/**
 * When the client truncated its retained output from the front, `next` may no
 * longer start with what we already sent. Re-anchor on the tail of `sent`.
 */
export function truncatedOutputDelta(sent: string, next: string): string {
  if (!sent) return next
  if (next.startsWith(sent)) return next.slice(sent.length)
  const tail = sent.slice(-4096)
  for (let k = Math.min(tail.length, next.length); k > 0; k -= 1) {
    if (next.startsWith(tail.slice(-k))) return next.slice(k)
  }
  return next
}

export function clientBridgeEnv(bridge: ClientBridge | undefined): NodeJS.ProcessEnv {
  // Do not inherit a parent adapter's session socket when running nested pi processes.
  return bridge?.env ?? { PI_ACP_FS_SOCKET: undefined, PI_ACP_FS_CAPS: undefined, PI_ACP_TERMINAL: undefined }
}
