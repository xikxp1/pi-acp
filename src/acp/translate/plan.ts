import type { PlanEntry } from '@agentclientprotocol/sdk'

export function todoDetailsToPlan(details: unknown): PlanEntry[] | null {
  if (typeof details !== 'object' || details === null || !('todos' in details)) return null
  if (!Array.isArray(details.todos)) return null

  const entries: PlanEntry[] = []
  for (const item of details.todos as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    if (!('content' in item) || typeof item.content !== 'string') continue
    if (
      !('status' in item) ||
      (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed')
    )
      continue
    if (!('priority' in item) || (item.priority !== 'high' && item.priority !== 'medium' && item.priority !== 'low'))
      continue
    entries.push({ content: item.content, status: item.status, priority: item.priority })
  }
  return entries
}
