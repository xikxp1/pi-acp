import { randomUUID } from 'node:crypto'

const MANAGER = Symbol.for('pi-subagents:manager')
const OWNER = Symbol.for('pi-acp:subagents:owner')
const globals = globalThis as unknown as Record<symbol, unknown>
export const MAX_TEXT = 64 * 1024
const TRUNCATED = '[Earlier output truncated; see outputFile when available.]\n'
type Data = Record<string, unknown>
type Status = 'pending' | 'in_progress' | 'completed' | 'failed'
export interface BridgeContext {
  mode?: string
  ui: { setStatus(key: string, text: string): void }
}
export interface BridgePi {
  events: { on(name: string, listener: (payload: unknown) => void): () => void }
  on(name: 'session_start' | 'session_shutdown', listener: (event: unknown, ctx: BridgeContext) => void): void
}
interface Run {
  id: string
  runId: string
  title: string
  baseline: WeakSet<object>
  startedAt: number
  started: boolean
  last?: string
  text: string
}
const data = (value: unknown): Data | undefined =>
  value !== null && typeof value === 'object' ? (value as Data) : undefined
const bounded = (text: string): string =>
  text.length > MAX_TEXT ? TRUNCATED + text.slice(-(MAX_TEXT - TRUNCATED.length)) : text
function status(value: unknown): Status | undefined {
  if (value === 'queued' || value === 'pending') return 'pending'
  if (value === 'running') return 'in_progress'
  if (value === 'completed' || value === 'steered') return 'completed'
  if (['error', 'failed', 'stopped', 'aborted'].includes(String(value))) return 'failed'
  return undefined
}
function visible(message: Data): string {
  if (message.role !== 'assistant' && message.role !== 'toolResult') return ''
  if (!Array.isArray(message.content)) return ''
  let text = ''
  for (const value of message.content) {
    const block = data(value)
    if (block?.type === 'text' && typeof block.text === 'string') text = bounded(text + block.text)
    if (message.role === 'assistant' && block?.type === 'toolCall' && typeof block.name === 'string') {
      let args = ''
      try {
        args = JSON.stringify(block.arguments ?? {}) ?? ''
      } catch {
        /* incompatible tool arguments */
      }
      text = bounded(text + `\nTool: ${block.name} ${args}\n`)
    }
  }
  return text
}

export class SubagentsBridge {
  private runs = new Map<string, Run>()
  private unsubscribers: (() => void)[] = []
  private timer?: ReturnType<typeof setInterval>
  constructor(
    private pi: BridgePi,
    private ctx: BridgeContext,
    private automaticTicks = true
  ) {}

  start(): boolean {
    if (globals[OWNER] !== undefined) return false
    globals[OWNER] = this
    for (const event of ['created', 'started', 'completed', 'failed']) {
      this.unsubscribers.push(this.pi.events.on(`subagents:${event}`, payload => this.event(event, payload)))
    }
    return true
  }

  private record(id: string): Data | undefined {
    try {
      const registry = data(globals[MANAGER])
      if (typeof registry?.getRecord !== 'function') return undefined
      const record = data(registry.getRecord(id))
      if (!record || record.parentAgentId !== undefined || record.workflowId !== undefined) return undefined
      return record
    } catch {
      return undefined
    }
  }

  private event(event: string, payload: unknown): void {
    if (globals[OWNER] !== this) return
    const value = data(payload)
    if (typeof value?.id !== 'string') return
    const record = this.record(value.id)
    if (!record || !status(record.status)) return
    let run = this.runs.get(value.id)
    if (!run) {
      if (event !== 'created' && event !== 'started') return
      if (!['pending', 'in_progress'].includes(status(record.status)!)) return
      const messages = data(record.session)?.messages
      const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now()
      const baseline = Array.isArray(messages)
        ? messages.filter(value => {
            const message = data(value)
            return (
              message &&
              (event === 'started' ||
                status(record.status) === 'pending' ||
                (typeof message.timestamp === 'number' && message.timestamp < startedAt))
            )
          })
        : []
      run = {
        id: value.id,
        runId: randomUUID(),
        title: ([value.type, value.description].filter(v => typeof v === 'string').join(': ') || value.id).slice(
          0,
          512
        ),
        baseline: new WeakSet(baseline),
        startedAt,
        started: status(record.status) === 'in_progress',
        text: ''
      }
      this.runs.set(value.id, run)
    }
    if (event === 'started') run.started = true
    this.flush(
      run,
      record,
      event === 'failed' ? 'failed' : event === 'completed' ? (status(value.status) ?? 'completed') : undefined,
      value
    )
    if (this.runs.size && !this.timer && this.automaticTicks) {
      this.timer = setInterval(() => this.tick(), 250)
      this.timer.unref()
    }
  }

  tick(): void {
    if (globals[OWNER] !== this) return
    for (const run of this.runs.values()) {
      const record = this.record(run.id)
      if (record) this.flush(run, record)
      else this.finishDetached(run)
    }
  }

  private flush(run: Run, record: Data, forced?: Status, event?: Data): void {
    // Terminal record status can precede awaited worktree cleanup and its final result.
    const currentStatus = forced ?? (run.started ? 'in_progress' : status(record.status))
    if (!currentStatus) return
    if (typeof record.startedAt === 'number') run.startedAt = Math.max(run.startedAt, record.startedAt)
    const session = data(record.session)
    const messages = Array.isArray(session?.messages) ? session.messages : []
    const streaming = data(data(session?.agent)?.state)?.streamingMessage
    let text = ''
    const append = (value: unknown) => {
      const message = data(value)
      if (
        !message ||
        run.baseline.has(message) ||
        typeof message.timestamp !== 'number' ||
        message.timestamp < run.startedAt
      )
        return
      const part = visible(message)
      if (part) text = bounded(text + (text ? '\n' : '') + part)
    }
    for (const message of messages) append(message)
    if (streaming && !messages.includes(streaming)) {
      const partial = data(streaming)
      // Some runtimes briefly retain the finalized streaming message as a separate object.
      const last = data(messages.at(-1))
      if (!last || last.timestamp !== partial?.timestamp || visible(last) !== (partial ? visible(partial) : ''))
        append(streaming)
    }
    if (text) run.text = text
    if (currentStatus === 'completed' || currentStatus === 'failed') {
      for (const result of [event?.result ?? record.result, event?.error ?? record.error]) {
        if (typeof result === 'string' && result && !run.text.includes(result))
          run.text = bounded(run.text + (run.text ? '\n' : '') + result)
      }
    }
    this.emit(run, currentStatus, typeof record.outputFile === 'string' ? record.outputFile : undefined)
    if (currentStatus === 'completed' || currentStatus === 'failed') this.remove(run)
  }

  private emit(run: Run, currentStatus: Status, outputFile?: string): void {
    const snapshot = JSON.stringify({
      version: 1,
      agentId: run.id,
      runId: run.runId,
      title: run.title,
      status: currentStatus,
      text: run.text,
      ...(outputFile ? { outputFile } : {})
    })
    if (snapshot === run.last) return
    try {
      this.ctx.ui.setStatus('pi-acp:subagent', snapshot)
      run.last = snapshot
    } catch {
      /* UI transport may already be detached. */
    }
  }
  private remove(run: Run): void {
    this.runs.delete(run.id)
    if (!this.runs.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
  private finishDetached(run: Run): void {
    run.text = bounded(run.text + '\nSubagent bridge detached; agent execution was not cancelled.')
    this.emit(run, 'failed')
    this.remove(run)
  }
  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (globals[OWNER] !== this) return
    for (const run of this.runs.values()) this.finishDetached(run)
    delete globals[OWNER]
  }
}

export default function piAcpSubagents(pi: BridgePi): void {
  let bridge: SubagentsBridge | undefined
  pi.on('session_start', (_event, ctx) => {
    if (process.env.PI_ACP_SUBAGENTS !== '1' || ctx.mode !== 'rpc' || bridge) return
    const candidate = new SubagentsBridge(pi, ctx)
    if (candidate.start()) bridge = candidate
  })
  pi.on('session_shutdown', () => {
    bridge?.stop()
    bridge = undefined
  })
}
