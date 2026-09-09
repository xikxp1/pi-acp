import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'

type Response = { id: string; content?: string; error?: string }

class FsClient {
  private socket?: Socket
  private failed = false
  private readonly pending = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(private readonly path: string) {}

  close(error = new Error('Filesystem bridge closed')): void {
    this.failed = true
    this.socket?.destroy()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  request(op: 'readTextFile' | 'writeTextFile', path: string, content?: string): Promise<Response> {
    if (this.failed) return Promise.reject(new Error('Filesystem bridge unavailable'))
    if (!this.socket) {
      const socket = (this.socket = createConnection(this.path))
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          try {
            const response = JSON.parse(line) as Response
            const entry = this.pending.get(response.id)
            if (!entry) continue
            this.pending.delete(response.id)
            clearTimeout(entry.timer)
            if (typeof response.error === 'string') entry.reject(new Error(response.error))
            else entry.resolve(response)
          } catch {
            this.close(new Error('Invalid filesystem bridge response'))
            return
          }
        }
      })
      socket.on('error', error => this.close(error))
      socket.on('close', () => this.close())
    }
    const socket = this.socket
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Filesystem bridge request timed out'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ id, op, path, content }) + '\n', error => {
        if (error) this.close(error)
      })
    })
  }
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PI_ACP_FS_SOCKET
  if (!socketPath) return
  const caps = new Set((process.env.PI_ACP_FS_CAPS ?? '').split(','))
  const client = new FsClient(socketPath)
  pi.on('session_shutdown', async () => client.close())

  const clientRead = async (path: string): Promise<Buffer> => {
    const response = await client.request('readTextFile', path)
    if (typeof response.content !== 'string') throw new Error('Expected text content')
    return Buffer.from(response.content, 'utf8')
  }
  const readFile = async (path: string): Promise<Buffer> => {
    try {
      return await clientRead(path)
    } catch {
      return fs.readFile(path)
    }
  }
  const access = async (path: string): Promise<void> => {
    try {
      await fs.access(path)
    } catch (error) {
      try {
        await clientRead(path)
      } catch {
        throw error
      }
    }
  }
  const writeFile = async (path: string, content: string): Promise<void> => {
    try {
      await client.request('writeTextFile', path, content)
    } catch {
      await fs.writeFile(path, content, 'utf8')
    }
  }
  const cwd = process.cwd()
  if (caps.has('read')) {
    pi.registerTool(
      createReadToolDefinition(cwd, {
        operations: {
          readFile,
          access,
          detectImageMimeType: path => detectSupportedImageMimeTypeFromFile(path).catch(() => null)
        }
      })
    )
  }
  if (caps.has('write')) {
    pi.registerTool(
      createWriteToolDefinition(cwd, {
        operations: {
          writeFile,
          mkdir: async dir => {
            await fs.mkdir(dir, { recursive: true })
          }
        }
      })
    )
  }
  if (caps.has('read') && caps.has('write')) {
    pi.registerTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }))
  }
}
