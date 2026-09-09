import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { toolResultToText } from './pi-tools.js'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function notificationDetailsText(details: unknown): string | undefined {
  const pending = [details]
  const seen = new Set<unknown>()
  const entries: string[] = []
  for (let index = 0; index < pending.length; index++) {
    const value = pending[index]
    if (seen.has(value)) continue
    seen.add(value)
    const d = record(value)
    if (![d.id, d.description, d.status, d.resultPreview].every(field => typeof field === 'string')) {
      if (index === 0) return undefined
      continue
    }
    const lines = [`Subagent: ${d.description} (${d.id})`, `Status: ${d.status}`]
    if (typeof d.toolUses === 'number' && Number.isFinite(d.toolUses)) lines.push(`Tool uses: ${d.toolUses}`)
    if (typeof d.durationMs === 'number' && Number.isFinite(d.durationMs)) lines.push(`Duration: ${d.durationMs} ms`)
    if (d.resultPreview) lines.push(`Result:\n${d.resultPreview}`)
    if (typeof d.error === 'string' && d.error) lines.push(`Error: ${d.error}`)
    if (typeof d.outputFile === 'string' && d.outputFile) lines.push(`Output file: ${d.outputFile}`)
    entries.push(lines.join('\n\n'))
    if (Array.isArray(d.others)) pending.push(...d.others)
  }
  return entries.join('\n\n') || undefined
}

export function displayedCustomMessageText(message: unknown): string | undefined {
  const m = record(message)
  if (m.role !== 'custom' || m.display !== true) return undefined
  if (m.customType === 'subagent-notification') {
    const notification = notificationDetailsText(m.details)
    if (notification) return `\n${notification}\n`
  }
  const text =
    typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .map(block => {
              const b = record(block)
              return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
            })
            .filter(Boolean)
            .join('\n')
        : ''
  return text ? `\n${text}\n` : undefined
}

export function isSubagentTool(name: string): boolean {
  return name === 'Agent' || name === 'agent' || name === 'subagent'
}

export function subagentToolTitle(name: string, args: unknown): string {
  if (!isSubagentTool(name)) return name
  const a = record(args)
  const label = [a.subagent_type, a.name, a.subagentType, a.displayName].find(
    value => typeof value === 'string' && value.trim()
  )
  const description = typeof a.description === 'string' ? a.description.trim() : ''
  return `${name}${label ? ` (${label})` : ''}${description ? `: ${description}` : ''}`
}

export function subagentResultText(result: unknown): string {
  const r = record(result)
  const details = record(r.details)
  const activity = typeof details.activity === 'string' ? details.activity : ''
  const count =
    typeof details.toolUses === 'number' && Number.isFinite(details.toolUses) ? `Tool uses: ${details.toolUses}` : ''
  const content = Array.isArray(r.content)
    ? r.content
        .map(block => {
          const b = record(block)
          return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
        })
        .filter(Boolean)
        .join('\n')
    : ''
  const text = [activity, count, content].filter(Boolean).join('\n\n')
  return text || toolResultToText(result)
}

type Status = 'pending' | 'in_progress' | 'completed' | 'failed'
type Snapshot = {
  version: 1
  agentId: string
  runId: string
  title: string
  status: Status
  text: string
  outputFile?: string
}

function parseSnapshot(value: unknown): Snapshot | undefined {
  if (typeof value !== 'string' || value.length > 524288) return undefined
  try {
    const p = record(JSON.parse(value) as unknown)
    if (
      p.version !== 1 ||
      typeof p.status !== 'string' ||
      !['pending', 'in_progress', 'completed', 'failed'].includes(p.status)
    )
      return undefined
    for (const key of ['agentId', 'runId', 'title'] as const) {
      if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > 512) return undefined
    }
    if (typeof p.text !== 'string' || p.text.length > 65536) return undefined
    if (
      p.outputFile !== undefined &&
      (typeof p.outputFile !== 'string' ||
        p.outputFile.length > 4096 ||
        !isAbsolute(p.outputFile) ||
        p.outputFile.includes('\0'))
    )
      return undefined
    return p as Snapshot
  } catch {
    return undefined
  }
}

export class SubagentCards {
  // Keep tombstones, not output, so late snapshots cannot reopen completed runs.
  private readonly cards = new Map<string, { status: Status; digest?: string }>()

  update(value: unknown): SessionUpdate | undefined {
    const p = parseSnapshot(value)
    if (!p) return undefined
    const previous = this.cards.get(p.runId)
    if (previous?.status === 'completed' || previous?.status === 'failed') return undefined
    // A hard session cap preserves finality without unbounded tombstone storage.
    if (!previous && this.cards.size >= 4096) return undefined
    const status = previous?.status === 'in_progress' && p.status === 'pending' ? 'in_progress' : p.status
    const digest = createHash('sha256')
      .update(JSON.stringify([p.title, status, p.text, p.outputFile]))
      .digest('hex')
    if (previous?.digest === digest) return undefined
    this.cards.set(p.runId, { status, ...(status === 'pending' || status === 'in_progress' ? { digest } : {}) })
    return {
      sessionUpdate: previous ? 'tool_call_update' : 'tool_call',
      toolCallId: `pi-subagent-${p.runId}`,
      title: p.title,
      kind: 'other',
      status,
      content: [{ type: 'content', content: { type: 'text', text: p.text } }],
      locations: p.outputFile ? [{ path: p.outputFile }] : []
    }
  }

  fail(): SessionUpdate[] {
    const updates: SessionUpdate[] = []
    for (const [runId, card] of this.cards) {
      if (card.status === 'pending' || card.status === 'in_progress')
        updates.push({ sessionUpdate: 'tool_call_update', toolCallId: `pi-subagent-${runId}`, status: 'failed' })
    }
    this.cards.clear()
    return updates
  }
}
