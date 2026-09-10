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
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export function parseAdditionalDirectories(value: string | undefined): string[] {
  if (!value) return []
  const dirs: unknown = JSON.parse(value)
  if (!Array.isArray(dirs) || !dirs.every(dir => typeof dir === 'string' && isAbsolute(dir))) {
    throw new Error('PI_ACP_ADDITIONAL_DIRECTORIES must be a JSON array of absolute paths')
  }
  return [...new Set(dirs.map(dir => resolve(dir)))]
}

export async function resolveWorkspacePath(
  path: string,
  cwd: string,
  roots: readonly string[],
  exists: (path: string) => Promise<boolean>
): Promise<string> {
  if (!roots.length) return path
  const input = path.replace(/^@/, '')
  if (isAbsolute(input) || input === '~' || input.startsWith('~/') || input.startsWith(`~${sep}`)) return path
  const local = resolve(cwd, input)
  if (await exists(local)) return local
  const parts = process.platform === 'win32' ? input.split(/[\\/]/) : input.split(sep)
  if (parts.includes('..')) return local
  const prefix = parts[0] === '.' ? parts.slice(1) : parts
  const named = roots.filter(root => basename(root) === prefix[0])
  if (named.length > 1) {
    throw new Error(`Ambiguous workspace root "${prefix[0]}": ${named.join(', ')}. Use an absolute path.`)
  }
  if (named.length === 1) return resolve(named[0], ...prefix.slice(1))
  const matches: string[] = []
  for (const root of roots) {
    const candidate = resolve(root, input)
    if (candidate === local || matches.includes(candidate)) continue
    if (await exists(candidate)) matches.push(candidate)
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous workspace path "${path}": ${matches.join(', ')}. Use root-name/path or an absolute path.`
    )
  }
  return matches[0] ?? local
}

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
  const roots = parseAdditionalDirectories(process.env.PI_ACP_ADDITIONAL_DIRECTORIES)
  if (!socketPath && !roots.length) return
  const caps = new Set((process.env.PI_ACP_FS_CAPS ?? '').split(','))
  const client = socketPath ? new FsClient(socketPath) : undefined
  pi.on('session_shutdown', async () => client?.close())

  const clientRead = async (path: string): Promise<Buffer> => {
    if (!client || !caps.has('read')) throw new Error('Client filesystem read unavailable')
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
      if (!client || !caps.has('write')) throw new Error('Client filesystem write unavailable')
      await client.request('writeTextFile', path, content)
    } catch {
      await fs.writeFile(path, content, 'utf8')
    }
  }
  const exists = async (path: string): Promise<boolean> => {
    try {
      await fs.lstat(path)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    if (client && caps.has('read')) {
      try {
        await clientRead(path)
        return true
      } catch {
        // ACP has no stat operation; missing local files may exist only in editor buffers.
      }
    }
    return false
  }
  const cwd = process.cwd()
  const resolvePath = (path: string, toolCwd: string) =>
    resolveWorkspacePath(
      path,
      toolCwd,
      roots.filter(root => relative(toolCwd, root) !== ''),
      exists
    )
  if (caps.has('read') || roots.length) {
    const tool = createReadToolDefinition(cwd, {
      operations: {
        readFile,
        access,
        detectImageMimeType: path => detectSupportedImageMimeTypeFromFile(path).catch(() => null)
      }
    })
    pi.registerTool({
      ...tool,
      async execute(id, params, signal, onUpdate, ctx) {
        const path = await resolvePath(params.path, ctx.cwd)
        return tool.execute(id, { ...params, path }, signal, onUpdate, ctx)
      }
    })
  }
  if (caps.has('write') || roots.length) {
    const tool = createWriteToolDefinition(cwd, {
      operations: {
        writeFile,
        mkdir: async dir => {
          await fs.mkdir(dir, { recursive: true })
        }
      }
    })
    pi.registerTool({
      ...tool,
      async execute(id, params, signal, onUpdate, ctx) {
        const path = await resolvePath(params.path, ctx.cwd)
        return tool.execute(id, { ...params, path }, signal, onUpdate, ctx)
      }
    })
  }
  if ((caps.has('read') && caps.has('write')) || roots.length) {
    const tool = createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } })
    pi.registerTool({
      ...tool,
      async execute(id, params, signal, onUpdate, ctx) {
        const path = await resolvePath(params.path, ctx.cwd)
        return tool.execute(id, { ...params, path }, signal, onUpdate, ctx)
      }
    })
  }
}
