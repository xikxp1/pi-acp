import type { SessionUpdate } from '@agentclientprotocol/sdk'

type ChunkKind = 'agent_message_chunk' | 'agent_thought_chunk'
type LiveTool = {
  fields: Record<string, unknown>
  meta: Record<string, unknown>
  output: string
  outputTerminalId?: string
  exit?: unknown
}

/** Identities of messages already present in a `get_messages` result. */
export type CommittedMessages = { assistantTimestamps: Set<unknown>; toolResultIds: Set<string> }

export function committedMessages(data: unknown): CommittedMessages {
  const messages = (data as { messages?: unknown } | null | undefined)?.messages
  const committed: CommittedMessages = { assistantTimestamps: new Set(), toolResultIds: new Set() }
  for (const message of Array.isArray(messages) ? messages : []) {
    const m = message as { role?: unknown; timestamp?: unknown; toolCallId?: unknown } | null
    if (m?.role === 'assistant' && m.timestamp !== undefined) committed.assistantTimestamps.add(m.timestamp)
    if (m?.role === 'toolResult' && typeof m.toolCallId === 'string') committed.toolResultIds.add(m.toolCallId)
  }
  return committed
}

/**
 * Output of the current turn that pi has not committed to its message list yet:
 * the streaming assistant message and tool calls whose result message is pending.
 * Together with `get_messages` this reconstructs the full transcript for a client
 * that attaches mid-turn.
 */
export class LiveTurn {
  private chunks: Array<{ kind: ChunkKind; text: string }> = []
  private messageTimestamp: unknown
  private readonly tools = new Map<string, LiveTool>()

  /** An assistant message started (with its timestamp) or was committed (without). */
  resetMessage(timestamp?: unknown): void {
    this.chunks = []
    this.messageTimestamp = timestamp
  }

  appendDelta(kind: ChunkKind, text: string): void {
    const last = this.chunks.at(-1)
    if (last?.kind === kind) last.text += text
    else this.chunks.push({ kind, text })
  }

  /** The tool's result message was committed; history now renders it. */
  commitTool(toolCallId: string): void {
    this.tools.delete(toolCallId)
  }

  clear(): void {
    this.chunks = []
    this.messageTimestamp = undefined
    this.tools.clear()
  }

  record(update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const { sessionUpdate, toolCallId, _meta, ...fields } = update
    let tool = this.tools.get(toolCallId)
    if (!tool) {
      if (sessionUpdate !== 'tool_call') return
      tool = { fields: {}, meta: {}, output: '' }
      this.tools.set(toolCallId, tool)
    }
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) tool.fields[key] = value
    for (const [key, value] of Object.entries(_meta ?? {})) {
      if (key === 'terminal_output') {
        const output = value as { terminal_id?: unknown; data?: unknown } | null
        if (typeof output?.data === 'string') tool.output += output.data
        if (typeof output?.terminal_id === 'string') tool.outputTerminalId = output.terminal_id
      } else if (key === 'terminal_exit') {
        tool.exit = value
      } else {
        tool.meta[key] = value
      }
    }
  }

  /**
   * Updates that render the live tail. `committed` guards the window where pi already
   * stored a message but its `message_end` event has not reached us yet.
   */
  snapshot(committed: CommittedMessages = committedMessages(undefined)): SessionUpdate[] {
    const messageCommitted =
      this.messageTimestamp !== undefined && committed.assistantTimestamps.has(this.messageTimestamp)
    const updates: SessionUpdate[] = messageCommitted
      ? []
      : this.chunks
          .filter(chunk => chunk.text)
          .map(chunk => ({ sessionUpdate: chunk.kind, content: { type: 'text', text: chunk.text } }))

    for (const [toolCallId, tool] of this.tools) {
      if (committed.toolResultIds.has(toolCallId)) continue
      const emulatedTerminal = (tool.meta.terminal_info as { terminal_id?: unknown } | undefined)?.terminal_id
      // Client-owned terminals belong to the previous connection and cannot be rendered by a new one.
      const content = Array.isArray(tool.fields.content)
        ? tool.fields.content.filter(
            (item: { type?: unknown; terminalId?: unknown }) =>
              item?.type !== 'terminal' || item.terminalId === emulatedTerminal
          )
        : tool.fields.content
      updates.push({
        ...tool.fields,
        content,
        sessionUpdate: 'tool_call',
        toolCallId,
        title: typeof tool.fields.title === 'string' ? tool.fields.title : 'tool',
        ...(Object.keys(tool.meta).length ? { _meta: tool.meta } : {})
      } as SessionUpdate)

      if (tool.output || tool.exit !== undefined) {
        updates.push({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          _meta: {
            ...(tool.output
              ? { terminal_output: { terminal_id: tool.outputTerminalId ?? toolCallId, data: tool.output } }
              : {}),
            ...(tool.exit !== undefined ? { terminal_exit: tool.exit } : {})
          }
        })
      }
    }

    return updates
  }
}
