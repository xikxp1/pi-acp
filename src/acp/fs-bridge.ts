import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type FsCapabilities = { read?: boolean; write?: boolean }
type FsConnection = Pick<AgentSideConnection, 'readTextFile' | 'writeTextFile'>

export class FsBridge {
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer(socket => this.accept(socket))
  private closed = false
  private readonly directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'pi-fs-'))
  readonly path = this.directory ? join(this.directory, 'fs.sock') : `\\\\.\\pipe\\pi-acp-fs-${randomUUID()}`

  private constructor(
    private readonly conn: FsConnection,
    private readonly sessionId: () => string,
    private readonly caps: FsCapabilities
  ) {}

  static async create(
    conn: FsConnection,
    sessionId: () => string,
    caps: FsCapabilities = {}
  ): Promise<FsBridge | undefined> {
    if (!caps.read && !caps.write) return undefined
    const bridge = new FsBridge(conn, sessionId, caps)
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
    return {
      PI_ACP_FS_SOCKET: this.path,
      PI_ACP_FS_CAPS: [this.caps.read && 'read', this.caps.write && 'write'].filter(Boolean).join(',')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server.close()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.sockets.delete(socket))
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

  private async respond(socket: Socket, line: string): Promise<void> {
    let id: string | null = null
    let response: { id: string | null; content?: string; error?: string }
    try {
      const request = JSON.parse(line) as { id?: unknown; op?: unknown; path?: unknown; content?: unknown } | null
      if (typeof request?.id !== 'string') throw new Error('Invalid request id')
      id = request.id
      if (typeof request.path !== 'string' || !isAbsolute(request.path)) throw new Error('Expected absolute path')
      const sessionId = this.sessionId()
      if (!sessionId) throw new Error('Session is not ready')
      if (request.op === 'readTextFile' && this.caps.read) {
        const result = await this.conn.readTextFile({ sessionId, path: request.path })
        response = { id, content: result.content }
      } else if (request.op === 'writeTextFile' && this.caps.write && typeof request.content === 'string') {
        await this.conn.writeTextFile({ sessionId, path: request.path, content: request.content })
        response = { id }
      } else {
        throw new Error('Unsupported filesystem operation or capability')
      }
    } catch (error) {
      response = { id, error: error instanceof Error ? error.message : String(error) }
    }
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n')
  }
}

export function fsBridgeEnv(bridge: FsBridge | undefined): NodeJS.ProcessEnv {
  // Do not inherit a parent adapter's session socket when running nested pi processes.
  return bridge?.env ?? { PI_ACP_FS_SOCKET: undefined, PI_ACP_FS_CAPS: undefined }
}
