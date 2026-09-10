import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

type BridgeMessage = {
  id: string
  error?: string
  event?: 'created' | 'output' | 'exit'
  terminalId?: string
  data?: string
  exitCode?: number | null
  signal?: string | null
}

type Listener = (message: BridgeMessage) => void

class BridgeClient {
  private socket?: Socket
  private failed = false
  private readonly listeners = new Map<string, Listener>()

  constructor(private readonly path: string) {}

  close(error = new Error('Client bridge closed')): void {
    this.failed = true
    this.socket?.destroy()
    for (const listener of this.listeners.values()) listener({ id: '', error: error.message })
    this.listeners.clear()
  }

  send(message: Record<string, unknown>, listener: Listener): string {
    if (this.failed) throw new Error('Client bridge unavailable')
    if (!this.socket) this.connect()
    const id = randomUUID()
    this.listeners.set(id, listener)
    this.socket!.write(JSON.stringify({ id, ...message }) + '\n', error => {
      if (error) this.close(error)
    })
    return id
  }

  unsubscribe(id: string): void {
    this.listeners.delete(id)
  }

  private connect(): void {
    const socket = (this.socket = createConnection(this.path))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: BridgeMessage
        try {
          message = JSON.parse(line) as BridgeMessage
        } catch {
          this.close(new Error('Invalid client bridge response'))
          return
        }
        this.listeners.get(message.id)?.(message)
      }
    })
    socket.on('error', error => this.close(error))
    socket.on('close', () => this.close())
  }
}

class CreateFailed extends Error {}

function envOverrides(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  // The client terminal already has the user's shell environment; only forward what pi added.
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && process.env[name] !== value) result[name] = value
  }
  return result
}

function createClientTerminalOperations(client: BridgeClient, toolCallIds: AsyncLocalStorage<string>): BashOperations {
  const local = createLocalBashOperations()
  return {
    async exec(command, cwd, options) {
      const { onData, signal, timeout } = options
      if (signal?.aborted) throw new Error('aborted')
      try {
        return await runInClientTerminal(client, toolCallIds.getStore(), command, cwd, options)
      } catch (error) {
        if (!(error instanceof CreateFailed)) throw error
        return local.exec(command, cwd, { onData, signal, timeout, env: options.env })
      }
    }
  }
}

function runInClientTerminal(
  client: BridgeClient,
  toolCallId: string | undefined,
  command: string,
  cwd: string,
  options: Parameters<BashOperations['exec']>[2]
): Promise<{ exitCode: number | null }> {
  const { onData, signal, timeout } = options
  return new Promise((resolve, reject) => {
    let created = false
    let aborted = false
    let timedOut = false
    let runId = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const kill = () => {
      if (!created) return
      try {
        client.send({ op: 'terminalKill', run: runId }, () => {})
      } catch {
        // Bridge is gone; the adapter kills orphaned terminals when the socket closes.
      }
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    const finish = (settle: () => void) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      client.unsubscribe(runId)
      settle()
    }

    try {
      runId = client.send({ op: 'terminalRun', toolCallId, command, cwd, env: envOverrides(options.env) }, message => {
        if (typeof message.error === 'string') {
          finish(() => reject(created ? new Error(message.error) : new CreateFailed(message.error)))
          return
        }
        if (message.event === 'created') {
          created = true
          if (signal?.aborted) {
            aborted = true
            kill()
          }
          if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
            timer = setTimeout(() => {
              timedOut = true
              kill()
            }, timeout * 1000)
          }
          return
        }
        if (message.event === 'output' && typeof message.data === 'string') {
          onData(Buffer.from(message.data, 'utf8'))
          return
        }
        if (message.event === 'exit') {
          finish(() => {
            if (aborted) reject(new Error('aborted'))
            else if (timedOut) reject(new Error(`timeout:${timeout}`))
            else resolve({ exitCode: typeof message.exitCode === 'number' ? message.exitCode : null })
          })
        }
      })
    } catch (error) {
      reject(new CreateFailed(error instanceof Error ? error.message : String(error)))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PI_ACP_FS_SOCKET
  if (!socketPath || process.env.PI_ACP_TERMINAL !== '1') return

  const client = new BridgeClient(socketPath)
  pi.on('session_shutdown', async () => client.close())

  const toolCallIds = new AsyncLocalStorage<string>()
  const bash = createBashToolDefinition(process.cwd(), {
    operations: createClientTerminalOperations(client, toolCallIds)
  })
  pi.registerTool({
    ...bash,
    execute: (toolCallId, ...rest) => toolCallIds.run(toolCallId, () => bash.execute(toolCallId, ...rest))
  })
}
