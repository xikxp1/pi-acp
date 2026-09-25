import { RequestError, type AgentSideConnection, type SessionUpdate } from '@agentclientprotocol/sdk'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getPiAcpDir } from './paths.js'
import { readPiSessionBranch } from './pi-sessions.js'
import { isSubagentTool } from './translate/subagents.js'
import { piImageBlocks } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import { toToolKind, toToolTitle, toToolResultTitle } from './translate/tool-presentation.js'
import { toToolCallLocations, historicDiffContent } from './translate/tool-args.js'

export const SUBAGENT_CAPABILITY = 'zed.dev/subagent-sessions'
export const SUBAGENT_INFO = 'zed.dev/subagent-session'
const PREFIX = 'pi-child-'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RECORD = 20 * 1024 * 1024

type Status = 'pending' | 'in_progress' | 'completed' | 'failed'
type Descriptor = {
  version: 2
  runId: string
  parentToolCallId: string
  parentPiSessionId?: string
  title: string
  sessionFile: string
  eventsFile: string
  outputFile: string
}
type StoredChild = Descriptor & { parentSessionId: string; cwd: string }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function status(value: unknown): value is Status {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed'
}
function terminal(value: Status): boolean {
  return value === 'completed' || value === 'failed'
}
function parse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > MAX_RECORD) return {}
  try {
    return record(JSON.parse(value))
  } catch {
    return {}
  }
}
function descriptor(value: unknown): Descriptor | undefined {
  const source = record(value)
  if (source.version !== 2 || typeof source.runId !== 'string' || !UUID.test(source.runId)) return
  for (const key of ['parentToolCallId', 'title'] as const) {
    if (
      typeof source[key] !== 'string' ||
      !source[key].trim() ||
      source[key].length > 512 ||
      source[key].includes('\0')
    )
      return
  }
  if (
    source.parentPiSessionId !== undefined &&
    (typeof source.parentPiSessionId !== 'string' ||
      !source.parentPiSessionId.trim() ||
      source.parentPiSessionId.length > 512 ||
      source.parentPiSessionId.includes('\0'))
  )
    return
  for (const key of ['sessionFile', 'eventsFile', 'outputFile'] as const) {
    const path = source[key]
    if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || path.includes('\0')) return
  }
  const directory = dirname(source.sessionFile as string)
  if (
    source.sessionFile !== join(directory, 'session.jsonl') ||
    source.eventsFile !== join(directory, 'events.jsonl') ||
    source.outputFile !== join(directory, 'output.txt')
  )
    return
  return {
    version: 2,
    runId: source.runId,
    parentToolCallId: source.parentToolCallId as string,
    ...(typeof source.parentPiSessionId === 'string' ? { parentPiSessionId: source.parentPiSessionId } : {}),
    title: source.title as string,
    sessionFile: source.sessionFile as string,
    eventsFile: source.eventsFile as string,
    outputFile: source.outputFile as string
  }
}

export function supportsSubagentSessions(meta: unknown): boolean {
  const capability = record(record(meta)[SUBAGENT_CAPABILITY])
  return capability.version === 1
}

/** A child has no RPC process: only the owning extension may execute it. */
class ChildSession {
  readonly updates: SessionUpdate[] = []
  private readonly translator: ChildTranslator
  private sequence = 0
  private status: Status = 'pending'
  private subscription: { delivery: Promise<void> } | undefined
  private loading: Promise<void> | undefined
  private cancelFile: string | undefined
  private live: boolean
  private restored: boolean

  constructor(
    readonly stored: StoredChild,
    private readonly conn: AgentSideConnection,
    cancelFile?: string
  ) {
    this.live = cancelFile !== undefined
    this.restored = this.live
    this.cancelFile = cancelFile
    this.translator = new ChildTranslator(stored.cwd)
  }
  get id(): string {
    return PREFIX + this.stored.runId
  }
  get link() {
    return { subagent_session_info: { session_id: this.id, message_start_index: 0 } }
  }
  get currentStatus(): Status {
    if (this.restored) return this.status
    const state = parse(readOptional(join(dirname(this.stored.sessionFile), 'state.json')))
    return state.runId === this.stored.runId && terminalStatus(state.status) ? state.status : 'failed'
  }
  interrupt(): void {
    if (this.live) this.finish('failed', 'Parent session stopped; subagent execution was interrupted.')
  }
  private info(status = this.status): SessionUpdate {
    return {
      sessionUpdate: 'session_info_update',
      title: this.stored.title,
      _meta: {
        [SUBAGENT_INFO]: {
          parent_session_id: this.stored.parentSessionId,
          parent_tool_call_id: this.stored.parentToolCallId,
          status
        }
      }
    }
  }
  private send(update: SessionUpdate, subscription = this.subscription): void {
    if (!subscription) return
    subscription.delivery = subscription.delivery.then(async () => {
      if (this.subscription !== subscription) throw new Error('Child replay subscription closed')
      await this.conn.sessionUpdate({ sessionId: this.id, update })
    })
    // Observe live failures without swallowing the rejection awaited by load().
    void subscription.delivery.catch(error => {
      if (this.subscription === subscription) {
        console.error(`pi-acp: child update delivery failed: ${String(error)}`)
        this.subscription = undefined
      }
    })
  }
  private append(update: SessionUpdate): void {
    this.updates.push(update)
    this.send(update)
  }
  event(value: Record<string, unknown>): void {
    if (terminal(this.status)) return
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < this.sequence) return
    if (value.sequence !== this.sequence) {
      this.finish('failed', 'Subagent event stream has a gap; see the persisted Pi session and output file.')
      return
    }
    this.sequence++
    for (const update of this.translator.event(record(value.event))) this.append(update)
  }
  finish(next: Status, error?: string): void {
    if (terminal(this.status) || (this.status === 'in_progress' && next === 'pending')) return
    if (terminal(next)) {
      this.live = false
      this.cancelFile = undefined
      for (const update of this.translator.finish()) this.append(update)
      if (error) this.append({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n${error}\n` } })
    }
    if (next !== this.status) {
      this.status = next
      this.send(this.info())
    }
  }
  restore(): void {
    try {
      const lines = readFileSync(this.stored.eventsFile, 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        const event = parse(line)
        if (event.version !== 2 || event.type !== 'event' || event.runId !== this.stored.runId)
          throw new Error('Invalid subagent event journal')
        this.event(event)
      }
    } catch (error) {
      console.error(`pi-acp: subagent journal unavailable: ${String(error)}`)
      // A missing journal must not prevent inspection of the real Pi history.
      this.updates.length = 0
      this.translator.reset()
      try {
        for (const entry of readPiSessionBranch(this.stored.sessionFile)) {
          if (entry.type === 'message') {
            for (const update of this.translator.event({ type: 'message_end', message: entry.message }))
              this.updates.push(update)
          }
        }
      } catch (historyError) {
        console.error(`pi-acp: subagent Pi history unavailable: ${String(historyError)}`)
        if (existsSync(this.stored.outputFile))
          this.updates.push({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: readFileSync(this.stored.outputFile, 'utf8') }
          })
      }
    }
    const state = parse(readOptional(join(dirname(this.stored.sessionFile), 'state.json')))
    if (state.runId === this.stored.runId && terminalStatus(state.status))
      this.finish(state.status, typeof state.error === 'string' ? state.error : undefined)
    else this.finish('failed', 'Subagent execution was interrupted; this saved session is inspect-only.')
  }
  async load(): Promise<void> {
    if (this.loading) return this.loading
    if (!this.restored) {
      this.restore()
      this.restored = true
    }
    // Installing the subscription and queuing the snapshot are synchronous. Any
    // event received while replay awaits delivery is queued strictly after it.
    const subscription = { delivery: Promise.resolve() }
    this.subscription = subscription
    // Clients stop reading on the first terminal transition. Replay into their
    // fresh entity before reporting the saved terminal state; do not mutate it.
    this.send(this.info(terminal(this.status) ? 'in_progress' : this.status))
    for (const update of this.updates) this.send(update)
    this.send(this.info())
    const loading = subscription.delivery
    this.loading = loading
    try {
      await loading
    } finally {
      if (this.loading === loading) this.loading = undefined
    }
  }
  close(): void {
    this.subscription = undefined
    this.loading = undefined
  }
  cancel(): void {
    if (!this.live || !this.cancelFile || terminal(this.status)) return
    // Only the live registration supplies this random capability. Never restore
    // a cancellation target (or a PID) from a saved session.
    try {
      writeFileSync(this.cancelFile, '', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.cancelFile = undefined
  }
}
function terminalStatus(value: unknown): value is 'completed' | 'failed' {
  return value === 'completed' || value === 'failed'
}
function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`pi-acp: cannot read child state: ${String(error)}`)
    return ''
  }
}

export class SubagentSessions {
  enabled = false
  private readonly children = new Map<string, ChildSession>()
  constructor(
    private readonly conn: AgentSideConnection,
    private readonly directory = join(getPiAcpDir(), 'children')
  ) {}
  isChildId(id: string): boolean {
    return id.startsWith(PREFIX)
  }
  assertRoot(id: string): void {
    if (this.isChildId(id))
      throw RequestError.invalidParams(
        { sessionId: id },
        'Subagent sessions are inspect-only; prompt or configure the parent session instead.'
      )
  }
  private path(id: string): string | undefined {
    return id.startsWith(PREFIX) && UUID.test(id.slice(PREFIX.length)) ? join(this.directory, `${id}.json`) : undefined
  }
  private get(id: string): ChildSession | undefined {
    const active = this.children.get(id)
    if (active) return active
    const path = this.path(id)
    if (!path) return
    const stored = parse(readOptional(path))
    const data = descriptor(stored)
    if (
      !data ||
      PREFIX + data.runId !== id ||
      typeof stored.parentSessionId !== 'string' ||
      !stored.parentSessionId.trim() ||
      stored.parentSessionId.length > 512 ||
      stored.parentSessionId.includes('\0') ||
      typeof stored.cwd !== 'string' ||
      !isAbsolute(stored.cwd) ||
      stored.cwd.includes('\0') ||
      stored.cwd.length > 4096
    )
      return
    const child = new ChildSession({ ...data, parentSessionId: stored.parentSessionId, cwd: stored.cwd }, this.conn)
    this.children.set(id, child)
    return child
  }
  private register(parentSessionId: string, cwd: string, data: Descriptor, cancelFile?: string): ChildSession {
    const id = PREFIX + data.runId
    const existing = this.get(id)
    if (existing) {
      if (
        existing.stored.parentSessionId !== parentSessionId ||
        existing.stored.parentToolCallId !== data.parentToolCallId ||
        existing.stored.sessionFile !== data.sessionFile ||
        existing.stored.eventsFile !== data.eventsFile
      )
        throw new Error('Conflicting subagent identity')
      return existing
    }
    const stored = { ...data, parentSessionId, cwd }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, `${id}.json`)
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 })
    renameSync(temporary, path)
    const child = new ChildSession(stored, this.conn, cancelFile)
    this.children.set(id, child)
    return child
  }
  receive(
    parentSessionId: string,
    cwd: string,
    value: unknown,
    ownsTool: (id: string) => boolean
  ): SessionUpdate | undefined {
    if (!this.enabled) return
    const event = parse(value)
    if (event.version !== 2 || typeof event.runId !== 'string' || !UUID.test(event.runId)) return
    if (event.type === 'register') {
      const data = descriptor(event)
      if (!data || !ownsTool(data.parentToolCallId)) return
      const cancelFile = event.cancelFile
      const directory = dirname(data.sessionFile)
      const controlPrefix = join(directory, 'cancel-')
      if (
        typeof cancelFile !== 'string' ||
        !cancelFile.startsWith(controlPrefix) ||
        !UUID.test(cancelFile.slice(controlPrefix.length))
      )
        return
      const child = this.register(parentSessionId, cwd, data, cancelFile)
      return { sessionUpdate: 'tool_call_update', toolCallId: data.parentToolCallId, _meta: child.link }
    }
    const child = this.children.get(PREFIX + event.runId)
    if (!child || child.stored.parentSessionId !== parentSessionId) return
    if (event.type === 'event') child.event(event)
    else if (event.type === 'status' && status(event.status))
      child.finish(event.status, typeof event.error === 'string' ? event.error : undefined)
  }
  restoreLink(parentSessionId: string, cwd: string, toolCallId: string, value: unknown) {
    if (!this.enabled) return undefined
    const data = descriptor(value)
    if (!data || data.parentToolCallId !== toolCallId) return undefined
    const original = this.get(PREFIX + data.runId)
    // Forks can copy a parent's tool history, but must not reparent its children.
    if (
      (data.parentPiSessionId !== undefined && data.parentPiSessionId !== parentSessionId) ||
      (original ? original.stored.parentSessionId !== parentSessionId : data.parentPiSessionId !== parentSessionId)
    )
      return undefined
    try {
      return this.register(parentSessionId, cwd, data).link
    } catch (error) {
      console.error(`pi-acp: cannot restore subagent link: ${String(error)}`)
      return undefined
    }
  }
  restoreHistory(parentSessionId: string, cwd: string, sessionFile: string) {
    const tools = new Map<string, { id: string; name: string; arguments: unknown }>()
    if (!this.enabled) return tools
    try {
      const branch = readPiSessionBranch(sessionFile)
      for (const entry of branch) {
        const message = record(entry.message)
        if (entry.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content)) continue
        for (const value of message.content) {
          const block = record(value)
          if (
            block.type === 'toolCall' &&
            typeof block.id === 'string' &&
            block.id &&
            typeof block.name === 'string' &&
            isSubagentTool(block.name) &&
            !tools.has(block.id)
          )
            tools.set(block.id, { id: block.id, name: block.name, arguments: block.arguments })
        }
      }
      for (const entry of branch) {
        const message = record(entry.message)
        const data =
          entry.type === 'custom' && entry.customType === 'pi-subagent-session'
            ? record(entry.data)
            : entry.type === 'message' &&
                message.role === 'toolResult' &&
                typeof message.toolName === 'string' &&
                isSubagentTool(message.toolName)
              ? record(record(message.details).subagentSession)
              : {}
        if (
          typeof data.parentToolCallId === 'string' &&
          tools.has(data.parentToolCallId) &&
          (entry.type !== 'message' || message.toolCallId === data.parentToolCallId)
        )
          this.restoreLink(parentSessionId, cwd, data.parentToolCallId, data)
      }
    } catch (error) {
      console.error(`pi-acp: cannot restore subagent history: ${String(error)}`)
    }
    return tools
  }
  link(parentSessionId: string, toolCallId: string) {
    if (!this.enabled) return undefined
    for (const child of this.children.values()) {
      if (child.stored.parentSessionId === parentSessionId && child.stored.parentToolCallId === toolCallId)
        return child.link
    }
    return undefined
  }
  toolStatus(parentSessionId: string, toolCallId: string): Status | undefined {
    for (const child of this.children.values())
      if (child.stored.parentSessionId === parentSessionId && child.stored.parentToolCallId === toolCallId)
        return child.currentStatus
    return undefined
  }
  async load(id: string): Promise<void> {
    if (!this.enabled) throw RequestError.invalidParams({}, 'Subagent inspection was not negotiated')
    const child = this.get(id)
    if (!child) throw RequestError.invalidParams({ sessionId: id }, `Unknown child sessionId: ${id}`)
    await child.load()
  }
  close(id: string): void {
    this.children.get(id)?.close()
  }
  cancel(id: string): void {
    this.children.get(id)?.cancel()
  }
  failParent(parentSessionId: string): void {
    for (const child of this.children.values()) if (child.stored.parentSessionId === parentSessionId) child.interrupt()
  }
}

class ChildTranslator {
  private streamed = new Map<number, string>()
  private tools = new Map<string, { name: string; args: unknown; done: boolean }>()
  constructor(private readonly cwd: string) {}
  reset(): void {
    this.streamed.clear()
    this.tools.clear()
  }
  finish(): SessionUpdate[] {
    const result: SessionUpdate[] = []
    for (const [toolCallId, tool] of this.tools)
      if (!tool.done) {
        tool.done = true
        result.push({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
      }
    return result
  }
  event(event: Record<string, unknown>): SessionUpdate[] {
    const updates: SessionUpdate[] = []
    const message = record(event.message)
    const chunk = (kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk', text: string) => {
      if (text) updates.push({ sessionUpdate: kind, content: { type: 'text', text } })
    }
    const toolStart = (id: unknown, name: unknown, args: unknown, status: 'pending' | 'in_progress') => {
      if (typeof id !== 'string' || !id || typeof name !== 'string') return
      const previous = this.tools.get(id)
      if (previous?.done) return
      this.tools.set(id, { name, args, done: false })
      const update = {
        toolCallId: id,
        title: toToolTitle(name, args, this.cwd),
        kind: toToolKind(name),
        status,
        rawInput: args,
        locations: toToolCallLocations(args, this.cwd)
      }
      updates.push(
        previous ? { ...update, sessionUpdate: 'tool_call_update' } : { ...update, sessionUpdate: 'tool_call' }
      )
    }
    const toolResult = (id: unknown, name: unknown, result: unknown, isError: boolean, final: boolean) => {
      if (typeof id !== 'string' || !id) return
      if (!this.tools.has(id)) toolStart(id, name, undefined, 'in_progress')
      const tool = this.tools.get(id)
      if (!tool || tool.done) return
      if (final) tool.done = true
      const text = toolResultToText(result)
      const title = toToolResultTitle(tool.name, result)
      const diff = final && !isError ? historicDiffContent(tool.name, tool.args) : undefined
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: final ? (isError ? 'failed' : 'completed') : 'in_progress',
        ...(title ? { title } : {}),
        content: diff ?? [
          ...(text ? [{ type: 'content' as const, content: { type: 'text' as const, text } }] : []),
          ...piImageBlocks(record(result).content).map(content => ({ type: 'content' as const, content }))
        ],
        rawOutput: result
      })
    }
    if (event.type === 'message_start' && message.role === 'assistant') this.streamed.clear()
    else if (event.type === 'message_update') {
      const delta = record(event.assistantMessageEvent)
      if ((delta.type === 'text_delta' || delta.type === 'thinking_delta') && typeof delta.delta === 'string') {
        const index = Number.isSafeInteger(delta.contentIndex) ? (delta.contentIndex as number) : 0
        this.streamed.set(index, (this.streamed.get(index) ?? '') + delta.delta)
        chunk(delta.type === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk', delta.delta)
      } else if (delta.type === 'toolcall_end') {
        const call = record(delta.toolCall)
        toolStart(call.id, call.name, call.arguments, 'pending')
      }
    } else if (event.type === 'message_end') {
      if (message.role === 'user') {
        if (typeof message.content === 'string') chunk('user_message_chunk', message.content)
        else if (Array.isArray(message.content))
          for (const value of message.content) {
            const block = record(value)
            if (block.type === 'text' && typeof block.text === 'string') chunk('user_message_chunk', block.text)
          }
        for (const content of piImageBlocks(message.content))
          updates.push({ sessionUpdate: 'user_message_chunk', content })
      } else if (message.role === 'assistant' && Array.isArray(message.content)) {
        message.content.forEach((value, index) => {
          const block = record(value)
          if (block.type === 'toolCall') {
            if (!this.tools.has(String(block.id))) toolStart(block.id, block.name, block.arguments, 'pending')
          } else {
            const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined
            if (typeof text === 'string') {
              const streamed = this.streamed.get(index) ?? ''
              if (text.startsWith(streamed))
                chunk(
                  block.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
                  text.slice(streamed.length)
                )
            }
          }
        })
        this.streamed.clear()
      } else if (message.role === 'toolResult')
        toolResult(message.toolCallId, message.toolName, message, message.isError === true, true)
    } else if (event.type === 'tool_execution_start')
      toolStart(event.toolCallId, event.toolName, event.args, 'in_progress')
    else if (event.type === 'tool_execution_update')
      toolResult(event.toolCallId, event.toolName, event.partialResult, false, false)
    else if (event.type === 'tool_execution_end')
      toolResult(event.toolCallId, event.toolName, event.result, event.isError === true, true)
    return updates
  }
}
